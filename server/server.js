import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { constants as fsConstants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import AdmZip from 'adm-zip';
import pg from 'pg';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execFile, fork } from 'child_process';
import { promisify } from 'util';
import {
  gradeMatchingAnswer,
  gradeNumberAnswer,
  gradeOrderingAnswer,
  gradeRegionAnswer,
  gradeTextAnswer,
  normalizeOpenAnswer,
} from './diagnosticLogic.js';

const execFileAsync = promisify(execFile);
const scryptAsync = promisify(crypto.scrypt);
const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const UPLOAD_LOG_DIR = path.join(DATA_DIR, 'upload-logs');
const SLIDES_JSON = path.join(DATA_DIR, 'slides.json');
const DIAGNOSTICS_JSON = path.join(DATA_DIR, 'diagnostics.json');
const DIAGNOSTIC_RESULTS_JSON = path.join(DATA_DIR, 'diagnostic-results.json');

const RAW_SLIDES_DIR = path.join(PROJECT_ROOT, 'raw-slides');
const PUBLIC_SLIDES_DIR = path.join(PROJECT_ROOT, 'public', 'slides');
const DIAGNOSTIC_TIME_ZONE_OFFSET_MINUTES = 5 * 60;

const app = express();
const PORT = process.env.PORT || 4000;
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5432/histology_viewer';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_LOGIN = String(process.env.ADMIN_LOGIN || 'admin').trim().toLowerCase();
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || '';
const TEACHER_ACCOUNTS = parseTeacherAccounts(process.env.TEACHER_ACCOUNTS);
if (!/^[a-z0-9_-]{3,64}$/.test(ADMIN_LOGIN)) {
  throw new Error('ADMIN_LOGIN должен содержать только латинские буквы, цифры, _ или -');
}
const ADMIN_SESSION_SECRET_CONFIGURED = Boolean(process.env.ADMIN_SESSION_SECRET);
const ADMIN_SESSION_SECRET =
  process.env.ADMIN_SESSION_SECRET ||
  crypto.randomBytes(32).toString('hex');
const ADMIN_SESSION_COOKIE = 'histology_admin_session';
const AUTH_MODE = ['local', 'moodle_lti'].includes(process.env.AUTH_MODE)
  ? process.env.AUTH_MODE
  : 'local';
const ENABLE_MOODLE_LTI = process.env.ENABLE_MOODLE_LTI === 'true' || AUTH_MODE === 'moodle_lti';
const LTI_SESSION_COOKIE = 'histology_lti_session';
const LTI_SESSION_SECRET = process.env.LTI_SESSION_SECRET || ADMIN_SESSION_SECRET;
const LTI_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LTI_COOKIE_SECURE = process.env.LTI_COOKIE_SECURE === 'true';
const LTI_PRIVATE_KEY = process.env.LTI_PRIVATE_KEY || '';
const LTI_PUBLIC_KEY = process.env.LTI_PUBLIC_KEY || '';
const LTI_KEY_ID = process.env.LTI_KEY_ID || 'histology-viewer-lti-key';
const LTI_REDIRECT_URI = process.env.LTI_REDIRECT_URI || `http://localhost:${PORT}/lti/launch`;
const LTI_CONFIG = {
  issuer: process.env.LTI_PLATFORM_ISSUER || '',
  clientId: process.env.LTI_CLIENT_ID || '',
  deploymentId: process.env.LTI_DEPLOYMENT_ID || '',
  authLoginUrl: process.env.LTI_AUTH_LOGIN_URL || '',
  authTokenUrl: process.env.LTI_AUTH_TOKEN_URL || '',
  jwksUrl: process.env.LTI_PLATFORM_JWKS_URL || '',
};
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const BACKUP_INTERVAL_HOURS = Math.max(1, Math.min(24 * 30, Number(process.env.BACKUP_INTERVAL_HOURS) || 24));
const BACKUP_RETENTION_DAYS = Math.max(1, Math.min(3650, Number(process.env.BACKUP_RETENTION_DAYS) || 30));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
});

const ALLOWED_SLIDE_EXTENSIONS = new Set([
  '.svs',
  '.tif',
  '.tiff',
  '.ndpi',
  '.scn',
  '.kfb',
  '.mrxs',
  '.zip',
]);

const OPENSLIDE_SLIDE_EXTENSIONS = [
  '.svs',
  '.vms',
  '.vmu',
  '.ndpi',
  '.scn',
  '.mrxs',
  '.svslide',
  '.tif',
  '.bif',
  '.dcm',
];

const BACKUP_STORES = ['slides', 'diagnostics', 'diagnostic_results'];
const BACKUP_SNAPSHOT_PREFIX = 'snapshot';

const jobs = new Map();
const slideConversionQueue = [];
const slideConversionTasks = new Map();
let activeSlideConversionTask = null;
let slideWorker = null;

function createJob(message = 'Ожидание обработки...') {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const job = {
    id,
    status: 'pending',
    message,
    progress: 0,
    slide: null,
    error: null,
    createdAt: new Date().toISOString(),
  };

  jobs.set(id, job);
  return job;
}

function updateJob(id, patch) {
  const current = jobs.get(id);
  if (!current) return;

  jobs.set(id, {
    ...current,
    ...patch,
  });
}

function createSlideWorkerError(details) {
  const error = new Error(details?.message || 'Worker конвертации препарата завершился с ошибкой');
  error.code = details?.code || null;
  error.signal = details?.signal || null;
  error.stdout = details?.stdout || '';
  error.stderr = details?.stderr || '';
  return error;
}

function rejectActiveSlideConversion(error) {
  if (!activeSlideConversionTask) return;

  const task = activeSlideConversionTask;
  activeSlideConversionTask = null;
  slideConversionTasks.delete(task.taskId);
  task.reject(error);
}

function runNextSlideConversion() {
  if (activeSlideConversionTask || slideConversionQueue.length === 0) return;

  if (!slideWorker?.connected) {
    startSlideWorker();
    return;
  }

  const task = slideConversionQueue.shift();
  activeSlideConversionTask = task;
  task.onProgress?.({
    progress: 50,
    message: 'Задача передана worker конвертации...',
  });

  slideWorker.send(
    {
      type: 'convert',
      taskId: task.taskId,
      inputPath: task.inputPath,
      slideId: task.slideId,
    },
    (error) => {
      if (!error) return;
      rejectActiveSlideConversion(error);
      runNextSlideConversion();
    }
  );
}

function startSlideWorker() {
  if (slideWorker?.connected) return;

  slideWorker = fork(path.join(__dirname, 'slide-worker.js'), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  slideWorker.on('message', (message) => {
    const task = activeSlideConversionTask;
    if (!task || message?.taskId !== task.taskId) return;

    if (message.type === 'progress') {
      task.onProgress?.(message);
      return;
    }

    if (!['done', 'error'].includes(message.type)) return;

    activeSlideConversionTask = null;
    slideConversionTasks.delete(task.taskId);

    if (message.type === 'done') {
      task.resolve(message.source);
    } else if (message.type === 'error') {
      task.reject(createSlideWorkerError(message.error));
    }

    runNextSlideConversion();
  });

  slideWorker.on('error', (error) => {
    rejectActiveSlideConversion(error);
  });

  slideWorker.on('exit', (code, signal) => {
    slideWorker = null;

    if (activeSlideConversionTask) {
      rejectActiveSlideConversion(
        new Error(
          `Worker конвертации завершился неожиданно (код ${code ?? 'нет'}, сигнал ${signal || 'нет'}).`
        )
      );
    }

    if (slideConversionQueue.length > 0) {
      startSlideWorker();
      runNextSlideConversion();
    }
  });
}

function convertSlideToDziInWorker(inputPath, slideId, onProgress) {
  return new Promise((resolve, reject) => {
    const task = {
      taskId: crypto.randomUUID(),
      inputPath,
      slideId,
      onProgress,
      resolve,
      reject,
    };

    slideConversionTasks.set(task.taskId, task);
    slideConversionQueue.push(task);
    startSlideWorker();
    runNextSlideConversion();
  });
}

function parseCookies(header = '') {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex < 0) return cookies;

      const name = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();

      cookies[name] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function parseTeacherAccounts(value) {
  if (!value) return [];
  let accounts;
  try {
    accounts = JSON.parse(value);
  } catch {
    throw new Error('TEACHER_ACCOUNTS должен содержать корректный JSON-массив');
  }

  if (!Array.isArray(accounts)) throw new Error('TEACHER_ACCOUNTS должен быть JSON-массивом');
  return accounts.map((account) => {
    const login = String(account?.login || '').trim().toLowerCase();
    const password = String(account?.password || '');
    if (!/^[a-z0-9_-]{3,64}$/.test(login) || !password) {
      throw new Error('Каждая учётная запись преподавателя должна иметь login и password');
    }
    return { login, password };
  });
}

function signAdminSession(role, login, expiresAt) {
  return crypto
    .createHmac('sha256', ADMIN_SESSION_SECRET)
    .update(`${role}.${login}.${expiresAt}`)
    .digest('hex');
}

function createAdminSessionToken(role, login) {
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  return `${role}.${login}.${expiresAt}.${signAdminSession(role, login, expiresAt)}`;
}

function getSessionRole(token) {
  const [role, login, expiresAtRaw, signature] = String(token || '').split('.');
  const expiresAt = Number(expiresAtRaw);

  if (!['admin', 'teacher', 'teacher_full', 'teacher_limited', 'resident', 'student'].includes(role) || !/^[a-z0-9_-]{3,64}$/.test(login) || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || !signature) {
    return null;
  }

  const expected = signAdminSession(role, login, expiresAt);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);

  return (
    expectedBuffer.length === signatureBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
  ) ? { role, login } : null;
}

const ROLE_PERMISSIONS = {
  admin: { canViewSlides: true, canViewSlideCards: true, canViewSlideDescriptions: true, canCreateSlideCards: true, canEditSlideCards: true, canDeleteSlideCards: true, canUploadSlides: true, canEditSlides: true, canDeleteSlides: true, canCreateDiagnostics: true, canEditOwnDiagnostics: true, canEditAllDiagnostics: true, canDeleteDiagnostics: true, canViewResults: true, canGradeResults: true, canManageTeachers: true, canManageUsers: true, canManageRoles: true, canManageMoodle: true, canManageLti: true, canSendGradesToMoodle: true },
  teacher_full: { canViewSlides: true, canViewSlideCards: true, canViewSlideDescriptions: true, canCreateSlideCards: true, canEditSlideCards: true, canDeleteSlideCards: true, canUploadSlides: true, canEditSlides: true, canDeleteSlides: true, canCreateDiagnostics: true, canEditOwnDiagnostics: true, canEditAllDiagnostics: true, canDeleteDiagnostics: true, canViewResults: true, canGradeResults: true, canManageTeachers: false, canManageUsers: false, canManageRoles: false, canManageMoodle: false, canManageLti: false, canSendGradesToMoodle: false },
  teacher_limited: { canViewSlides: true, canViewSlideCards: true, canViewSlideDescriptions: true, canCreateSlideCards: false, canEditSlideCards: false, canDeleteSlideCards: false, canUploadSlides: false, canEditSlides: false, canDeleteSlides: false, canCreateDiagnostics: true, canEditOwnDiagnostics: true, canEditAllDiagnostics: false, canDeleteDiagnostics: false, canViewResults: true, canGradeResults: true, canManageTeachers: false, canManageUsers: false, canManageRoles: false, canManageMoodle: false, canManageLti: false, canSendGradesToMoodle: false },
  resident: { canViewSlides: true, canViewSlideCards: false, canViewSlideDescriptions: false, canCreateSlideCards: false, canEditSlideCards: false, canDeleteSlideCards: false, canUploadSlides: false, canEditSlides: false, canDeleteSlides: false, canCreateDiagnostics: false, canEditOwnDiagnostics: false, canEditAllDiagnostics: false, canDeleteDiagnostics: false, canViewResults: false, canGradeResults: false, canManageTeachers: false, canManageUsers: false, canManageRoles: false, canManageMoodle: false, canManageLti: false, canSendGradesToMoodle: false },
  student: { canViewSlides: true, canViewSlideCards: true, canViewSlideDescriptions: true, canCreateSlideCards: false, canEditSlideCards: false, canDeleteSlideCards: false, canUploadSlides: false, canEditSlides: false, canDeleteSlides: false, canCreateDiagnostics: false, canEditOwnDiagnostics: false, canEditAllDiagnostics: false, canDeleteDiagnostics: false, canViewResults: false, canGradeResults: false, canManageTeachers: false, canManageUsers: false, canManageRoles: false, canManageMoodle: false, canManageLti: false, canSendGradesToMoodle: false },
};

const USER_ROLES = Object.keys(ROLE_PERMISSIONS);
function normalizeRole(role, fallback = 'student') {
  return USER_ROLES.includes(role) ? role : fallback;
}
function normalizePermissionOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.keys(ROLE_PERMISSIONS.admin)
      .filter((key) => typeof value[key] === 'boolean')
      .map((key) => [key, value[key]])
  );
}
function permissionsForRole(role, overrides = {}) {
  return {
    ...(ROLE_PERMISSIONS[normalizeRole(role)] || ROLE_PERMISSIONS.student),
    ...normalizePermissionOverrides(overrides),
  };
}
const DEV_AUTH_ENABLED = process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS === 'true';
const DEV_AUTH_ROLE = Object.hasOwn(ROLE_PERMISSIONS, process.env.DEV_AUTH_ROLE)
  ? process.env.DEV_AUTH_ROLE
  : 'teacher_full';

function getDevUser() {
  if (!DEV_AUTH_ENABLED) return null;

  const courseId = process.env.DEV_AUTH_COURSE_ID || 'dev-course';
  const groupId = process.env.DEV_AUTH_GROUP_ID || 'dev-group';
  return {
    authProvider: 'dev',
    moodleUserId: 'dev-user',
    userId: 'dev-user',
    name: 'Dev User',
    email: 'dev@example.local',
    role: DEV_AUTH_ROLE,
    permissions: permissionsForRole(DEV_AUTH_ROLE),
    courseIds: [courseId],
    groupIds: [groupId],
    courseExternalIds: [courseId],
  };
}
function roleFromLtiRoles(roles = []) {
  const values = roles.map((value) => String(value).toLowerCase());
  if (values.some((value) => /administrator/.test(value))) return 'admin';
  if (values.some((value) => /instructor|teacher|faculty/.test(value))) return 'teacher_full';
  if (values.some((value) => /resident|ординатор/.test(value))) return 'resident';
  return 'student';
}

function getAdminCookieOptions({ expires = null } = {}) {
  const options = [
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
  ];

  if (process.env.ADMIN_COOKIE_SECURE === 'true') {
    options.push('Secure');
  }

  if (expires) {
    options.push(`Expires=${expires.toUTCString()}`);
  } else {
    options.push(`Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`);
  }

  return options.join('; ');
}

function setAdminSessionCookie(res, role, login) {
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(createAdminSessionToken(role, login))}; ${getAdminCookieOptions()}`
  );
}

function clearAdminSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=; ${getAdminCookieOptions({ expires: new Date(0) })}; Max-Age=0`
  );
}

function isAdminAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  return getSessionRole(cookies[ADMIN_SESSION_COOKIE]);
}

function requireAdministrator(req, res, next) {
  if ((req.user?.role || req.adminRole) !== 'admin') return res.status(403).json({ error: 'Эта операция доступна только администратору' });
  return next();
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}
function parseBase64UrlJson(value) {
  return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
}
function createLtiSessionToken(user) {
  const payload = base64Url(JSON.stringify({ ...user, exp: Date.now() + LTI_SESSION_TTL_MS }));
  const signature = crypto.createHmac('sha256', LTI_SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function getLtiSession(req) {
  const token = parseCookies(req.headers.cookie)[LTI_SESSION_COOKIE];
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', LTI_SESSION_SECRET).update(payload).digest('base64url');
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const session = parseBase64UrlJson(payload);
    return session.exp > Date.now() ? session : null;
  } catch { return null; }
}
function setLtiSessionCookie(res, user) {
  const options = ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(LTI_SESSION_TTL_MS / 1000)}`];
  if (LTI_COOKIE_SECURE) options.push('Secure');
  res.setHeader('Set-Cookie', `${LTI_SESSION_COOKIE}=${createLtiSessionToken(user)}; ${options.join('; ')}`);
}
async function requireAuth(req, res, next) {
  try {
    const user = await getSessionUser(req);
    if (user) { req.user = user; return next(); }

    if (!ENABLE_MOODLE_LTI) {
      req.user = getLocalGuestUser();
      return next();
    }

    return res.status(401).json({ error: 'Требуется авторизация через Moodle LTI', authenticated: false });
  } catch (error) {
    return next(error);
  }
}
async function requireAdminAreaAuth(req, res, next) {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Требуется вход в админку', authenticated: false });
    req.user = user;
    return requireUserActive(req, res, next);
  } catch (error) {
    return next(error);
  }
}
function requirePermission(permission) {
  return (req, res, next) => requireAuth(req, res, () => req.user.permissions?.[permission]
    ? next()
    : res.status(403).json({ error: `Недостаточно прав: ${permission}` }));
}
function requireUserManagement(req, res, next) {
  return req.user?.permissions?.canManageUsers || req.user?.permissions?.canManageTeachers
    ? next()
    : res.status(403).json({ error: 'Недостаточно прав для управления пользователями' });
}
function maskSlideForResident(slide, index) {
  const title = `Препарат ${index + 1}`;
  return { id: slide.id, title, displayTitle: title, description: '', diagnosis: '', diagnosticSigns: [], selfCheckQuestions: [], organ: '', stain: slide.stain || '', system: slide.system || '', viewerOnly: true, source: slide.source, dziUrl: slide.dziUrl || slide.source };
}
async function getSlideAccess(slide, user) {
  if (!ENABLE_MOODLE_LTI && user.authProvider === 'local') return true;
  if (user.role === 'admin' || user.role === 'teacher_full') return true;
  if (user.role === 'teacher_limited') return true;
  if (user.role === 'resident' && slide.visibleForResidents === false) return false;
  if (user.role === 'student' && slide.visibleForStudents === false) return false;
  // Dev identities do not have internal Moodle database IDs. Keep course/group
  // assignments testable in production while allowing a local UI preview.
  if (user.authProvider === 'dev') return true;
  const [{ rows: courses }, { rows: groups }] = await Promise.all([
    pool.query('SELECT course_id FROM slide_course_access WHERE slide_id = $1', [slide.id]),
    pool.query('SELECT group_id FROM slide_group_access WHERE slide_id = $1', [slide.id]),
  ]);
  const courseIds = courses.map((row) => String(row.course_id));
  const groupIds = groups.map((row) => String(row.group_id));
  if (!courseIds.length && !groupIds.length) return true;
  if (courseIds.length && !courseIds.some((id) => user.courseIds?.map(String).includes(id))) return false;
  return !groupIds.length || groupIds.some((id) => user.groupIds?.map(String).includes(id));
}
async function requireSlideAccess(slideId) {
  const slides = await readSlides();
  const slide = slides.find((item) => item.id === slideId);
  return slide;
}
async function getDiagnosticAccess(diagnostic, user) {
  if (!ENABLE_MOODLE_LTI && user.authProvider === 'local') return true;
  if (user.role === 'resident') return false;
  if (['admin', 'teacher_full', 'teacher_limited'].includes(user.role)) return true;
  if (user.authProvider === 'dev') return true;
  const [{ rows: courses }, { rows: groups }] = await Promise.all([
    pool.query('SELECT course_id FROM diagnostic_course_access WHERE diagnostic_id=$1', [diagnostic.id]),
    pool.query('SELECT group_id FROM diagnostic_group_access WHERE diagnostic_id=$1', [diagnostic.id]),
  ]);
  const courseIds = courses.map((row) => String(row.course_id)); const groupIds = groups.map((row) => String(row.group_id));
  if (!courseIds.length && !groupIds.length) return true;
  return (!courseIds.length || courseIds.some((id) => user.courseIds?.map(String).includes(id))) && (!groupIds.length || groupIds.some((id) => user.groupIds?.map(String).includes(id)));
}
function isAdminPasswordValid(value) {
  if (!ADMIN_PASSWORD) return false;

  const expectedBuffer = Buffer.from(ADMIN_PASSWORD);
  const actualBuffer = Buffer.from(String(value || ''));

  return (
    expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function isTeacherPasswordValid(value) {
  if (!TEACHER_PASSWORD) return false;

  const expectedBuffer = Buffer.from(TEACHER_PASSWORD);
  const actualBuffer = Buffer.from(String(value || ''));

  return (
    expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function isPasswordValid(expected, actual) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(String(actual || ''));
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function normalizeAccountLogin(value) {
  const login = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,64}$/.test(login)) {
    throw new Error('Логин должен содержать 3-64 латинских букв, цифр, _ или -');
  }
  return login;
}

function requireAccountPassword(value) {
  const password = String(value || '');
  if (password.length < 8) throw new Error('Пароль должен содержать не менее 8 символов');
  return password;
}

async function hashAccountPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, 64);
  return `${salt}:${Buffer.from(hash).toString('hex')}`;
}

async function isStoredPasswordValid(passwordHash, password) {
  const [salt, savedHash] = String(passwordHash || '').split(':');
  if (!salt || !savedHash) return false;
  const actualHash = Buffer.from(await scryptAsync(String(password || ''), salt, 64)).toString('hex');
  return isPasswordValid(savedHash, actualHash);
}

async function listTeacherAccounts() {
  const { rows } = await pool.query(
    'SELECT login, role, active, course_ids, group_ids, created_at, updated_at FROM teacher_accounts ORDER BY login'
  );
  return rows.map((row) => ({
    login: row.login,
    role: row.role,
    active: row.active,
    courseIds: row.course_ids || [],
    groupIds: row.group_ids || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function findStoredTeacherAccount(login) {
  const { rows } = await pool.query(
    'SELECT login, password_hash, role, active, course_ids, group_ids FROM teacher_accounts WHERE login = $1',
    [login]
  );
  return rows[0] || null;
}

function normalizeOptionalEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Некорректный email');
  return email;
}

function normalizeFullName(value) {
  return String(value || '').trim();
}

function userRowToApi(row) {
  const permissionOverrides = normalizePermissionOverrides(row.permission_overrides || {});
  return {
    id: row.id,
    login: row.login,
    email: row.email || '',
    fullName: row.full_name || '',
    name: row.full_name || row.login,
    role: normalizeRole(row.role),
    permissionOverrides,
    permissions: permissionsForRole(row.role, permissionOverrides),
    isActive: row.is_active,
    authProvider: row.auth_provider || 'local',
    moodleUserId: row.moodle_user_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

async function findUserByLogin(login) {
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(login) = lower($1) AND deleted_at IS NULL', [login]);
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
  return rows[0] || null;
}

async function requireUserActive(req, res, next) {
  if (req.user?.isActive === false) return res.status(403).json({ error: 'Учётная запись заблокирована' });
  return next();
}

async function listUsers() {
  const { rows } = await pool.query(
    `SELECT id, login, email, full_name, role, permission_overrides, is_active, auth_provider, moodle_user_id, created_at, updated_at, last_login_at
     FROM users
     WHERE deleted_at IS NULL
     ORDER BY created_at DESC, id DESC`
  );
  return rows.map(userRowToApi);
}

async function userFromStoredRow(row) {
  const apiUser = userRowToApi(row);
  return {
    authProvider: apiUser.authProvider,
    id: apiUser.id,
    userId: apiUser.id,
    login: apiUser.login,
    name: apiUser.name,
    email: apiUser.email,
    role: apiUser.role,
    permissions: apiUser.permissions,
    permissionOverrides: apiUser.permissionOverrides,
    isActive: apiUser.isActive,
    moodleUserId: apiUser.moodleUserId,
    courseIds: [],
    groupIds: [],
    courseExternalIds: [],
  };
}

async function getSessionUser(req) {
  const devUser = getDevUser();
  if (devUser) return devUser;

  if (ENABLE_MOODLE_LTI) {
    const lti = getLtiSession(req);
    if (lti) return lti;
  }

  const session = isAdminAuthenticated(req);
  if (!session) return null;

  if (session.role === 'admin' && session.login === ADMIN_LOGIN) {
    return { authProvider: 'local_admin', role: 'admin', login: session.login, name: session.login, permissions: permissionsForRole('admin'), courseIds: [], groupIds: [], courseExternalIds: [], isActive: true };
  }

  const storedUser = await findUserByLogin(session.login);
  if (storedUser?.is_active) return userFromStoredRow(storedUser);

  const storedTeacher = await findStoredTeacherAccount(session.login);
  if (storedTeacher?.active) {
    const role = normalizeRole(storedTeacher.role, 'teacher_full');
    return { authProvider: 'local', role, login: storedTeacher.login, name: storedTeacher.login, permissions: permissionsForRole(role), courseIds: storedTeacher.course_ids || [], groupIds: storedTeacher.group_ids || [], courseExternalIds: [], isActive: true };
  }

  return null;
}

function getLocalGuestUser() {
  return {
    authenticated: false,
    authProvider: 'local',
    role: 'guest',
    name: '',
    permissions: {
      canViewSlides: true,
      canViewSlideCards: true,
      canViewSlideDescriptions: true,
    },
    courseIds: [],
    groupIds: [],
    courseExternalIds: [],
    isActive: true,
  };
}

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(BACKUP_DIR, { recursive: true });
await fs.mkdir(UPLOAD_LOG_DIR, { recursive: true });
await fs.mkdir(RAW_SLIDES_DIR, { recursive: true });
await fs.mkdir(PUBLIC_SLIDES_DIR, { recursive: true });

const upload = multer({
  dest: RAW_SLIDES_DIR,
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024,
  },
});

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(
  '/slides',
  async (req, res, next) => {
    try {
      if (!ENABLE_MOODLE_LTI) return next();
      const slideId = String(req.path).match(/^\/([^/_./]+)(?:\.dzi|_files\/)/)?.[1];
      const user = await getSessionUser(req);
      if (!user || !slideId) return res.status(401).json({ error: 'Требуется авторизация для доступа к препарату' });
      const slide = (await readSlides()).find((item) => item.id === slideId);
      if (!slide || !(await getSlideAccess(slide, user))) return res.status(403).json({ error: 'Нет доступа к препарату' });
      return next();
    } catch (error) { return next(error); }
  },
  express.static(PUBLIC_SLIDES_DIR, {
    immutable: true,
    maxAge: '30d',
  })
);

async function readJsonArrayFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function getJsonStore(filePath) {
  if (filePath === DIAGNOSTICS_JSON) return 'diagnostics';
  if (filePath === DIAGNOSTIC_RESULTS_JSON) return 'diagnostic_results';
  if (filePath === SLIDES_JSON) return 'slides';
  throw new Error(`Неизвестное JSON-хранилище: ${filePath}`);
}

async function upsertJsonItem(client, tableName, item) {
  if (!item?.id) return;

  if (tableName === 'diagnostic_results') {
    await client.query(
      `INSERT INTO diagnostic_results (id, diagnostic_id, student_name, group_name, submitted_at, data)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         diagnostic_id = EXCLUDED.diagnostic_id,
         student_name = EXCLUDED.student_name,
         group_name = EXCLUDED.group_name,
         submitted_at = EXCLUDED.submitted_at,
         data = EXCLUDED.data,
         updated_at = now()`,
      [
        item.id,
        item.diagnosticId || '',
        item.studentName || '',
        item.group || '',
        item.submittedAt || null,
        JSON.stringify(item),
      ]
    );
    return;
  }

  await client.query(
    `INSERT INTO ${tableName} (id, data)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [item.id, JSON.stringify(item)]
  );
}

async function upsertJsonItems(tableName, items) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    for (const item of items) {
      await upsertJsonItem(client, tableName, item);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function replaceJsonItems(tableName, items) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const currentRows = await client.query(
      tableName === 'diagnostic_results'
        ? 'SELECT data FROM diagnostic_results ORDER BY submitted_at NULLS LAST, id'
        : `SELECT data FROM ${tableName} ORDER BY id`
    );
    await backupJsonStore(tableName, currentRows.rows.map((row) => row.data));
    await client.query(`DELETE FROM ${tableName}`);
    for (const item of items) {
      await upsertJsonItem(client, tableName, item);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function backupJsonStore(tableName, items) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `${tableName}-${timestamp}.json`);
  await fs.writeFile(backupPath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

async function createDataSnapshotBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = {
    version: 1,
    type: 'full-data-snapshot',
    createdAt: new Date().toISOString(),
    stores: {
      slides: await readJsonItems('slides'),
      diagnostics: await readJsonItems('diagnostics'),
      diagnostic_results: await readJsonItems('diagnostic_results'),
    },
  };
  const fileName = `${BACKUP_SNAPSHOT_PREFIX}-${timestamp}.json`;
  const backupPath = path.join(BACKUP_DIR, fileName);

  await fs.writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');

  return {
    fileName,
    createdAt: backup.createdAt,
    counts: Object.fromEntries(
      Object.entries(backup.stores).map(([store, items]) => [store, items.length])
    ),
  };
}

async function pruneExpiredDataBackups() {
  const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
  const expiresBefore = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.startsWith(`${BACKUP_SNAPSHOT_PREFIX}-`)) return;
    const backupPath = path.join(BACKUP_DIR, entry.name);
    const stats = await fs.stat(backupPath);
    if (stats.mtimeMs < expiresBefore) await fs.rm(backupPath, { force: true });
  }));
}

async function runScheduledBackup() {
  try {
    const backup = await createDataSnapshotBackup();
    await pruneExpiredDataBackups();
    console.info(`Создан плановый backup: ${backup.fileName}`);
  } catch (error) {
    console.error('Не удалось создать плановый backup:', error);
  }
}

function getBackupFilePath(fileName) {
  const rawName = String(fileName || '');
  const safeName = path.basename(rawName);

  if (!safeName || safeName !== rawName || !safeName.endsWith('.json')) {
    throw new Error('Некорректное имя backup-файла');
  }

  return path.join(BACKUP_DIR, safeName);
}

async function readDataSnapshotBackup(fileName) {
  const backupPath = getBackupFilePath(fileName);
  const data = JSON.parse(await fs.readFile(backupPath, 'utf8'));

  if (data?.type !== 'full-data-snapshot' || typeof data.stores !== 'object') {
    throw new Error('Этот backup не является полным снимком данных');
  }

  for (const store of BACKUP_STORES) {
    if (!Array.isArray(data.stores[store])) {
      throw new Error(`В backup отсутствует раздел: ${store}`);
    }
  }

  return data;
}

async function listDataBackups() {
  const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
  const backups = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

    const backupPath = path.join(BACKUP_DIR, entry.name);
    const stats = await fs.stat(backupPath);
    const item = {
      fileName: entry.name,
      sizeBytes: stats.size,
      createdAt: stats.mtime.toISOString(),
      restorable: entry.name.startsWith(`${BACKUP_SNAPSHOT_PREFIX}-`),
      counts: null,
    };

    if (item.restorable) {
      try {
        const data = await readDataSnapshotBackup(entry.name);
        item.createdAt = data.createdAt || item.createdAt;
        item.counts = Object.fromEntries(
          BACKUP_STORES.map((store) => [store, data.stores[store].length])
        );
      } catch (error) {
        item.restorable = false;
        item.error = error.message;
      }
    }

    backups.push(item);
  }

  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function readJsonItems(tableName, { diagnosticId = null } = {}) {
  if (tableName === 'diagnostic_results') {
    const params = [];
    let whereClause = '';

    if (diagnosticId) {
      params.push(diagnosticId);
      whereClause = 'WHERE diagnostic_id = $1';
    }

    const { rows } = await pool.query(
      `SELECT data FROM diagnostic_results ${whereClause}
       ORDER BY submitted_at NULLS LAST, id`,
      params
    );
    return rows.map((row) => row.data);
  }

  const { rows } = await pool.query(
    `SELECT data FROM ${tableName} ORDER BY id`
  );
  return rows.map((row) => row.data);
}

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS slides (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS diagnostics (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS diagnostic_results (
        id text PRIMARY KEY,
        diagnostic_id text NOT NULL,
        student_name text NOT NULL DEFAULT '',
        group_name text NOT NULL DEFAULT '',
        submitted_at timestamptz,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS diagnostic_results_diagnostic_id_idx
        ON diagnostic_results (diagnostic_id);
      CREATE INDEX IF NOT EXISTS diagnostic_results_student_idx
        ON diagnostic_results (diagnostic_id, lower(student_name), lower(group_name));
      CREATE INDEX IF NOT EXISTS diagnostics_data_gin_idx
        ON diagnostics USING gin (data);

      CREATE TABLE IF NOT EXISTS teacher_accounts (
        login text PRIMARY KEY,
        password_hash text NOT NULL,
        role text NOT NULL DEFAULT 'teacher_full',
        active boolean NOT NULL DEFAULT true,
        course_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        group_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE teacher_accounts ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'teacher_full';
      ALTER TABLE teacher_accounts ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
      ALTER TABLE teacher_accounts ADD COLUMN IF NOT EXISTS course_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE teacher_accounts ADD COLUMN IF NOT EXISTS group_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

      CREATE TABLE IF NOT EXISTS users (
        id bigserial PRIMARY KEY,
        login text UNIQUE NOT NULL,
        email text UNIQUE,
        full_name text NOT NULL DEFAULT '',
        password_hash text,
        role text NOT NULL DEFAULT 'student',
        permission_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
        is_active boolean NOT NULL DEFAULT true,
        auth_provider text NOT NULL DEFAULT 'local',
        moodle_user_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_login_at timestamptz,
        deleted_at timestamptz
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email text UNIQUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name text NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'student';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS permission_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'local';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS moodle_user_id text;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
      CREATE INDEX IF NOT EXISTS users_login_idx ON users(lower(login));
      CREATE INDEX IF NOT EXISTS users_email_idx ON users(lower(email));
      CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);
      CREATE INDEX IF NOT EXISTS users_auth_provider_idx ON users(auth_provider);
      CREATE INDEX IF NOT EXISTS users_moodle_user_id_idx ON users(moodle_user_id);

      CREATE TABLE IF NOT EXISTS moodle_platforms (id bigserial PRIMARY KEY, issuer text UNIQUE NOT NULL, client_id text NOT NULL, deployment_id text NOT NULL, auth_login_url text, auth_token_url text, jwks_url text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS moodle_users (id bigserial PRIMARY KEY, platform_id bigint REFERENCES moodle_platforms(id) ON DELETE CASCADE, moodle_user_id text NOT NULL, name text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '', role text NOT NULL DEFAULT 'student', claims jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(platform_id, moodle_user_id));
      CREATE TABLE IF NOT EXISTS moodle_courses (id bigserial PRIMARY KEY, platform_id bigint REFERENCES moodle_platforms(id) ON DELETE CASCADE, lti_context_id text NOT NULL, course_id text NOT NULL, shortname text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '', data jsonb NOT NULL DEFAULT '{}'::jsonb, UNIQUE(platform_id, lti_context_id));
      CREATE TABLE IF NOT EXISTS moodle_groups (id bigserial PRIMARY KEY, course_id bigint REFERENCES moodle_courses(id) ON DELETE CASCADE, moodle_group_id text NOT NULL, name text NOT NULL DEFAULT '', UNIQUE(course_id, moodle_group_id));
      CREATE TABLE IF NOT EXISTS moodle_memberships (id bigserial PRIMARY KEY, moodle_user_id bigint REFERENCES moodle_users(id) ON DELETE CASCADE, course_id bigint REFERENCES moodle_courses(id) ON DELETE CASCADE, group_id bigint REFERENCES moodle_groups(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(moodle_user_id, course_id, group_id));
      CREATE TABLE IF NOT EXISTS lti_launches (id uuid PRIMARY KEY, state text UNIQUE NOT NULL, nonce text NOT NULL, platform_id bigint REFERENCES moodle_platforms(id), moodle_user_id bigint REFERENCES moodle_users(id), course_id bigint REFERENCES moodle_courses(id), id_token_claims jsonb NOT NULL DEFAULT '{}'::jsonb, ags jsonb NOT NULL DEFAULT '{}'::jsonb, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS lti_resource_links (id bigserial PRIMARY KEY, course_id bigint REFERENCES moodle_courses(id) ON DELETE CASCADE, resource_link_id text NOT NULL, title text NOT NULL DEFAULT '', data jsonb NOT NULL DEFAULT '{}'::jsonb, UNIQUE(course_id, resource_link_id));
      CREATE TABLE IF NOT EXISTS lti_grade_items (id bigserial PRIMARY KEY, diagnostic_id text NOT NULL, course_id bigint REFERENCES moodle_courses(id) ON DELETE CASCADE, resource_link_id bigint REFERENCES lti_resource_links(id) ON DELETE SET NULL, lineitem_url text, label text NOT NULL DEFAULT '', score_maximum numeric, UNIQUE(diagnostic_id, course_id));
      CREATE TABLE IF NOT EXISTS lti_grade_results (id bigserial PRIMARY KEY, result_id text NOT NULL, moodle_user_id bigint REFERENCES moodle_users(id), course_id bigint REFERENCES moodle_courses(id), diagnostic_id text NOT NULL, score_given numeric NOT NULL, score_maximum numeric NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, last_error text, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(result_id));
      CREATE TABLE IF NOT EXISTS slide_course_access (slide_id text REFERENCES slides(id) ON DELETE CASCADE, course_id bigint REFERENCES moodle_courses(id) ON DELETE CASCADE, PRIMARY KEY(slide_id, course_id));
      CREATE TABLE IF NOT EXISTS slide_group_access (slide_id text REFERENCES slides(id) ON DELETE CASCADE, group_id bigint REFERENCES moodle_groups(id) ON DELETE CASCADE, PRIMARY KEY(slide_id, group_id));
      CREATE TABLE IF NOT EXISTS diagnostic_course_access (diagnostic_id text REFERENCES diagnostics(id) ON DELETE CASCADE, course_id bigint REFERENCES moodle_courses(id) ON DELETE CASCADE, PRIMARY KEY(diagnostic_id, course_id));
      CREATE TABLE IF NOT EXISTS diagnostic_group_access (diagnostic_id text REFERENCES diagnostics(id) ON DELETE CASCADE, group_id bigint REFERENCES moodle_groups(id) ON DELETE CASCADE, PRIMARY KEY(diagnostic_id, group_id));
      CREATE INDEX IF NOT EXISTS moodle_users_external_idx ON moodle_users(moodle_user_id);
      CREATE INDEX IF NOT EXISTS moodle_courses_context_idx ON moodle_courses(lti_context_id);
      CREATE INDEX IF NOT EXISTS moodle_groups_course_idx ON moodle_groups(course_id);
      CREATE INDEX IF NOT EXISTS lti_resource_links_link_idx ON lti_resource_links(resource_link_id);
      CREATE INDEX IF NOT EXISTS grade_results_result_idx ON lti_grade_results(result_id);
      CREATE INDEX IF NOT EXISTS slides_data_gin_idx
        ON slides USING gin (data);
    `);

    const [slidesCount, diagnosticsCount, resultsCount] = await Promise.all([
      pool.query('SELECT count(*)::int AS count FROM slides'),
      pool.query('SELECT count(*)::int AS count FROM diagnostics'),
      pool.query('SELECT count(*)::int AS count FROM diagnostic_results'),
    ]);

    if (slidesCount.rows[0].count === 0) {
      await upsertJsonItems('slides', await readJsonArrayFile(SLIDES_JSON));
    }

    if (diagnosticsCount.rows[0].count === 0) {
      await upsertJsonItems('diagnostics', await readJsonArrayFile(DIAGNOSTICS_JSON));
    }

    if (resultsCount.rows[0].count === 0) {
      await upsertJsonItems('diagnostic_results', await readJsonArrayFile(DIAGNOSTIC_RESULTS_JSON));
    }

    console.log('PostgreSQL storage is ready');
  } catch (error) {
    console.error('Не удалось подключиться к PostgreSQL.');
    console.error(`DATABASE_URL: ${DATABASE_URL.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@')}`);
    throw error;
  }
}

await initDatabase();
setInterval(runScheduledBackup, BACKUP_INTERVAL_HOURS * 60 * 60 * 1000).unref();

async function countPublicSlideFiles() {
  try {
    const entries = await fs.readdir(PUBLIC_SLIDES_DIR, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.dzi')).length;
  } catch {
    return 0;
  }
}

async function getHealthReport() {
  const startedAt = Date.now();
  const report = {
    ok: true,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    adminAuth: {
      configured: Boolean(ADMIN_PASSWORD),
      sessionSecretConfigured: ADMIN_SESSION_SECRET_CONFIGURED,
      notes: [],
    },
    database: {
      ok: false,
      latencyMs: null,
      counts: {
        slides: 0,
        diagnostics: 0,
        diagnosticResults: 0,
      },
    },
    storage: {
      rawSlidesDir: {
        ok: false,
        path: RAW_SLIDES_DIR,
      },
      publicSlidesDir: {
        ok: false,
        path: PUBLIC_SLIDES_DIR,
      },
      uploadLogDir: {
        ok: false,
        path: UPLOAD_LOG_DIR,
      },
      dziFiles: await countPublicSlideFiles(),
    },
    backups: {
      intervalHours: BACKUP_INTERVAL_HOURS,
      retentionDays: BACKUP_RETENTION_DAYS,
    },
    conversion: {
      vips: {
        ok: false,
        version: null,
      },
      openslide: {
        availableViaVips: false,
        supportedExtensions: [],
      },
      acceptedUploadExtensions: [...ALLOWED_SLIDE_EXTENSIONS],
      worker: {
        mode: 'sequential',
        status: slideWorker?.connected ? 'ready' : 'idle',
        queuedTasks: slideConversionQueue.length,
        activeTaskId: activeSlideConversionTask?.taskId || null,
      },
      notes: [],
    },
  };

  if (ADMIN_PASSWORD && !ADMIN_SESSION_SECRET_CONFIGURED) {
    report.adminAuth.notes.push(
      'ADMIN_SESSION_SECRET не задан. Cookie-сессии администратора будут сбрасываться при каждом перезапуске backend.'
    );
  }

  const [rawSlidesDir, publicSlidesDir, uploadLogDir, vips] = await Promise.all([
    getDirectoryStatus(RAW_SLIDES_DIR),
    getDirectoryStatus(PUBLIC_SLIDES_DIR),
    getDirectoryStatus(UPLOAD_LOG_DIR),
    getCommandVersion('vips'),
  ]);

  report.storage.rawSlidesDir = rawSlidesDir;
  report.storage.publicSlidesDir = publicSlidesDir;
  report.storage.uploadLogDir = uploadLogDir;
  report.conversion.vips = vips;

  if (!rawSlidesDir.ok || !publicSlidesDir.ok || !uploadLogDir.ok || !vips.ok) {
    report.ok = false;
  }

  if (vips.ok) {
    try {
      const { stdout } = await execFileAsync('vips', ['list', 'classes']);
      const openslideAvailable = stdout.includes('VipsForeignLoadOpenslide');
      report.conversion.openslide.availableViaVips = openslideAvailable;
      report.conversion.openslide.supportedExtensions = openslideAvailable
        ? OPENSLIDE_SLIDE_EXTENSIONS
        : [];

      if (!openslideAvailable) {
        report.ok = false;
        report.conversion.notes.push(
          'libvips установлен, но загрузчик OpenSlide недоступен. SVS/NDPI/SCN/MRXS могут не конвертироваться.'
        );
      }
    } catch (error) {
      report.ok = false;
      report.conversion.openslide.error = error.message;
    }
  }

  if (!report.conversion.openslide.supportedExtensions.includes('.kfb')) {
    report.conversion.notes.push(
      'KFB принят формой загрузки, но текущий libvips/OpenSlide обычно не читает KFB напрямую. Используйте экспорт в DZI/TIFF/SVS или отдельный KFB-конвертер.'
    );
  }

  try {
    const dbStartedAt = Date.now();
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM slides) AS slides,
        (SELECT count(*)::int FROM diagnostics) AS diagnostics,
        (SELECT count(*)::int FROM diagnostic_results) AS diagnostic_results
    `);

    report.database.ok = true;
    report.database.latencyMs = Date.now() - dbStartedAt;
    report.database.counts = {
      slides: rows[0]?.slides || 0,
      diagnostics: rows[0]?.diagnostics || 0,
      diagnosticResults: rows[0]?.diagnostic_results || 0,
    };
  } catch (error) {
    report.ok = false;
    report.database.error = error.message;
  }

  report.latencyMs = Date.now() - startedAt;
  return report;
}

function slugify(value) {
  const cyrillicMap = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e',
    ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
    ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };

  return String(value || '')
    .trim()
    .toLowerCase()
    .split('')
    .map((char) => cyrillicMap[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function requireTextField(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`Не заполнено поле: ${fieldName}`);
  return text;
}

function normalizeSlideData(slide, { strict = false } = {}) {
  const title = strict
    ? requireTextField(slide.title, 'Название')
    : String(slide.title || 'Без названия').trim();
  const lesson = strict
    ? requireTextField(slide.lesson, 'Занятие')
    : String(slide.lesson || 'Без занятия').trim();
  const system = strict
    ? requireTextField(slide.system, 'Раздел / система')
    : String(slide.system || 'Без раздела').trim();
  const organ = strict
    ? requireTextField(slide.organ, 'Орган')
    : String(slide.organ || 'Не указан').trim();
  const stain = strict
    ? requireTextField(slide.stain, 'Окраска')
    : String(slide.stain || 'Не указана').trim();
  const source = strict
    ? requireTextField(slide.source, 'DZI-адрес или файл препарата')
    : String(slide.source || '').trim();

  return {
    ...slide,
    title,
    lesson,
    system,
    organ,
    stain,
    source,
    description: String(slide.description || '').trim(),
    diagnosticSigns: parseDiagnosticSigns(slide.diagnosticSigns),
    selfCheckQuestions: parseSelfCheckQuestions(slide.selfCheckQuestions),
    visibleForStudents: slide.visibleForStudents !== false,
    visibleForResidents: slide.visibleForResidents !== false,
    anonymizeForResidents: slide.anonymizeForResidents !== false,
    courseIds: Array.isArray(slide.courseIds) ? slide.courseIds : [],
    groupIds: Array.isArray(slide.groupIds) ? slide.groupIds : [],
  };
}

async function syncAccessLinks(table, entityColumn, entityId, ids) {
  const safeIds = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
  await pool.query(`DELETE FROM ${table} WHERE ${entityColumn}=$1`, [entityId]);
  for (const id of safeIds) await pool.query(`INSERT INTO ${table} (${entityColumn}, ${table.includes('_group_') ? 'group_id' : 'course_id'}) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [entityId, id]);
}
async function syncSlideAccess(slide) {
  await syncAccessLinks('slide_course_access', 'slide_id', slide.id, slide.courseIds);
  await syncAccessLinks('slide_group_access', 'slide_id', slide.id, slide.groupIds);
}
async function syncDiagnosticAccess(diagnostic) {
  await syncAccessLinks('diagnostic_course_access', 'diagnostic_id', diagnostic.id, diagnostic.courseIds);
  await syncAccessLinks('diagnostic_group_access', 'diagnostic_id', diagnostic.id, diagnostic.groupIds);
}

async function readSlides() {
  return (await readJsonItems('slides')).map((slide) => normalizeSlideData(slide));
}

async function writeSlides(slides) {
  await replaceJsonItems('slides', slides.map((slide) => normalizeSlideData(slide)));
}

async function readJsonArray(filePath) {
  return readJsonItems(getJsonStore(filePath));
}

async function writeJsonArray(filePath, data) {
  await replaceJsonItems(getJsonStore(filePath), data);
}

function parseDiagnosticSigns(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeDiagnosticSign).filter(Boolean);
  }

  const rawValue = String(value || '').trim();

  if (rawValue.startsWith('[')) {
    try {
      const parsed = JSON.parse(rawValue);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeDiagnosticSign).filter(Boolean);
      }
    } catch {
      // Fall through to the legacy newline format.
    }
  }

  return rawValue
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((text) => ({ text, marker: null }));
}

function parseSelfCheckQuestions(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDiagnosticSign(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? { text, marker: null } : null;
  }

  const text = String(value?.text || '').trim();
  if (!text) return null;

  return {
    text,
    marker: normalizeSlideMarker(value?.marker),
  };
}

function normalizeSlideMarker(marker) {
  if (!marker || typeof marker !== 'object') return null;

  const type = marker.type === 'arrow' ? 'arrow' : 'rect';

  if (type === 'arrow') {
    return {
      type,
      x1: clampPercent(marker.x1),
      y1: clampPercent(marker.y1),
      x2: clampPercent(marker.x2 ?? marker.x1),
      y2: clampPercent(marker.y2 ?? marker.y1),
    };
  }

  return {
    type,
    ...sanitizeHighlight(marker),
  };
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function parseYekaterinburgDateTime(value) {
  const match = String(value || '').trim().match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
  );

  if (!match) return null;

  const [, year, month, day, hour, minute, second = '0', millisecond = '0'] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: Number(millisecond.padEnd(3, '0')),
  };
  const localAsUtcTimestamp = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond
  );
  const localAsUtcDate = new Date(localAsUtcTimestamp);

  if (
    localAsUtcDate.getUTCFullYear() !== parts.year ||
    localAsUtcDate.getUTCMonth() !== parts.month - 1 ||
    localAsUtcDate.getUTCDate() !== parts.day ||
    localAsUtcDate.getUTCHours() !== parts.hour ||
    localAsUtcDate.getUTCMinutes() !== parts.minute ||
    localAsUtcDate.getUTCSeconds() !== parts.second
  ) {
    return '';
  }

  return new Date(
    localAsUtcTimestamp - DIAGNOSTIC_TIME_ZONE_OFFSET_MINUTES * 60 * 1000
  ).toISOString();
}

function parseDateValue(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) return '';

  const yekaterinburgDate = parseYekaterinburgDateTime(rawValue);
  if (yekaterinburgDate !== null) return yekaterinburgDate;

  const date = new Date(rawValue);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function getDiagnosticStatus(diagnostic, now = new Date()) {
  const startsAt = diagnostic.startsAt ? new Date(diagnostic.startsAt) : null;
  const endsAt = diagnostic.endsAt ? new Date(diagnostic.endsAt) : null;

  if (startsAt && now < startsAt) return 'scheduled';
  if (endsAt && now > endsAt) return 'closed';
  return diagnostic.isPublished === false ? 'draft' : 'open';
}

function sanitizeHighlight(value = {}) {
  const numberOrZero = (item) => {
    const number = Number(item);
    return Number.isFinite(number) ? number : 0;
  };

  const x = Math.max(0, Math.min(100, numberOrZero(value.x)));
  const y = Math.max(0, Math.min(100, numberOrZero(value.y)));
  const width = Math.max(1, Math.min(100 - x, numberOrZero(value.width) || 12));
  const height = Math.max(1, Math.min(100 - y, numberOrZero(value.height) || 12));

  return { x, y, width, height };
}

function createStableId(prefix = 'id') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeQuestionOptions(question, type) {
  const sourceOptions = Array.isArray(question.answer?.options)
    ? question.answer.options
    : Array.isArray(question.options)
      ? question.options
      : [];

  return sourceOptions
    .map((option, index) => {
      const text = typeof option === 'string' ? option : option?.text;
      const fallbackCorrect =
        type === 'multiple'
          ? Array.isArray(question.correctIndices) && question.correctIndices.includes(index)
          : Number(question.correctIndex) === index;

      return {
        id: typeof option === 'string' ? `opt-${index}` : option?.id || `opt-${index}`,
        text: String(text || '').trim(),
        isCorrect: Boolean(typeof option === 'string' ? fallbackCorrect : option?.isCorrect),
      };
    })
    .filter((option) => option.text);
}

function normalizeAnswerItems(items, prefix) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({
      id: item?.id || `${prefix}-${index}`,
      text: String(item?.text || item || '').trim(),
    }))
    .filter((item) => item.text);
}

function normalizeMatchingPairs(question) {
  const sourcePairs = Array.isArray(question.answer?.pairs) ? question.answer.pairs : [];

  return sourcePairs
    .map((pair, index) => ({
      id: pair?.id || `pair-${index}`,
      left: String(pair?.left || '').trim(),
      right: String(pair?.right || '').trim(),
    }))
    .filter((pair) => pair.left && pair.right);
}

function parseAcceptedTexts(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }

  return String(value || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalNumber(value) {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) return NaN;

  const number = Number(rawValue);
  return Number.isFinite(number) ? number : NaN;
}

function sanitizeDiagnosticQuestion(question, index) {
  const allowedTypes = new Set([
    'single',
    'multiple',
    'text',
    'number',
    'matching',
    'ordering',
    'region',
    'combined',
  ]);
  const type = allowedTypes.has(question.answer?.type)
    ? question.answer.type
    : allowedTypes.has(question.type)
      ? question.type
      : 'single';
  const options = normalizeQuestionOptions(question, type);
  const correctOptionIds = options
    .filter((option) => option.isCorrect)
    .map((option) => option.id);
  const correctIndex = Math.max(0, options.findIndex((option) => option.isCorrect));
  const correctIndices = options
    .map((option, optionIndex) => (option.isCorrect ? optionIndex : null))
    .filter((optionIndex) => optionIndex !== null);
  const correctText = String(question.answer?.correctText || question.correctText || '').trim();
  const acceptedTexts = parseAcceptedTexts(question.answer?.acceptedTexts || question.acceptedTexts || correctText);
  const numeric = {
    correctValue: parseOptionalNumber(question.answer?.numeric?.correctValue ?? question.correctNumber),
    tolerance: Number(question.answer?.numeric?.tolerance ?? question.tolerance ?? 0),
    min: parseOptionalNumber(question.answer?.numeric?.min ?? question.numberMin),
    max: parseOptionalNumber(question.answer?.numeric?.max ?? question.numberMax),
  };
  const pairs = normalizeMatchingPairs(question);
  const orderingItems = normalizeAnswerItems(question.answer?.items || question.orderingItems, 'item');
  const regions = Array.isArray(question.regions)
    ? question.regions.map((item) => ({
        enabled: item?.enabled !== false,
        ...normalizeSlideMarker(item),
      }))
    : [
        {
          enabled: (question.region || question.highlight)?.enabled !== false,
          ...normalizeSlideMarker(question.region || question.highlight || {
            type: 'rect',
            x: 35,
            y: 35,
            width: 20,
            height: 18,
          }),
        },
      ];
  const region = regions[0] || null;
  const points = Number(question.grading?.points);

  return {
    id: question.id || createStableId(`q-${index}`),
    type,
    slideId: String(question.slideId || '').trim(),
    prompt: String(question.prompt || '').trim(),
    answer: {
      type,
      shuffle: question.answer?.shuffle !== false,
      options,
      correctOptionIds:
        type === 'multiple'
          ? correctOptionIds
          : correctOptionIds.slice(0, 1),
      correctText,
      acceptedTexts,
      numeric,
      pairs,
      items: orderingItems,
    },
    grading: {
      mode: question.grading?.mode || 'auto',
      points: Number.isFinite(points) && points > 0 ? points : 1,
      partialCredit: Boolean(question.grading?.partialCredit),
      regionMode: question.grading?.regionMode || 'intersection',
      regionThreshold: Number(question.grading?.regionThreshold || 70),
    },
    region,
    regions,
    options: options.map((option) => option.text),
    correctIndex,
    correctIndices: type === 'multiple' ? correctIndices : [correctIndex],
    correctText,
    highlight: region,
  };
}

function shuffleArray(items) {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }

  return result;
}

async function buildDiagnosticPayload(rawDiagnostic, { includeAnswers = false } = {}) {
  const slides = await readSlides();
  const slideById = new Map(slides.map((slide) => [slide.id, slide]));
  const questions = Array.isArray(rawDiagnostic.questions)
    ? rawDiagnostic.questions
        .map((question) => {
          const slide = slideById.get(question.slideId);
          const normalizedQuestion = sanitizeDiagnosticQuestion(question, 0);
          const answerOptions =
            normalizedQuestion.answer.type === 'text'
              ? []
              : normalizedQuestion.answer.shuffle
                ? shuffleArray(normalizedQuestion.answer.options)
                : normalizedQuestion.answer.options;

          return {
            id: normalizedQuestion.id,
            type: normalizedQuestion.answer.type,
            slideId: normalizedQuestion.slideId,
            prompt: normalizedQuestion.prompt,
            answer: {
              type: normalizedQuestion.answer.type,
              shuffle: normalizedQuestion.answer.shuffle,
              options: answerOptions.map((option) => ({
                id: option.id,
                text: option.text,
              })),
              pairs:
                normalizedQuestion.answer.type === 'matching'
                  ? {
                      left: normalizedQuestion.answer.pairs.map((pair) => ({
                        id: pair.id,
                        text: pair.left,
                      })),
                      right: shuffleArray(normalizedQuestion.answer.pairs).map((pair) => ({
                        id: pair.id,
                        text: pair.right,
                      })),
                    }
                  : null,
              items:
                normalizedQuestion.answer.type === 'ordering'
                  ? shuffleArray(normalizedQuestion.answer.items).map((item) => ({
                      id: item.id,
                      text: item.text,
                    }))
                  : [],
              numeric:
                normalizedQuestion.answer.type === 'number'
                  ? {
                      hasRange:
                        Number.isFinite(normalizedQuestion.answer.numeric.min) &&
                        Number.isFinite(normalizedQuestion.answer.numeric.max),
                    }
                  : null,
            },
            grading: normalizedQuestion.grading,
            region: includeAnswers ? normalizedQuestion.region : null,
            regions: includeAnswers ? normalizedQuestion.regions : [],
            options: answerOptions.map((option) => option.text),
            optionIds: answerOptions.map((option) => option.id),
            highlight: normalizedQuestion.answer.type === 'region'
              ? getQuestionVisibleMarker(normalizedQuestion)
              : getQuestionVisibleMarker(normalizedQuestion) || normalizedQuestion.region,
            slide: slide
              ? {
                  id: slide.id,
                  title: slide.title,
                  source: slide.source,
                  organ: slide.organ,
                  stain: slide.stain,
                }
              : null,
            ...(includeAnswers
              ? {
                  correctIndex: normalizedQuestion.correctIndex,
                  correctIndices: normalizedQuestion.correctIndices,
                  correctText: normalizedQuestion.correctText,
                  correctOptionIds: normalizedQuestion.answer.correctOptionIds,
                  acceptedTexts: normalizedQuestion.answer.acceptedTexts,
                  numeric: normalizedQuestion.answer.numeric,
                  pairs: normalizedQuestion.answer.pairs,
                  items: normalizedQuestion.answer.items,
                }
              : {}),
          };
        })
        .filter((question) => {
          if (!question.slide || !question.prompt) return false;
          if (['single', 'multiple', 'combined'].includes(question.type)) {
            return question.options.length > 0;
          }
          return true;
        })
    : [];

  return {
    id: rawDiagnostic.id,
    title: rawDiagnostic.title,
    startsAt: rawDiagnostic.startsAt,
    endsAt: rawDiagnostic.endsAt,
    durationMinutes: Number(rawDiagnostic.durationMinutes || 0),
    isPublished: rawDiagnostic.isPublished !== false,
    createdAt: rawDiagnostic.createdAt,
    updatedAt: rawDiagnostic.updatedAt,
    status: getDiagnosticStatus(rawDiagnostic),
    questions,
  };
}

function sanitizeDiagnosticPayload(payload, existingDiagnostic = null) {
  const title = String(payload.title || '').trim();
  const diagnosticId = slugify(payload.id || existingDiagnostic?.id || title);
  const durationMinutes = Number(payload.durationMinutes);

  if (!diagnosticId) {
    throw new Error('Не удалось создать ID диагностики');
  }

  if (!title) {
    throw new Error('Не указано название диагностики');
  }

  const questions = Array.isArray(payload.questions)
    ? payload.questions.map(sanitizeDiagnosticQuestion)
    : [];

  if (questions.length === 0) {
    throw new Error('Добавьте хотя бы один вопрос');
  }

  questions.forEach((question, index) => {
    if (!question.slideId) {
      throw new Error(`В вопросе ${index + 1} не выбран препарат`);
    }

    if (!question.prompt) {
      throw new Error(`В вопросе ${index + 1} не указан вопрос`);
    }

    if (['single', 'multiple', 'combined'].includes(question.type) && question.options.length < 2) {
      throw new Error(`В вопросе ${index + 1} должно быть минимум два варианта ответа`);
    }

    if (
      question.type === 'single' &&
      (question.correctIndex < 0 || question.correctIndex >= question.options.length)
    ) {
      throw new Error(`В вопросе ${index + 1} неверно выбран правильный ответ`);
    }

    if (question.type === 'multiple' && question.correctIndices.length === 0) {
      throw new Error(`В вопросе ${index + 1} выберите минимум один правильный ответ`);
    }

    if (['text', 'combined'].includes(question.type) && question.grading.mode !== 'manual' && !question.correctText) {
      throw new Error(`В вопросе ${index + 1} укажите правильный открытый ответ`);
    }

    if (question.type === 'number') {
      const hasExact = Number.isFinite(question.answer.numeric.correctValue);
      const hasRange = Number.isFinite(question.answer.numeric.min) && Number.isFinite(question.answer.numeric.max);

      if (question.grading.mode !== 'manual' && !hasExact && !hasRange) {
        throw new Error(`В вопросе ${index + 1} укажите числовой ответ или диапазон`);
      }
    }

    if (question.type === 'matching' && question.answer.pairs.length < 2) {
      throw new Error(`В вопросе ${index + 1} добавьте минимум две пары для сопоставления`);
    }

    if (question.type === 'ordering' && question.answer.items.length < 2) {
      throw new Error(`В вопросе ${index + 1} добавьте минимум два элемента для упорядочивания`);
    }
  });

  return {
    id: diagnosticId,
    title,
    startsAt: parseDateValue(payload.startsAt),
    endsAt: parseDateValue(payload.endsAt),
    durationMinutes:
      Number.isFinite(durationMinutes) && durationMinutes > 0
        ? Math.round(durationMinutes)
        : 0,
    isPublished: payload.isPublished !== false,
    courseIds: Array.isArray(payload.courseIds) ? payload.courseIds : (existingDiagnostic?.courseIds || []),
    groupIds: Array.isArray(payload.groupIds) ? payload.groupIds : (existingDiagnostic?.groupIds || []),
    resourceLinkId: String(payload.resourceLinkId || existingDiagnostic?.resourceLinkId || ''),
    createdBy: existingDiagnostic?.createdBy || '',
    questions,
    createdAt: existingDiagnostic?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function escapeCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeParticipantValue(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function getQuestionVisibleMarker(question) {
  const markers = Array.isArray(question.regions)
    ? question.regions
    : [question.region];

  return markers.find((marker) => marker?.type === 'arrow') || null;
}

async function validateDiagnosticForPublication(diagnostic) {
  if (diagnostic.isPublished === false) return;

  const slides = await readSlides();
  const slideById = new Map(slides.map((slide) => [slide.id, slide]));
  const errors = [];

  if (!diagnostic.questions.length) {
    errors.push('Добавьте хотя бы один вопрос');
  }

  diagnostic.questions.forEach((question, index) => {
    const number = index + 1;
    const correctOptionCount = Array.isArray(question.answer?.correctOptionIds)
      ? question.answer.correctOptionIds.length
      : 0;

    if (!question.prompt) {
      errors.push(`Вопрос ${number}: не указан текст вопроса`);
    }

    if (!question.slideId || !slideById.has(question.slideId)) {
      errors.push(`Вопрос ${number}: выбранный препарат недоступен`);
    }

    if (['single', 'multiple', 'combined'].includes(question.type) && question.options.length < 2) {
      errors.push(`Вопрос ${number}: нужно минимум два варианта ответа`);
    }

    if (['single', 'combined'].includes(question.type) && correctOptionCount !== 1) {
      errors.push(`Вопрос ${number}: выберите один правильный вариант ответа`);
    }

    if (question.type === 'multiple' && correctOptionCount === 0) {
      errors.push(`Вопрос ${number}: выберите минимум один правильный вариант ответа`);
    }

    if (['text', 'combined'].includes(question.type) && question.grading.mode !== 'manual' && !question.correctText) {
      errors.push(`Вопрос ${number}: укажите правильный открытый ответ`);
    }

    if (question.type === 'number' && question.grading.mode !== 'manual') {
      const hasExact = Number.isFinite(question.answer?.numeric?.correctValue);
      const hasRange =
        Number.isFinite(question.answer?.numeric?.min) &&
        Number.isFinite(question.answer?.numeric?.max);

      if (!hasExact && !hasRange) {
        errors.push(`Вопрос ${number}: укажите числовой ответ или диапазон`);
      }

      if (hasRange && question.answer.numeric.min > question.answer.numeric.max) {
        errors.push(`Вопрос ${number}: нижняя граница диапазона больше верхней`);
      }
    }

    if (question.type === 'matching' && question.answer.pairs.length < 2) {
      errors.push(`Вопрос ${number}: добавьте минимум две пары для сопоставления`);
    }

    if (question.type === 'ordering' && question.answer.items.length < 2) {
      errors.push(`Вопрос ${number}: добавьте минимум два элемента для упорядочивания`);
    }

    if (
      question.type === 'region' &&
      (!Array.isArray(question.regions) ||
        question.regions.filter((region) => region?.type !== 'arrow' && region?.enabled !== false).length === 0)
    ) {
      errors.push(`Вопрос ${number}: добавьте хотя бы одну правильную область`);
    }
  });

  if (errors.length > 0) {
    throw new Error(`Диагностику нельзя опубликовать: ${errors.join('; ')}`);
  }
}

function formatAnswerForReport(answer) {
  if (!answer) return 'Нет ответа';
  if (answer.type === 'text') return answer.textAnswer || 'Нет ответа';
  if (answer.type === 'number') return answer.numberAnswer ?? 'Нет ответа';
  if (answer.type === 'matching') {
    return Object.entries(answer.selectedPairs || {})
      .map(([left, right]) => `${left} → ${right}`)
      .join('; ') || 'Нет ответа';
  }
  if (answer.type === 'ordering') {
    return (answer.orderedItemIds || []).join(' → ') || 'Нет ответа';
  }
  if (answer.type === 'region') {
    return answer.selectedRegion
      ? `x=${answer.selectedRegion.x}; y=${answer.selectedRegion.y}; w=${answer.selectedRegion.width}; h=${answer.selectedRegion.height}`
      : 'Нет ответа';
  }
  return (answer.selectedOptions || []).join('; ') || answer.selectedOption || 'Нет ответа';
}

function buildDetailedReportHtml(diagnostic, results) {
  const questionById = new Map((diagnostic.questions || []).map((question, index) => [
    question.id,
    {
      ...question,
      displayNumber: index + 1,
    },
  ]));
  const rows = results.map((result) => {
    const answers = Array.isArray(result.answers) ? result.answers : [];
    const answersHtml = answers.map((answer) => {
      const question = questionById.get(answer.questionId);
      return `
        <tr>
          <td>${escapeHtml(question ? `${question.displayNumber}. ${question.prompt}` : answer.questionId)}</td>
          <td>${escapeHtml(answer.type)}</td>
          <td>${escapeHtml(formatAnswerForReport(answer))}</td>
          <td>${escapeHtml(answer.correctOptions?.join('; ') || answer.correctText || answer.correctOption || '')}</td>
          <td>${escapeHtml(`${answer.earnedPoints ?? 0} / ${answer.points ?? 0}`)}</td>
          <td>${escapeHtml(answer.reviewComment || '')}</td>
        </tr>
      `;
    }).join('');

    return `
      <section class="student">
        <h2>${escapeHtml(result.studentName)} <small>${escapeHtml(result.group)}</small></h2>
        <p>Сдано: ${escapeHtml(result.submittedAt)} · Баллы: <strong>${escapeHtml(result.score)} из ${escapeHtml(result.total)}</strong> (${escapeHtml(result.percent)}%)</p>
        ${result.reviewComment ? `<p class="comment">${escapeHtml(result.reviewComment)}</p>` : ''}
        <table>
          <thead>
            <tr>
              <th>Вопрос</th>
              <th>Тип</th>
              <th>Ответ студента</th>
              <th>Правильный ответ</th>
              <th>Баллы</th>
              <th>Комментарий</th>
            </tr>
          </thead>
          <tbody>${answersHtml}</tbody>
        </table>
      </section>
    `;
  }).join('');

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(diagnostic.title)} - подробный отчет</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111827; margin: 24px; }
    h1 { margin-bottom: 4px; }
    .student { page-break-inside: avoid; margin-top: 28px; }
    small { color: #6b7280; font-weight: 400; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; }
    .comment { padding: 10px; background: #f9fafb; border: 1px solid #e5e7eb; }
  </style>
</head>
<body>
  <h1>${escapeHtml(diagnostic.title)}</h1>
  <p>Подробный отчет по студентам. Результатов: ${results.length}</p>
  ${rows || '<p>Результатов пока нет.</p>'}
</body>
</html>`;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeIfExists(filePath) {
  if (await pathExists(filePath)) {
    await fs.rm(filePath, { recursive: true, force: true });
  }
}

async function getCommandVersion(command, args = ['--version']) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args);
    return {
      ok: true,
      version: String(stdout || stderr).trim().split('\n')[0] || null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.code === 'ENOENT'
        ? `Команда ${command} не найдена`
        : error.message,
    };
  }
}

async function getDirectoryStatus(directoryPath) {
  try {
    await fs.access(directoryPath, fsConstants.R_OK | fsConstants.W_OK);

    return {
      ok: true,
      path: directoryPath,
      readable: true,
      writable: true,
    };
  } catch (error) {
    return {
      ok: false,
      path: directoryPath,
      readable: false,
      writable: false,
      error: error.message,
    };
  }
}

async function findFileByExtension(directoryPath, extension) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
      return entryPath;
    }

    if (entry.isDirectory()) {
      const found = await findFileByExtension(entryPath, extension);
      if (found) return found;
    }
  }

  return null;
}

async function findAllFilesByExtension(directoryPath, extension) {
  const result = [];
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
      result.push(entryPath);
    }

    if (entry.isDirectory()) {
      const nested = await findAllFilesByExtension(entryPath, extension);
      result.push(...nested);
    }
  }

  return result;
}

function safeZipExtract(zipPath, outputDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const outputRoot = path.resolve(outputDir);

  for (const entry of entries) {
    const targetPath = path.resolve(outputDir, entry.entryName);

    if (!targetPath.startsWith(outputRoot)) {
      throw new Error('ZIP-архив содержит небезопасные пути');
    }

    zip.extractEntryTo(entry, outputDir, true, true);
  }
}

function getDziTilesFolderName(dziContent) {
  const match = dziContent.match(/Url=["']([^"']+)["']/i);
  if (!match) return null;

  return match[1].replace(/\/$/, '');
}

async function validateDziFileAndTiles(dziPath, tilesPath) {
  const dziContent = await fs.readFile(dziPath, 'utf8');
  const imageMatch = dziContent.match(/<Image\b[^>]*\bTileSize=["'](\d+)["'][^>]*\bFormat=["']([a-z0-9]+)["'][^>]*>/i);
  const sizeMatch = dziContent.match(/<Size\b[^>]*\bWidth=["'](\d+)["'][^>]*\bHeight=["'](\d+)["'][^>]*\/?\s*>/i);

  if (!imageMatch || !sizeMatch || Number(imageMatch[1]) < 1 || Number(sizeMatch[1]) < 1 || Number(sizeMatch[2]) < 1) {
    throw new Error('DZI-файл не содержит корректную структуру Deep Zoom');
  }

  if (!(await pathExists(tilesPath))) {
    throw new Error(`Папка тайлов отсутствует: ${path.basename(tilesPath)}`);
  }

  const tilePath =
    await findFileByExtension(tilesPath, '.jpeg') ||
    await findFileByExtension(tilesPath, '.jpg') ||
    await findFileByExtension(tilesPath, '.png') ||
    await findFileByExtension(tilesPath, '.webp');

  if (!tilePath) {
    throw new Error('Папка DZI не содержит тайлов JPEG, PNG или WebP');
  }
}

async function copyDirectory(sourceDir, targetDir) {
  await removeIfExists(targetDir);
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });
}

async function prepareDziFromDirectory(directoryPath, slideId) {
  const dziFiles = await findAllFilesByExtension(directoryPath, '.dzi');

  if (dziFiles.length === 0) {
    throw new Error('В ZIP-архиве не найден файл .dzi');
  }

  const sourceDziPath = dziFiles[0];
  const dziDir = path.dirname(sourceDziPath);
  let dziContent = await fs.readFile(sourceDziPath, 'utf8');

  const originalTilesFolderName =
    getDziTilesFolderName(dziContent) ||
    `${path.basename(sourceDziPath, '.dzi')}_files`;

  const sourceTilesDir = path.join(dziDir, originalTilesFolderName);

  await validateDziFileAndTiles(sourceDziPath, sourceTilesDir);

  const targetDziPath = path.join(PUBLIC_SLIDES_DIR, `${slideId}.dzi`);
  const targetTilesDir = path.join(PUBLIC_SLIDES_DIR, `${slideId}_files`);

  await removeIfExists(targetDziPath);
  await removeIfExists(targetTilesDir);

  dziContent = dziContent.replace(
    /Url=["'][^"']+["']/i,
    `Url="${slideId}_files/"`
  );

  await fs.writeFile(targetDziPath, dziContent, 'utf8');
  await copyDirectory(sourceTilesDir, targetTilesDir);

  return `/slides/${slideId}.dzi`;
}

async function prepareSlideFile(uploadedFile, slideId) {
  const originalExt = path
    .extname(uploadedFile.originalname || '')
    .toLowerCase();

  if (!ALLOWED_SLIDE_EXTENSIONS.has(originalExt)) {
    await fs.unlink(uploadedFile.path);

    throw new Error(
      'Неподдерживаемый формат файла. Разрешены: .svs, .tif, .tiff, .ndpi, .scn, .kfb, .mrxs, .zip'
    );
  }

  if (originalExt === '.zip') {
    const extractDir = path.join(RAW_SLIDES_DIR, slideId);

    await removeIfExists(extractDir);
    await fs.mkdir(extractDir, { recursive: true });

    safeZipExtract(uploadedFile.path, extractDir);
    await fs.unlink(uploadedFile.path);

    const mrxsPath = await findFileByExtension(extractDir, '.mrxs');

    if (mrxsPath) {
      return {
        type: 'convert',
        inputPath: mrxsPath,
      };
    }

    const dziPath = await findFileByExtension(extractDir, '.dzi');

    if (dziPath) {
      const source = await prepareDziFromDirectory(extractDir, slideId);
      await removeIfExists(extractDir);

      return {
        type: 'ready-dzi',
        source,
      };
    }

    await removeIfExists(extractDir);

    throw new Error(
      'В ZIP-архиве не найден ни .mrxs, ни .dzi. Для MRXS загрузите архив с .mrxs и папкой данных. Для готовых тайлов загрузите архив с .dzi и папкой *_files.'
    );
  }

  const savedRawPath = path.join(RAW_SLIDES_DIR, `${slideId}${originalExt}`);
  await fs.rename(uploadedFile.path, savedRawPath);

  return {
    type: 'convert',
    inputPath: savedRawPath,
  };
}

async function countDirectoryFiles(directoryPath, limit = 5000) {
  if (limit <= 0) {
    return { count: 0, capped: true };
  }

  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    let count = 0;
    let capped = false;

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isFile()) {
        count += 1;
      } else if (entry.isDirectory()) {
        const nested = await countDirectoryFiles(entryPath, limit - count);
        count += nested.count;
        capped = capped || nested.capped;
      }

      if (count >= limit) {
        capped = true;
        break;
      }
    }

    return { count, capped };
  } catch {
    return { count: 0, capped: false };
  }
}

function getPublicSlidePath(source) {
  const normalizedSource = String(source || '').trim();

  if (!normalizedSource.startsWith('/slides/')) return null;
  if (normalizedSource.includes('..')) return null;

  return path.join(PUBLIC_SLIDES_DIR, normalizedSource.replace(/^\/slides\//, ''));
}

async function getSlideFileStatus(slide) {
  const source = String(slide?.source || '').trim();

  if (!source) {
    return {
      status: 'missing',
      label: 'Нет источника',
      details: 'У препарата не указан DZI-адрес или файл.',
      previewable: false,
    };
  }

  if (!source.endsWith('.dzi')) {
    return {
      status: 'external',
      label: 'Внешний источник',
      details: 'Источник не является DZI-файлом в локальном хранилище.',
      previewable: true,
    };
  }

  const dziPath = getPublicSlidePath(source);

  if (!dziPath) {
    return {
      status: 'external',
      label: 'Внешний DZI',
      details: 'DZI-адрес находится вне локальной папки /slides.',
      previewable: true,
    };
  }

  if (!(await pathExists(dziPath))) {
    return {
      status: 'missing',
      label: 'DZI не найден',
      details: `Файл отсутствует: ${source}`,
      previewable: false,
    };
  }

  try {
    const dziContent = await fs.readFile(dziPath, 'utf8');
    const tilesFolderName =
      getDziTilesFolderName(dziContent) ||
      `${path.basename(dziPath, '.dzi')}_files`;
    const tilesPath = path.join(path.dirname(dziPath), tilesFolderName);
    const dziStats = await fs.stat(dziPath);

    if (!/<Image\b/i.test(dziContent) || !/<Size\b/i.test(dziContent)) {
      return {
        status: 'invalid',
        label: 'DZI поврежден',
        details: 'DZI-файл не содержит корректную структуру Deep Zoom.',
        previewable: false,
        sizeBytes: dziStats.size,
      };
    }

    if (!(await pathExists(tilesPath))) {
      return {
        status: 'missing',
        label: 'Тайлы не найдены',
        details: `Папка тайлов отсутствует: ${path.basename(tilesPath)}`,
        previewable: false,
        sizeBytes: dziStats.size,
      };
    }

    const tileStats = await countDirectoryFiles(tilesPath);

    if (tileStats.count === 0) {
      return {
        status: 'invalid',
        label: 'Нет тайлов',
        details: `Папка тайлов пуста: ${path.basename(tilesPath)}`,
        previewable: false,
        sizeBytes: dziStats.size,
        tileCount: tileStats.count,
      };
    }

    return {
      status: 'ready',
      label: 'Готов',
      details: `DZI и тайлы найдены: ${tileStats.count}${tileStats.capped ? '+' : ''} файлов`,
      previewable: true,
      sizeBytes: dziStats.size,
      tileCount: tileStats.count,
      tileCountCapped: tileStats.capped,
    };
  } catch (error) {
    return {
      status: 'invalid',
      label: 'Ошибка проверки',
      details: error.message,
      previewable: false,
    };
  }
}

async function withSlideAdminMetadata(slides) {
  return Promise.all(
    slides.map(async (slide) => ({
      ...slide,
      fileStatus: await getSlideFileStatus(slide),
    }))
  );
}

function getFriendlyConversionError(inputPath, error) {
  const ext = path.extname(inputPath).toLowerCase();
  const details = String(error?.stderr || error?.message || '');

  if (error?.code === 'ENOENT') {
    return new Error(
      'На сервере не найдена команда vips. Установите libvips для конвертации препаратов в DZI.',
      { cause: error }
    );
  }

  if (ext === '.kfb' && details.includes('not a known file format')) {
    return new Error(
      'KFB-файл принят, но текущая сборка libvips/OpenSlide на сервере не умеет читать KFB. Экспортируйте препарат в TIFF/SVS/DZI или установите серверный KFB-конвертер.',
      { cause: error }
    );
  }

  if (details.includes('not a known file format')) {
    return new Error(
      'Файл принят, но libvips не смог распознать его формат. Проверьте, что файл не поврежден и что сервер поддерживает этот тип препарата.',
      { cause: error }
    );
  }

  return error;
}

async function convertSlideToDzi(inputPath, slideId, onProgress) {
  try {
    return await convertSlideToDziInWorker(inputPath, slideId, onProgress);
  } catch (error) {
    throw getFriendlyConversionError(inputPath, error);
  }
}

async function deleteSlideFiles(slideId) {
  await removeIfExists(path.join(PUBLIC_SLIDES_DIR, `${slideId}.dzi`));
  await removeIfExists(path.join(PUBLIC_SLIDES_DIR, `${slideId}_files`));

  for (const ext of ALLOWED_SLIDE_EXTENSIONS) {
    await removeIfExists(path.join(RAW_SLIDES_DIR, `${slideId}${ext}`));
  }

  await removeIfExists(path.join(RAW_SLIDES_DIR, slideId));
  await removeIfExists(path.join(RAW_SLIDES_DIR, `${slideId}-dzi-zip`));
}

async function saveSlideToDatabase(slideData) {
  const slides = await readSlides();
  const existingIndex = slides.findIndex((slide) => slide.id === slideData.id);

  if (existingIndex >= 0) {
    slides[existingIndex] = slideData;
  } else {
    slides.push(slideData);
  }

  await writeSlides(slides);
  await syncSlideAccess(slideData);
}

function ltiConfigurationError() {
  return !LTI_CONFIG.issuer || !LTI_CONFIG.clientId || !LTI_CONFIG.deploymentId || !LTI_CONFIG.authLoginUrl || !LTI_CONFIG.jwksUrl;
}
async function getPlatform(issuer, clientId, deploymentId) {
  const configured = await pool.query('SELECT * FROM moodle_platforms WHERE issuer = $1 AND client_id = $2 AND deployment_id = $3', [issuer, clientId, deploymentId]);
  if (configured.rows[0]) return configured.rows[0];
  if (issuer !== LTI_CONFIG.issuer || clientId !== LTI_CONFIG.clientId || deploymentId !== LTI_CONFIG.deploymentId) return null;
  const result = await pool.query(
    `INSERT INTO moodle_platforms (issuer, client_id, deployment_id, auth_login_url, auth_token_url, jwks_url)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (issuer) DO UPDATE SET client_id=EXCLUDED.client_id, deployment_id=EXCLUDED.deployment_id, auth_login_url=EXCLUDED.auth_login_url, auth_token_url=EXCLUDED.auth_token_url, jwks_url=EXCLUDED.jwks_url RETURNING *`,
    [issuer, clientId, deploymentId, LTI_CONFIG.authLoginUrl, LTI_CONFIG.authTokenUrl, LTI_CONFIG.jwksUrl]
  );
  return result.rows[0];
}
async function verifyLtiIdToken(token, platform, nonce) {
  const [headerRaw, payloadRaw, signatureRaw] = String(token || '').split('.');
  if (!headerRaw || !payloadRaw || !signatureRaw) throw new Error('Некорректный id_token');
  const header = parseBase64UrlJson(headerRaw);
  const claims = parseBase64UrlJson(payloadRaw);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Поддерживается только JWT RS256 с kid');
  const jwksResponse = await fetch(platform.jwks_url);
  if (!jwksResponse.ok) throw new Error('Не удалось получить JWKS Moodle');
  const jwks = await jwksResponse.json();
  const jwk = (jwks.keys || []).find((key) => key.kid === header.kid && key.kty === 'RSA');
  if (!jwk) throw new Error('Ключ подписи Moodle не найден в JWKS');
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${headerRaw}.${payloadRaw}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signatureRaw, 'base64url'));
  if (!valid) throw new Error('Подпись id_token недействительна');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== platform.issuer || !audience.includes(platform.client_id) || claims.exp * 1000 < Date.now() || claims.nonce !== nonce) throw new Error('Проверка issuer, audience, срока действия или nonce не пройдена');
  const deployment = claims['https://purl.imsglobal.org/spec/lti/claim/deployment_id'];
  if (deployment !== platform.deployment_id) throw new Error('Некорректный LTI deployment_id');
  return claims;
}
function ltiCustom(claims) { return claims['https://purl.imsglobal.org/spec/lti/claim/custom'] || {}; }
async function persistLtiLaunch({ platform, launch, claims }) {
  const context = claims['https://purl.imsglobal.org/spec/lti/claim/context'] || {};
  const custom = ltiCustom(claims);
  const contextId = String(context.id || custom.custom_moodle_course_id || '');
  if (!contextId) throw new Error('Moodle не передал LTI context/course');
  const courseExternalId = String(custom.custom_moodle_course_id || context.label || contextId);
  const courseResult = await pool.query(
    `INSERT INTO moodle_courses (platform_id,lti_context_id,course_id,shortname,title,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT(platform_id,lti_context_id) DO UPDATE SET course_id=EXCLUDED.course_id, shortname=EXCLUDED.shortname, title=EXCLUDED.title, data=EXCLUDED.data RETURNING *`,
    [platform.id, contextId, courseExternalId, String(custom.custom_moodle_course_shortname || context.label || ''), String(context.title || ''), JSON.stringify(context)]
  );
  const course = courseResult.rows[0];
  const role = roleFromLtiRoles(claims['https://purl.imsglobal.org/spec/lti/claim/roles'] || []);
  const userResult = await pool.query(
    `INSERT INTO moodle_users (platform_id,moodle_user_id,name,email,role,claims) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT(platform_id,moodle_user_id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,role=EXCLUDED.role,claims=EXCLUDED.claims,updated_at=now() RETURNING *`,
    [platform.id, String(claims.sub), String(claims.name || `${claims.given_name || ''} ${claims.family_name || ''}`).trim(), String(claims.email || ''), role, JSON.stringify(claims)]
  );
  const user = userResult.rows[0];
  const commonUser = (await pool.query(
    `INSERT INTO users (login,email,full_name,password_hash,role,auth_provider,moodle_user_id)
     VALUES ($1,$2,$3,NULL,$4,'moodle_lti',$5)
     ON CONFLICT(login) DO UPDATE SET email=EXCLUDED.email, full_name=EXCLUDED.full_name, auth_provider='moodle_lti', moodle_user_id=EXCLUDED.moodle_user_id, updated_at=now()
     RETURNING *`,
    [`moodle_${platform.id}_${claims.sub}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '_'), String(claims.email || ''), String(claims.name || `${claims.given_name || ''} ${claims.family_name || ''}`).trim(), role, String(claims.sub)]
  )).rows[0];
  const finalRole = normalizeRole(commonUser.role, role);
  const finalPermissions = permissionsForRole(finalRole, commonUser.permission_overrides || {});
  const groupExternalId = custom.custom_moodle_group_id || custom.custom_user_group || claims['https://purl.imsglobal.org/spec/lti/claim/groups']?.[0];
  let group = null;
  if (groupExternalId) {
    const groupResult = await pool.query('INSERT INTO moodle_groups (course_id,moodle_group_id,name) VALUES ($1,$2,$3) ON CONFLICT(course_id,moodle_group_id) DO UPDATE SET name=EXCLUDED.name RETURNING *', [course.id, String(groupExternalId), String(custom.custom_moodle_group_name || custom.custom_user_group || groupExternalId)]);
    group = groupResult.rows[0];
  }
  await pool.query('INSERT INTO moodle_memberships (moodle_user_id,course_id,group_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [user.id, course.id, group?.id || null]);
  const resource = claims['https://purl.imsglobal.org/spec/lti/claim/resource_link'] || {};
  let resourceLink = null;
  if (resource.id) resourceLink = (await pool.query('INSERT INTO lti_resource_links (course_id,resource_link_id,title,data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT(course_id,resource_link_id) DO UPDATE SET title=EXCLUDED.title,data=EXCLUDED.data RETURNING *', [course.id, String(resource.id), String(resource.title || ''), JSON.stringify(resource)])).rows[0];
  const ags = claims['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint'] || {};
  await pool.query('UPDATE lti_launches SET platform_id=$2,moodle_user_id=$3,course_id=$4,id_token_claims=$5::jsonb,ags=$6::jsonb WHERE id=$1', [launch.id, platform.id, user.id, course.id, JSON.stringify(claims), JSON.stringify({ ...ags, resourceLinkId: resourceLink?.id || null })]);
  return { user, commonUser, course, group, role: finalRole, permissions: finalPermissions, resourceLink, ags };
}

if (ENABLE_MOODLE_LTI) {
app.get('/.well-known/jwks.json', (req, res) => {
  if (!LTI_PUBLIC_KEY) return res.status(503).json({ error: 'LTI_PUBLIC_KEY не настроен' });
  try {
    const publicKey = crypto.createPublicKey(LTI_PUBLIC_KEY).export({ format: 'jwk' });
    res.json({ keys: [{ ...publicKey, use: 'sig', alg: 'RS256', kid: LTI_KEY_ID }] });
  } catch { res.status(500).json({ error: 'LTI_PUBLIC_KEY имеет некорректный формат' }); }
});
app.get('/lti/login', async (req, res) => {
  try {
    if (ltiConfigurationError()) return res.status(503).json({ error: 'LTI не настроен' });
    const issuer = String(req.query.iss || ''); const clientId = String(req.query.client_id || LTI_CONFIG.clientId); const deploymentId = String(req.query.lti_deployment_id || LTI_CONFIG.deploymentId);
    const platform = await getPlatform(issuer, clientId, deploymentId);
    if (!platform) return res.status(400).json({ error: 'Неизвестная Moodle platform/client_id' });
    const state = crypto.randomUUID(); const nonce = crypto.randomUUID(); const launchId = crypto.randomUUID();
    await pool.query('INSERT INTO lti_launches (id,state,nonce,platform_id,expires_at) VALUES ($1,$2,$3,$4,now() + interval \'10 minutes\')', [launchId, state, nonce, platform.id]);
    const url = new URL(platform.auth_login_url);
    url.searchParams.set('response_type', 'id_token'); url.searchParams.set('response_mode', 'form_post'); url.searchParams.set('scope', 'openid'); url.searchParams.set('prompt', 'none'); url.searchParams.set('client_id', platform.client_id); url.searchParams.set('redirect_uri', LTI_REDIRECT_URI); url.searchParams.set('login_hint', String(req.query.login_hint || '')); url.searchParams.set('state', state); url.searchParams.set('nonce', nonce);
    if (req.query.lti_message_hint) url.searchParams.set('lti_message_hint', String(req.query.lti_message_hint));
    return res.redirect(url.toString());
  } catch (error) { return res.status(400).json({ error: error.message }); }
});
app.post('/lti/launch', async (req, res) => {
  try {
    const launch = (await pool.query('SELECT * FROM lti_launches WHERE state=$1 AND expires_at > now()', [String(req.body.state || '')])).rows[0];
    if (!launch) return res.status(400).json({ error: 'LTI state отсутствует, истёк или уже использован' });
    const platform = (await pool.query('SELECT * FROM moodle_platforms WHERE id=$1', [launch.platform_id])).rows[0];
    const claims = await verifyLtiIdToken(req.body.id_token, platform, launch.nonce);
    const persisted = await persistLtiLaunch({ platform, launch, claims });
    // Keep the audited launch (and its AGS endpoint) for grade retries, while invalidating state.
    await pool.query('UPDATE lti_launches SET state=$2, expires_at=now() WHERE id=$1', [launch.id, `used-${crypto.randomUUID()}`]);
    setLtiSessionCookie(res, { authProvider: 'moodle_lti', moodleUserId: persisted.user.moodle_user_id, userId: persisted.user.id, name: persisted.user.name, email: persisted.user.email, role: persisted.role, permissions: persisted.permissions, courseIds: [persisted.course.id], groupIds: persisted.group ? [persisted.group.id] : [], courseExternalIds: [persisted.course.course_id], resourceLinkId: persisted.resourceLink?.id || null, ags: persisted.ags, platformId: platform.id });
    return res.redirect('/');
  } catch (error) { return res.status(401).json({ error: `LTI launch отклонён: ${error.message}` }); }
});
}

app.get('/api/me', async (req, res, next) => {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      const guest = getLocalGuestUser();
      return res.json({
        authenticated: false,
        authProvider: 'local',
        role: guest.role,
        permissions: guest.permissions,
      });
    }

    return res.json({
      authenticated: true,
      authProvider: user.authProvider,
      id: user.id || user.userId || null,
      login: user.login || '',
      role: user.role,
      moodleUserId: user.moodleUserId || '',
      name: user.name || user.login || '',
      email: user.email || '',
      courses: user.courseExternalIds || [],
      groups: user.groupIds || [],
      permissions: user.permissions,
      permissionOverrides: user.permissionOverrides || {},
    });
  } catch (error) {
    return next(error);
  }
});
app.get('/api/auth/check-slide-access', requireAuth, async (req, res) => {
  const originalUri = String(req.get('X-Original-URI') || '');
  const slideId = String(req.query.slideId || req.query.slide_id || originalUri.match(/^\/slides\/([^/_./]+)(?:\.dzi|_files\/)/)?.[1] || '');
  const slide = await requireSlideAccess(slideId);
  if (!slide || !(await getSlideAccess(slide, req.user))) return res.status(403).json({ error: 'Нет доступа к препарату' });
  return res.status(204).end();
});

function createClientAssertion(audience) {
  if (!LTI_PRIVATE_KEY) throw new Error('LTI_PRIVATE_KEY не настроен');
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: LTI_KEY_ID }));
  const payload = base64Url(JSON.stringify({ iss: LTI_CONFIG.clientId, sub: LTI_CONFIG.clientId, aud: audience, iat: now, exp: now + 300, jti: crypto.randomUUID() }));
  return `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), LTI_PRIVATE_KEY).toString('base64url')}`;
}
async function getAgsAccessToken() {
  if (!LTI_CONFIG.authTokenUrl) throw new Error('LTI_AUTH_TOKEN_URL не настроен');
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: createClientAssertion(LTI_CONFIG.authTokenUrl), scope: 'https://purl.imsglobal.org/spec/lti-ags/scope/score' });
  const response = await fetch(LTI_CONFIG.authTokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  if (!response.ok) throw new Error(`Moodle token endpoint: ${response.status} ${await response.text()}`);
  const data = await response.json();
  if (!data.access_token) throw new Error('Moodle не вернул access_token для AGS');
  return data.access_token;
}
async function sendGradeToMoodle(queueItem, session) {
  if (!session?.ags?.lineitems) throw new Error('В LTI launch отсутствует AGS lineitems endpoint');
  const token = await getAgsAccessToken();
  let gradeItem = (await pool.query('SELECT * FROM lti_grade_items WHERE diagnostic_id=$1 AND course_id=$2', [queueItem.diagnostic_id, queueItem.course_id])).rows[0];
  if (!gradeItem?.lineitem_url) {
    const lineitemResponse = await fetch(session.ags.lineitems, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.ims.lis.v2.lineitem+json' }, body: JSON.stringify({ label: `Гистологический атлас: ${queueItem.diagnostic_id}`, scoreMaximum: Number(queueItem.score_maximum), resourceId: queueItem.diagnostic_id, resourceLinkId: session.ags.resource_link_id || undefined }) });
    if (!lineitemResponse.ok) throw new Error(`Не удалось создать Moodle line item: ${lineitemResponse.status} ${await lineitemResponse.text()}`);
    const lineitem = await lineitemResponse.json();
    gradeItem = (await pool.query('INSERT INTO lti_grade_items (diagnostic_id,course_id,resource_link_id,lineitem_url,label,score_maximum) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(diagnostic_id,course_id) DO UPDATE SET lineitem_url=EXCLUDED.lineitem_url RETURNING *', [queueItem.diagnostic_id, queueItem.course_id, session.resourceLinkId || null, lineitem.id, lineitem.label || '', queueItem.score_maximum])).rows[0];
  }
  const user = (await pool.query('SELECT moodle_user_id FROM moodle_users WHERE id=$1', [queueItem.moodle_user_id])).rows[0];
  if (!user) throw new Error('Moodle user для результата не найден');
  const response = await fetch(`${gradeItem.lineitem_url}/scores`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.ims.lis.v1.score+json' }, body: JSON.stringify({ userId: user.moodle_user_id, scoreGiven: Number(queueItem.score_given), scoreMaximum: Number(queueItem.score_maximum), activityProgress: 'Completed', gradingProgress: 'FullyGraded', timestamp: new Date().toISOString() }) });
  if (!response.ok) throw new Error(`Moodle не принял оценку: ${response.status} ${await response.text()}`);
  await pool.query('UPDATE lti_grade_results SET status=$2,attempts=attempts+1,last_error=NULL,sent_at=now(),updated_at=now() WHERE id=$1', [queueItem.id, 'sent']);
}
async function queueAndSendGrade(result, user) {
  if (user.authProvider !== 'moodle_lti' || !user.userId || !user.courseIds?.[0]) return null;
  const inserted = await pool.query('INSERT INTO lti_grade_results (result_id,moodle_user_id,course_id,diagnostic_id,score_given,score_maximum,status) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(result_id) DO UPDATE SET score_given=EXCLUDED.score_given,score_maximum=EXCLUDED.score_maximum,status=$7,updated_at=now() RETURNING *', [result.id, user.userId, user.courseIds[0], result.diagnosticId, result.score, result.total || 1, 'pending']);
  try { await sendGradeToMoodle(inserted.rows[0], user); } catch (error) { await pool.query('UPDATE lti_grade_results SET status=$2,attempts=attempts+1,last_error=$3,updated_at=now() WHERE id=$1', [inserted.rows[0].id, 'failed', error.message]); }
  return (await pool.query('SELECT * FROM lti_grade_results WHERE result_id=$1', [result.id])).rows[0];
}

app.get('/api/slides', requireAuth, async (req, res) => {
  const slides = await readSlides();
  const allowed = [];
  for (const slide of slides) if (await getSlideAccess(slide, req.user)) allowed.push(slide);
  res.json(req.user.role === 'resident'
    ? allowed.map((slide, index) => maskSlideForResident(slide, index))
    : allowed);
});

app.get('/api/health', async (req, res) => {
  const report = await getHealthReport();
  res.status(report.ok ? 200 : 503).json(report);
});

app.get('/api/admin/session', async (req, res, next) => {
  try {
    const sessionUser = await getSessionUser(req);
    const accounts = await listTeacherAccounts();
    const users = await listUsers();
    res.json({
      ok: true,
      configured: Boolean(ADMIN_PASSWORD || TEACHER_PASSWORD || TEACHER_ACCOUNTS.length || accounts.length || users.length),
      authenticated: Boolean(sessionUser),
      role: sessionUser?.role || '',
      login: sessionUser?.login || '',
      name: sessionUser?.name || '',
      permissions: sessionUser?.permissions || {},
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/login', async (req, res) => {
  if (!ADMIN_PASSWORD && !TEACHER_PASSWORD && TEACHER_ACCOUNTS.length === 0 && !(await listTeacherAccounts()).length) {
    return res.status(503).json({
      error: 'Авторизация администратора не настроена. Задайте ADMIN_PASSWORD на сервере.',
    });
  }

  const login = String(req.body?.login || '').trim().toLowerCase();
  const teacher = TEACHER_ACCOUNTS.find((account) => account.login === login);
  const storedUser = await findUserByLogin(login);
  const storedTeacher = await findStoredTeacherAccount(login);
  const session = login === ADMIN_LOGIN.toLowerCase() && isAdminPasswordValid(req.body?.password)
    ? { role: 'admin', login }
    : storedUser && storedUser.is_active && storedUser.password_hash && await isStoredPasswordValid(storedUser.password_hash, req.body?.password)
      ? { role: normalizeRole(storedUser.role), login: storedUser.login, userId: storedUser.id }
    : teacher && isPasswordValid(teacher.password, req.body?.password)
      ? { role: 'teacher', login: teacher.login }
      : storedTeacher && storedTeacher.active && await isStoredPasswordValid(storedTeacher.password_hash, req.body?.password)
        ? { role: storedTeacher.role || 'teacher_full', login: storedTeacher.login }
      : login === 'teacher' && isTeacherPasswordValid(req.body?.password)
        ? { role: 'teacher', login }
        : null;

  if (!session) {
    clearAdminSessionCookie(res);
    return res.status(401).json({
      error: 'Неверный пароль',
    });
  }

  setAdminSessionCookie(res, session.role, session.login);
  if (session.userId) await pool.query('UPDATE users SET last_login_at=now(), updated_at=now() WHERE id=$1', [session.userId]);
  return res.json({
    ok: true,
    role: session.role,
    login: session.login,
  });
});

app.post('/api/admin/logout', (req, res) => {
  clearAdminSessionCookie(res);
  res.json({
    ok: true,
  });
});

app.use('/api/admin', requireAdminAreaAuth);

app.get('/api/admin/users', requireUserManagement, async (req, res, next) => {
  try {
    res.json(await listUsers());
  } catch (error) { next(error); }
});

app.post('/api/admin/users', requireUserManagement, async (req, res) => {
  try {
    const login = normalizeAccountLogin(req.body?.login);
    const password = requireAccountPassword(req.body?.password);
    const role = normalizeRole(req.body?.role, 'teacher_limited');
    const email = normalizeOptionalEmail(req.body?.email);
    const fullName = normalizeFullName(req.body?.fullName || req.body?.name);
    const permissionOverrides = normalizePermissionOverrides(req.body?.permissionOverrides || {});
    if (login === ADMIN_LOGIN || login === 'teacher' || TEACHER_ACCOUNTS.some((account) => account.login === login)) {
      return res.status(400).json({ error: 'Этот логин зарезервирован конфигурацией сервера' });
    }
    const { rows } = await pool.query(
      `INSERT INTO users (login,email,full_name,password_hash,role,permission_overrides,is_active,auth_provider)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'local') RETURNING *`,
      [login, email || null, fullName, await hashAccountPassword(password), role, JSON.stringify(permissionOverrides), req.body?.isActive !== false]
    );
    return res.status(201).json(userRowToApi(rows[0]));
  } catch (error) {
    return res.status(error.code === '23505' ? 409 : 400).json({ error: error.code === '23505' ? 'Пользователь с таким логином или email уже существует' : error.message });
  }
});

app.get('/api/admin/users/:id', requireUserManagement, async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  return res.json(userRowToApi(user));
});

app.put('/api/admin/users/:id', requireUserManagement, async (req, res) => {
  try {
    const role = normalizeRole(req.body?.role, 'teacher_limited');
    const email = normalizeOptionalEmail(req.body?.email);
    const fullName = normalizeFullName(req.body?.fullName || req.body?.name);
    const permissionOverrides = normalizePermissionOverrides(req.body?.permissionOverrides || {});
    const { rows } = await pool.query(
      `UPDATE users SET email=$2, full_name=$3, role=$4, permission_overrides=$5::jsonb, is_active=$6, updated_at=now()
       WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
      [req.params.id, email || null, fullName, role, JSON.stringify(permissionOverrides), req.body?.isActive !== false]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });
    return res.json(userRowToApi(rows[0]));
  } catch (error) {
    return res.status(error.code === '23505' ? 409 : 400).json({ error: error.code === '23505' ? 'Пользователь с таким email уже существует' : error.message });
  }
});

app.patch('/api/admin/users/:id/permissions', requireUserManagement, async (req, res) => {
  const permissionOverrides = normalizePermissionOverrides(req.body?.permissionOverrides || req.body?.permissions || {});
  const { rows } = await pool.query(
    'UPDATE users SET permission_overrides=$2::jsonb, updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *',
    [req.params.id, JSON.stringify(permissionOverrides)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });
  return res.json(userRowToApi(rows[0]));
});

app.patch('/api/admin/users/:id/password', requireUserManagement, async (req, res) => {
  try {
    const password = requireAccountPassword(req.body?.password);
    const { rows } = await pool.query(
      'UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *',
      [req.params.id, await hashAccountPassword(password)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });
    return res.json({ ok: true, id: rows[0].id });
  } catch (error) { return res.status(400).json({ error: error.message }); }
});

app.patch('/api/admin/users/:id/status', requireUserManagement, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE users SET is_active=$2, updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *',
    [req.params.id, req.body?.isActive !== false]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });
  return res.json(userRowToApi(rows[0]));
});

app.delete('/api/admin/users/:id', requireUserManagement, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE users SET is_active=false, deleted_at=now(), updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });
  return res.json({ ok: true, id: rows[0].id });
});

app.get('/api/admin/teachers', requireAdministrator, async (req, res) => {
  res.json(await listTeacherAccounts());
});

app.get('/api/admin/moodle/courses', requirePermission('canCreateDiagnostics'), async (req, res) => {
  const { rows } = await pool.query('SELECT id, course_id, shortname, title, lti_context_id FROM moodle_courses ORDER BY title, shortname');
  res.json(rows);
});
app.get('/api/admin/moodle/groups', requirePermission('canCreateDiagnostics'), async (req, res) => {
  const { rows } = await pool.query('SELECT g.id, g.moodle_group_id, g.name, g.course_id FROM moodle_groups g ORDER BY g.name');
  res.json(rows);
});

app.post('/api/admin/teachers', requireAdministrator, async (req, res) => {
  try {
    const login = normalizeAccountLogin(req.body?.login);
    const password = requireAccountPassword(req.body?.password);
    if (login === ADMIN_LOGIN || login === 'teacher' || TEACHER_ACCOUNTS.some((account) => account.login === login)) {
      return res.status(400).json({ error: 'Этот логин зарезервирован конфигурацией сервера' });
    }

    const role = ['teacher_full', 'teacher_limited'].includes(req.body?.role) ? req.body.role : 'teacher_full';
    await pool.query(
      'INSERT INTO teacher_accounts (login, password_hash, role, active, course_ids, group_ids) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)',
      [login, await hashAccountPassword(password), role, req.body?.active !== false, JSON.stringify(Array.isArray(req.body?.courseIds) ? req.body.courseIds : []), JSON.stringify(Array.isArray(req.body?.groupIds) ? req.body.groupIds : [])]
    );
    res.status(201).json({ ok: true, login, role });
  } catch (error) {
    res.status(error.code === '23505' ? 409 : 400).json({
      error: error.code === '23505' ? 'Такой логин уже существует' : error.message,
    });
  }
});

app.put('/api/admin/teachers/:login', requireAdministrator, async (req, res) => {
  try {
    const login = normalizeAccountLogin(req.params.login);
    const role = String(req.body?.role || '');
    if (!['teacher_full', 'teacher_limited'].includes(role)) return res.status(400).json({ error: 'Некорректная роль преподавателя' });
    const result = await pool.query('UPDATE teacher_accounts SET role=$2, active=$3, course_ids=$4::jsonb, group_ids=$5::jsonb, updated_at=now() WHERE login=$1', [login, role, req.body?.active !== false, JSON.stringify(Array.isArray(req.body?.courseIds) ? req.body.courseIds : []), JSON.stringify(Array.isArray(req.body?.groupIds) ? req.body.groupIds : [])]);
    if (!result.rowCount) return res.status(404).json({ error: 'Преподаватель не найден' });
    return res.json({ ok: true, login, role });
  } catch (error) { return res.status(400).json({ error: error.message }); }
});

app.put('/api/admin/teachers/:login/password', requireAdministrator, async (req, res) => {
  try {
    const login = normalizeAccountLogin(req.params.login);
    const password = requireAccountPassword(req.body?.password);
    const result = await pool.query(
      'UPDATE teacher_accounts SET password_hash = $2, updated_at = now() WHERE login = $1',
      [login, await hashAccountPassword(password)]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Преподаватель не найден' });
    res.json({ ok: true, login });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/teachers/:login', requireAdministrator, async (req, res) => {
  try {
    const login = normalizeAccountLogin(req.params.login);
    const result = await pool.query('DELETE FROM teacher_accounts WHERE login = $1', [login]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Преподаватель не найден' });
    res.json({ ok: true, login });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/admin/slides', requirePermission('canViewSlides'), async (req, res) => {
  const slides = await readSlides();
  res.json(await withSlideAdminMetadata(slides));
});

app.get('/api/admin/diagnostics', requirePermission('canCreateDiagnostics'), async (req, res) => {
  const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
  const results = await readJsonArray(DIAGNOSTIC_RESULTS_JSON);

  const resultCountByDiagnostic = results.reduce((counts, result) => {
    counts[result.diagnosticId] = (counts[result.diagnosticId] || 0) + 1;
    return counts;
  }, {});

  res.json(
    diagnostics.map((diagnostic) => ({
      ...diagnostic,
      status: getDiagnosticStatus(diagnostic),
      resultCount: resultCountByDiagnostic[diagnostic.id] || 0,
    }))
  );
});

app.post('/api/admin/diagnostics', requirePermission('canCreateDiagnostics'), async (req, res) => {
  try {
    const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
    const diagnostic = { ...sanitizeDiagnosticPayload(req.body), createdBy: req.user.login || req.user.moodleUserId || String(req.user.userId || '') };
    await validateDiagnosticForPublication(diagnostic);

    if (diagnostics.some((item) => item.id === diagnostic.id)) {
      return res.status(409).json({
        error: 'Диагностика с таким ID уже существует',
      });
    }

    diagnostics.push(diagnostic);
    await writeJsonArray(DIAGNOSTICS_JSON, diagnostics);
    await syncDiagnosticAccess(diagnostic);

    res.json({
      ok: true,
      diagnostic,
    });
  } catch (error) {
    res.status(400).json({
      error: error.message,
    });
  }
});

app.put('/api/admin/diagnostics/:id', requirePermission('canEditOwnDiagnostics'), async (req, res) => {
  try {
    const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
    const existingIndex = diagnostics.findIndex((item) => item.id === req.params.id);

    if (existingIndex < 0) {
      return res.status(404).json({
        error: 'Диагностика не найдена',
      });
    }
    if (!req.user.permissions?.canEditAllDiagnostics && diagnostics[existingIndex].createdBy !== (req.user.login || req.user.moodleUserId || String(req.user.userId || ''))) {
      return res.status(403).json({ error: 'Можно редактировать только свои диагностики' });
    }

    const diagnostic = sanitizeDiagnosticPayload(
      {
        ...req.body,
        id: req.params.id,
      },
      diagnostics[existingIndex]
    );
    await validateDiagnosticForPublication(diagnostic);

    diagnostics[existingIndex] = diagnostic;
    await writeJsonArray(DIAGNOSTICS_JSON, diagnostics);
    await syncDiagnosticAccess(diagnostic);

    res.json({
      ok: true,
      diagnostic,
    });
  } catch (error) {
    res.status(400).json({
      error: error.message,
    });
  }
});

app.delete('/api/admin/diagnostics/:id', requirePermission('canEditAllDiagnostics'), async (req, res) => {
  const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
    const nextDiagnostics = diagnostics.filter((item) => item.id !== req.params.id);

    await writeJsonArray(DIAGNOSTICS_JSON, nextDiagnostics);
  await pool.query('DELETE FROM diagnostic_course_access WHERE diagnostic_id=$1', [req.params.id]);
  await pool.query('DELETE FROM diagnostic_group_access WHERE diagnostic_id=$1', [req.params.id]);

  res.json({
    ok: true,
    message: 'Диагностика удалена',
  });
});

app.get('/api/admin/diagnostics/:id/results', requirePermission('canViewResults'), async (req, res) => {
  const results = await readJsonArray(DIAGNOSTIC_RESULTS_JSON);
  const grades = await pool.query('SELECT result_id,status,attempts,last_error,sent_at FROM lti_grade_results');
  const byResult = new Map(grades.rows.map((grade) => [grade.result_id, grade]));
  res.json(results.filter((result) => result.diagnosticId === req.params.id).map((result) => ({ ...result, moodleGrade: byResult.get(result.id) || null })));
});

app.patch('/api/admin/results/:id/review', requirePermission('canGradeResults'), async (req, res) => {
  try {
    const results = await readJsonArray(DIAGNOSTIC_RESULTS_JSON);
    const resultIndex = results.findIndex((result) => result.id === req.params.id);

    if (resultIndex < 0) {
      return res.status(404).json({
        error: 'Результат не найден',
      });
    }

    const reviewByQuestionId = new Map(
      (Array.isArray(req.body.answers) ? req.body.answers : []).map((answer) => [
        String(answer.questionId || ''),
        answer,
      ])
    );
    const currentResult = results[resultIndex];
    const answers = (Array.isArray(currentResult.answers) ? currentResult.answers : []).map((answer) => {
      const review = reviewByQuestionId.get(answer.questionId);
      if (!review) return answer;

      const points = Number(answer.points || 0);
      const rawEarnedPoints = Number(review.earnedPoints);
      const earnedPoints = Number.isFinite(rawEarnedPoints)
        ? Math.max(0, Math.min(points, rawEarnedPoints))
        : Number(answer.earnedPoints || 0);

      return {
        ...answer,
        earnedPoints,
        isCorrect: points > 0 && earnedPoints >= points,
        needsReview: false,
        reviewComment: String(review.reviewComment || '').trim(),
      };
    });
    const score = answers.reduce((sum, answer) => sum + Number(answer.earnedPoints || 0), 0);
    const total = answers.reduce((sum, answer) => sum + Number(answer.points || 0), 0);
    const percent = total > 0 ? Math.round((score / total) * 100) : 0;
    const reviewedResult = {
      ...currentResult,
      answers,
      score,
      total,
      percent,
      reviewComment: String(req.body.reviewComment || '').trim(),
      reviewedAt: new Date().toISOString(),
    };

    results[resultIndex] = reviewedResult;
    await writeJsonArray(DIAGNOSTIC_RESULTS_JSON, results);

    res.json({
      ok: true,
      result: reviewedResult,
    });
  } catch (error) {
    res.status(400).json({
      error: error.message,
    });
  }
});

app.get('/api/admin/diagnostics/:id/results.csv', async (req, res) => {
  const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
  const diagnostic = diagnostics.find((item) => item.id === req.params.id);

  if (!diagnostic) {
    return res.status(404).send('Диагностика не найдена');
  }

  const results = (await readJsonArray(DIAGNOSTIC_RESULTS_JSON)).filter(
    (result) => result.diagnosticId === req.params.id
  );
  const questions = Array.isArray(diagnostic.questions) ? diagnostic.questions : [];
  const questionHeaders = questions.map((question, index) =>
    `${index + 1}. ${question.prompt || question.id}`
  );

  const header = [
    'Дата сдачи',
    'Диагностика',
    'ФИО',
    'Группа',
    'Баллы',
    'Всего вопросов',
    'Процент',
    'Автоотправка',
    ...questionHeaders,
  ];

  const rows = results.map((result) => {
    const answerByQuestionId = new Map(
      (Array.isArray(result.answers) ? result.answers : []).map((answer) => [
        answer.questionId,
        answer,
      ])
    );

    return [
      result.submittedAt,
      diagnostic.title,
      result.studentName,
      result.group,
      result.score,
      result.total,
      result.percent,
      result.isAutoSubmitted ? 'Да' : 'Нет',
      ...questions.map((question) => {
        const answer = answerByQuestionId.get(question.id);
        if (!answer) return 'не верно';
        return answer.isCorrect ? 'верно' : 'не верно';
      }),
    ];
  });

  const csv = [header, ...rows]
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${diagnostic.id}-results.csv"`
  );
  res.send(`\uFEFF${csv}`);
});

app.get('/api/admin/diagnostics/:id/report.html', async (req, res) => {
  const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
  const diagnostic = diagnostics.find((item) => item.id === req.params.id);

  if (!diagnostic) {
    return res.status(404).send('Диагностика не найдена');
  }

  const results = (await readJsonArray(DIAGNOSTIC_RESULTS_JSON)).filter(
    (result) => result.diagnosticId === req.params.id
  );

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${diagnostic.id}-detailed-report.html"`
  );
  res.send(buildDetailedReportHtml(diagnostic, results));
});

app.get('/api/admin/diagnostics/:id/preview', async (req, res) => {
  const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
  const diagnostic = diagnostics.find((item) => item.id === req.params.id);

  if (!diagnostic) {
    return res.status(404).json({
      error: 'Диагностика не найдена',
    });
  }

  res.json({
    ...(await buildDiagnosticPayload(diagnostic)),
    isPreview: true,
    status: 'preview',
  });
});

app.get('/api/admin/backups', requireAdministrator, async (req, res) => {
  try {
    res.json(await listDataBackups());
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

app.post('/api/admin/backups', requireAdministrator, async (req, res) => {
  try {
    const backup = await createDataSnapshotBackup();

    res.json({
      ok: true,
      backup,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

app.get('/api/admin/backups/:fileName', requireAdministrator, async (req, res) => {
  try {
    const backupPath = getBackupFilePath(req.params.fileName);

    if (!(await pathExists(backupPath))) {
      return res.status(404).json({
        error: 'Backup-файл не найден',
      });
    }

    return res.download(backupPath);
  } catch (error) {
    return res.status(400).json({
      error: error.message,
    });
  }
});

app.post('/api/admin/backups/:fileName/restore', requireAdministrator, async (req, res) => {
  try {
    const backup = await readDataSnapshotBackup(req.params.fileName);

    for (const store of BACKUP_STORES) {
      await replaceJsonItems(store, backup.stores[store]);
    }

    res.json({
      ok: true,
      restoredFrom: req.params.fileName,
      counts: Object.fromEntries(
        BACKUP_STORES.map((store) => [store, backup.stores[store].length])
      ),
    });
  } catch (error) {
    res.status(400).json({
      error: error.message,
    });
  }
});

app.get('/api/diagnostics/:id', requireAuth, async (req, res) => {
  const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
  const diagnostic = diagnostics.find((item) => item.id === req.params.id);

  if (!diagnostic) {
    return res.status(404).json({
      error: 'Диагностика не найдена',
    });
  }
  if (!(await getDiagnosticAccess(diagnostic, req.user))) return res.status(403).json({ error: 'Нет доступа к диагностике' });

  const status = getDiagnosticStatus(diagnostic);

  if (status !== 'open') {
    return res.status(403).json({
      error:
        status === 'scheduled'
          ? 'Диагностика еще не открыта'
          : status === 'closed'
            ? 'Диагностика уже закрыта'
            : 'Диагностика пока не опубликована',
      status,
      startsAt: diagnostic.startsAt,
      endsAt: diagnostic.endsAt,
    });
  }

  res.json(await buildDiagnosticPayload(diagnostic));
});

app.post('/api/diagnostics/:id/check-attempt', requireAuth, async (req, res) => {
  const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
  const diagnostic = diagnostics.find((item) => item.id === req.params.id);

  if (!diagnostic) {
    return res.status(404).json({
      error: 'Диагностика не найдена',
    });
  }
  if (!(await getDiagnosticAccess(diagnostic, req.user))) return res.status(403).json({ error: 'Нет доступа к диагностике' });

  const studentName = String(req.user.name || req.body.studentName || '').trim();
  const group = String((req.user.groupIds || []).join(',') || req.body.group || 'Без группы').trim();

  if (!studentName) {
    return res.status(400).json({
      error: 'Не удалось определить пользователя Moodle',
    });
  }

  const results = await readJsonArray(DIAGNOSTIC_RESULTS_JSON);
  const normalizedStudentName = normalizeParticipantValue(studentName);
  const normalizedGroup = normalizeParticipantValue(group);
  const existingResult = results.find((result) => {
    return (
      result.diagnosticId === diagnostic.id &&
      normalizeParticipantValue(result.studentName) === normalizedStudentName &&
      normalizeParticipantValue(result.group) === normalizedGroup
    );
  });

  if (existingResult) {
    return res.status(409).json({
      error: 'Для этого ФИО и группы диагностика уже была сдана',
      submittedAt: existingResult.submittedAt,
    });
  }

  res.json({
    ok: true,
  });
});

app.get('/api/diagnostics/:id/results/:resultId', requireAuth, async (req, res) => {
  const studentName = String(req.user.name || req.query.studentName || '').trim();
  const group = String((req.user.groupIds || []).join(',') || req.query.group || 'Без группы').trim();
  const results = await readJsonArray(DIAGNOSTIC_RESULTS_JSON);
  const result = results.find((item) => (
    item.id === req.params.resultId &&
    item.diagnosticId === req.params.id &&
    normalizeParticipantValue(item.studentName) === normalizeParticipantValue(studentName) &&
    normalizeParticipantValue(item.group) === normalizeParticipantValue(group)
  ));

  if (!result) return res.status(404).json({ error: 'Результат не найден' });

  res.json({
    id: result.id,
    score: result.score,
    total: result.total,
    percent: result.percent,
    reviewComment: result.reviewComment || '',
    answers: (result.answers || []).map((answer) => ({
      questionId: answer.questionId,
      type: answer.type,
      isCorrect: answer.isCorrect,
      earnedPoints: answer.earnedPoints,
      points: answer.points,
      needsReview: answer.needsReview,
      reviewComment: answer.reviewComment || '',
    })),
  });
});

app.post('/api/diagnostics/:id/submit', requireAuth, async (req, res) => {
  try {
    const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
    const diagnostic = diagnostics.find((item) => item.id === req.params.id);

    if (!diagnostic) {
      return res.status(404).json({
        error: 'Диагностика не найдена',
      });
    }
    if (!(await getDiagnosticAccess(diagnostic, req.user))) return res.status(403).json({ error: 'Нет доступа к диагностике' });

    if (getDiagnosticStatus(diagnostic) !== 'open') {
      return res.status(403).json({
        error: 'Прием ответов закрыт',
      });
    }

    const studentName = String(req.user.name || req.body.studentName || '').trim();
    const group = String((req.user.groupIds || []).join(',') || req.body.group || 'Без группы').trim();
    const submittedAnswers = Array.isArray(req.body.answers) ? req.body.answers : [];

    if (!studentName) {
      return res.status(400).json({
        error: 'Не удалось определить пользователя Moodle',
      });
    }

    const results = await readJsonArray(DIAGNOSTIC_RESULTS_JSON);
    const normalizedStudentName = normalizeParticipantValue(studentName);
    const normalizedGroup = normalizeParticipantValue(group);
    const existingResult = results.find((result) => {
      return (
        result.diagnosticId === diagnostic.id &&
        normalizeParticipantValue(result.studentName) === normalizedStudentName &&
        normalizeParticipantValue(result.group) === normalizedGroup
      );
    });

    if (existingResult) {
      return res.status(409).json({
        error: 'Для этого ФИО и группы диагностика уже была сдана',
        submittedAt: existingResult.submittedAt,
      });
    }

    const answers = diagnostic.questions.map((rawQuestion, questionIndex) => {
      const question = sanitizeDiagnosticQuestion(rawQuestion, questionIndex);
      const submitted = submittedAnswers.find((item) => item.questionId === question.id);
      const type = question.answer.type;
      const selectedIndex = Number(submitted?.selectedIndex);
      const selectedOptionFromIndex = Number.isInteger(selectedIndex)
        ? question.options[selectedIndex] || ''
        : '';
      const selectedOption = String(submitted?.selectedOption || selectedOptionFromIndex || '').trim();
      const selectedOptionId = String(submitted?.selectedOptionId || '').trim();
      const selectedOptionIds = Array.isArray(submitted?.selectedOptionIds)
        ? submitted.selectedOptionIds.map((item) => String(item || '').trim()).filter(Boolean)
        : selectedOptionId
          ? [selectedOptionId]
          : [];
      const selectedOptions = Array.isArray(submitted?.selectedOptions)
        ? submitted.selectedOptions.map((item) => String(item || '').trim()).filter(Boolean)
        : selectedOption
          ? [selectedOption]
          : [];
      const textAnswer = String(submitted?.textAnswer || '').trim();
      const numberAnswer = submitted?.numberAnswer;
      const selectedPairs = submitted?.selectedPairs && typeof submitted.selectedPairs === 'object'
        ? submitted.selectedPairs
        : {};
      const orderedItemIds = Array.isArray(submitted?.orderedItemIds)
        ? submitted.orderedItemIds.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      const selectedRegion = submitted?.selectedRegion || null;
      const correctIndices = question.correctIndices;
      const correctOptions = question.answer.options
        .filter((option) => question.answer.correctOptionIds.includes(option.id))
        .map((option) => option.text);
      const normalizeOptionSet = (items) => {
        return Array.from(new Set(items.map(normalizeOpenAnswer))).sort();
      };
      const normalizeIdSet = (items) => {
        return Array.from(new Set(items)).sort();
      };
      let isCorrect;

      if (question.grading.mode === 'manual') {
        isCorrect = false;
      } else if (type === 'text') {
        isCorrect = gradeTextAnswer(question, textAnswer);
      } else if (type === 'number') {
        isCorrect = gradeNumberAnswer(question, numberAnswer);
      } else if (type === 'matching') {
        isCorrect = gradeMatchingAnswer(question, selectedPairs);
      } else if (type === 'ordering') {
        isCorrect = gradeOrderingAnswer(question, orderedItemIds);
      } else if (type === 'region') {
        isCorrect = gradeRegionAnswer(question, selectedRegion);
      } else if (type === 'combined') {
        const choiceCorrect = selectedOptionIds.length > 0
          ? JSON.stringify(normalizeIdSet(selectedOptionIds)) ===
            JSON.stringify(normalizeIdSet(question.answer.correctOptionIds.slice(0, 1)))
          : JSON.stringify(normalizeOptionSet(selectedOptions)) ===
            JSON.stringify(normalizeOptionSet([question.options[question.correctIndex]]));
        isCorrect = choiceCorrect && gradeTextAnswer(question, textAnswer);
      } else {
        isCorrect = selectedOptionIds.length > 0
          ? JSON.stringify(normalizeIdSet(selectedOptionIds)) ===
            JSON.stringify(normalizeIdSet(type === 'multiple'
              ? question.answer.correctOptionIds
              : question.answer.correctOptionIds.slice(0, 1)))
          : JSON.stringify(normalizeOptionSet(selectedOptions)) ===
            JSON.stringify(normalizeOptionSet(type === 'multiple' ? correctOptions : [question.options[question.correctIndex]]));
      }

      return {
        questionId: question.id,
        type,
        selectedIndex: Number.isInteger(selectedIndex) ? selectedIndex : null,
        selectedOptionId,
        selectedOptionIds,
        selectedOption: type === 'text' ? textAnswer : selectedOptions.join('; '),
        selectedOptions,
        textAnswer,
        numberAnswer,
        selectedPairs,
        orderedItemIds,
        selectedRegion,
        correctIndex: question.correctIndex,
        correctIndices,
        correctOption: question.options[question.correctIndex] || '',
        correctOptions,
        correctText: question.correctText || '',
        points: question.grading.points,
        earnedPoints: isCorrect ? question.grading.points : 0,
        needsReview: question.grading.mode === 'manual',
        isCorrect,
      };
    });

    const score = answers.reduce((sum, answer) => sum + answer.earnedPoints, 0);
    const total = answers.reduce((sum, answer) => sum + answer.points, 0);
    const percent = total > 0 ? Math.round((score / total) * 100) : 0;

    const result = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      diagnosticId: diagnostic.id,
      diagnosticTitle: diagnostic.title,
      studentName,
      group,
      score,
      total,
      percent,
      isAutoSubmitted: Boolean(req.body.isAutoSubmitted),
      answers,
      submittedAt: new Date().toISOString(),
    };

    results.push(result);
    await writeJsonArray(DIAGNOSTIC_RESULTS_JSON, results);
    const moodleGrade = await queueAndSendGrade(result, req.user);

    res.json({
      ok: true,
      id: result.id,
      score,
      total,
      percent,
      moodleGradeStatus: moodleGrade?.status || null,
      reviewComment: result.reviewComment || '',
      answers: answers.map((answer) => ({
        questionId: answer.questionId,
        type: answer.type,
        isCorrect: answer.isCorrect,
        earnedPoints: answer.earnedPoints,
        points: answer.points,
        needsReview: answer.needsReview,
        reviewComment: answer.reviewComment || '',
      })),
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

app.post('/api/admin/results/:id/resend-to-moodle', requirePermission('canSendGradesToMoodle'), async (req, res) => {
  const queueItem = (await pool.query('SELECT * FROM lti_grade_results WHERE result_id=$1', [req.params.id])).rows[0];
  if (!queueItem) return res.status(404).json({ error: 'Очередь отправки результата в Moodle не найдена' });
  try {
    const launch = (await pool.query('SELECT ags FROM lti_launches WHERE moodle_user_id=$1 AND course_id=$2 ORDER BY created_at DESC LIMIT 1', [queueItem.moodle_user_id, queueItem.course_id])).rows[0];
    const session = launch ? { ags: launch.ags } : req.user;
    await sendGradeToMoodle(queueItem, session);
    return res.json({ ok: true, status: 'sent' });
  } catch (error) {
    await pool.query('UPDATE lti_grade_results SET status=$2,attempts=attempts+1,last_error=$3,updated_at=now() WHERE id=$1', [queueItem.id, 'failed', error.message]);
    return res.status(502).json({ error: error.message });
  }
});

app.get('/api/admin/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: 'Задача не найдена',
    });
  }

  res.json(job);
});

app.post('/api/admin/slides/import', requirePermission('canUploadSlides'), async (req, res) => {
  try {
    const rawSlides = req.body?.slides;

    if (!Array.isArray(rawSlides) || rawSlides.length === 0) {
      return res.status(400).json({
        error: 'Передайте непустой массив slides с карточками препаратов',
      });
    }

    if (rawSlides.length > 500) {
      return res.status(400).json({
        error: 'За одну операцию можно импортировать не более 500 карточек',
      });
    }

    const slides = await readSlides();
    const occupiedIds = new Set(slides.map((slide) => slide.id));
    const created = [];
    const skipped = [];

    rawSlides.forEach((rawSlide, index) => {
      const row = index + 1;

      try {
        if (!rawSlide || typeof rawSlide !== 'object' || Array.isArray(rawSlide)) {
          throw new Error('ожидается объект карточки');
        }

        const id = slugify(rawSlide.id || rawSlide.title);
        if (!id) throw new Error('не удалось создать ID');

        if (occupiedIds.has(id)) {
          throw new Error(`ID "${id}" уже занят`);
        }

        const slide = normalizeSlideData({
          id,
          title: rawSlide.title,
          lesson: rawSlide.lesson,
          system: rawSlide.system,
          organ: rawSlide.organ,
          stain: rawSlide.stain,
          source: rawSlide.source,
          description: rawSlide.description,
          diagnosticSigns: rawSlide.diagnosticSigns,
          selfCheckQuestions: rawSlide.selfCheckQuestions,
        }, { strict: true });

        created.push(slide);
        occupiedIds.add(id);
      } catch (error) {
        skipped.push({
          row,
          id: String(rawSlide?.id || rawSlide?.title || '').trim(),
          error: error.message,
        });
      }
    });

    if (created.length > 0) {
      await writeSlides([...slides, ...created]);
    }

    res.status(created.length > 0 ? 201 : 400).json({
      ok: created.length > 0,
      created: created.map((slide) => ({ id: slide.id, title: slide.title })),
      skipped,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/slides', requirePermission('canUploadSlides'), upload.single('slideFile'), async (req, res) => {
  const job = createJob('Файл получен. Подготовка к обработке...');

  res.json({
    ok: true,
    jobId: job.id,
  });

  try {
    const {
      id,
      title,
      lesson,
      system,
      organ,
      stain,
      description,
      diagnosticSigns,
      selfCheckQuestions,
      source,
      courseIds,
      groupIds,
      visibleForStudents,
      visibleForResidents,
      anonymizeForResidents,
    } = req.body;

    const slideId = slugify(id || title);

    if (!slideId) {
      throw new Error('Не удалось создать ID препарата');
    }

    const slides = await readSlides();
    const existingSlide = slides.find((slide) => slide.id === slideId);

    if (existingSlide) {
      throw new Error(
        `ID препарата "${slideId}" уже занят: ${existingSlide.title || 'без названия'}. Выберите другой ID или отредактируйте существующий препарат.`
      );
    }

    if (!req.file && !String(source || '').trim()) {
      throw new Error('Укажите DZI-адрес или загрузите файл препарата');
    }

    updateJob(job.id, {
      status: 'processing',
      progress: 15,
      message: 'Создание карточки препарата...',
    });

    let slideSource = String(source || '').trim();

    if (req.file) {
      updateJob(job.id, {
        progress: 30,
        message: 'Подготовка файла препарата...',
      });

      const prepared = await prepareSlideFile(req.file, slideId);

      if (prepared.type === 'ready-dzi') {
        updateJob(job.id, {
          progress: 80,
          message: 'Готовые DZI-тайлы распакованы...',
        });

        slideSource = prepared.source;
      } else {
        updateJob(job.id, {
          progress: 50,
          message: 'Конвертация препарата в DZI. Это может занять несколько минут...',
        });

        slideSource = await convertSlideToDzi(
          prepared.inputPath,
          slideId,
          ({ progress, message }) => {
            updateJob(job.id, { progress, message });
          }
        );
      }
    }

    updateJob(job.id, {
      progress: 90,
      message: 'Сохранение данных препарата...',
    });

    const newSlide = normalizeSlideData({
      id: slideId,
      title,
      lesson,
      system,
      organ,
      stain,
      source: slideSource,
      description: description || '',
      diagnosticSigns: parseDiagnosticSigns(diagnosticSigns),
      selfCheckQuestions: parseSelfCheckQuestions(selfCheckQuestions),
      courseIds: typeof courseIds === 'string' ? JSON.parse(courseIds || '[]') : courseIds,
      groupIds: typeof groupIds === 'string' ? JSON.parse(groupIds || '[]') : groupIds,
      visibleForStudents: visibleForStudents !== 'false',
      visibleForResidents: visibleForResidents !== 'false',
      anonymizeForResidents: anonymizeForResidents !== 'false',
      createdBy: req.user.login || req.user.moodleUserId || '',
    }, { strict: true });

    await saveSlideToDatabase(newSlide);

    updateJob(job.id, {
      status: 'done',
      progress: 100,
      message: 'Препарат успешно добавлен',
      slide: newSlide,
    });
  } catch (error) {
    console.error(error);

    if (req.file) {
      await removeIfExists(req.file.path);
    }

    updateJob(job.id, {
      status: 'error',
      progress: 100,
      message: 'Ошибка при добавлении препарата',
      error: error.message,
    });
  }
});

app.put('/api/admin/slides/:id', requirePermission('canEditSlides'), upload.single('slideFile'), async (req, res) => {
  const job = createJob('Файл получен. Подготовка к редактированию...');

  res.json({
    ok: true,
    jobId: job.id,
  });

  try {
    const currentId = req.params.id;

    const {
      title,
      lesson,
      system,
      organ,
      stain,
      description,
      diagnosticSigns,
      selfCheckQuestions,
      source,
      courseIds,
      groupIds,
      visibleForStudents,
      visibleForResidents,
      anonymizeForResidents,
    } = req.body;

    const slides = await readSlides();
    const existingIndex = slides.findIndex((slide) => slide.id === currentId);

    if (existingIndex < 0) {
      if (req.file) {
        await removeIfExists(req.file.path);
      }

      throw new Error('Препарат не найден');
    }

    const existingSlide = slides[existingIndex];

    updateJob(job.id, {
      status: 'processing',
      progress: 20,
      message: 'Подготовка изменений карточки...',
    });

    let slideSource = String(source || existingSlide.source || '').trim();

    if (req.file) {
      updateJob(job.id, {
        progress: 35,
        message: 'Подготовка нового файла препарата...',
      });

      const prepared = await prepareSlideFile(req.file, currentId);

      if (prepared.type === 'ready-dzi') {
        updateJob(job.id, {
          progress: 80,
          message: 'Готовые DZI-тайлы распакованы...',
        });

        slideSource = prepared.source;
      } else {
        updateJob(job.id, {
          progress: 55,
          message: 'Конвертация нового файла в DZI. Это может занять несколько минут...',
        });

        slideSource = await convertSlideToDzi(
          prepared.inputPath,
          currentId,
          ({ progress, message }) => {
            updateJob(job.id, { progress, message });
          }
        );
      }
    }

    updateJob(job.id, {
      progress: 90,
      message: 'Сохранение изменений...',
    });

    const updatedSlide = normalizeSlideData({
      ...existingSlide,
      id: currentId,
      title,
      lesson,
      system,
      organ,
      stain,
      source: slideSource,
      description: description || '',
      diagnosticSigns: parseDiagnosticSigns(diagnosticSigns),
      selfCheckQuestions: parseSelfCheckQuestions(selfCheckQuestions),
      courseIds: typeof courseIds === 'string' ? JSON.parse(courseIds || '[]') : courseIds,
      groupIds: typeof groupIds === 'string' ? JSON.parse(groupIds || '[]') : groupIds,
      visibleForStudents: visibleForStudents !== 'false',
      visibleForResidents: visibleForResidents !== 'false',
      anonymizeForResidents: anonymizeForResidents !== 'false',
      updatedBy: req.user.login || req.user.moodleUserId || '',
    }, { strict: true });

    slides[existingIndex] = updatedSlide;

    await writeSlides(slides);
    await syncSlideAccess(updatedSlide);

    updateJob(job.id, {
      status: 'done',
      progress: 100,
      message: 'Изменения успешно сохранены',
      slide: updatedSlide,
    });
  } catch (error) {
    console.error(error);

    if (req.file) {
      await removeIfExists(req.file.path);
    }

    updateJob(job.id, {
      status: 'error',
      progress: 100,
      message: 'Ошибка при редактировании препарата',
      error: error.message,
    });
  }
});

app.delete('/api/admin/slides/:id', requirePermission('canDeleteSlides'), async (req, res) => {
  try {
    const { id } = req.params;

    const slides = await readSlides();
    const nextSlides = slides.filter((slide) => slide.id !== id);

    await writeSlides(nextSlides);
    await deleteSlideFiles(id);

    res.json({
      ok: true,
      message: 'Препарат и связанные файлы удалены',
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Ошибка при удалении препарата',
      details: error.message,
    });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Histology API started on http://127.0.0.1:${PORT}`);
});

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import AdmZip from 'adm-zip';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
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
const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
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
  '.mrxs',
  '.zip',
]);

const jobs = new Map();

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

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(BACKUP_DIR, { recursive: true });
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
app.use(
  '/slides',
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
      publicSlidesDir: PUBLIC_SLIDES_DIR,
      dziFiles: await countPublicSlideFiles(),
    },
  };

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
  };
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

    if (!question.prompt) {
      errors.push(`Вопрос ${number}: не указан текст вопроса`);
    }

    if (!question.slideId || !slideById.has(question.slideId)) {
      errors.push(`Вопрос ${number}: выбранный препарат недоступен`);
    }

    if (['single', 'multiple', 'combined'].includes(question.type) && question.options.length < 2) {
      errors.push(`Вопрос ${number}: нужно минимум два варианта ответа`);
    }

    if (
      question.type === 'region' &&
      (!Array.isArray(question.regions) ||
        question.regions.filter((region) => region?.type !== 'arrow').length === 0)
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

  if (!(await pathExists(sourceTilesDir))) {
    throw new Error(
      `В ZIP-архиве не найдена папка тайлов: ${originalTilesFolderName}`
    );
  }

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
      'Неподдерживаемый формат файла. Разрешены: .svs, .tif, .tiff, .ndpi, .scn, .mrxs, .zip'
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

async function convertSlideToDzi(inputPath, slideId) {
  const outputBase = path.join(PUBLIC_SLIDES_DIR, slideId);

  await removeIfExists(`${outputBase}.dzi`);
  await removeIfExists(`${outputBase}_files`);

  await execFileAsync('vips', ['dzsave', inputPath, outputBase]);

  return `/slides/${slideId}.dzi`;
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
}

app.get('/api/slides', async (req, res) => {
  const slides = await readSlides();
  res.json(slides);
});

app.get('/api/health', async (req, res) => {
  const report = await getHealthReport();
  res.status(report.ok ? 200 : 503).json(report);
});

app.get('/api/admin/slides', async (req, res) => {
  const slides = await readSlides();
  res.json(slides);
});

app.get('/api/admin/diagnostics', async (req, res) => {
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

app.post('/api/admin/diagnostics', async (req, res) => {
  try {
    const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
    const diagnostic = sanitizeDiagnosticPayload(req.body);
    await validateDiagnosticForPublication(diagnostic);

    if (diagnostics.some((item) => item.id === diagnostic.id)) {
      return res.status(409).json({
        error: 'Диагностика с таким ID уже существует',
      });
    }

    diagnostics.push(diagnostic);
    await writeJsonArray(DIAGNOSTICS_JSON, diagnostics);

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

app.put('/api/admin/diagnostics/:id', async (req, res) => {
  try {
    const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
    const existingIndex = diagnostics.findIndex((item) => item.id === req.params.id);

    if (existingIndex < 0) {
      return res.status(404).json({
        error: 'Диагностика не найдена',
      });
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

app.delete('/api/admin/diagnostics/:id', async (req, res) => {
  const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
  const nextDiagnostics = diagnostics.filter((item) => item.id !== req.params.id);

  await writeJsonArray(DIAGNOSTICS_JSON, nextDiagnostics);

  res.json({
    ok: true,
    message: 'Диагностика удалена',
  });
});

app.get('/api/admin/diagnostics/:id/results', async (req, res) => {
  const results = await readJsonArray(DIAGNOSTIC_RESULTS_JSON);
  res.json(results.filter((result) => result.diagnosticId === req.params.id));
});

app.patch('/api/admin/results/:id/review', async (req, res) => {
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

app.get('/api/diagnostics/:id', async (req, res) => {
  const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
  const diagnostic = diagnostics.find((item) => item.id === req.params.id);

  if (!diagnostic) {
    return res.status(404).json({
      error: 'Диагностика не найдена',
    });
  }

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

app.post('/api/diagnostics/:id/check-attempt', async (req, res) => {
  const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
  const diagnostic = diagnostics.find((item) => item.id === req.params.id);

  if (!diagnostic) {
    return res.status(404).json({
      error: 'Диагностика не найдена',
    });
  }

  const studentName = String(req.body.studentName || '').trim();
  const group = String(req.body.group || '').trim();

  if (!studentName || !group) {
    return res.status(400).json({
      error: 'Укажите ФИО и группу',
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

app.post('/api/diagnostics/:id/submit', async (req, res) => {
  try {
    const diagnostics = await readJsonArray(DIAGNOSTICS_JSON);
    const diagnostic = diagnostics.find((item) => item.id === req.params.id);

    if (!diagnostic) {
      return res.status(404).json({
        error: 'Диагностика не найдена',
      });
    }

    if (getDiagnosticStatus(diagnostic) !== 'open') {
      return res.status(403).json({
        error: 'Прием ответов закрыт',
      });
    }

    const studentName = String(req.body.studentName || '').trim();
    const group = String(req.body.group || '').trim();
    const submittedAnswers = Array.isArray(req.body.answers) ? req.body.answers : [];

    if (!studentName || !group) {
      return res.status(400).json({
        error: 'Укажите ФИО и группу',
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

    res.json({
      ok: true,
      score,
      total,
      percent,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
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

app.post('/api/admin/slides', upload.single('slideFile'), async (req, res) => {
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
    } = req.body;

    const slideId = slugify(id || title);

    if (!slideId) {
      throw new Error('Не удалось создать ID препарата');
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

        slideSource = await convertSlideToDzi(prepared.inputPath, slideId);
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

app.put('/api/admin/slides/:id', upload.single('slideFile'), async (req, res) => {
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

        slideSource = await convertSlideToDzi(prepared.inputPath, currentId);
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
    }, { strict: true });

    slides[existingIndex] = updatedSlide;

    await writeSlides(slides);

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

app.delete('/api/admin/slides/:id', async (req, res) => {
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

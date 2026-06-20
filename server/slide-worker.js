import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_SLIDES_DIR = path.join(PROJECT_ROOT, 'public', 'slides');
const UPLOAD_LOG_DIR = path.join(__dirname, 'data', 'upload-logs');

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removeIfExists(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function ensureDziOutput(outputBase) {
  const dziPath = `${outputBase}.dzi`;
  const tilesDir = `${outputBase}_files`;

  if (!(await pathExists(dziPath))) {
    throw new Error('Конвертация завершилась без DZI-файла результата');
  }

  if (!(await pathExists(tilesDir))) {
    throw new Error('Конвертация завершилась без папки тайлов DZI');
  }

  const dziContent = await fs.readFile(dziPath, 'utf8');

  if (!/<Image\b/i.test(dziContent) || !/<Size\b/i.test(dziContent)) {
    throw new Error('Созданный DZI-файл не похож на корректный Deep Zoom Image');
  }
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || null,
    signal: error?.signal || null,
    stdout: String(error?.stdout || ''),
    stderr: String(error?.stderr || ''),
  };
}

async function writeUploadErrorLog({ slideId, inputPath, outputBase, error, startedAt }) {
  const timestamp = new Date().toISOString();
  const logName = `${timestamp.replace(/[:.]/g, '-')}-${String(slideId || 'slide').replace(/[^a-z0-9_-]+/gi, '-')}.json`;
  let inputStats;

  try {
    const stats = await fs.stat(inputPath);
    inputStats = {
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } catch {
    inputStats = null;
  }

  const log = {
    timestamp,
    slideId,
    inputPath,
    outputBase,
    extension: path.extname(inputPath).toLowerCase(),
    durationMs: Date.now() - startedAt,
    inputStats,
    error: serializeError(error),
  };

  await fs.mkdir(UPLOAD_LOG_DIR, { recursive: true });
  await fs.writeFile(
    path.join(UPLOAD_LOG_DIR, logName),
    `${JSON.stringify(log, null, 2)}\n`,
    'utf8'
  );
}

async function convertSlideToDzi({ taskId, inputPath, slideId }) {
  const outputBase = path.join(PUBLIC_SLIDES_DIR, slideId);
  const startedAt = Date.now();

  await fs.mkdir(PUBLIC_SLIDES_DIR, { recursive: true });
  await removeIfExists(`${outputBase}.dzi`);
  await removeIfExists(`${outputBase}_files`);
  process.send?.({
    type: 'progress',
    taskId,
    progress: 55,
    message: 'Конвертация препарата в DZI...',
  });

  try {
    await execFileAsync('vips', ['dzsave', inputPath, outputBase]);
    process.send?.({
      type: 'progress',
      taskId,
      progress: 80,
      message: 'Проверка созданного DZI...',
    });
    await ensureDziOutput(outputBase);
  } catch (error) {
    await writeUploadErrorLog({
      slideId,
      inputPath,
      outputBase,
      error,
      startedAt,
    });
    throw error;
  }

  return `/slides/${slideId}.dzi`;
}

process.on('message', async (message) => {
  if (message?.type !== 'convert') return;

  try {
    const source = await convertSlideToDzi(message);
    process.send?.({
      type: 'done',
      taskId: message.taskId,
      source,
    });
  } catch (error) {
    process.send?.({
      type: 'error',
      taskId: message.taskId,
      error: serializeError(error),
    });
  }
});

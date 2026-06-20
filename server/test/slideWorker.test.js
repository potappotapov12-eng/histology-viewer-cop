import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WORKER_PATH = path.join(PROJECT_ROOT, 'server', 'slide-worker.js');
const OUTPUT_BASE = path.join(PROJECT_ROOT, 'public', 'slides', 'worker-test-fixture');

async function createFakeVips(tempDir, { createTile = true } = {}) {
  const executablePath = path.join(tempDir, 'vips');
  const script = `#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const [, , command, inputPath, outputBase] = process.argv;
if (command !== 'dzsave' || !inputPath || !outputBase) process.exit(2);
await fs.mkdir(path.join(outputBase + '_files', '0'), { recursive: true });
await fs.writeFile(
  outputBase + '.dzi',
  '<Image TileSize="256" Overlap="0" Format="jpeg"><Size Width="512" Height="512"/></Image>'
);
${createTile ? "await fs.writeFile(path.join(outputBase + '_files', '0', '0_0.jpeg'), 'tile');" : ''}
`;

  await fs.writeFile(executablePath, script, 'utf8');
  await fs.chmod(executablePath, 0o755);
  return executablePath;
}

function runWorker(worker, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.off('message', handleMessage);
      reject(new Error('Worker не ответил за отведенное время'));
    }, 5000);

    const handleMessage = (message) => {
      if (message?.type === 'progress') return;
      clearTimeout(timeout);
      worker.off('message', handleMessage);
      resolve(message);
    };

    worker.on('message', handleMessage);
    worker.once('error', (error) => {
      clearTimeout(timeout);
      worker.off('message', handleMessage);
      reject(error);
    });
    worker.send(payload);
  });
}

test('slide worker creates and verifies DZI outside HTTP process', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'histology-slide-worker-'));
  const inputPath = path.join(tempDir, 'fixture.tiff');
  const worker = fork(WORKER_PATH, [], {
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH}`,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  t.after(async () => {
    worker.kill();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(`${OUTPUT_BASE}.dzi`, { force: true });
    await fs.rm(`${OUTPUT_BASE}_files`, { recursive: true, force: true });
  });

  await createFakeVips(tempDir);
  await fs.writeFile(inputPath, 'fixture', 'utf8');

  const result = await runWorker(worker, {
    type: 'convert',
    taskId: 'worker-test-task',
    inputPath,
    slideId: 'worker-test-fixture',
  });

  assert.equal(result.type, 'done');
  assert.equal(result.taskId, 'worker-test-task');
  assert.equal(result.source, '/slides/worker-test-fixture.dzi');

  const dziContent = await fs.readFile(`${OUTPUT_BASE}.dzi`, 'utf8');
  const tileContent = await fs.readFile(path.join(`${OUTPUT_BASE}_files`, '0', '0_0.jpeg'), 'utf8');

  assert.match(dziContent, /<Image\b/);
  assert.equal(tileContent, 'tile');
});

test('slide worker rejects DZI without image tiles', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'histology-slide-worker-'));
  const inputPath = path.join(tempDir, 'fixture.tiff');
  const worker = fork(WORKER_PATH, [], {
    env: { ...process.env, PATH: `${tempDir}:${process.env.PATH}` },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  t.after(async () => {
    worker.kill();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(`${OUTPUT_BASE}.dzi`, { force: true });
    await fs.rm(`${OUTPUT_BASE}_files`, { recursive: true, force: true });
  });

  await createFakeVips(tempDir, { createTile: false });
  await fs.writeFile(inputPath, 'fixture', 'utf8');

  const result = await runWorker(worker, {
    type: 'convert',
    taskId: 'worker-invalid-dzi-task',
    inputPath,
    slideId: 'worker-test-fixture',
  });

  assert.equal(result.type, 'error');
  assert.match(result.error.message, /не содержит ни одного поддерживаемого тайла/i);
});

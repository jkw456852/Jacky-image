import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, '..');
const runtimeDirectory = path.join(rootDirectory, 'build', 'desktop-runtime');
const runtimeMarker = path.join(runtimeDirectory, '.prepared.json');
const requiredFiles = [
  path.join(runtimeDirectory, 'backend', 'server.js'),
  path.join(runtimeDirectory, 'frontend', 'out', 'index.html'),
  path.join(runtimeDirectory, 'frontend', 'out', 'seat-cover-presets'),
  path.join(runtimeDirectory, 'node.exe'),
];

const sourcePaths = [
  'frontend/src',
  'frontend/public',
  'frontend/next.config.ts',
  'frontend/package.json',
  'frontend/package-lock.json',
  'backend/server.js',
  'backend/prompts.json',
  'backend/blacklist.json',
  'backend/seat-cover-prompts',
  'backend/package.json',
  'backend/package-lock.json',
  'scripts/prepare-electron-runtime.mjs',
];

function runResidueCleanup() {
  const cleanupScript = path.join(rootDirectory, 'scripts', 'remove-intelligent-conversation-residue.mjs');
  const result = spawnSync(process.execPath, [cleanupScript], {
    cwd: rootDirectory,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    const detail = result.error ? `: ${result.error.message}` : '';
    throw new Error(`Intelligent conversation residue cleanup failed with code ${result.status}${detail}`);
  }
}

function newestWriteTime(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'out') continue;
    newest = Math.max(newest, newestWriteTime(path.join(targetPath, entry.name)));
  }
  return newest;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function needsPrepare() {
  if (!fs.existsSync(runtimeMarker)) return true;
  if (requiredFiles.some(filePath => !fs.existsSync(filePath))) return true;
  const markerTime = fs.statSync(runtimeMarker).mtimeMs;
  const marker = JSON.parse(fs.readFileSync(runtimeMarker, 'utf8'));
  const runtimeNode = path.join(runtimeDirectory, 'node.exe');
  if (!marker.nodeExecutableSha256 || !fs.existsSync(runtimeNode) || sha256(runtimeNode) !== marker.nodeExecutableSha256) return true;
  return sourcePaths
    .map(relativePath => newestWriteTime(path.join(rootDirectory, relativePath)))
    .some(sourceTime => sourceTime > markerTime);
}

runResidueCleanup();

if (!needsPrepare()) {
  console.log('[desktop-runtime] Sources unchanged; skipping renderer/runtime rebuild.');
  process.exit(0);
}

const npmCliPath = process.env.npm_execpath
  || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const result = spawnSync(process.execPath, [npmCliPath, 'run', 'desktop:prepare'], {
  cwd: rootDirectory,
  env: process.env,
  stdio: 'inherit',
});
if (result.status !== 0) {
  const detail = result.error ? `: ${result.error.message}` : '';
  throw new Error(`Desktop runtime preparation failed with code ${result.status}${detail}`);
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, '..');
const nativeBuildDirectory = process.env.JACKY_ELECTRON_NATIVE_BUILD_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(rootDirectory, 'build'), 'JackyImageBuild');
const sourceDirectory = path.join(nativeBuildDirectory, 'out', 'make');
const packagedApplicationDirectory = path.join(nativeBuildDirectory, 'out', 'Jacky Image-win32-x64');
const innoInstallerPath = path.join(nativeBuildDirectory, 'out', 'inno', 'Jacky-Image-Setup.exe');
const releaseDirectory = path.join(rootDirectory, 'release');

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name.toLowerCase().startsWith('squirrel.')) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) copyFileWithRetry(sourcePath, destinationPath);
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function copyFileWithRetry(sourcePath, destinationPath) {
  const maxAttempts = 10;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fs.copyFileSync(sourcePath, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      const retryable = error?.code === 'EBUSY' || error?.code === 'EPERM' || error?.code === 'EACCES';
      if (!retryable || attempt === maxAttempts) break;
      console.log(`[artifacts] File is locked; retrying ${attempt}/${maxAttempts - 1}: ${destinationPath}`);
      sleep(1000);
    }
  }

  if (lastError?.code === 'EBUSY' || lastError?.code === 'EPERM' || lastError?.code === 'EACCES') {
    throw new Error(
      `无法写入构建产物：${destinationPath}\n` +
      '该文件可能正被已打开的安装程序、资源管理器预览或杀毒软件占用。请关闭 Jacky-Image-Setup.exe 及其预览窗口后重试。',
    );
  }
  throw lastError;
}

function findPresetDirectories(directory, matches = []) {
  if (!fs.existsSync(directory)) return matches;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === 'seat-cover-presets') matches.push(entryPath);
    findPresetDirectories(entryPath, matches);
  }
  return matches;
}

function validatePackagedPresetAssets() {
  const presetDirectories = findPresetDirectories(packagedApplicationDirectory);
  if (presetDirectories.length === 0) {
    throw new Error('Packaged desktop runtime does not contain seat-cover-presets.');
  }
  const emptyDirectories = presetDirectories.filter(directory =>
    fs.readdirSync(directory).some(file => file.toLowerCase().endsWith('.webp')) === false,
  );
  if (emptyDirectories.length > 0) {
    throw new Error(`Packaged seat-cover preset directory is empty: ${emptyDirectories.join(', ')}`);
  }
  console.log(`[artifacts] Verified seat-cover preset assets in ${presetDirectories.length} packaged target(s).`);
}

if (!fs.existsSync(sourceDirectory) || !fs.existsSync(packagedApplicationDirectory)) {
  throw new Error(`Electron artifacts were not found: ${sourceDirectory}`);
}

validatePackagedPresetAssets();
fs.rmSync(releaseDirectory, { recursive: true, force: true });
copyDirectory(sourceDirectory, releaseDirectory);
if (!fs.existsSync(innoInstallerPath)) throw new Error(`Windows installer was not found: ${innoInstallerPath}`);
copyFileWithRetry(innoInstallerPath, path.join(releaseDirectory, 'Jacky-Image-Setup.exe'));

const artifacts = [];
function collectFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(entryPath);
    else if (entry.isFile()) artifacts.push(entryPath);
  }
}
collectFiles(releaseDirectory);

if (process.env.JACKY_REQUIRE_WINDOWS_SIGNATURE === '1' && process.platform === 'win32') {
  const setup = artifacts.find(file => /Jacky-Image-Setup\.exe$/i.test(file));
  if (!setup) throw new Error('Required Windows signature gate could not find Jacky-Image-Setup.exe');
  const escaped = setup.replace(/'/g, "''");
  const result = require('node:child_process').spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`,
  ], { encoding: 'utf8' });
  if (result.status !== 0 || result.stdout.trim() !== 'Valid') {
    throw new Error(`Windows Authenticode signature gate failed for ${setup}: ${result.stdout.trim() || result.stderr.trim()}`);
  }
  console.log(`[artifacts] Authenticode signature verified: ${setup}`);
}

console.log('Electron distributables copied to:');
for (const artifact of artifacts) console.log(`- ${artifact}`);

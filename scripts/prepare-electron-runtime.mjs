import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, '..');
// Keep the staging directory identical to ensure-desktop-prepare, forge, and
// the packaged Electron runtime. A caller-controlled alternate directory can
// otherwise leave stale or unverified files in the shipped application.
const runtimeDirectory = path.join(rootDirectory, 'build', 'desktop-runtime');
const electronCacheDirectory = path.join(rootDirectory, 'build', 'electron-cache');
const runtimeBackendDirectory = path.join(runtimeDirectory, 'backend');
const runtimeFrontendDirectory = path.join(runtimeDirectory, 'frontend', 'out');
const backendDirectory = path.join(rootDirectory, 'backend');
const frontendOutputDirectory = path.join(rootDirectory, 'frontend', 'out');
const preparedMarkerFile = path.join(runtimeDirectory, '.prepared.json');
const frontendPresetDirectory = path.join(frontendOutputDirectory, 'seat-cover-presets');
const runtimePresetDirectory = path.join(runtimeFrontendDirectory, 'seat-cover-presets');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function findFile(directory, expectedName) {
  if (!directory || !fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === expectedName) return entryPath;
    if (entry.isDirectory()) {
      const nestedMatch = findFile(entryPath, expectedName);
      if (nestedMatch) return nestedMatch;
    }
  }
  return null;
}

function copyDirectory(sourceDirectory, destinationDirectory) {
  fs.mkdirSync(destinationDirectory, { recursive: true });
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) {
      if (filesEqual(sourcePath, destinationPath)) continue;
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function removeDirectoryWithin(targetDirectory, parentDirectory) {
  const target = path.resolve(targetDirectory);
  const parent = path.resolve(parentDirectory) + path.sep;
  if (!target.startsWith(parent)) throw new Error(`Refusing to remove directory outside ${parentDirectory}: ${target}`);
  if (!fs.existsSync(target)) return;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) removeDirectoryWithin(entryPath, target);
    else fs.unlinkSync(entryPath);
  }
  fs.rmdirSync(target);
}

function hashFiles(filePaths) {
  const hash = crypto.createHash('sha256');
  for (const filePath of [...filePaths].sort((a, b) => a.localeCompare(b))) {
    hash.update(path.basename(filePath));
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function filesEqual(firstPath, secondPath) {
  if (!fs.existsSync(firstPath) || !fs.existsSync(secondPath)) return false;
  const first = fs.statSync(firstPath);
  const second = fs.statSync(secondPath);
  if (first.size !== second.size) return false;
  return fs.readFileSync(firstPath).equals(fs.readFileSync(secondPath));
}

function collectCodeFiles(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'studio') continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectCodeFiles(entryPath, output);
    else if (entry.isFile()) output.push(entryPath);
  }
  return output;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function findFiles(directory, expectedName, matches = []) {
  if (!directory || !fs.existsSync(directory)) return matches;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === expectedName) matches.push(entryPath);
    else if (entry.isDirectory()) findFiles(entryPath, expectedName, matches);
  }
  return matches;
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function validateSeatCoverPresetAssets() {
  const sourceFiles = listFiles(frontendPresetDirectory).filter(file => file.endsWith('.webp'));
  const runtimeFiles = listFiles(runtimePresetDirectory).filter(file => file.endsWith('.webp'));
  if (sourceFiles.length === 0) {
    throw new Error(`Seat-cover preset assets are missing from the frontend output: ${frontendPresetDirectory}`);
  }
  const missing = sourceFiles.filter(file => !runtimeFiles.includes(file));
  if (missing.length > 0) {
    throw new Error(`Seat-cover preset assets were not copied into the desktop runtime: ${missing.join(', ')}`);
  }
  console.log(`[desktop-runtime] Verified ${sourceFiles.length} seat-cover preset assets.`);
}

if (!fs.existsSync(frontendOutputDirectory)) throw new Error(`Frontend output was not found: ${frontendOutputDirectory}`);

const electronPackagePath = path.join(rootDirectory, 'node_modules', 'electron', 'package.json');
const electronPackage = JSON.parse(fs.readFileSync(electronPackagePath, 'utf8'));
const electronArchiveName = `electron-v${electronPackage.version}-${process.platform}-${process.arch}.zip`;
const defaultElectronCache = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
  : process.platform === 'darwin'
    ? path.join(process.env.HOME || '', 'Library', 'Caches', 'electron')
    : path.join(process.env.HOME || '', '.cache', 'electron');
const electronArchives = findFiles(process.env.ELECTRON_CACHE || defaultElectronCache, electronArchiveName);
if (electronArchives.length > 1) throw new Error(`Found multiple Electron archives with the same name; refusing ambiguous cache selection: ${electronArchives.join(', ')}`);
const sourceElectronArchive = electronArchives[0];
if (!sourceElectronArchive) throw new Error(`Electron archive was not found in the local cache: ${electronArchiveName}`);
const expectedElectronArchiveHash = String(process.env.ELECTRON_ARCHIVE_SHA256 || '').trim().toLowerCase();
if (process.env.JACKY_REQUIRE_ELECTRON_ARCHIVE_HASH === '1' && !/^[a-f0-9]{64}$/.test(expectedElectronArchiveHash)) {
  throw new Error('JACKY_REQUIRE_ELECTRON_ARCHIVE_HASH=1 requires ELECTRON_ARCHIVE_SHA256 (64 hex characters)');
}
if (expectedElectronArchiveHash) {
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(sourceElectronArchive)).digest('hex');
  if (actualHash !== expectedElectronArchiveHash) throw new Error(`Electron archive SHA-256 mismatch: expected ${expectedElectronArchiveHash}, got ${actualHash}`);
  console.log(`[desktop-runtime] Verified Electron archive SHA-256: ${actualHash}`);
}
fs.mkdirSync(electronCacheDirectory, { recursive: true });
fs.copyFileSync(sourceElectronArchive, path.join(electronCacheDirectory, electronArchiveName));

fs.mkdirSync(runtimeDirectory, { recursive: true });
if (fs.existsSync(runtimeBackendDirectory)) removeDirectoryWithin(runtimeBackendDirectory, runtimeDirectory);
fs.mkdirSync(runtimeBackendDirectory, { recursive: true });
fs.mkdirSync(path.dirname(runtimeFrontendDirectory), { recursive: true });
const previousMarker = readJson(preparedMarkerFile) || {};

const backendPackageFiles = ['package.json', 'package-lock.json'].map(fileName => path.join(backendDirectory, fileName));
const backendDependenciesHash = hashFiles(backendPackageFiles);
const runtimePackageFiles = backendPackageFiles.map(filePath => path.join(runtimeDirectory, path.basename(filePath)));
const canAdoptBackendDependencies = fs.existsSync(path.join(runtimeDirectory, 'node_modules'))
  && backendPackageFiles.every((sourcePath, index) => filesEqual(sourcePath, runtimePackageFiles[index]));
const backendDependenciesReady = fs.existsSync(path.join(runtimeDirectory, 'node_modules'))
  && (previousMarker.backendDependenciesHash === backendDependenciesHash || canAdoptBackendDependencies);

for (const fileName of ['package.json', 'package-lock.json']) {
  fs.copyFileSync(path.join(backendDirectory, fileName), path.join(runtimeDirectory, fileName));
}

if (backendDependenciesReady) {
  console.log('[desktop-runtime] Backend dependencies unchanged; reusing existing node_modules.');
} else {
  console.log('[desktop-runtime] Backend dependencies changed; running npm ci once.');
  const npmCliPath = process.env.npm_execpath
    || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const installResult = spawnSync(process.execPath, [npmCliPath, 'ci', '--omit=dev'], {
    cwd: runtimeDirectory,
    env: process.env,
    stdio: 'inherit',
  });
  if (installResult.status !== 0) {
    const detail = installResult.error ? `: ${installResult.error.message}` : '';
    throw new Error(`Desktop backend dependency installation failed with code ${installResult.status}${detail}`);
  }
}

for (const fileName of ['server.js', 'prompts.json', 'blacklist.json']) {
  const sourcePath = path.join(backendDirectory, fileName);
  if (fs.existsSync(sourcePath)) fs.copyFileSync(sourcePath, path.join(runtimeBackendDirectory, fileName));
}
const seatCoverPromptsDirectory = path.join(backendDirectory, 'seat-cover-prompts');
if (fs.existsSync(seatCoverPromptsDirectory)) {
  const runtimeSeatCoverPromptsDirectory = path.join(runtimeBackendDirectory, 'seat-cover-prompts');
  if (fs.existsSync(runtimeSeatCoverPromptsDirectory)) removeDirectoryWithin(runtimeSeatCoverPromptsDirectory, runtimeBackendDirectory);
  copyDirectory(seatCoverPromptsDirectory, runtimeSeatCoverPromptsDirectory);
}

if (fs.existsSync(runtimeFrontendDirectory)) {
  removeDirectoryWithin(runtimeFrontendDirectory, runtimeDirectory);
}
copyDirectory(frontendOutputDirectory, runtimeFrontendDirectory);
validateSeatCoverPresetAssets();
console.log('[desktop-runtime] Frontend output updated.');

const runtimeExecutableName = process.platform === 'win32' ? 'node.exe' : 'node';
const runtimeExecutablePath = path.join(runtimeDirectory, runtimeExecutableName);
const expectedNodeHash = hashFile(process.execPath);
const runtimeNodeHash = fs.existsSync(runtimeExecutablePath) ? hashFile(runtimeExecutablePath) : '';
if (!fs.existsSync(runtimeExecutablePath) || previousMarker.nodeVersion !== process.version || runtimeNodeHash !== expectedNodeHash) {
  try {
    fs.copyFileSync(process.execPath, runtimeExecutablePath);
    if (process.platform !== 'win32') fs.chmodSync(runtimeExecutablePath, 0o755);
  } catch (error) {
    throw new Error(`Could not update the embedded Node.js runtime. Exit Jacky Image from the system tray and retry. ${error instanceof Error ? error.message : String(error)}`);
  }
} else {
  console.log(`[desktop-runtime] Embedded Node.js ${process.version} unchanged; SHA-256 verified.`);
}

const rootLicensePath = path.join(rootDirectory, 'LICENSE');
if (fs.existsSync(rootLicensePath)) fs.copyFileSync(rootLicensePath, path.join(runtimeDirectory, 'LICENSE'));

fs.writeFileSync(preparedMarkerFile, `${JSON.stringify({
  preparedAt: new Date().toISOString(),
  nodeVersion: process.version,
  nodeExecutableSha256: expectedNodeHash,
  platform: process.platform,
  arch: process.arch,
  backendDependenciesHash,
}, null, 2)}\n`);

console.log(`Desktop runtime prepared incrementally: ${runtimeDirectory}`);
console.log(`Electron archive prepared: ${path.join(electronCacheDirectory, electronArchiveName)}`);

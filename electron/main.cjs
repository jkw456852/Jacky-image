const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, safeStorage, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { recoverLegacyLocalStorage } = require('./legacy-storage.cjs');
const { createUpdateManager } = require('./update-manager.cjs');
const {
  copyDirectoryContents,
  deleteAppBlob,
  deleteAppDocument,
  deleteCachedImages,
  getBackendImageCacheDirectory,
  getDefaultStoragePaths,
  getStorageConfigPath,
  getTaskDatabasePath,
  loadPreferences,
  loadStoragePaths,
  loadUsageHistory,
  listAppBlobKeys,
  normalizeStoragePaths,
  readCachedImage,
  readAppBlob,
  readAppDocument,
  saveDownload,
  savePreferences,
  saveStoragePaths,
  saveUsageHistory,
  writeAppBlob,
  writeAppDocument,
  writeCachedImage,
} = require('./desktop-storage.cjs');
const {
  cloneAndValidateRegistry,
  getSecureRegistryPath,
  loadSecureRegistry,
  saveSecureRegistry,
} = require('./model-registry-store.cjs');
const {
  buildTaskNotification,
  buildTrayTooltip,
  collectTaskTransitions,
  sanitizeTaskSummaries,
} = require('./task-status.cjs');

const APP_NAME = 'Jacky Image';
const LEGACY_BRAND_SLUG = Buffer.from('bm92YQ==', 'base64').toString('utf8');
const LEGACY_APP_NAME = `${LEGACY_BRAND_SLUG[0].toUpperCase()}${LEGACY_BRAND_SLUG.slice(1)} Image`;
const BACKEND_START_TIMEOUT_MS = 30_000;
const BACKEND_STOP_TIMEOUT_MS = 8_000;
const DEFAULT_DESKTOP_PORT = 32145;
const WINDOWS_TITLE_BAR_HEIGHT = 42;

// Squirrel.Windows launches the application with these lifecycle arguments
// while installing, updating, or uninstalling. The app must handle them
// before acquiring the single-instance lock or starting the backend services;
// otherwise Setup.exe can report that installation failed even though files
// were copied successfully.
function handleSquirrelEvent() {
  if (process.platform !== 'win32') return false;

  const squirrelEvent = process.argv.find(argument => argument.startsWith('--squirrel-'));
  if (!squirrelEvent) return false;

  const updateExecutable = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
  const applicationExecutable = path.basename(process.execPath);
  const spawnUpdate = args => {
    try {
      const child = spawn(updateExecutable, args, { detached: true, windowsHide: true });
      child.unref();
    } catch {
      // Squirrel will still finish the file operation; shortcut refresh is best effort.
    }
  };

  switch (squirrelEvent) {
    case '--squirrel-install':
    case '--squirrel-updated':
      spawnUpdate(['--createShortcut', applicationExecutable]);
      break;
    case '--squirrel-uninstall':
      spawnUpdate(['--removeShortcut', applicationExecutable]);
      break;
    case '--squirrel-obsolete':
      break;
    default:
      return false;
  }

  return true;
}

if (handleSquirrelEvent()) {
  // Do not start Electron windows, tray, or the local backend during
  // Squirrel's lifecycle callbacks. Update.exe is detached above.
  process.exit(0);
}

if (process.argv.includes('--disable-gpu')) {
  app.disableHardwareAcceleration();
}

if (!app.isPackaged) {
  const developmentDataArgument = process.argv.find(argument => argument.startsWith('--jacky-dev-app-data='));
  if (developmentDataArgument) {
    const developmentDataDirectory = path.resolve(developmentDataArgument.slice('--jacky-dev-app-data='.length));
    app.setPath('appData', developmentDataDirectory);
  }
}

function configureUserDataDirectory() {
  const appDataDirectory = app.getPath('appData');
  const targetDirectory = path.join(appDataDirectory, APP_NAME);
  const legacyDirectory = path.join(appDataDirectory, LEGACY_APP_NAME);
  if (!fs.existsSync(targetDirectory) && fs.existsSync(legacyDirectory)) {
    try {
      fs.cpSync(legacyDirectory, targetDirectory, { recursive: true, errorOnExist: false });
    } catch (error) {
      process.stderr.write(`Could not migrate legacy user data: ${error.message}\n`);
    }
  }
  app.setPath('userData', targetDirectory);
}

configureUserDataDirectory();

let mainWindow = null;
let updateManager = null;
const repaintWindowPayloads = new Map();
const repaintWindows = new Map();
const promptEditorWindowPayloads = new Map();
const promptEditorWindows = new Map();
const promptEditorWindowSessionIds = new WeakMap();
let promptEditorWindowSingleton = null;
let tray = null;
let backendProcess = null;
let backendPort = null;
let backendControlToken = null;
let backendRendererSessionToken = null;
let backendReady = false;
let isQuitting = false;
let hasShownTrayNotice = false;
let logFilePath = null;
let logStream = null;
let legacyLocalStorageMigration = null;
let modelRegistryFilePath = null;
let modelRegistry = null;
let storageConfigFilePath = null;
let storageDefaults = null;
let storagePaths = null;
const approvedStorageDirectories = new Map();
const expectedBackendStops = new WeakSet();
let desktopPreferences = {};
let hasReceivedTaskSnapshot = false;
let previousTaskStatuses = new Map();
let currentTaskSummaries = [];

function sanitizeLogValue(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***')
    .replace(/((?:api[-_ ]?key|authorization)["']?\s*[:=]\s*["']?)[^\s,"']+/gi, '$1***');
}

function writeLog(scope, value) {
  const line = `[${new Date().toISOString()}] [${scope}] ${sanitizeLogValue(value)}`;
  if (logStream) logStream.write(`${line}\n`);
  if (!app.isPackaged) process.stdout.write(`${line}\n`);
}

function initializeLogging() {
  const logDirectory = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDirectory, { recursive: true });
  logFilePath = path.join(logDirectory, 'jacky-image.log');

  try {
    if (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > 5 * 1024 * 1024) {
      const previousLogPath = path.join(logDirectory, 'jacky-image.previous.log');
      fs.rmSync(previousLogPath, { force: true });
      fs.renameSync(logFilePath, previousLogPath);
    }
  } catch {
    // Logging must never prevent the application from starting.
  }

  logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
  writeLog('Electron', `${APP_NAME} ${app.getVersion()} starting`);
  writeLog('Electron', `User data: ${app.getPath('userData')}`);
}

function getConfiguredDesktopPort() {
  const configured = Number(process.env.JACKY_DESKTOP_PORT || DEFAULT_DESKTOP_PORT);
  if (!Number.isInteger(configured) || configured < 1024 || configured > 65535) {
    throw new Error(`Invalid JACKY_DESKTOP_PORT: ${process.env.JACKY_DESKTOP_PORT}`);
  }
  return configured;
}

function getDesktopRuntimeDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'desktop-runtime')
    : path.join(app.getAppPath(), 'build', 'desktop-runtime');
}

function ensurePortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', error => {
      if (error?.code === 'EADDRINUSE') {
        reject(new Error(`Jacky Image 固定端口 ${port} 已被占用。请关闭占用该端口的程序后重试。`));
        return;
      }
      reject(error);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(error => error ? reject(error) : resolve());
    });
  });
}

function checkBackend(port) {
  return new Promise(resolve => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: '/api/jacky/queue-status',
      headers: { 'x-jacky-renderer-token': backendRendererSessionToken || '' },
      timeout: 1_000,
    }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolve(false));
  });
}

async function waitForBackend(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < BACKEND_START_TIMEOUT_MS) {
    if (!backendProcess || backendProcess.exitCode !== null) {
      throw new Error('The local service exited before it became ready.');
    }
    if (await checkBackend(port)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`The local service did not start within ${BACKEND_START_TIMEOUT_MS / 1000} seconds.`);
}

function initializeModelRegistry() {
  modelRegistryFilePath = getSecureRegistryPath(app.getPath('appData'), APP_NAME);
  modelRegistry = loadSecureRegistry(modelRegistryFilePath, safeStorage);
  if (modelRegistry) {
    try {
      const payload = JSON.parse(fs.readFileSync(modelRegistryFilePath, 'utf8'));
      if (payload?.version !== 3 || payload?.encryption !== 'electron-safeStorage') {
        modelRegistry = saveSecureRegistry(modelRegistryFilePath, modelRegistry, safeStorage);
        writeLog('Electron', `Migrated model registry to encrypted format at ${modelRegistryFilePath}`);
      }
    } catch (error) {
      writeLog('Electron', `Could not convert legacy encrypted model registry: ${error.message}`);
    }
    writeLog('Electron', `Loaded model registry from ${modelRegistryFilePath}`);
    return;
  }

  const recovered = recoverLegacyLocalStorage(app.getPath('userData'), null);
  const legacyRegistryKey = `${LEGACY_BRAND_SLUG}-model-registry`;
  const rawRegistry = recovered?.values?.['jacky-model-registry'] || recovered?.values?.[legacyRegistryKey];
  if (typeof rawRegistry !== 'string') {
    writeLog('Electron', `No secure model registry or legacy API configuration found; target is ${modelRegistryFilePath}`);
    return;
  }

  try {
    const legacyRegistry = cloneAndValidateRegistry(JSON.parse(rawRegistry));
    modelRegistry = saveSecureRegistry(modelRegistryFilePath, legacyRegistry, safeStorage, {
      migratedFromPort: recovered.sourcePort,
    });
    writeLog('Electron', `Migrated model registry from local storage port ${recovered.sourcePort} to ${modelRegistryFilePath}`);
  } catch (error) {
    writeLog('Electron', `Legacy model registry migration failed: ${error.message}`);
  }
}

function getModelRegistryResponse() {
  const exposeModel = model => {
    const { apiKey: _apiKey, encryptedApiKey: _encryptedApiKey, ...metadata } = model;
    return { ...metadata, apiKeyConfigured: Boolean(model.apiKey) };
  };
  return {
    ok: true,
    registry: modelRegistry ? {
      ...cloneAndValidateRegistry(modelRegistry),
      imageModels: modelRegistry.imageModels.map(exposeModel),
      textModels: modelRegistry.textModels.map(exposeModel),
    } : null,
  };
}

function credentialEndpointKey(model) {
  try {
    const url = new URL(String(model?.baseUrl || '').trim());
    return `${String(model?.protocol || '').trim().toLowerCase()}|${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return `${String(model?.protocol || '').trim().toLowerCase()}|invalid`;
  }
}

function saveModelRegistryFromRenderer(value) {
  const normalizeKeys = (nextModels, existingModels) => nextModels.map(model => {
    const existing = existingModels.find(candidate => candidate.id === model.id);
    if (Object.prototype.hasOwnProperty.call(model, 'apiKey')) {
      throw new Error('API Key 必须通过安全设置窗口配置');
    }
    const { apiKeyConfigured: _apiKeyConfigured, encryptedApiKey: _encryptedApiKey, ...rest } = model;
    const sameCredentialEndpoint = existing && credentialEndpointKey(existing) === credentialEndpointKey(model);
    return { ...rest, apiKey: (sameCredentialEndpoint ? existing?.apiKey : '') || '' };
  });
  const next = cloneAndValidateRegistry(value);
  const merged = {
    ...next,
    imageModels: normalizeKeys(next.imageModels, modelRegistry?.imageModels || []),
    textModels: normalizeKeys(next.textModels, modelRegistry?.textModels || []),
  };
  modelRegistry = saveSecureRegistry(modelRegistryFilePath, merged, safeStorage);
  writeLog('Electron', `Saved model registry to ${modelRegistryFilePath}`);
  void syncModelRegistryToBackend();
  return { ok: true, registry: getModelRegistryResponse().registry };
}

function promptForApiKey() {
  return new Promise(resolve => {
    const scriptPath = path.join(__dirname, 'windows-secret-prompt.ps1');
    let script;
    try {
      script = fs.readFileSync(scriptPath, 'utf8');
    } catch {
      resolve(null);
      return;
    }
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodedScript,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (output.length < 16 * 1024) output += chunk;
    });
    child.once('error', () => resolve(null));
    child.once('close', code => {
      const secret = output.trim();
      resolve(code === 0 && secret ? secret : null);
    });
  });
}

async function configureModelSecretFromMain(event, value) {
  if (event.sender !== mainWindow?.webContents) return { ok: false, error: 'Unauthorized renderer' };
  const kind = value?.kind === 'image' || value?.kind === 'text' ? value.kind : null;
  const modelId = typeof value?.modelId === 'string' ? value.modelId.trim() : '';
  if (!kind || !modelId || !modelRegistry) return { ok: false, error: 'Invalid model secret request' };
  const models = kind === 'image' ? modelRegistry.imageModels : modelRegistry.textModels;
  const model = models.find(candidate => candidate.id === modelId);
  if (!model) return { ok: false, error: 'Model not found' };
  const secret = await promptForApiKey();
  if (!secret) return { ok: false, cancelled: true };
  model.apiKey = secret;
  modelRegistry = saveSecureRegistry(modelRegistryFilePath, modelRegistry, safeStorage);
  await syncModelRegistryToBackend();
  return { ok: true, configured: true, registry: getModelRegistryResponse().registry };
}

function syncModelRegistryToBackend() {
  return new Promise((resolve, reject) => {
    if (!backendPort || !backendControlToken) {
      resolve();
      return;
    }
    const payload = Buffer.from(JSON.stringify(modelRegistry || { imageModels: [], textModels: [], defaults: {} }));
    const request = http.request({
      host: '127.0.0.1',
      port: backendPort,
      path: '/api/jacky/desktop/model-registry',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        'x-jacky-desktop-token': backendControlToken,
      },
      timeout: 3_000,
    }, response => {
      response.resume();
      response.once('end', () => response.statusCode === 200
        ? resolve()
        : reject(new Error(`Model registry sync failed: HTTP ${response.statusCode}`)));
    });
    request.once('timeout', () => request.destroy(new Error('Model registry sync timed out')));
    request.once('error', reject);
    request.end(payload);
  });
}

function initializeDesktopStorage() {
  storageDefaults = getDefaultStoragePaths({
    userDataDirectory: app.getPath('userData'),
    downloadsDirectory: app.getPath('downloads'),
  });
  storageConfigFilePath = getStorageConfigPath(app.getPath('appData'), APP_NAME);
  storagePaths = loadStoragePaths(storageConfigFilePath, storageDefaults);
  storagePaths = applyInstallerStorageOptions(storagePaths);
  migrateLegacyServiceDatabase();
  desktopPreferences = migrateLegacyPreferenceKeys(loadPreferences(storagePaths));
  savePreferences(storagePaths, desktopPreferences);
  writeLog('Electron', `Usage records: ${storagePaths.recordsDirectory}`);
  writeLog('Electron', `Image cache: ${storagePaths.cacheDirectory}`);
  writeLog('Electron', `Downloads: ${storagePaths.downloadsDirectory}`);
}

function migrateLegacyServiceDatabase() {
  const serviceDirectory = path.join(storagePaths.recordsDirectory, 'service');
  const legacyBase = path.join(serviceDirectory, `${LEGACY_BRAND_SLUG}-tasks.sqlite`);
  const currentBase = path.join(serviceDirectory, 'jacky-tasks.sqlite');
  fs.mkdirSync(serviceDirectory, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${legacyBase}${suffix}`;
    const target = `${currentBase}${suffix}`;
    if (!fs.existsSync(target) && fs.existsSync(source)) fs.copyFileSync(source, target);
  }
}

function migrateLegacyPreferenceKeys(preferences) {
  const next = { ...(preferences || {}) };
  const legacyPrefix = `${LEGACY_BRAND_SLUG}-`;
  for (const [key, value] of Object.entries(preferences || {})) {
    if (!key.startsWith(legacyPrefix)) continue;
    const currentKey = `jacky-${key.slice(legacyPrefix.length)}`;
    if (next[currentKey] == null) next[currentKey] = value;
    delete next[key];
  }
  return next;
}

async function saveDesktopStoragePaths(value) {
  const next = normalizeStoragePaths(value, storageDefaults);
  const restartRequired = next.recordsDirectory !== storagePaths.recordsDirectory
    || next.cacheDirectory !== storagePaths.cacheDirectory;
  const storageKinds = { recordsDirectory: 'records', cacheDirectory: 'cache', downloadsDirectory: 'downloads' };
  for (const [key, current] of Object.entries(storagePaths)) {
    if (next[key] !== current && approvedStorageDirectories.get(storageKinds[key]) !== next[key]) {
      throw new Error(`目录 ${key} 必须先通过系统目录选择器确认`);
    }
  }
  if (restartRequired) {
    // 后端持有 SQLite/WAL 和图片目录句柄，迁移前必须先停服，避免复制到不一致快照。
    await stopBackend();
  }
  try {
    if (next.recordsDirectory !== storagePaths.recordsDirectory) {
      copyDirectoryContents(storagePaths.recordsDirectory, next.recordsDirectory);
    }
    if (next.cacheDirectory !== storagePaths.cacheDirectory) {
      copyDirectoryContents(storagePaths.cacheDirectory, next.cacheDirectory);
    }
  } catch (error) {
    if (restartRequired) await startBackend().catch(() => undefined);
    throw error;
  }
  storagePaths = saveStoragePaths(storageConfigFilePath, next, storageDefaults);
  for (const [kind, selected] of approvedStorageDirectories) {
    if (!Object.values(storagePaths).includes(selected)) approvedStorageDirectories.delete(kind);
  }
  desktopPreferences = migrateLegacyPreferenceKeys(loadPreferences(storagePaths));
  savePreferences(storagePaths, desktopPreferences);
  if (restartRequired) {
    await startBackend();
  }
  writeLog('Electron', 'Desktop storage directories updated');
  return { ok: true, paths: storagePaths, restartRequired };
}

function saveDesktopPreferences(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const { ['jacky-model-registry']: _registry, ['jacky-jobs']: _jobs, ...safePreferences } = input;
  desktopPreferences = savePreferences(storagePaths, safePreferences);
  return desktopPreferences;
}

async function startBackend() {
  backendPort = getConfiguredDesktopPort();
  initializeDesktopStorage();
  initializeModelRegistry();
  await ensurePortAvailable(backendPort);
  legacyLocalStorageMigration = recoverLegacyLocalStorage(app.getPath('userData'), backendPort);
  if (legacyLocalStorageMigration) {
    writeLog('Electron', `Found legacy local storage on port ${legacyLocalStorageMigration.sourcePort}; migration is ready`);
  }
  backendControlToken = crypto.randomBytes(32).toString('hex');
  if (!backendRendererSessionToken) backendRendererSessionToken = crypto.randomBytes(32).toString('hex');

  const userDataDirectory = app.getPath('userData');
  const imageDirectory = getBackendImageCacheDirectory(storagePaths);
  const databasePath = getTaskDatabasePath(storagePaths);
  const runtimeDirectory = getDesktopRuntimeDirectory();
  const nodeExecutable = path.join(runtimeDirectory, process.platform === 'win32' ? 'node.exe' : 'node');
  const serverPath = path.join(runtimeDirectory, 'backend', 'server.js');

  fs.mkdirSync(imageDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  if (!fs.existsSync(nodeExecutable)) {
    throw new Error(`Desktop Node runtime was not found: ${nodeExecutable}`);
  }
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Backend entry was not found: ${serverPath}`);
  }

  writeLog('Electron', `Starting local service on 127.0.0.1:${backendPort}`);
  backendProcess = spawn(nodeExecutable, [serverPath], {
    cwd: userDataDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JACKY_DESKTOP_MODE: '1',
      HOSTNAME: '127.0.0.1',
      PORT: String(backendPort),
      JACKY_TASK_DB: databasePath,
      JACKY_IMAGE_DIR: imageDirectory,
      JACKY_DESKTOP_CONTROL_TOKEN: backendControlToken,
      JACKY_RENDERER_SESSION_TOKEN: backendRendererSessionToken,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backendProcess.stdout?.setEncoding('utf8');
  backendProcess.stderr?.setEncoding('utf8');
  backendProcess.stdout?.on('data', data => writeLog('Backend', data.toString().trimEnd()));
  backendProcess.stderr?.on('data', data => writeLog('Backend error', data.toString().trimEnd()));
  backendProcess.once('error', error => writeLog('Backend error', error.stack || error.message));
  const child = backendProcess;
  child.once('exit', (code, signal) => {
    writeLog('Backend', `Exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    backendReady = false;
    if (!expectedBackendStops.has(child) && !isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: `${APP_NAME} local service stopped`,
        message: 'The local service stopped unexpectedly.',
        detail: logFilePath ? `See the log for details:\n${logFilePath}` : undefined,
      }).finally(() => app.quit());
    }
  });

  await waitForBackend(backendPort);
  await syncModelRegistryToBackend();
  backendReady = true;
  await installRendererSessionCookie();
  writeLog('Electron', 'Local service is ready');
}

function applyInstallerStorageOptions(currentPaths) {
  const optionsPath = path.join(app.getPath('appData'), APP_NAME, 'config', 'installer-options.json');
  if (!fs.existsSync(optionsPath)) return currentPaths;
  try {
    const stat = fs.statSync(optionsPath);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('安装器数据目录配置无效');
    const payload = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
    const projectRoot = typeof payload?.projectDataDirectory === 'string' ? payload.projectDataDirectory.trim() : '';
    if (payload?.version !== 1 || !projectRoot || !path.isAbsolute(projectRoot) || projectRoot.includes('\0')) throw new Error('安装器指定的项目数据目录无效');
    const next = normalizeStoragePaths({
      recordsDirectory: path.join(projectRoot, 'records'),
      cacheDirectory: path.join(projectRoot, 'images'),
      downloadsDirectory: currentPaths.downloadsDirectory,
    }, storageDefaults);
    if (next.recordsDirectory !== currentPaths.recordsDirectory) copyDirectoryContents(currentPaths.recordsDirectory, next.recordsDirectory);
    if (next.cacheDirectory !== currentPaths.cacheDirectory) copyDirectoryContents(currentPaths.cacheDirectory, next.cacheDirectory);
    const saved = saveStoragePaths(storageConfigFilePath, next, storageDefaults);
    fs.rmSync(optionsPath, { force: true });
    return saved;
  } catch (error) {
    writeLog('Electron error', `Installer storage options ignored: ${error?.message || error}`);
    return currentPaths;
  }
}

function requestBackendShutdown() {
  return new Promise(resolve => {
    if (!backendProcess || backendProcess.exitCode !== null || !backendPort || !backendControlToken) {
      resolve();
      return;
    }

    const finish = () => resolve();
    const request = http.request({
      host: '127.0.0.1',
      port: backendPort,
      path: '/api/jacky/desktop/shutdown',
      method: 'POST',
      headers: {
        'x-jacky-desktop-token': backendControlToken,
        'content-length': '0',
      },
      timeout: 1_500,
    }, response => {
      response.resume();
      response.once('end', finish);
    });
    request.once('timeout', () => {
      request.destroy();
      finish();
    });
    request.once('error', finish);
    request.end();
  });
}

async function stopBackend() {
  if (!backendProcess || backendProcess.exitCode !== null) return;

  expectedBackendStops.add(backendProcess);

  writeLog('Electron', 'Stopping local service');
  await requestBackendShutdown();

  await Promise.race([
    new Promise(resolve => backendProcess.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, BACKEND_STOP_TIMEOUT_MS)),
  ]);

  if (backendProcess.exitCode === null) {
    writeLog('Electron', 'Local service did not stop in time; terminating it');
    backendProcess.kill();
    await Promise.race([
      new Promise(resolve => backendProcess.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ]);
    if (backendProcess.exitCode === null) {
      throw new Error('本地服务未能退出，已取消存储目录迁移');
    }
  }
}

function attachWindowDiagnostics(window) {
  let lastRendererDiagnostic = "";
  let lastRendererDiagnosticAt = 0;

  window.webContents.on('console-message', (_event, details) => {
    const message = typeof details?.message === 'string' ? details.message.trim() : '';
    // Chromium can emit empty console messages during high-frequency input (for example wheel zoom).
    // They carry no diagnostic value and otherwise become noisy `(unknown:0)` entries in the log.
    if (!message) return;

    const diagnostic = `${message} (${details?.sourceId || 'unknown'}:${details?.lineNumber || 0})`;
    const now = Date.now();
    if (diagnostic === lastRendererDiagnostic && now - lastRendererDiagnosticAt < 250) return;
    lastRendererDiagnostic = diagnostic;
    lastRendererDiagnosticAt = now;
    writeLog('Renderer', diagnostic);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    writeLog('Renderer error', `Process gone: ${JSON.stringify(details)}`);
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    writeLog('Renderer error', `Load failed ${errorCode}: ${errorDescription} (${validatedURL})`);
  });
}

function createApplicationMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Hide to tray', click: () => mainWindow?.close() },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${APP_NAME}` },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        {
          label: 'Developer Tools (F12)',
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual size' },
        { role: 'zoomIn', label: 'Zoom in' },
        { role: 'zoomOut', label: 'Zoom out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Full screen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open runtime log',
          click: () => logFilePath && shell.openPath(logFilePath),
        },
        {
          label: 'Open data folder',
          click: () => shell.openPath(app.getPath('userData')),
        },
        { type: 'separator' },
        {
          label: `About ${APP_NAME}`,
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: `About ${APP_NAME}`,
            message: `${APP_NAME} ${app.getVersion()}`,
            detail: `Electron ${process.versions.electron}\nChromium ${process.versions.chrome}`,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function updateTrayTaskTooltip() {
  tray?.setToolTip(buildTrayTooltip(currentTaskSummaries, APP_NAME));
}

function isMainWindowBackgrounded() {
  return !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || !mainWindow.isFocused();
}

function showTaskTransitionNotification(tasks) {
  if (tasks.length === 0 || !isMainWindowBackgrounded()) return;

  const notification = buildTaskNotification(tasks);
  if (process.platform === 'win32' && tray) {
    tray.displayBalloon({
      iconType: notification.iconType,
      title: notification.title,
      content: notification.content,
      noSound: false,
      respectQuietTime: true,
    });
    return;
  }

  if (!Notification.isSupported()) return;
  const nativeNotification = new Notification({
    title: notification.title,
    body: notification.content,
    silent: false,
  });
  nativeNotification.on('click', showMainWindow);
  nativeNotification.show();
}

function updateDesktopTaskStatus(value) {
  const tasks = sanitizeTaskSummaries(value);
  const transition = collectTaskTransitions(previousTaskStatuses, tasks, hasReceivedTaskSnapshot);
  previousTaskStatuses = transition.nextStatuses;
  currentTaskSummaries = tasks;
  hasReceivedTaskSnapshot = true;
  updateTrayTaskTooltip();
  showTaskTransitionNotification(transition.terminalTasks);
}

function createTray() {
  if (tray) return;

  const iconPath = path.join(app.getAppPath(), 'build', 'icon.ico');
  const trayIcon = nativeImage.createFromPath(iconPath);
  if (trayIcon.isEmpty()) {
    writeLog('Electron error', `Tray icon could not be loaded: ${iconPath}`);
    return;
  }

  tray = new Tray(trayIcon);
  updateTrayTaskTooltip();
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '打开 Jacky Image',
      click: showMainWindow,
    },
    {
      label: '打开开发者工具',
      click: () => {
        showMainWindow();
        mainWindow?.webContents.openDevTools({ mode: 'detach' });
      },
    },
    { type: 'separator' },
    {
      label: '查看运行日志',
      click: () => logFilePath && shell.openPath(logFilePath),
    },
    {
      label: '打开数据目录',
      click: () => shell.openPath(app.getPath('userData')),
    },
    { type: 'separator' },
    {
      label: '退出 Jacky Image',
      click: () => app.quit(),
    },
  ]));

  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  tray.on('balloon-click', showMainWindow);
  writeLog('Electron', 'System tray icon created');
}

function getRepaintWindowForSender(sender) {
  for (const repaintWindow of repaintWindows.values()) {
    if (!repaintWindow.isDestroyed() && repaintWindow.webContents === sender) return repaintWindow;
  }
  return null;
}

function getPromptEditorWindowForSender(sender) {
  for (const promptEditorWindow of promptEditorWindows.values()) {
    if (!promptEditorWindow.isDestroyed() && promptEditorWindow.webContents === sender) return promptEditorWindow;
  }
  return null;
}

async function installRendererSessionCookie() {
  if (!backendPort || !backendRendererSessionToken) return;
  await session.defaultSession.cookies.set({
    url: `http://127.0.0.1:${backendPort}/`,
    name: 'jacky_renderer_session',
    value: backendRendererSessionToken,
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
  });
}

function notifyPromptEditorWindowClosed(sessionId) {
  if (!sessionId || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try {
    mainWindow.webContents.send('jacky:prompt-editor-window:closed', { sessionId });
  } catch (error) {
    writeLog('Electron error', `Prompt editor close notification failed: ${error.stack || error.message}`);
  }
}

function releasePromptEditorWindowSession(promptEditorWindow, notify = true) {
  const sessionId = promptEditorWindowSessionIds.get(promptEditorWindow);
  if (!sessionId) return;
  promptEditorWindows.delete(sessionId);
  promptEditorWindowPayloads.delete(sessionId);
  promptEditorWindowSessionIds.delete(promptEditorWindow);
  if (notify) notifyPromptEditorWindowClosed(sessionId);
}

function isTrustedRenderer(sender) {
  return sender === mainWindow?.webContents || Boolean(getRepaintWindowForSender(sender)) || Boolean(getPromptEditorWindowForSender(sender));
}

function getWindowsTitleBarOverlay(theme = 'light') {
  const dark = theme === 'dark';
  return {
    color: dark ? '#0f141c' : '#f8fafc',
    symbolColor: dark ? '#e2e8f0' : '#334155',
    height: WINDOWS_TITLE_BAR_HEIGHT,
  };
}

function hardenChildWindow(window, applicationURL) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin === new URL(applicationURL).origin) return;
    } catch { /* block invalid URLs */ }
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
}

function createMainWindow() {
  const applicationURL = `http://127.0.0.1:${backendPort}`;
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0b0d',
    icon: path.join(app.getAppPath(), 'build', 'icon.ico'),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    ...(process.platform === 'win32'
      ? { titleBarOverlay: getWindowsTitleBarOverlay('light') }
      : {}),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'electron', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  attachWindowDiagnostics(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin === new URL(applicationURL).origin) return;
    } catch {
      // Invalid or non-standard URLs are blocked below.
    }
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isF12 = input.type === 'keyDown' && input.key === 'F12';
    const isDevToolsShortcut = input.type === 'keyDown'
      && input.control
      && input.shift
      && input.key.toLowerCase() === 'i';
    if (isF12 || isDevToolsShortcut) {
      writeLog('Electron', `Developer tools shortcut: ${input.key}`);
      mainWindow?.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', event => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
    writeLog('Electron', 'Window hidden to system tray');

    if (process.platform === 'win32' && tray && !hasShownTrayNotice) {
      hasShownTrayNotice = true;
      tray.displayBalloon({
        iconType: 'info',
        title: APP_NAME,
        content: 'Jacky Image 仍在后台运行，可从系统托盘重新打开或退出。',
        noSound: true,
      });
    }
  });
  mainWindow.once('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(applicationURL);
  const shouldOpenDevTools = process.argv.includes('--devtools')
    || (!app.isPackaged && !process.argv.includes('--no-devtools'));
  if (shouldOpenDevTools) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    });
  }
}

app.setName(APP_NAME);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  showMainWindow();
});

app.on('before-quit', event => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  void stopBackend().finally(() => {
    writeLog('Electron', 'Application stopped');
    tray?.destroy();
    tray = null;
    logStream?.end();
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') app.quit();
});

app.on('activate', showMainWindow);

app.whenReady().then(async () => {
  app.setAppUserModelId('com.jackyimage.studio');
  initializeLogging();
  app.on('web-contents-created', (_event, contents) => {
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  });
  ipcMain.on('jacky:titlebar-theme', (event, theme) => {
    if (process.platform !== 'win32') return;
    const targetWindow = event.sender === mainWindow?.webContents ? mainWindow : getRepaintWindowForSender(event.sender);
    targetWindow?.setTitleBarOverlay(getWindowsTitleBarOverlay(theme === 'dark' ? 'dark' : 'light'));
  });
  ipcMain.on('jacky:task-status:update', (event, tasks) => {
    if (event.sender !== mainWindow?.webContents) return;
    updateDesktopTaskStatus(tasks);
  });
  ipcMain.on('jacky:get-legacy-local-storage', event => {
    if (event.sender !== mainWindow?.webContents) {
      event.returnValue = null;
      return;
    }
    event.returnValue = legacyLocalStorageMigration;
  });
  ipcMain.on('jacky:model-registry:get', event => {
    if (!isTrustedRenderer(event.sender)) {
      event.returnValue = { ok: false, error: 'Unauthorized renderer' };
      return;
    }
    try {
      event.returnValue = getModelRegistryResponse();
    } catch (error) {
      writeLog('Electron', `Could not provide model registry: ${error.message}`);
      event.returnValue = { ok: false, error: error.message };
    }
  });
  ipcMain.on('jacky:model-registry:save', (event, value) => {
    if (event.sender !== mainWindow?.webContents) {
      event.returnValue = { ok: false, error: 'Unauthorized renderer' };
      return;
    }
    try {
      event.returnValue = saveModelRegistryFromRenderer(value);
    } catch (error) {
      writeLog('Electron', `Could not save model registry: ${error.message}`);
      event.returnValue = { ok: false, error: error.message };
    }
  });
  ipcMain.on('jacky:storage:get', event => {
    if (!isTrustedRenderer(event.sender)) {
      event.returnValue = { ok: false, error: 'Unauthorized renderer' };
      return;
    }
    event.returnValue = { ok: true, paths: storagePaths };
  });
  ipcMain.on('jacky:preferences:get-all', event => {
    if (!isTrustedRenderer(event.sender)) {
      event.returnValue = { ok: false, error: 'Unauthorized renderer' };
      return;
    }
    event.returnValue = { ok: true, preferences: desktopPreferences };
  });
  ipcMain.on('jacky:preferences:save-all', (event, value) => {
    if (event.sender !== mainWindow?.webContents) {
      event.returnValue = { ok: false, error: 'Unauthorized renderer' };
      return;
    }
    try {
      event.returnValue = { ok: true, preferences: saveDesktopPreferences(value) };
    } catch (error) {
      writeLog('Electron', `Could not save desktop preferences: ${error.message}`);
      event.returnValue = { ok: false, error: error.message };
    }
  });
  ipcMain.on('jacky:records:get', event => {
    if (event.sender !== mainWindow?.webContents) {
      event.returnValue = { ok: false, error: 'Unauthorized renderer' };
      return;
    }
    try {
      event.returnValue = { ok: true, jobs: loadUsageHistory(storagePaths) };
    } catch (error) {
      writeLog('Electron', `Could not read usage history: ${error.message}`);
      event.returnValue = { ok: false, error: error.message };
    }
  });
  ipcMain.on('jacky:records:save', (event, jobs) => {
    if (event.sender !== mainWindow?.webContents) {
      event.returnValue = { ok: false, error: 'Unauthorized renderer' };
      return;
    }
    try {
      saveUsageHistory(storagePaths, jobs);
      event.returnValue = { ok: true };
    } catch (error) {
      writeLog('Electron', `Could not save usage history: ${error.message}`);
      event.returnValue = { ok: false, error: error.message };
    }
  });
  ipcMain.handle('jacky:repaint-window:open', async (event, payload) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    const sessionId = crypto.randomUUID();
    repaintWindowPayloads.set(sessionId, payload);
    const applicationURL = `http://127.0.0.1:${backendPort}`;
    const repaintWindow = new BrowserWindow({
      title: `局部重绘 · ${payload?.fileName || '座套候选'}`,
      width: 1600,
      height: 1040,
      minWidth: 1100,
      minHeight: 760,
      show: false,
      backgroundColor: '#0b0b0d',
      icon: path.join(app.getAppPath(), 'build', 'icon.ico'),
      autoHideMenuBar: true,
      titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
      ...(process.platform === 'win32' ? { titleBarOverlay: getWindowsTitleBarOverlay('light') } : {}),
      webPreferences: {
        preload: path.join(app.getAppPath(), 'electron', 'repaint-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    repaintWindows.set(sessionId, repaintWindow);
    attachWindowDiagnostics(repaintWindow);
    hardenChildWindow(repaintWindow, applicationURL);
    repaintWindow.once('ready-to-show', () => repaintWindow.show());
    repaintWindow.on('closed', () => {
      repaintWindows.delete(sessionId);
      repaintWindowPayloads.delete(sessionId);
      mainWindow?.webContents.send('jacky:repaint-window:closed', { sessionId });
    });
    await repaintWindow.loadURL(`${applicationURL}/repaint-window?sessionId=${encodeURIComponent(sessionId)}`);
    return { ok: true, sessionId };
  });
  ipcMain.handle('jacky:repaint-window:get-payload', async (event, sessionId) => {
    const repaintWindow = repaintWindows.get(sessionId);
    if (!repaintWindow || event.sender !== repaintWindow.webContents) throw new Error('Unauthorized renderer');
    const payload = repaintWindowPayloads.get(sessionId);
    return payload ? { ok: true, payload } : { ok: false, error: '局部重绘窗口数据已失效' };
  });
  ipcMain.handle('jacky:repaint-window:complete', async (event, value) => {
    const sessionId = value?.sessionId;
    const repaintWindow = repaintWindows.get(sessionId);
    if (!repaintWindow || event.sender !== repaintWindow.webContents) throw new Error('Unauthorized renderer');
    if (typeof value?.dataUrl !== 'string' || value.dataUrl.length > 40 * 1024 * 1024 || !value.dataUrl.startsWith('data:image/')) throw new Error('局部重绘结果无效');
    mainWindow?.webContents.send('jacky:repaint-window:result', { sessionId, dataUrl: value.dataUrl });
    repaintWindow.close();
    return { ok: true };
  });
  ipcMain.handle('jacky:repaint-window:cancel', async (event, sessionId) => {
    const repaintWindow = repaintWindows.get(sessionId);
    if (!repaintWindow || event.sender !== repaintWindow.webContents) throw new Error('Unauthorized renderer');
    repaintWindow.close();
    return { ok: true };
  });

  ipcMain.handle('jacky:prompt-editor-window:open', async (event, payload) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    const sessionId = crypto.randomUUID();
    promptEditorWindowPayloads.set(sessionId, payload);
    const applicationURL = `http://127.0.0.1:${backendPort}`;
    let promptEditorWindow = promptEditorWindowSingleton;
    if (!promptEditorWindow || promptEditorWindow.isDestroyed()) {
      promptEditorWindow = new BrowserWindow({
        title: `提示词编辑器 · ${payload?.preset?.name || '角度提示词'}`,
        width: 1380,
        height: 920,
        minWidth: 900,
        minHeight: 680,
        show: false,
        backgroundColor: '#f8fafc',
        icon: path.join(app.getAppPath(), 'build', 'icon.ico'),
        autoHideMenuBar: true,
        titleBarStyle: 'default',
        webPreferences: {
          preload: path.join(app.getAppPath(), 'electron', 'prompt-editor-preload.cjs'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      promptEditorWindowSingleton = promptEditorWindow;
      attachWindowDiagnostics(promptEditorWindow);
      hardenChildWindow(promptEditorWindow, applicationURL);
      promptEditorWindow.on('close', closeEvent => {
        if (isQuitting) return;
        closeEvent.preventDefault();
        releasePromptEditorWindowSession(promptEditorWindow);
        promptEditorWindow.hide();
      });
      promptEditorWindow.once('closed', () => {
        releasePromptEditorWindowSession(promptEditorWindow, false);
        if (promptEditorWindowSingleton === promptEditorWindow) promptEditorWindowSingleton = null;
      });
    } else {
      releasePromptEditorWindowSession(promptEditorWindow);
    }
    promptEditorWindow.setTitle(`提示词编辑器 · ${payload?.preset?.name || '角度提示词'}`);
    promptEditorWindowSessionIds.set(promptEditorWindow, sessionId);
    promptEditorWindows.set(sessionId, promptEditorWindow);
    await promptEditorWindow.loadURL(`${applicationURL}/prompt-editor-window?sessionId=${encodeURIComponent(sessionId)}`);
    if (!promptEditorWindow.isDestroyed()) {
      promptEditorWindow.show();
      promptEditorWindow.focus();
    }
    return { ok: true, sessionId };
  });
  ipcMain.handle('jacky:model-secret:configure', configureModelSecretFromMain);
  ipcMain.handle('jacky:prompt-editor-window:get-payload', async (event, sessionId) => {
    const promptEditorWindow = promptEditorWindows.get(sessionId);
    if (!promptEditorWindow || event.sender !== promptEditorWindow.webContents) throw new Error('Unauthorized renderer');
    const payload = promptEditorWindowPayloads.get(sessionId);
    return payload ? { ok: true, payload } : { ok: false, error: '提示词编辑窗口数据已失效' };
  });
  ipcMain.handle('jacky:prompt-editor-window:close', async (event, sessionId) => {
    const promptEditorWindow = promptEditorWindows.get(sessionId);
    if (!promptEditorWindow || event.sender !== promptEditorWindow.webContents) throw new Error('Unauthorized renderer');
    // Keep this auxiliary BrowserWindow alive. Destroying it from the IPC close
    // callback can abort a native Windows callback with 0xC000041D. The next
    // prompt edit reuses the same hidden window and reloads it with a new session.
    setTimeout(() => {
      if (!promptEditorWindow.isDestroyed() && promptEditorWindowSessionIds.get(promptEditorWindow) === sessionId) {
        releasePromptEditorWindowSession(promptEditorWindow);
        promptEditorWindow.hide();
      }
    }, 100);
    return { ok: true };
  });

  ipcMain.handle('jacky:seat-cover-prompts:open-directory', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    const promptDirectory = path.join(app.getPath('userData'), 'prompts', 'seat-cover-angles');
    fs.mkdirSync(promptDirectory, { recursive: true });
    const error = await shell.openPath(promptDirectory);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('jacky:storage:select-directory', async (event, kind) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    const pathKey = {
      records: 'recordsDirectory',
      cache: 'cacheDirectory',
      downloads: 'downloadsDirectory',
    }[kind];
    if (!pathKey) throw new Error('Unknown storage directory kind');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择本地目录',
      defaultPath: storagePaths[pathKey],
      properties: ['openDirectory', 'createDirectory'],
    });
    const selectedPath = result.canceled ? null : result.filePaths[0] || null;
    if (selectedPath) approvedStorageDirectories.set(kind, path.resolve(selectedPath));
    return selectedPath;
  });
  ipcMain.handle('jacky:storage:save', async (event, value) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    return saveDesktopStoragePaths(value);
  });
  ipcMain.handle('jacky:storage:open-directory', async (event, kind) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    const pathKey = {
      records: 'recordsDirectory',
      cache: 'cacheDirectory',
      downloads: 'downloadsDirectory',
    }[kind];
    if (!pathKey) throw new Error('Unknown storage directory kind');
    fs.mkdirSync(storagePaths[pathKey], { recursive: true });
    const error = await shell.openPath(storagePaths[pathKey]);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle('jacky:image-cache:write', async (event, value) => {
    if (!isTrustedRenderer(event.sender)) throw new Error('Unauthorized renderer');
    const result = writeCachedImage(storagePaths, value?.jobId, value?.imageIndex, value?.mimeType, value?.bytes);
    return { ok: true, mimeType: result.mimeType };
  });
  ipcMain.handle('jacky:image-cache:read', async (event, value) => {
    if (!isTrustedRenderer(event.sender)) throw new Error('Unauthorized renderer');
    const result = readCachedImage(storagePaths, value?.jobId, value?.imageIndex);
    return result ? { ok: true, mimeType: result.mimeType, bytes: result.bytes } : { ok: true, missing: true };
  });
  ipcMain.handle('jacky:image-cache:delete-job', async (event, value) => {
    if (!isTrustedRenderer(event.sender)) throw new Error('Unauthorized renderer');
    return { ok: true, deleted: deleteCachedImages(storagePaths, value?.jobId, value?.imageCount) };
  });
  ipcMain.handle('jacky:downloads:save', async (event, value) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    if (typeof value?.fileName !== 'string' || value.fileName.length > 180) throw new Error('下载文件名无效');
    const filePath = saveDownload(storagePaths, value?.fileName, value?.bytes);
    writeLog('Electron', `Saved download: ${filePath}`);
    return { ok: true, filePath };
  });
  ipcMain.handle('jacky:app-data:read', async (event, namespace) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    return { ok: true, value: readAppDocument(storagePaths, namespace) };
  });
  ipcMain.handle('jacky:app-data:write', async (event, value) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    return { ok: true, value: writeAppDocument(storagePaths, value?.namespace, value?.data) };
  });
  ipcMain.handle('jacky:app-data:delete', async (event, namespace) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    deleteAppDocument(storagePaths, namespace);
    return { ok: true };
  });
  ipcMain.handle('jacky:app-cache:write', async (event, value) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    writeAppBlob(storagePaths, value?.scope, value?.key, value?.mimeType, value?.bytes);
    return { ok: true };
  });
  ipcMain.handle('jacky:app-cache:read', async (event, value) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    const result = readAppBlob(storagePaths, value?.scope, value?.key);
    return result ? { ok: true, ...result } : { ok: true, missing: true };
  });
  ipcMain.handle('jacky:app-cache:delete', async (event, value) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    return { ok: true, deleted: deleteAppBlob(storagePaths, value?.scope, value?.key) };
  });
  ipcMain.handle('jacky:app-cache:list', async (event, scope) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    return { ok: true, keys: listAppBlobKeys(storagePaths, scope) };
  });
  ipcMain.handle('jacky:update:get-state', event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    return updateManager?.getState() || { status: 'idle', currentVersion: app.getVersion() };
  });
  ipcMain.handle('jacky:update:check', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    return updateManager?.check() || { ok: false, reason: 'Updater unavailable' };
  });
  ipcMain.handle('jacky:update:download', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    return updateManager?.download() || { ok: false, reason: 'Updater unavailable' };
  });
  ipcMain.handle('jacky:update:install', async event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized renderer');
    return updateManager?.install() || { ok: false, reason: 'Updater unavailable' };
  });
  updateManager = createUpdateManager({
    app,
    getMainWindow: () => mainWindow,
    stopBackend,
    beginUpdateQuit: () => { isQuitting = true; tray?.destroy(); tray = null; },
    writeLog,
  });
  createApplicationMenu();
  await startBackend();
  await installRendererSessionCookie();
  createMainWindow();
  createTray();
  if (app.isPackaged && process.platform === 'win32') {
    setTimeout(() => updateManager?.check().catch(error => writeLog('Updater', `Startup update check failed: ${error.message}`)), 5_000);
  }
}).catch(async error => {
  writeLog('Startup error', error.stack || error.message);
  dialog.showErrorBox(`${APP_NAME} could not start`, `${error.message}\n\n${logFilePath || ''}`);
  isQuitting = true;
  await stopBackend();
  logStream?.end();
  app.exit(1);
});

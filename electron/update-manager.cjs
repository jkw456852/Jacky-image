const path = require('node:path');

function createUpdateManager({ app, getMainWindow, stopBackend, beginUpdateQuit, writeLog }) {
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeLog('Updater', `electron-updater unavailable: ${detail}`);
    const unavailable = () => ({ ok: false, reason: 'Updater unavailable' });
    return {
      getState: () => ({ status: 'unsupported', currentVersion: app.getVersion(), availableVersion: null, releaseName: null, releaseNotes: null, releaseDate: null, progress: null, error: '更新组件不可用' }),
      check: async () => unavailable(),
      download: async () => unavailable(),
      install: async () => unavailable(),
    };
  }
  let state = { status: 'idle', currentVersion: app.getVersion(), availableVersion: null, releaseName: null, releaseNotes: null, releaseDate: null, progress: null, error: null };
  const publish = patch => {
    state = { ...state, ...patch };
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send('jacky:update:state', state);
  };
  autoUpdater.logger = {
    info: message => writeLog('Updater', String(message)),
    warn: message => writeLog('Updater', `WARN ${message}`),
    error: message => writeLog('Updater', `ERROR ${message}`),
    debug: message => writeLog('Updater', String(message)),
  };
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableDifferentialDownload = false;
  if (process.platform === 'win32' && app.isPackaged) autoUpdater.installDirectory = path.dirname(process.execPath);
  autoUpdater.on('checking-for-update', () => publish({ status: 'checking', error: null }));
  autoUpdater.on('update-available', info => publish({ status: 'available', availableVersion: info.version, releaseName: info.releaseName || null, releaseNotes: info.releaseNotes || null, releaseDate: info.releaseDate || null, progress: null, error: null }));
  autoUpdater.on('update-not-available', info => publish({ status: 'latest', availableVersion: info?.version || null, releaseName: null, releaseNotes: null, releaseDate: null, progress: null, error: null }));
  autoUpdater.on('download-progress', progress => publish({ status: 'downloading', progress: { percent: progress.percent, transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond } }));
  autoUpdater.on('update-downloaded', info => publish({ status: 'downloaded', availableVersion: info.version, progress: { percent: 100 }, error: null }));
  autoUpdater.on('error', error => { writeLog('Updater', error.stack || error.message); publish({ status: 'error', error: error.message }); });
  return {
    getState: () => ({ ...state }),
    check: async () => {
      if (!app.isPackaged || process.platform !== 'win32') {
        publish({ status: 'unsupported', error: '在线更新仅适用于 Windows 正式打包版' });
        return { ok: false, reason: 'Updates require a packaged Windows build' };
      }
      await autoUpdater.checkForUpdates();
      return { ok: true };
    },
    download: async () => { await autoUpdater.downloadUpdate(); return { ok: true }; },
    install: async () => { await stopBackend(); beginUpdateQuit(); autoUpdater.quitAndInstall(false, true); return { ok: true }; },
  };
}

module.exports = { createUpdateManager };

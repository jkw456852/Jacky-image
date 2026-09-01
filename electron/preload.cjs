const { contextBridge, ipcRenderer } = require('electron');

const MAX_CACHE_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_REPAINT_DATA_URL_LENGTH = 40 * 1024 * 1024;

function boundedBytes(value, maxBytes, label) {
  const bytes = new Uint8Array(value);
  if (bytes.byteLength > maxBytes) throw new Error(`${label} too large`);
  return bytes;
}

const MODEL_REGISTRY_KEY = 'jacky-model-registry';
const LEGACY_BRAND_SLUG = Buffer.from('bm92YQ==', 'base64').toString('utf8');
const LEGACY_MODEL_REGISTRY_KEY = `${LEGACY_BRAND_SLUG}-model-registry`;
const LEGACY_JSON_STORAGE_KEYS = new Set([
  'jacky-jobs',
  'jacky-t2i-settings',
  'jacky-i2i-settings',
  'jacky-image-generation-settings',
  'jacky-reverse-prompt-settings',
  'jacky-agent-params',
  'jacky-gif-settings',
  'jacky-gif-active-job',
  'jacky-assets-settings',
  'jacky-image:canvas_config',
  'jacky-gif-tuner-mobile-hint-hidden',
]);
const LEGACY_TEXT_STORAGE_KEYS = new Set([
  'theme',
  'jacky-wide-mode',
  'jacky-agent-web-search',
  'jacky-agent-intent-recognition',
]);
let modelRegistrySnapshot = null;
let storagePathsSnapshot = null;
let legacyStorageMigrationSnapshot = null;
let preferencesSnapshot = {};

function getLegacyStorageKey(key) {
  return key.startsWith('jacky-') ? `${LEGACY_BRAND_SLUG}-${key.slice('jacky-'.length)}` : key;
}

function getCurrentStorageKey(key) {
  const legacyPrefix = `${LEGACY_BRAND_SLUG}-`;
  return key.startsWith(legacyPrefix) ? `jacky-${key.slice(legacyPrefix.length)}` : key;
}

function cloneJson(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function parseRegistry(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.imageModels) || !Array.isArray(parsed?.textModels) || !parsed?.defaults) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseJobs(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isValidLegacyStorageValue(key, value) {
  if (LEGACY_TEXT_STORAGE_KEYS.has(key)) return true;
  if (!LEGACY_JSON_STORAGE_KEYS.has(key)) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function removeCorruptedCurrentStorage() {
  for (const key of LEGACY_JSON_STORAGE_KEYS) {
    const value = window.localStorage.getItem(key);
    if (value != null && !isValidLegacyStorageValue(key, value)) {
      window.localStorage.removeItem(key);
    }
  }
}

function saveModelRegistry(registry) {
  const candidate = cloneJson(registry);
  const response = ipcRenderer.sendSync('jacky:model-registry:save', candidate);
  if (response?.ok) {
    modelRegistrySnapshot = cloneJson(response.registry || candidate);
    try {
      window.localStorage.removeItem(MODEL_REGISTRY_KEY);
    } catch {
      // The secure file is already authoritative even if old browser storage cannot be cleaned here.
    }
  }
  return response && typeof response === 'object'
    ? response
    : { ok: false, error: '桌面配置保存失败' };
}

function initializeModelRegistry() {
  let migration = null;
  try {
    removeCorruptedCurrentStorage();
    const response = ipcRenderer.sendSync('jacky:model-registry:get');
    if (response?.ok && response.registry) {
      modelRegistrySnapshot = cloneJson(response.registry);
    }

    migration = ipcRenderer.sendSync('jacky:get-legacy-local-storage');
    legacyStorageMigrationSnapshot = migration;
    if (!modelRegistrySnapshot) {
      const legacyRegistry = parseRegistry(migration?.values?.[MODEL_REGISTRY_KEY])
        || parseRegistry(migration?.values?.[LEGACY_MODEL_REGISTRY_KEY]);
      const currentRegistry = parseRegistry(window.localStorage.getItem(MODEL_REGISTRY_KEY))
        || parseRegistry(window.localStorage.getItem(LEGACY_MODEL_REGISTRY_KEY));
      const recoveredRegistry = legacyRegistry || currentRegistry;
      if (recoveredRegistry) saveModelRegistry(recoveredRegistry);
    }

    if (modelRegistrySnapshot) {
      window.localStorage.removeItem(MODEL_REGISTRY_KEY);
      window.localStorage.removeItem(LEGACY_MODEL_REGISTRY_KEY);
    }
  } catch {
    // Keep startup usable even when the secure registry cannot be initialized.
  }

}

initializeModelRegistry();

function initializeStoragePaths() {
  try {
    const response = ipcRenderer.sendSync('jacky:storage:get');
    if (response?.ok && response.paths) storagePathsSnapshot = cloneJson(response.paths);
  } catch {
    storagePathsSnapshot = null;
  }
}

initializeStoragePaths();

function savePreferencesSnapshot(next) {
  const response = ipcRenderer.sendSync('jacky:preferences:save-all', cloneJson(next));
  if (response?.ok && response.preferences && typeof response.preferences === 'object') {
    preferencesSnapshot = cloneJson(response.preferences);
  }
  return response && typeof response === 'object'
    ? response
    : { ok: false, error: 'Desktop preferences could not be saved' };
}

function initializePreferences() {
  try {
    const response = ipcRenderer.sendSync('jacky:preferences:get-all');
    if (response?.ok && response.preferences && typeof response.preferences === 'object') {
      preferencesSnapshot = cloneJson(response.preferences);
    }

    const next = { ...preferencesSnapshot };
    const legacyValues = legacyStorageMigrationSnapshot?.values;
    if (legacyValues && typeof legacyValues === 'object') {
      for (const [key, value] of Object.entries(legacyValues)) {
        const currentKey = getCurrentStorageKey(key);
        if (currentKey === MODEL_REGISTRY_KEY || currentKey === 'jacky-jobs') continue;
        if (typeof value !== 'string' || !isValidLegacyStorageValue(currentKey, value)) continue;
        if (next[currentKey] == null) next[currentKey] = value;
      }
    }

    for (const key of [...LEGACY_JSON_STORAGE_KEYS, ...LEGACY_TEXT_STORAGE_KEYS]) {
      if (key === 'jacky-jobs') continue;
      const value = window.localStorage.getItem(key);
      const legacyKey = getLegacyStorageKey(key);
      const recoveredValue = value ?? window.localStorage.getItem(legacyKey);
      if (typeof recoveredValue === 'string' && isValidLegacyStorageValue(key, recoveredValue) && next[key] == null) {
        next[key] = recoveredValue;
      }
    }
    if (legacyStorageMigrationSnapshot?.sourcePort != null) {
      next['jacky-desktop-storage-migrated-from'] = String(legacyStorageMigrationSnapshot.sourcePort);
    }

    savePreferencesSnapshot(next);
    for (const key of [...LEGACY_JSON_STORAGE_KEYS, ...LEGACY_TEXT_STORAGE_KEYS]) {
      if (key !== 'jacky-jobs') {
        window.localStorage.removeItem(key);
        window.localStorage.removeItem(getLegacyStorageKey(key));
      }
    }
    window.localStorage.removeItem('jacky-desktop-storage-migrated-from');
  } catch {
    // Preferences are optional and must not block desktop startup.
  }
}

initializePreferences();

function initializeUsageHistory() {
  try {
    const response = ipcRenderer.sendSync('jacky:records:get');
    if (response?.ok && Array.isArray(response.jobs)) {
      window.localStorage.removeItem('jacky-jobs');
      window.localStorage.removeItem(getLegacyStorageKey('jacky-jobs'));
      return;
    }

    const legacyJobsKey = getLegacyStorageKey('jacky-jobs');
    const legacyJobs = parseJobs(legacyStorageMigrationSnapshot?.values?.['jacky-jobs'])
      || parseJobs(legacyStorageMigrationSnapshot?.values?.[legacyJobsKey]);
    const currentJobs = parseJobs(window.localStorage.getItem('jacky-jobs'))
      || parseJobs(window.localStorage.getItem(legacyJobsKey));
    const recoveredJobs = legacyJobs || currentJobs;
    if (!recoveredJobs) return;

    const saveResponse = ipcRenderer.sendSync('jacky:records:save', cloneJson(recoveredJobs));
    if (saveResponse?.ok) {
      window.localStorage.removeItem('jacky-jobs');
      window.localStorage.removeItem(legacyJobsKey);
    }
  } catch {
    // Usage history migration is best-effort; the desktop file remains authoritative.
  }
}

initializeUsageHistory();

function resolveTheme() {
  const explicitTheme = document.documentElement.getAttribute('data-theme');
  if (explicitTheme === 'dark' || explicitTheme === 'light') return explicitTheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function initializeDesktopChrome() {
  const syncTheme = () => ipcRenderer.send('jacky:titlebar-theme', resolveTheme());
  syncTheme();

  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);
}

if (document.readyState === 'complete') {
  initializeDesktopChrome();
} else {
  window.addEventListener('load', initializeDesktopChrome, { once: true });
}

contextBridge.exposeInMainWorld('jackyDesktop', Object.freeze({
  isElectron: true,
  platform: process.platform,
  electronVersion: process.versions.electron,
  modelRegistry: Object.freeze({
    load: () => cloneJson(modelRegistrySnapshot),
    save: registry => saveModelRegistry(registry),
  }),
  modelSecrets: Object.freeze({
    configure: (modelId, kind) => ipcRenderer.invoke('jacky:model-secret:configure', { modelId, kind }),
  }),
  storage: Object.freeze({
    get: () => cloneJson(storagePathsSnapshot),
    selectDirectory: kind => ipcRenderer.invoke('jacky:storage:select-directory', kind),
    save: async paths => {
      const response = await ipcRenderer.invoke('jacky:storage:save', cloneJson(paths));
      if (response?.ok && response.paths) storagePathsSnapshot = cloneJson(response.paths);
      return response;
    },
    openDirectory: kind => ipcRenderer.invoke('jacky:storage:open-directory', kind),
  }),
  preferences: Object.freeze({
    get: key => typeof key === 'string' && typeof preferencesSnapshot[key] === 'string'
      ? preferencesSnapshot[key]
      : null,
    getAll: () => cloneJson(preferencesSnapshot),
    set: (key, value) => {
      if (typeof key !== 'string' || typeof value !== 'string') {
        return { ok: false, error: 'Invalid preference value' };
      }
      return savePreferencesSnapshot({ ...preferencesSnapshot, [key]: value });
    },
    remove: key => {
      if (typeof key !== 'string') return { ok: false, error: 'Invalid preference key' };
      const next = { ...preferencesSnapshot };
      delete next[key];
      return savePreferencesSnapshot(next);
    },
  }),
  taskStatus: Object.freeze({
    update: tasks => ipcRenderer.send('jacky:task-status:update', cloneJson(tasks)),
  }),
  seatCoverPrompts: Object.freeze({
    openDirectory: () => ipcRenderer.invoke('jacky:seat-cover-prompts:open-directory'),
  }),
  promptEditorWindow: Object.freeze({
    open: payload => ipcRenderer.invoke('jacky:prompt-editor-window:open', cloneJson(payload)),
    getPayload: sessionId => ipcRenderer.invoke('jacky:prompt-editor-window:get-payload', sessionId),
    close: sessionId => ipcRenderer.invoke('jacky:prompt-editor-window:close', sessionId),
    onClosed: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('jacky:prompt-editor-window:closed', listener);
      return () => ipcRenderer.removeListener('jacky:prompt-editor-window:closed', listener);
    },
  }),
  repaintWindow: Object.freeze({
    open: payload => ipcRenderer.invoke('jacky:repaint-window:open', cloneJson(payload)),
    getPayload: sessionId => ipcRenderer.invoke('jacky:repaint-window:get-payload', sessionId),
    complete: (sessionId, dataUrl) => {
      if (typeof dataUrl !== 'string' || dataUrl.length > MAX_REPAINT_DATA_URL_LENGTH) throw new Error('Repaint result too large');
      return ipcRenderer.invoke('jacky:repaint-window:complete', { sessionId, dataUrl });
    },
    cancel: sessionId => ipcRenderer.invoke('jacky:repaint-window:cancel', sessionId),
    onResult: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('jacky:repaint-window:result', listener);
      return () => ipcRenderer.removeListener('jacky:repaint-window:result', listener);
    },
    onClosed: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('jacky:repaint-window:closed', listener);
      return () => ipcRenderer.removeListener('jacky:repaint-window:closed', listener);
    },
  }),
  records: Object.freeze({
    loadJobs: () => {
      const response = ipcRenderer.sendSync('jacky:records:get');
      return response?.ok ? cloneJson(response.jobs) : null;
    },
    saveJobs: jobs => ipcRenderer.sendSync('jacky:records:save', cloneJson(jobs)),
  }),
  appData: Object.freeze({
    read: namespace => ipcRenderer.invoke('jacky:app-data:read', namespace),
    write: (namespace, data) => ipcRenderer.invoke('jacky:app-data:write', {
      namespace,
      data: cloneJson(data),
    }),
    delete: namespace => ipcRenderer.invoke('jacky:app-data:delete', namespace),
  }),
  appCache: Object.freeze({
    write: (scope, key, mimeType, bytes) => ipcRenderer.invoke('jacky:app-cache:write', {
      scope,
      key,
      mimeType,
      bytes: boundedBytes(bytes, MAX_CACHE_BYTES, 'App cache'),
    }),
    read: (scope, key) => ipcRenderer.invoke('jacky:app-cache:read', { scope, key }),
    delete: (scope, key) => ipcRenderer.invoke('jacky:app-cache:delete', { scope, key }),
    list: scope => ipcRenderer.invoke('jacky:app-cache:list', scope),
  }),
  imageCache: Object.freeze({
    write: (jobId, imageIndex, mimeType, bytes) => ipcRenderer.invoke('jacky:image-cache:write', {
      jobId,
      imageIndex,
      mimeType,
      bytes: boundedBytes(bytes, MAX_CACHE_BYTES, 'Image cache'),
    }),
    read: (jobId, imageIndex) => ipcRenderer.invoke('jacky:image-cache:read', { jobId, imageIndex }),
    deleteJob: (jobId, imageCount) => ipcRenderer.invoke('jacky:image-cache:delete-job', { jobId, imageCount }),
  }),
  downloads: Object.freeze({
    save: (fileName, bytes) => ipcRenderer.invoke('jacky:downloads:save', {
      fileName,
      bytes: boundedBytes(bytes, MAX_DOWNLOAD_BYTES, 'Download'),
    }),
  }),
  updates: Object.freeze({
    getState: () => ipcRenderer.invoke('jacky:update:get-state'),
    check: () => ipcRenderer.invoke('jacky:update:check'),
    download: () => ipcRenderer.invoke('jacky:update:download'),
    install: () => ipcRenderer.invoke('jacky:update:install'),
    onState: callback => {
      const listener = (_event, state) => callback(cloneJson(state));
      ipcRenderer.on('jacky:update:state', listener);
      return () => ipcRenderer.removeListener('jacky:update:state', listener);
    },
  }),
}));

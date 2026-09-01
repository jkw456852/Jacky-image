const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STORAGE_CONFIG_VERSION = 1;
const STORAGE_CONFIG_FILE_NAME = 'storage-paths.json';
const USAGE_HISTORY_FILE_NAME = 'usage-history.json';
const PREFERENCES_FILE_NAME = 'preferences.json';
const MAX_HISTORY_BYTES = 100 * 1024 * 1024;
const MAX_PREFERENCES_BYTES = 20 * 1024 * 1024;
const MAX_APP_DOCUMENT_BYTES = 100 * 1024 * 1024;
const MAX_CACHE_BLOB_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

function bufferFromBoundedBytes(bytes, maxBytes, label) {
  const buffer = Buffer.from(bytes || []);
  if (buffer.byteLength > maxBytes) throw new Error(`${label}超过大小限制`);
  return buffer;
}

const MIME_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
]);

const EXTENSION_MIME_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['avif', 'image/avif'],
]);

function getStorageConfigPath(appDataDirectory, appName = 'Jacky Image') {
  return path.join(appDataDirectory, appName, 'config', STORAGE_CONFIG_FILE_NAME);
}

function getDefaultStoragePaths({ userDataDirectory, downloadsDirectory }) {
  const dataDirectory = path.join(userDataDirectory, 'data');
  return {
    recordsDirectory: path.join(dataDirectory, 'records'),
    cacheDirectory: path.join(dataDirectory, 'images'),
    downloadsDirectory: path.join(downloadsDirectory, 'Jacky Image'),
  };
}

function normalizeDirectory(value, fallback, label) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!path.isAbsolute(candidate) || candidate.includes('\0')) {
    throw new Error(`${label}必须是有效的绝对路径`);
  }
  return path.normalize(candidate);
}

function normalizeStoragePaths(value, defaults) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    recordsDirectory: normalizeDirectory(input.recordsDirectory, defaults.recordsDirectory, '使用记录目录'),
    cacheDirectory: normalizeDirectory(input.cacheDirectory, defaults.cacheDirectory, '图片缓存目录'),
    downloadsDirectory: normalizeDirectory(input.downloadsDirectory, defaults.downloadsDirectory, '下载目录'),
  };
}

function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function getUsageHistoryPath(storagePaths) {
  return path.join(storagePaths.recordsDirectory, USAGE_HISTORY_FILE_NAME);
}

function getPreferencesPath(storagePaths) {
  return path.join(storagePaths.recordsDirectory, PREFERENCES_FILE_NAME);
}

function getTaskDatabasePath(storagePaths) {
  return path.join(storagePaths.recordsDirectory, 'service', 'jacky-tasks.sqlite');
}

function getBackendImageCacheDirectory(storagePaths) {
  return path.join(storagePaths.cacheDirectory, 'service-cache');
}

function getPersistentImageCacheDirectory(storagePaths) {
  return path.join(storagePaths.cacheDirectory, 'history-cache');
}

function getAppDataDirectory(storagePaths) {
  return path.join(storagePaths.recordsDirectory, 'app-data');
}

function getAppCacheDirectory(storagePaths) {
  return path.join(storagePaths.cacheDirectory, 'app-cache');
}

function ensureStorageDirectories(storagePaths) {
  fs.mkdirSync(storagePaths.recordsDirectory, { recursive: true });
  fs.mkdirSync(getAppDataDirectory(storagePaths), { recursive: true });
  fs.mkdirSync(getPersistentImageCacheDirectory(storagePaths), { recursive: true });
  fs.mkdirSync(getBackendImageCacheDirectory(storagePaths), { recursive: true });
  fs.mkdirSync(getAppCacheDirectory(storagePaths), { recursive: true });
  fs.mkdirSync(storagePaths.downloadsDirectory, { recursive: true });
}

function loadStoragePaths(configPath, defaults) {
  if (!fs.existsSync(configPath)) {
    const storagePaths = normalizeStoragePaths(defaults, defaults);
    ensureStorageDirectories(storagePaths);
    return storagePaths;
  }
  const payload = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const storagePaths = normalizeStoragePaths(payload?.paths, defaults);
  ensureStorageDirectories(storagePaths);
  return storagePaths;
}

function saveStoragePaths(configPath, storagePaths, defaults) {
  const normalized = normalizeStoragePaths(storagePaths, defaults);
  ensureStorageDirectories(normalized);
  writeJsonAtomic(configPath, {
    version: STORAGE_CONFIG_VERSION,
    updatedAt: new Date().toISOString(),
    paths: normalized,
  });
  return normalized;
}

function cloneAndValidateJobs(jobs) {
  const serialized = JSON.stringify(jobs);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_HISTORY_BYTES) {
    throw new Error('使用记录为空或超过 100 MB 限制');
  }
  const cloned = JSON.parse(serialized);
  if (!Array.isArray(cloned)) throw new Error('使用记录格式无效');
  return cloned;
}

function loadUsageHistory(storagePaths) {
  const filePath = getUsageHistoryPath(storagePaths);
  if (!fs.existsSync(filePath)) return null;
  return cloneAndValidateJobs(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function saveUsageHistory(storagePaths, jobs) {
  const normalized = cloneAndValidateJobs(jobs);
  writeJsonAtomic(getUsageHistoryPath(storagePaths), normalized);
  return normalized;
}

function cloneAndValidatePreferences(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!/^[a-zA-Z0-9:._-]{1,160}$/.test(key)) continue;
    if (typeof entry !== 'string') continue;
    normalized[key] = entry;
  }
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PREFERENCES_BYTES) {
    throw new Error('Preferences exceed the 20 MB limit');
  }
  return normalized;
}

function loadPreferences(storagePaths) {
  const filePath = getPreferencesPath(storagePaths);
  if (!fs.existsSync(filePath)) return {};
  return cloneAndValidatePreferences(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function savePreferences(storagePaths, preferences) {
  const normalized = cloneAndValidatePreferences(preferences);
  writeJsonAtomic(getPreferencesPath(storagePaths), normalized);
  return normalized;
}

function normalizeNamespace(value, label = 'namespace') {
  const normalized = String(value || '').trim();
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function cloneAndValidateDocument(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_APP_DOCUMENT_BYTES) {
    throw new Error('App data document exceeds the 100 MB limit');
  }
  return JSON.parse(serialized);
}

function getAppDocumentPath(storagePaths, namespace) {
  return path.join(getAppDataDirectory(storagePaths), `${normalizeNamespace(namespace)}.json`);
}

function readAppDocument(storagePaths, namespace) {
  const filePath = getAppDocumentPath(storagePaths, namespace);
  if (!fs.existsSync(filePath)) return null;
  return cloneAndValidateDocument(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function writeAppDocument(storagePaths, namespace, value) {
  const normalized = cloneAndValidateDocument(value);
  writeJsonAtomic(getAppDocumentPath(storagePaths, namespace), normalized);
  return normalized;
}

function deleteAppDocument(storagePaths, namespace) {
  fs.rmSync(getAppDocumentPath(storagePaths, namespace), { force: true });
}

function encodeBlobKey(value) {
  const key = String(value || '');
  if (!key || key.length > 180 || key.includes('\0')) throw new Error('Invalid app cache key');
  return Buffer.from(key, 'utf8').toString('base64url');
}

function decodeBlobKey(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function getAppBlobScopeDirectory(storagePaths, scope) {
  return path.join(getAppCacheDirectory(storagePaths), normalizeNamespace(scope, 'cache scope'));
}

function findAppBlobPath(storagePaths, scope, key) {
  const directory = getAppBlobScopeDirectory(storagePaths, scope);
  if (!fs.existsSync(directory)) return null;
  const prefix = `${encodeBlobKey(key)}.`;
  const fileName = fs.readdirSync(directory).find(name => name.startsWith(prefix));
  return fileName ? path.join(directory, fileName) : null;
}

function writeAppBlob(storagePaths, scope, key, mimeType, bytes) {
  const directory = getAppBlobScopeDirectory(storagePaths, scope);
  fs.mkdirSync(directory, { recursive: true });
  const encodedKey = encodeBlobKey(key);
  for (const fileName of fs.readdirSync(directory)) {
    if (fileName.startsWith(`${encodedKey}.`)) fs.rmSync(path.join(directory, fileName), { force: true });
  }
  const extension = MIME_EXTENSIONS.get(String(mimeType || '').toLowerCase()) || 'bin';
  fs.writeFileSync(path.join(directory, `${encodedKey}.${extension}`), bufferFromBoundedBytes(bytes, MAX_CACHE_BLOB_BYTES, '应用缓存'));
}

function readAppBlob(storagePaths, scope, key) {
  const filePath = findAppBlobPath(storagePaths, scope, key);
  if (!filePath) return null;
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return {
    bytes: fs.readFileSync(filePath),
    mimeType: EXTENSION_MIME_TYPES.get(extension) || 'application/octet-stream',
  };
}

function deleteAppBlob(storagePaths, scope, key) {
  const filePath = findAppBlobPath(storagePaths, scope, key);
  if (!filePath) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}

function listAppBlobKeys(storagePaths, scope) {
  const directory = getAppBlobScopeDirectory(storagePaths, scope);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).map(fileName => {
    const encodedKey = fileName.slice(0, fileName.lastIndexOf('.'));
    try {
      return decodeBlobKey(encodedKey);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function sanitizeJobId(jobId) {
  const value = String(jobId || '');
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(value)) throw new Error('图片缓存任务 ID 无效');
  return value;
}

function normalizeImageIndex(imageIndex) {
  const value = Number(imageIndex);
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error('图片缓存索引无效');
  return value;
}

function getCacheFilePrefix(jobId, imageIndex) {
  return `${sanitizeJobId(jobId)}-${normalizeImageIndex(imageIndex)}`;
}

function findCachedImagePath(storagePaths, jobId, imageIndex) {
  const directory = getPersistentImageCacheDirectory(storagePaths);
  const prefix = `${getCacheFilePrefix(jobId, imageIndex)}.`;
  if (!fs.existsSync(directory)) return null;
  const fileName = fs.readdirSync(directory).find(name => name.startsWith(prefix));
  return fileName ? path.join(directory, fileName) : null;
}

function writeCachedImage(storagePaths, jobId, imageIndex, mimeType, bytes) {
  const directory = getPersistentImageCacheDirectory(storagePaths);
  fs.mkdirSync(directory, { recursive: true });
  const prefix = getCacheFilePrefix(jobId, imageIndex);
  const extension = MIME_EXTENSIONS.get(String(mimeType || '').toLowerCase()) || 'png';
  for (const fileName of fs.readdirSync(directory)) {
    if (fileName.startsWith(`${prefix}.`)) fs.rmSync(path.join(directory, fileName), { force: true });
  }
  const filePath = path.join(directory, `${prefix}.${extension}`);
  fs.writeFileSync(filePath, bufferFromBoundedBytes(bytes, MAX_CACHE_BLOB_BYTES, '图片缓存'));
  return { filePath, mimeType: EXTENSION_MIME_TYPES.get(extension) || 'image/png' };
}

function readCachedImage(storagePaths, jobId, imageIndex) {
  const filePath = findCachedImagePath(storagePaths, jobId, imageIndex);
  if (!filePath) return null;
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return {
    bytes: fs.readFileSync(filePath),
    mimeType: EXTENSION_MIME_TYPES.get(extension) || 'application/octet-stream',
  };
}

function deleteCachedImages(storagePaths, jobId, imageCount) {
  const directory = getPersistentImageCacheDirectory(storagePaths);
  if (!fs.existsSync(directory)) return 0;
  const safeJobId = sanitizeJobId(jobId);
  const prefixes = typeof imageCount === 'number'
    ? Array.from({ length: Math.max(0, imageCount) }, (_, index) => `${safeJobId}-${index}.`)
    : [`${safeJobId}-`];
  let deleted = 0;
  for (const fileName of fs.readdirSync(directory)) {
    if (!prefixes.some(prefix => fileName.startsWith(prefix))) continue;
    fs.rmSync(path.join(directory, fileName), { force: true });
    deleted += 1;
  }
  return deleted;
}

function sanitizeDownloadName(fileName) {
  const sanitized = String(fileName || 'jacky-image')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 180);
  const safeName = sanitized || 'jacky-image';
  const stem = path.parse(safeName).name.toUpperCase().replace(/[. ]+$/g, '');
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  return reserved.test(stem) ? `_${safeName}` : safeName;
}

function getAvailableDownloadPath(directory, requestedName) {
  const parsed = path.parse(sanitizeDownloadName(requestedName));
  let candidate = path.join(directory, `${parsed.name}${parsed.ext}`);
  for (let suffix = 1; fs.existsSync(candidate); suffix += 1) {
    candidate = path.join(directory, `${parsed.name} (${suffix})${parsed.ext}`);
  }
  return candidate;
}

function saveDownload(storagePaths, fileName, bytes) {
  fs.mkdirSync(storagePaths.downloadsDirectory, { recursive: true });
  const safeName = sanitizeDownloadName(fileName);
  const extension = path.extname(safeName).slice(1).toLowerCase();
  if (!['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(extension)) {
    throw new Error('下载文件类型不允许');
  }
  const filePath = getAvailableDownloadPath(storagePaths.downloadsDirectory, safeName);
  fs.writeFileSync(filePath, bufferFromBoundedBytes(bytes, MAX_DOWNLOAD_BYTES, '下载文件'));
  return filePath;
}

function isNestedPath(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function copyDirectoryContents(source, target) {
  const sourcePath = path.resolve(source);
  const targetPath = path.resolve(target);
  if (sourcePath === targetPath || !fs.existsSync(sourcePath)) return;
  if (isNestedPath(sourcePath, targetPath) || isNestedPath(targetPath, sourcePath)) {
    throw new Error('新旧目录不能互相包含');
  }
  fs.mkdirSync(targetPath, { recursive: true });
  // 迁移时覆盖同名文件，避免目标目录残留旧版本文件导致“静默回滚”。
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true, errorOnExist: false });
}

module.exports = {
  copyDirectoryContents,
  deleteAppBlob,
  deleteAppDocument,
  deleteCachedImages,
  ensureStorageDirectories,
  getBackendImageCacheDirectory,
  getAppCacheDirectory,
  getAppDataDirectory,
  getDefaultStoragePaths,
  getPersistentImageCacheDirectory,
  getPreferencesPath,
  getStorageConfigPath,
  getTaskDatabasePath,
  getUsageHistoryPath,
  loadStoragePaths,
  loadPreferences,
  loadUsageHistory,
  normalizeStoragePaths,
  readCachedImage,
  readAppBlob,
  readAppDocument,
  saveDownload,
  savePreferences,
  saveStoragePaths,
  saveUsageHistory,
  listAppBlobKeys,
  writeAppBlob,
  writeAppDocument,
  writeCachedImage,
};

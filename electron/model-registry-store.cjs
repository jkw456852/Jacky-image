const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_VERSION = 3;
const SECURE_REGISTRY_FILE_NAME = 'model-registry.secure.json';
const MAX_REGISTRY_BYTES = 5 * 1024 * 1024;

function getSecureRegistryPath(appDataDirectory, appName = 'Jacky Image') {
  return path.join(appDataDirectory, appName, 'config', SECURE_REGISTRY_FILE_NAME);
}

function cloneAndValidateRegistry(registry) {
  let serialized;
  try {
    serialized = JSON.stringify(registry);
  } catch {
    throw new Error('模型配置无法序列化');
  }

  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_REGISTRY_BYTES) {
    throw new Error('模型配置为空或超过大小限制');
  }

  const cloned = JSON.parse(serialized);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new Error('模型配置格式无效');
  }
  if (!Array.isArray(cloned.imageModels) || !Array.isArray(cloned.textModels)) {
    throw new Error('模型配置缺少模型列表');
  }
  if (!cloned.defaults || typeof cloned.defaults !== 'object' || Array.isArray(cloned.defaults)) {
    throw new Error('模型配置缺少默认模型设置');
  }
  return cloned;
}

function decryptLegacyApiKey(encryptedApiKey, safeStorage) {
  if (!encryptedApiKey) return '';
  if (typeof encryptedApiKey !== 'string') throw new Error('旧版加密 API Key 格式无效');
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error('无法解密旧版 API Key，请在原 Windows 用户下启动一次完成迁移');
  }
  return safeStorage.decryptString(Buffer.from(encryptedApiKey, 'base64'));
}

function readLegacyEncryptedModel(model, safeStorage) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return model;
  const { encryptedApiKey, apiKey: plaintextApiKey, ...rest } = model;
  return {
    ...rest,
    apiKey: typeof plaintextApiKey === 'string'
      ? plaintextApiKey
      : decryptLegacyApiKey(encryptedApiKey, safeStorage),
  };
}

function encryptApiKey(apiKey, safeStorage) {
  if (!apiKey) return undefined;
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error('Windows 安全存储不可用，无法保存 API Key');
  }
  return safeStorage.encryptString(apiKey).toString('base64');
}

function decryptApiKey(encryptedApiKey, safeStorage) {
  if (!encryptedApiKey) return '';
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error('Windows 安全存储不可用，无法读取 API Key');
  }
  return safeStorage.decryptString(Buffer.from(encryptedApiKey, 'base64'));
}

function toEncryptedRegistry(registry, safeStorage) {
  const cloned = cloneAndValidateRegistry(registry);
  const protect = model => {
    const { apiKey, encryptedApiKey: _legacyEncrypted, ...metadata } = model;
    const encrypted = encryptApiKey(typeof apiKey === 'string' ? apiKey.trim() : '', safeStorage);
    return encrypted ? { ...metadata, encryptedApiKey: encrypted } : metadata;
  };
  return {
    ...cloned,
    imageModels: cloned.imageModels.map(protect),
    textModels: cloned.textModels.map(protect),
  };
}

function fromEncryptedRegistry(registry, safeStorage) {
  const cloned = cloneAndValidateRegistry(registry);
  const restore = model => {
    const { encryptedApiKey, ...metadata } = model;
    return { ...metadata, apiKey: decryptApiKey(encryptedApiKey, safeStorage) };
  };
  return {
    ...cloned,
    imageModels: cloned.imageModels.map(restore),
    textModels: cloned.textModels.map(restore),
  };
}

function createSecurePayload(registry, safeStorage, metadata = {}) {
  const cloned = cloneAndValidateRegistry(registry);
  return {
    version: REGISTRY_VERSION,
    encryption: 'electron-safeStorage',
    updatedAt: new Date().toISOString(),
    ...(metadata.migratedFromPort ? { migratedFromPort: metadata.migratedFromPort } : {}),
    registry: toEncryptedRegistry(cloned, safeStorage),
  };
}

function parseSecurePayload(payload, safeStorage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('模型配置文件格式无效');
  }

  if (payload.version === REGISTRY_VERSION && payload.encryption === 'electron-safeStorage') {
    return fromEncryptedRegistry(payload.registry, safeStorage);
  }

  if (payload.version === 2 && payload.encryption === 'none') {
    return cloneAndValidateRegistry(payload.registry);
  }

  if (payload.version === 1 && payload.encryption === 'electron-safeStorage') {
    const registry = cloneAndValidateRegistry(payload.registry);
    return {
      ...registry,
      imageModels: registry.imageModels.map(model => readLegacyEncryptedModel(model, safeStorage)),
      textModels: registry.textModels.map(model => readLegacyEncryptedModel(model, safeStorage)),
    };
  }

  if (Array.isArray(payload.imageModels) && Array.isArray(payload.textModels) && payload.defaults) {
    return cloneAndValidateRegistry(payload);
  }

  throw new Error(`不支持的模型配置文件版本: ${payload.version ?? 'unknown'}`);
}

function loadSecureRegistry(filePath, safeStorage) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_REGISTRY_BYTES) throw new Error('模型配置文件超过大小限制');
  return parseSecurePayload(JSON.parse(fs.readFileSync(filePath, 'utf8')), safeStorage);
}

function saveSecureRegistry(filePath, registry, safeStorage, metadata = {}) {
  const payload = createSecurePayload(registry, safeStorage, metadata);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return cloneAndValidateRegistry(registry);
}

module.exports = {
  SECURE_REGISTRY_FILE_NAME,
  cloneAndValidateRegistry,
  createSecurePayload,
  getSecureRegistryPath,
  loadSecureRegistry,
  parseSecurePayload,
  saveSecureRegistry,
};

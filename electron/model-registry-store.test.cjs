const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createSecurePayload,
  getSecureRegistryPath,
  loadSecureRegistry,
  parseSecurePayload,
  saveSecureRegistry,
} = require('./model-registry-store.cjs');

const registry = {
  imageModels: [{ id: 'image-1', name: 'Image', apiKey: 'image-secret' }],
  textModels: [{ id: 'text-1', name: 'Text', apiKey: 'text-secret' }],
  defaults: { textToImage: 'image-1', reversePrompt: 'text-1' },
};

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value, 'utf8').map(byte => byte ^ 0xa5),
  decryptString: buffer => Buffer.from(buffer).map(byte => byte ^ 0xa5).toString('utf8'),
};

test('uses the fixed Jacky Image roaming AppData path', () => {
  assert.equal(
    getSecureRegistryPath('C:\\Users\\Jacky\\AppData\\Roaming'),
    path.join('C:\\Users\\Jacky\\AppData\\Roaming', 'Jacky Image', 'config', 'model-registry.secure.json'),
  );
});

test('stores API keys encrypted in the JSON payload', () => {
  const payload = createSecurePayload(registry, safeStorage);
  const serialized = JSON.stringify(payload);

  assert.equal(payload.encryption, 'electron-safeStorage');
  assert.equal(payload.registry.imageModels[0].apiKey, undefined);
  assert.equal(typeof payload.registry.imageModels[0].encryptedApiKey, 'string');
  assert.equal(serialized.includes('image-secret'), false);
  assert.equal(serialized.includes('text-secret'), false);
});

test('round-trips the registry through safeStorage', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jacky-model-registry-'));
  const filePath = path.join(directory, 'config', 'model-registry.secure.json');
  try {
    saveSecureRegistry(filePath, registry, safeStorage, { migratedFromPort: 3000 });
    assert.deepEqual(loadSecureRegistry(filePath, safeStorage), registry);

    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.migratedFromPort, 3000);
    assert.equal(JSON.stringify(onDisk).includes('image-secret'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reads the previous safeStorage format for one-time plaintext migration', () => {
  const encrypt = value => safeStorage.encryptString(value).toString('base64');
  const legacyPayload = {
    version: 1,
    encryption: 'electron-safeStorage',
    registry: {
      imageModels: [{ id: 'image-1', name: 'Image', encryptedApiKey: encrypt('image-secret') }],
      textModels: [{ id: 'text-1', name: 'Text', encryptedApiKey: encrypt('text-secret') }],
      defaults: registry.defaults,
    },
  };

  assert.deepEqual(parseSecurePayload(legacyPayload, safeStorage), registry);
});

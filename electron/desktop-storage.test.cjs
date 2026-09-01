const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  deleteCachedImages,
  deleteAppBlob,
  getDefaultStoragePaths,
  getStorageConfigPath,
  loadPreferences,
  loadStoragePaths,
  loadUsageHistory,
  readCachedImage,
  readAppBlob,
  readAppDocument,
  saveDownload,
  savePreferences,
  saveStoragePaths,
  saveUsageHistory,
  writeCachedImage,
  writeAppBlob,
  writeAppDocument,
} = require('./desktop-storage.cjs');

test('persists custom storage paths and usage history as local files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jacky-storage-'));
  try {
    const defaults = getDefaultStoragePaths({
      userDataDirectory: path.join(root, 'user-data'),
      downloadsDirectory: path.join(root, 'downloads'),
    });
    const configPath = getStorageConfigPath(path.join(root, 'app-data'));
    const custom = {
      recordsDirectory: path.join(root, 'records-custom'),
      cacheDirectory: path.join(root, 'cache-custom'),
      downloadsDirectory: path.join(root, 'downloads-custom'),
    };

    saveStoragePaths(configPath, custom, defaults);
    assert.deepEqual(loadStoragePaths(configPath, defaults), custom);

    const jobs = [{ id: 'job-1', status: 'completed', prompt: 'test' }];
    saveUsageHistory(custom, jobs);
    assert.deepEqual(loadUsageHistory(custom), jobs);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writes, reads, and deletes image cache files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jacky-cache-'));
  const paths = { recordsDirectory: path.join(root, 'records'), cacheDirectory: path.join(root, 'cache'), downloadsDirectory: path.join(root, 'downloads') };
  try {
    writeCachedImage(paths, 'job-1', 0, 'image/png', Buffer.from([1, 2, 3]));
    const cached = readCachedImage(paths, 'job-1', 0);
    assert.equal(cached.mimeType, 'image/png');
    assert.deepEqual([...cached.bytes], [1, 2, 3]);
    assert.equal(deleteCachedImages(paths, 'job-1'), 1);
    assert.equal(readCachedImage(paths, 'job-1', 0), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saves downloads with collision-safe names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jacky-download-'));
  const paths = { recordsDirectory: path.join(root, 'records'), cacheDirectory: path.join(root, 'cache'), downloadsDirectory: path.join(root, 'downloads') };
  try {
    const first = saveDownload(paths, 'image.png', Buffer.from('first'));
    const second = saveDownload(paths, 'image.png', Buffer.from('second'));
    assert.equal(path.basename(first), 'image.png');
    assert.equal(path.basename(second), 'image (1).png');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('persists desktop preferences as a validated local file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jacky-preferences-'));
  const paths = {
    recordsDirectory: path.join(root, 'records'),
    cacheDirectory: path.join(root, 'cache'),
    downloadsDirectory: path.join(root, 'downloads'),
  };
  try {
    savePreferences(paths, {
      theme: 'dark',
      'jacky-t2i-settings': JSON.stringify({ outputSize: '2K' }),
      'invalid key': 'ignored',
      broken: 123,
    });
    assert.deepEqual(loadPreferences(paths), {
      theme: 'dark',
      'jacky-t2i-settings': JSON.stringify({ outputSize: '2K' }),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('persists app documents and binary cache entries in custom directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jacky-app-files-'));
  const paths = {
    recordsDirectory: path.join(root, 'records'),
    cacheDirectory: path.join(root, 'cache'),
    downloadsDirectory: path.join(root, 'downloads'),
  };
  try {
    writeAppDocument(paths, 'agent-session', { messages: [{ id: 'message-1' }] });
    assert.deepEqual(readAppDocument(paths, 'agent-session'), {
      messages: [{ id: 'message-1' }],
    });

    writeAppBlob(paths, 'canvas-images', 'image:key-1', 'image/webp', Buffer.from([4, 5, 6]));
    const cached = readAppBlob(paths, 'canvas-images', 'image:key-1');
    assert.equal(cached.mimeType, 'image/webp');
    assert.deepEqual([...cached.bytes], [4, 5, 6]);
    assert.equal(deleteAppBlob(paths, 'canvas-images', 'image:key-1'), true);
    assert.equal(readAppBlob(paths, 'canvas-images', 'image:key-1'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

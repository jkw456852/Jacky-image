const fs = require('node:fs');
const path = require('node:path');
const LEGACY_BRAND_SLUG = Buffer.from('bm92YQ==', 'base64').toString('utf8');

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length && shift <= 35) {
    const byte = buffer[cursor++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset: cursor };
    shift += 7;
  }
  throw new Error('Invalid LevelDB varint');
}

function readPhysicalRecords(buffer) {
  const records = [];
  let fragmented = [];
  for (let blockStart = 0; blockStart < buffer.length; blockStart += 32768) {
    let offset = blockStart;
    const blockEnd = Math.min(blockStart + 32768, buffer.length);
    while (offset + 7 <= blockEnd) {
      const length = buffer.readUInt16LE(offset + 4);
      const type = buffer[offset + 6];
      if (length === 0 && type === 0) break;
      const start = offset + 7;
      const end = start + length;
      if (end > blockEnd || end > buffer.length) break;
      const payload = buffer.subarray(start, end);
      offset = end;

      if (type === 1) records.push(payload);
      else if (type === 2) fragmented = [payload];
      else if (type === 3 && fragmented.length > 0) fragmented.push(payload);
      else if (type === 4 && fragmented.length > 0) {
        fragmented.push(payload);
        records.push(Buffer.concat(fragmented));
        fragmented = [];
      }
    }
  }
  return records;
}

function parseWriteBatch(record) {
  if (record.length < 12) return [];
  const sequence = record.readBigUInt64LE(0);
  const count = record.readUInt32LE(8);
  const operations = [];
  let offset = 12;

  for (let index = 0; index < count && offset < record.length; index += 1) {
    const tag = record[offset++];
    const keyLength = readVarint(record, offset);
    offset = keyLength.offset;
    const key = record.subarray(offset, offset + keyLength.value);
    offset += keyLength.value;

    let value;
    if (tag === 1) {
      const valueLength = readVarint(record, offset);
      offset = valueLength.offset;
      value = record.subarray(offset, offset + valueLength.value);
      offset += valueLength.value;
    }
    operations.push({ sequence: sequence + BigInt(index), tag, key, value });
  }
  return operations;
}

function decodeStorageKey(buffer) {
  const separator = buffer.indexOf(Buffer.from([0, 1]));
  if (separator < 0) return null;
  const prefix = buffer.subarray(0, separator).toString('utf8');
  const originMatch = prefix.match(/_http:\/\/127\.0\.0\.1:(\d+)/);
  if (!originMatch) return null;
  const storageKey = buffer.subarray(separator + 2).toString('utf8');
  if (!storageKey || storageKey.length > 512) return null;
  return { port: Number(originMatch[1]), storageKey };
}

function scoreDecodedText(text) {
  if (!text || text.includes('\u0000') || text.includes('\ufffd')) return -1000;
  let score = 0;
  const printable = Array.from(text).filter(char => char >= ' ' || char === '\n' || char === '\t').length;
  score += printable / Math.max(1, text.length) * 10;
  try {
    JSON.parse(text);
    score += 50;
  } catch {
    if (/^[\w\s.:/+-]+$/.test(text)) score += 5;
  }
  return score;
}

function decodeStorageValue(buffer) {
  if (!buffer) return null;
  const candidates = [];
  const add = (text) => candidates.push({ text, score: scoreDecodedText(text) });

  if (buffer[0] === 1 && buffer.length > 1) add(buffer.subarray(1).toString('utf16le'));
  if (buffer[0] === 0 && buffer.length > 1) add(buffer.subarray(1).toString('utf8'));
  add(buffer.toString('utf8'));
  if (buffer.length % 2 === 0) add(buffer.toString('utf16le'));
  if ((buffer.length - 1) % 2 === 0 && buffer.length > 1) add(buffer.subarray(1).toString('utf16le'));

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.score > -100 ? candidates[0].text : null;
}

function parseLocalStorageLogs(levelDbDirectory) {
  const operations = [];
  if (!fs.existsSync(levelDbDirectory)) return operations;
  const files = fs.readdirSync(levelDbDirectory)
    .filter(name => name.endsWith('.log'))
    .sort();

  for (const fileName of files) {
    try {
      const buffer = fs.readFileSync(path.join(levelDbDirectory, fileName));
      for (const record of readPhysicalRecords(buffer)) {
        operations.push(...parseWriteBatch(record));
      }
    } catch {
      // Ignore locked or malformed auxiliary files.
    }
  }
  operations.sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0);
  return operations;
}

function registryScore(rawValue) {
  try {
    const registry = JSON.parse(rawValue);
    if (!Array.isArray(registry?.imageModels) || !Array.isArray(registry?.textModels)) return -1;
    const models = [...registry.imageModels, ...registry.textModels];
    const configured = models.filter(model => typeof model?.apiKey === 'string' && model.apiKey.trim());
    const realConfigured = configured.filter(model => model.apiKey.trim() !== 'test-key' && !/^test\b/i.test(String(model.name || '')));
    if (realConfigured.length === 0) return -1;
    return realConfigured.length * 100 + configured.length * 10 + models.length;
  } catch {
    return -1;
  }
}

function recoverLegacyLocalStorage(userDataDirectory, targetPort) {
  const levelDbDirectory = path.join(userDataDirectory, 'Local Storage', 'leveldb');
  const origins = new Map();

  for (const operation of parseLocalStorageLogs(levelDbDirectory)) {
    const decodedKey = decodeStorageKey(operation.key);
    if (!decodedKey || decodedKey.port === targetPort) continue;
    let values = origins.get(decodedKey.port);
    if (!values) {
      values = new Map();
      origins.set(decodedKey.port, values);
    }
    if (operation.tag === 0) values.delete(decodedKey.storageKey);
    else {
      const decodedValue = decodeStorageValue(operation.value);
      if (decodedValue != null) values.set(decodedKey.storageKey, decodedValue);
    }
  }

  let best = null;
  for (const [port, values] of origins) {
    const registry = values.get('jacky-model-registry') || values.get(`${LEGACY_BRAND_SLUG}-model-registry`);
    const score = registry ? registryScore(registry) : -1;
    if (score < 0 || (best && score <= best.score)) continue;
    const safeValues = {};
    let totalBytes = 0;
    for (const [key, value] of values) {
      if (typeof value !== 'string' || key.length > 512) continue;
      const bytes = Buffer.byteLength(key) + Buffer.byteLength(value);
      if (totalBytes + bytes > 10 * 1024 * 1024) continue;
      safeValues[key] = value;
      totalBytes += bytes;
    }
    best = { port, score, values: safeValues };
  }

  return best ? { sourcePort: best.port, values: best.values } : null;
}

module.exports = {
  decodeStorageValue,
  parseWriteBatch,
  readPhysicalRecords,
  recoverLegacyLocalStorage,
};

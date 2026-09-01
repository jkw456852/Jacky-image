const http = require('http');
const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('node:dns').promises;
const net = require('node:net');
const next = process.env.NODE_ENV !== 'production' ? require('next') : null;
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const { Agent } = require('undici');

if (process.env.NODE_ENV === 'production' && process.env.JACKY_DESKTOP_MODE !== '1') {
  throw new Error('Jacky Image production server can only be started by the Electron desktop application.');
}

const ENV_FILE_PATH = path.join(process.cwd(), '.env');
const TASK_STATUS = {
  QUEUED: '排队中',
  LEGACY_QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};
function isTerminalTaskStatus(status) {
  return status === TASK_STATUS.COMPLETED || status === TASK_STATUS.FAILED
    || status === TASK_STATUS.CANCELLED || status === 'expired';
}
const GLOBAL_TASK_CONCURRENCY = 50;
const DEFAULT_LIMIT_CONFIG = {
  maxQueueSize: 200,
  rateLimitWindowMs: 60 * 1000,
  maxRequestsPerIp: 20,
  maxRequestsPerApiKey: 20,
  maxPendingTasksPerIp: 20,
  maxPendingTasksPerApiKey: 10,
  retryAfterSeconds: 30,
};
const LIMIT_ERROR_MESSAGES = {
  queueFull: '当前排队任务较多，请稍后再试。',
  rateLimited: '请求太频繁，请稍后再试。',
  tooManyPending: '你已有较多任务正在排队或生成，请稍后再提交。',
  notAcceptingTasks: '服务器正在升级维护，暂不接受新任务。未完成任务将继续完成。',
};

function parseEnvFile(filePath = ENV_FILE_PATH) {
  if (!fs.existsSync(filePath)) return {};

  const values = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    values[key] = value;
  }
  return values;
}

// .env 运行期读取加 1 秒 TTL 缓存：原本每次调用都同步 readFileSync，而
// getQueueStats / 建任务 / 队列广播 / WS 订阅 / 出图前都走它（单次 getQueueStats
// 触发 3 次读盘），在事件循环上造成不必要的同步 IO。1 秒对"改 .env 实时生效"
// 而言对人类无感，符合 README 承诺。
let _runtimeEnvCache = { values: null, expiresAt: 0 };

function getRuntimeEnv() {
  const now = Date.now();
  if (!_runtimeEnvCache.values || now >= _runtimeEnvCache.expiresAt) {
    _runtimeEnvCache = {
      values: { ...process.env, ...parseEnvFile() },
      expiresAt: now + 1000,
    };
  }
  return _runtimeEnvCache.values;
}

function loadEnvFile() {
  const values = parseEnvFile();
  for (const [key, value] of Object.entries(values)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function normalizeProtocolBaseUrl(protocol, url) {
  const normalized = normalizeBaseUrl(url);
  if (!normalized) return '';
  if (protocol === 'google' || protocol === 'google-gemini') {
    return normalized.endsWith('/v1beta') ? normalized.slice(0, -7) : normalized;
  }
  return normalized.endsWith('/v1') ? normalized.slice(0, -3) : normalized;
}

function resolveJackyApiBaseUrl() {
  return normalizeBaseUrl(getRuntimeEnv().JACKY_API_BASE_URL) || 'https://api.openai.com';
}

function hashPromptGalleryPassword(password) {
  return createHash('sha256')
    .update(`${PROMPT_GALLERY_PASSWORD_SALT}${String(password || '')}`)
    .digest('hex');
}

const PORT = Number(process.env.PORT || 3000);
const HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
const DB_PATH = process.env.JACKY_TASK_DB || path.join(__dirname, 'jacky-tasks.sqlite');
const TASK_TTL_MS = 12 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_UPSTREAM_RESPONSE_BYTES = 128 * 1024 * 1024;
const NON_IDEMPOTENT_IMAGE_RETRY_COUNT = 0;
// 开源版：不再硬编码模型列表，由前端通过 protocol 字段指定协议类型
const VALID_PROTOCOLS = new Set(['google', 'openai', 'grok']);
const GPT_IMAGE_QUALITIES = new Set(['auto', 'high', 'medium', 'low']);
const GPT_IMAGE_STYLES = new Set(['auto', 'vivid', 'natural']);
const GPT_IMAGE_BACKGROUNDS = new Set(['auto', 'transparent', 'opaque']);
const DEFAULT_GPT_IMAGE_ADVANCED_PARAMS = {
  quality: 'auto',
  style: 'auto',
  background: 'auto',
};
const PROMPT_GALLERY_PASSWORD_SALT = 'jacky-pg-2026';
const RENDERER_SESSION_TOKEN = String(process.env.JACKY_RENDERER_SESSION_TOKEN || '');
const RENDERER_SESSION_COOKIE = 'jacky_renderer_session';
const CUSTOM_IMAGE_SIZE_LIMITS = {
  multiple: 16,
  maxAspectRatio: 3,
  minPixels: 655360,
  maxPixels: 8294400,
};
const IS_DEV = process.env.NODE_ENV !== 'production';
const STATIC_DIR = path.join(__dirname, '..', 'frontend', 'out');
const IMAGE_DIR = process.env.JACKY_IMAGE_DIR || path.join(__dirname, 'jacky-images');
const DEFAULT_SEAT_COVER_PROMPT_DIR = path.join(__dirname, 'seat-cover-prompts', 'angles');
const SEAT_COVER_PROMPT_DIR = process.env.JACKY_SEAT_COVER_PROMPT_DIR
  || (process.env.JACKY_DESKTOP_MODE === '1'
    ? path.join(process.cwd(), 'prompts', 'seat-cover-angles')
    : DEFAULT_SEAT_COVER_PROMPT_DIR);
const taskRefImages = new Map();
const taskMasks = new Map();

const app = IS_DEV ? next({ dev: IS_DEV, hostname: HOSTNAME, port: PORT, dir: path.join(__dirname, '..', 'frontend') }) : null;
const handle = app ? app.getRequestHandler() : null;
const db = new Database(DB_PATH);
const apiKeys = new Map();
const desktopModelRegistry = new Map();
const taskSources = new Map(); // taskId -> { ip, apiKeyHash }
const rateLimitBuckets = new Map(); // key -> { windowStart: number, count: number }
const pendingCountByIp = new Map(); // ip -> count
const pendingCountByApiKeyHash = new Map(); // apiKeyHash -> count
const queue = [];
let activeCount = 0;
const runningTaskPromises = new Set();
const taskAbortControllers = new Map();
let isShuttingDown = false;
let shutdownPromise = null;
let httpServerRef = null;
let wsServerRef = null;

// ===== WebSocket subscription state =====
const taskSubscriptions = new Map(); // WebSocket -> Set<taskId>
const queueSubscribers = new Set(); // Set<WebSocket>
const wsAlive = new WeakMap(); // WebSocket -> { lastPong: number, missed: number }
const WS_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const WS_PONG_GRACE_MS = 10 * 1000;

function getCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  const entry = raw.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

function isAuthorizedRendererRequest(req) {
  if (!RENDERER_SESSION_TOKEN) return !process.env.JACKY_DESKTOP_MODE;
  const headerToken = String(req.headers['x-jacky-renderer-token'] || '');
  return getCookie(req, RENDERER_SESSION_COOKIE) === RENDERER_SESSION_TOKEN || headerToken === RENDERER_SESSION_TOKEN;
}
// 单条 subscribeTasks 消息最多处理的 taskId 数，以及单连接订阅总量上限，
// 防止一条消息被放大成大量 DB 查询（DoS 面）。
const WS_MAX_TASK_IDS_PER_MESSAGE = 200;
const WS_MAX_SUBSCRIPTIONS_PER_SOCKET = 500;
let queueBroadcastTimer = null;
let queueBroadcastPending = false;

function getMaxServerConcurrency() {
  const configured = Number(getRuntimeEnv().JACKY_TASK_CONCURRENCY || GLOBAL_TASK_CONCURRENCY);
  const safeConfigured = Number.isFinite(configured) ? configured : GLOBAL_TASK_CONCURRENCY;
  return Math.max(1, Math.min(GLOBAL_TASK_CONCURRENCY, safeConfigured));
}

function parseIntegerEnv(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function getLimitConfig() {
  const env = getRuntimeEnv();
  return {
    maxQueueSize: parseIntegerEnv(env.JACKY_MAX_QUEUE_SIZE, DEFAULT_LIMIT_CONFIG.maxQueueSize, { min: 0, max: 100000 }),
    rateLimitWindowMs: parseIntegerEnv(env.JACKY_RATE_LIMIT_WINDOW_MS, DEFAULT_LIMIT_CONFIG.rateLimitWindowMs, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    maxRequestsPerIp: parseIntegerEnv(env.JACKY_RATE_LIMIT_MAX_REQUESTS_PER_IP, DEFAULT_LIMIT_CONFIG.maxRequestsPerIp, { min: 0, max: 100000 }),
    maxRequestsPerApiKey: parseIntegerEnv(env.JACKY_RATE_LIMIT_MAX_REQUESTS_PER_API_KEY, DEFAULT_LIMIT_CONFIG.maxRequestsPerApiKey, { min: 0, max: 100000 }),
    maxPendingTasksPerIp: parseIntegerEnv(env.JACKY_MAX_PENDING_TASKS_PER_IP, DEFAULT_LIMIT_CONFIG.maxPendingTasksPerIp, { min: 0, max: 100000 }),
    maxPendingTasksPerApiKey: parseIntegerEnv(env.JACKY_MAX_PENDING_TASKS_PER_API_KEY, DEFAULT_LIMIT_CONFIG.maxPendingTasksPerApiKey, { min: 0, max: 100000 }),
    retryAfterSeconds: parseIntegerEnv(env.JACKY_RATE_LIMIT_RETRY_AFTER_SECONDS, DEFAULT_LIMIT_CONFIG.retryAfterSeconds, { min: 1, max: 24 * 60 * 60 }),
  };
}

function createHttpError(statusCode, code, message, retryAfterSeconds) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.retryAfter = retryAfterSeconds;
  return error;
}

function isHttpError(error) {
  return error && typeof error.statusCode === 'number' && typeof error.code === 'string';
}

function getClientIp(req) {
  const forwardedFor = req?.headers?.['x-forwarded-for'];
  const firstForwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const ip = String(firstForwarded || '').split(',')[0].trim()
    || req?.socket?.remoteAddress
    || 'unknown';
  return ip.replace(/^::ffff:/, '');
}

function hashApiKey(apiKey) {
  return createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 24);
}

function normalizeDesktopModel(model, kind) {
  if (!model || typeof model !== 'object') return null;
  const id = String(model.id || '').trim();
  const apiKey = String(model.apiKey || '').trim();
  const baseUrl = String(model.baseUrl || '').trim();
  const modelId = String(model.modelId || '').trim();
  const protocol = String(model.protocol || '').trim();
  const builtinPreset = String(model.builtinPreset || '').trim();
  if (!id || !apiKey || !baseUrl || !modelId || !protocol) return null;
  return { id, kind, apiKey, baseUrl, modelId, protocol, builtinPreset };
}

function replaceDesktopModelRegistry(registry) {
  const next = new Map();
  for (const model of Array.isArray(registry?.imageModels) ? registry.imageModels : []) {
    const normalized = normalizeDesktopModel(model, 'image');
    if (normalized) next.set(normalized.id, normalized);
  }
  for (const model of Array.isArray(registry?.textModels) ? registry.textModels : []) {
    const normalized = normalizeDesktopModel(model, 'text');
    if (normalized) next.set(normalized.id, normalized);
  }
  desktopModelRegistry.clear();
  for (const [id, model] of next) desktopModelRegistry.set(id, model);
  return desktopModelRegistry.size;
}

function resolveDesktopModel(modelConfigId, expectedKind) {
  const id = String(modelConfigId || '').trim();
  const model = desktopModelRegistry.get(id);
  if (!model || (expectedKind && model.kind !== expectedKind)) {
    throw createHttpError(400, 'MODEL_NOT_CONFIGURED', `模型配置不可用: ${id || 'missing'}`);
  }
  return model;
}

function cleanupTaskRuntimeState(taskId) {
  const source = taskSources.get(taskId);
  if (source) {
    // 递减 IP 计数
    if (source.ip) {
      const ipCount = pendingCountByIp.get(source.ip) || 0;
      if (ipCount <= 1) {
        pendingCountByIp.delete(source.ip);
      } else {
        pendingCountByIp.set(source.ip, ipCount - 1);
      }
    }
    // 递减 apiKeyHash 计数
    if (source.apiKeyHash) {
      const hashCount = pendingCountByApiKeyHash.get(source.apiKeyHash) || 0;
      if (hashCount <= 1) {
        pendingCountByApiKeyHash.delete(source.apiKeyHash);
      } else {
        pendingCountByApiKeyHash.set(source.apiKeyHash, hashCount - 1);
      }
    }
  }
  apiKeys.delete(taskId);
  taskRefImages.delete(taskId);
  taskMasks.delete(taskId);
  taskSources.delete(taskId);
}

function getPendingCountForSource(fieldName, value) {
  if (!value) return 0;
  // O(1) 查找：使用独立计数器代替遍历 taskSources
  if (fieldName === 'ip') return pendingCountByIp.get(value) || 0;
  if (fieldName === 'apiKeyHash') return pendingCountByApiKeyHash.get(value) || 0;
  // fallback：未知字段仍用遍历（不应发生）
  let count = 0;
  for (const source of taskSources.values()) {
    if (source?.[fieldName] === value) count++;
  }
  return count;
}

function consumeRateLimit(bucketKey, maxRequests, windowMs) {
  if (maxRequests <= 0) {
    return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }
  const now = Date.now();
  const existing = rateLimitBuckets.get(bucketKey);
  if (!existing || now - existing.windowStart >= windowMs) {
    rateLimitBuckets.set(bucketKey, { windowStart: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (existing.count >= maxRequests) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - existing.windowStart)) / 1000)) };
  }
  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

function cleanupRateLimitBuckets() {
  const now = Date.now();
  const maxWindowMs = getLimitConfig().rateLimitWindowMs;
  for (const [key, bucket] of rateLimitBuckets) {
    if (!bucket || now - bucket.windowStart > maxWindowMs * 2) {
      rateLimitBuckets.delete(key);
    }
  }
}

function enforceRateLimit(req, body, config) {
  const ip = getClientIp(req);
  const apiKeyHash = hashApiKey(body.apiKey);
  const ipLimit = consumeRateLimit(`ip:${ip}`, config.maxRequestsPerIp, config.rateLimitWindowMs);
  if (!ipLimit.allowed) {
    throw createHttpError(429, 'RATE_LIMITED', LIMIT_ERROR_MESSAGES.rateLimited, Math.max(config.retryAfterSeconds, ipLimit.retryAfterSeconds));
  }
  const apiKeyLimit = consumeRateLimit(`api:${apiKeyHash}`, config.maxRequestsPerApiKey, config.rateLimitWindowMs);
  if (!apiKeyLimit.allowed) {
    throw createHttpError(429, 'RATE_LIMITED', LIMIT_ERROR_MESSAGES.rateLimited, Math.max(config.retryAfterSeconds, apiKeyLimit.retryAfterSeconds));
  }
  return { ip, apiKeyHash };
}

function enforceQueueCapacity(source, config) {
  const stats = getQueueStats();
  if (stats.pendingCount >= config.maxQueueSize) {
    throw createHttpError(503, 'QUEUE_FULL', LIMIT_ERROR_MESSAGES.queueFull, config.retryAfterSeconds);
  }
  if (getPendingCountForSource('ip', source.ip) >= config.maxPendingTasksPerIp) {
    throw createHttpError(429, 'TOO_MANY_PENDING_TASKS', LIMIT_ERROR_MESSAGES.tooManyPending, config.retryAfterSeconds);
  }
  if (getPendingCountForSource('apiKeyHash', source.apiKeyHash) >= config.maxPendingTasksPerApiKey) {
    throw createHttpError(429, 'TOO_MANY_PENDING_TASKS', LIMIT_ERROR_MESSAGES.tooManyPending, config.retryAfterSeconds);
  }
}

function isRejectNewTasksEnabled() {
  const env = getRuntimeEnv();
  const rejectSwitch = String(env.JACKY_REJECT_NEW_TASKS || '').trim().toLowerCase();
  const acceptSwitch = String(env.JACKY_ACCEPT_NEW_TASKS || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(rejectSwitch) || acceptSwitch === 'false' || acceptSwitch === '0';
}

function getQueueStats() {
  const config = getLimitConfig();
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM tasks
    WHERE status IN (?, ?, ?)
    GROUP BY status
  `).all(TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED, TASK_STATUS.PROCESSING);
  const counts = Object.fromEntries(rows.map(row => [row.status, Number(row.count || 0)]));
  const processingCount = counts[TASK_STATUS.PROCESSING] || 0;
  const queuedCount = (counts[TASK_STATUS.QUEUED] || 0) + (counts[TASK_STATUS.LEGACY_QUEUED] || 0);
  const totalActiveTasks = processingCount + queuedCount;
  const acceptingNewTasks = !isShuttingDown && !isRejectNewTasksEnabled();

  return {
    concurrencyLimit: GLOBAL_TASK_CONCURRENCY,
    configuredConcurrency: getMaxServerConcurrency(),
    processingCount,
    queuedCount,
    pendingCount: totalActiveTasks,
    maxQueueSize: config.maxQueueSize,
    remainingQueueSlots: Math.max(0, config.maxQueueSize - totalActiveTasks),
    displayConcurrency: Math.min(GLOBAL_TASK_CONCURRENCY, totalActiveTasks),
    displayQueued: Math.max(0, totalActiveTasks - GLOBAL_TASK_CONCURRENCY),
    acceptingNewTasks,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMaxRequestsPerIp: config.maxRequestsPerIp,
    rateLimitMaxRequestsPerApiKey: config.maxRequestsPerApiKey,
    retryAfterSeconds: config.retryAfterSeconds,
    serverMessage: acceptingNewTasks ? undefined : LIMIT_ERROR_MESSAGES.notAcceptingTasks,
  };
}

// ===== Image Storage Service =====

function extractSeatCoverAngleRule(template) {
  const startMarker = '{{! JACKY_ANGLE_RULE_START }}';
  const endMarker = '{{! JACKY_ANGLE_RULE_END }}';
  const normalized = String(template || '').trim();
  const start = normalized.indexOf(startMarker);
  const end = normalized.indexOf(endMarker);
  if (start < 0 || end <= start) return normalized;
  return normalized
    .slice(start + startMarker.length, end)
    .trim()
    .replace(/^【摄影机位与构图】\s*(?:\r?\n)?/, '')
    .trim();
}

function ensureSeatCoverPromptDirectory() {
  fs.mkdirSync(SEAT_COVER_PROMPT_DIR, { recursive: true });
  if (!fs.existsSync(DEFAULT_SEAT_COVER_PROMPT_DIR)) return;
  for (const entry of fs.readdirSync(DEFAULT_SEAT_COVER_PROMPT_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.txt')) continue;
    const source = path.join(DEFAULT_SEAT_COVER_PROMPT_DIR, entry.name);
    const target = path.join(SEAT_COVER_PROMPT_DIR, entry.name);
    if (!fs.existsSync(target)) {
      if (entry.name.toLowerCase() === 'readme.txt') {
        fs.copyFileSync(source, target);
      } else {
        const defaultContent = fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '').trim();
        fs.writeFileSync(target, `${extractSeatCoverAngleRule(defaultContent)}\n`, 'utf8');
      }
      continue;
    }
    if (entry.name.toLowerCase() === 'readme.txt') continue;
    const current = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '').trim();
    const compactPrompt = extractSeatCoverAngleRule(current);
    if (compactPrompt === current) continue;
    const backup = `${target}.full-template.bak`;
    if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
    fs.writeFileSync(target, `${compactPrompt}\n`, 'utf8');
    console.log('[seat-cover-prompt-compact]', { fileName: entry.name, contentLength: compactPrompt.length });
  }
}

function resolveSeatCoverAnglePromptFile(name) {
  ensureSeatCoverPromptDirectory();
  const normalizedName = String(name || '').trim();
  if (!normalizedName || normalizedName.includes('..') || /[\\/]/.test(normalizedName)) return null;
  const entry = fs.readdirSync(SEAT_COVER_PROMPT_DIR, { withFileTypes: true })
    .find(item => item.isFile()
      && item.name.toLowerCase().endsWith('.txt')
      && item.name.toLowerCase() !== 'readme.txt'
      && item.name.replace(/\.txt$/i, '').replace(/^\d+[._-]?/, '').trim() === normalizedName);
  if (entry) return path.join(SEAT_COVER_PROMPT_DIR, entry.name);
  return path.join(SEAT_COVER_PROMPT_DIR, `${normalizedName}.txt`);
}

function saveSeatCoverAnglePrompt(name, content) {
  const filePath = resolveSeatCoverAnglePromptFile(name);
  if (!filePath) throw new Error('提示词角度名称无效');
  const normalizedContent = String(content || '').replace(/^\uFEFF/, '').trim();
  if (!normalizedContent) throw new Error('提示词内容不能为空');
  fs.writeFileSync(filePath, `${normalizedContent}\n`, 'utf8');
  const savedContent = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
  if (savedContent !== normalizedContent) throw new Error('提示词写入后校验失败');
  console.log('[seat-cover-prompt-save]', {
    name: String(name || '').trim(),
    fileName: path.basename(filePath),
    contentLength: savedContent.length,
    contentDigest: createHash('sha256').update(savedContent).digest('hex').slice(0, 16),
  });
  return path.basename(filePath);
}

function loadSeatCoverAnglePrompts(directory = SEAT_COVER_PROMPT_DIR) {
  if (directory === SEAT_COVER_PROMPT_DIR) ensureSeatCoverPromptDirectory();
  if (!fs.existsSync(directory)) return {};
  const prompts = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.txt') || entry.name.toLowerCase() === 'readme.txt') continue;
    const name = entry.name.replace(/\.txt$/i, '').replace(/^\d+[._-]?/, '').trim();
    const prompt = fs.readFileSync(path.join(directory, entry.name), 'utf8').replace(/^\uFEFF/, '').trim();
    if (name && prompt) prompts[name] = prompt;
  }
  return prompts;
}

function ensureImageDir() {
  try {
    if (!fs.existsSync(IMAGE_DIR)) {
      fs.mkdirSync(IMAGE_DIR, { recursive: true });
    }
    console.log(`[image-storage] 图片存储目录: ${IMAGE_DIR}`);
  } catch (error) {
    console.error(`[image-storage] 无法创建图片存储目录: ${IMAGE_DIR}`, error);
    process.exit(1);
  }
}

function getImageExtension(mimeType) {
  if (mimeType?.includes('jpeg') || mimeType?.includes('jpg')) return 'jpg';
  if (mimeType?.includes('webp')) return 'webp';
  return 'png';
}

function saveImageToDisk(taskId, itemIndex, subIndex, imageBuffer, mimeType) {
  const ext = getImageExtension(mimeType);
  const fileName = `${taskId}-${itemIndex}-${subIndex}.${ext}`;
  const filePath = path.join(IMAGE_DIR, fileName);
  fs.writeFileSync(filePath, imageBuffer);
  return { filePath, httpUrl: `/api/jacky/images/${taskId}/${itemIndex}` };
}

async function downloadUrlToDisk(taskId, itemIndex, subIndex, imageUrl, signal) {
  const isBlockedIp = address => {
    const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, '');
    if (net.isIPv4(normalized)) return /^(127\.|10\.|192\.168\.|169\.254\.)/.test(normalized) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized) || normalized === '0.0.0.0';
    if (net.isIPv6(normalized)) {
      if (normalized.startsWith('::ffff:')) return isBlockedIp(normalized.slice(7));
      return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd')
        || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff');
    }
    return true;
  };
  const validateRemoteUrl = async value => {
    let parsed;
    try { parsed = new URL(String(value)); } catch { throw new Error('远程图片 URL 无效'); }
    if (parsed.protocol !== 'https:' || !parsed.hostname) throw new Error('远程图片仅支持 HTTPS URL');
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('远程图片地址不允许访问本机或内网');
    const addresses = net.isIP(hostname) ? [hostname] : (await dns.lookup(hostname, { all: true })).map(entry => entry.address);
    if (addresses.length === 0 || addresses.some(isBlockedIp)) throw new Error('远程图片地址不允许访问本机或内网');
    return { parsed, address: addresses[0] };
  };
  let validated = await validateRemoteUrl(imageUrl);
  let parsed = validated.parsed;
  let response;
  let activeDispatcher;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    activeDispatcher = new Agent({ connect: { lookup: (_hostname, _options, callback) => callback(null, validated.address, net.isIPv6(validated.address) ? 6 : 4) } });
    response = await fetchWithTimeout(parsed.toString(), { signal, redirect: 'manual', dispatcher: activeDispatcher });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location || redirect === 3) throw new Error('远程图片重定向次数过多');
    await response.body?.cancel?.().catch(() => undefined);
    await activeDispatcher.close().catch(() => undefined);
    validated = await validateRemoteUrl(new URL(location, parsed).toString());
    parsed = validated.parsed;
  }
  if (!response.ok) throw new Error(`远程图片下载失败: ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_REMOTE_IMAGE_BYTES) throw new Error('远程图片超过大小限制');
  const contentType = response.headers.get('content-type') || 'image/png';
  const chunks = [];
  let total = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REMOTE_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('远程图片超过大小限制');
      }
      chunks.push(Buffer.from(value));
    }
  } else {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_REMOTE_IMAGE_BYTES) throw new Error('远程图片超过大小限制');
    chunks.push(Buffer.from(arrayBuffer));
  }
  const buffer = Buffer.concat(chunks);
  await activeDispatcher?.close?.().catch(() => undefined);
  return saveImageToDisk(taskId, itemIndex, subIndex, buffer, contentType);
}

function getTaskImageFiles(taskId) {
  try {
    if (!fs.existsSync(IMAGE_DIR)) return [];
    const prefix = `${taskId}-`;
    return fs.readdirSync(IMAGE_DIR)
      .filter(name => name.startsWith(prefix))
      .map(name => path.join(IMAGE_DIR, name));
  } catch {
    return [];
  }
}

function deleteImageFile(filePath, _taskId) {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: true, reason: 'not_found' };
    }
    fs.unlinkSync(filePath);
    return { success: true };
  } catch (error) {
    console.warn(`[image-lifecycle] 删除文件失败: ${filePath}`, error?.message || error);
    return { success: false, reason: error?.message || String(error) };
  }
}

function deleteTaskImageFiles(taskId) {
  const files = getTaskImageFiles(taskId);
  let successCount = 0;
  let notFoundCount = 0;
  let failedCount = 0;
  for (const filePath of files) {
    const result = deleteImageFile(filePath, taskId);
    if (result.success && result.reason === 'not_found') {
      notFoundCount++;
    } else if (result.success) {
      successCount++;
    } else {
      failedCount++;
    }
  }
  console.log(`[image-lifecycle] 任务图片清理完成: taskId=${taskId}, total=${files.length}, success=${successCount}, notFound=${notFoundCount}, failed=${failedCount}`);
  return { total: files.length, success: successCount, notFound: notFoundCount, failed: failedCount };
}

function initDatabase() {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      warning TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS task_items (
      task_id TEXT NOT NULL,
      item_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      image_data TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (task_id, item_index)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_expires_at ON tasks(expires_at);
    CREATE INDEX IF NOT EXISTS idx_task_items_task_id ON task_items(task_id);
  `);

  const now = new Date().toISOString();
  db.prepare('UPDATE tasks SET status = ? WHERE status = ?').run(TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED);
  db.prepare('UPDATE task_items SET status = ? WHERE status = ?').run(TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED);
  const interruptedIds = db.prepare(`SELECT id FROM tasks WHERE status IN (?, ?)`)
    .all(TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING).map(r => r.id);
  const markInterrupted = db.transaction(() => {
    db.prepare(`
      UPDATE tasks SET status = 'failed', error = ?, completed_at = ?, expires_at = ?
      WHERE status IN (?, ?)
    `).run('服务器重启，任务已中断，请重新生成', now, new Date(Date.now() + TASK_TTL_MS).toISOString(), TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING);
    if (interruptedIds.length > 0) {
      const placeholders = interruptedIds.map(() => '?').join(',');
      db.prepare(`UPDATE task_items SET status = 'failed', error = ?, completed_at = ? WHERE task_id IN (${placeholders}) AND status IN (?, ?, ?)`)
        .run('服务器重启，任务已中断，请重新生成', now, ...interruptedIds, TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING, TASK_STATUS.LEGACY_QUEUED);
    }
  });
  markInterrupted();
  for (const id of interruptedIds) {
    deleteTaskImageFiles(id);
  }
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendHttpError(res, error) {
  const headers = {};
  if (error.retryAfter) {
    headers['Retry-After'] = String(error.retryAfter);
  }
  // 413 时请求体可能仍在上传，保持 keep-alive 会让残留入站数据干扰下个请求；
  // 显式关闭连接，确保客户端能干净收到这条错误响应。
  if (error.statusCode === 413) {
    headers['Connection'] = 'close';
  }
  sendJson(res, error.statusCode, {
    error: normalizeError(error),
    code: error.code,
    retryAfter: error.retryAfter,
  }, headers);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

// 统一的文件流响应：必须挂 'error' 监听，否则流中途出错（文件被删 / EACCES /
// 磁盘错）会抛出未捕获异常拖垮整个进程。头已发出时只能断开连接。
function pipeFileToResponse(res, filePath, statusCode, headers) {
  const stream = fs.createReadStream(filePath);
  stream.on('error', error => {
    console.warn(`[static] 文件流读取失败: ${filePath}`, error?.message || error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    } else {
      res.destroy(error);
    }
  });
  res.writeHead(statusCode, headers);
  stream.pipe(res);
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(STATIC_DIR)) return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname || '/');
  } catch {
    decodedPath = (pathname || '/').replace(/%(?![0-9a-fA-F]{2})/g, '');
  }
  // 路径遍历防护：规范化后检测 .. 路径段，提前拒绝
  const normalizedPath = path.normalize(decodedPath);
  if (normalizedPath.includes('..')) return false;

  const candidates = [];
  if (normalizedPath.endsWith('/') || normalizedPath.endsWith(path.sep)) {
    candidates.push(path.join(STATIC_DIR, normalizedPath, 'index.html'));
  } else {
    candidates.push(path.join(STATIC_DIR, normalizedPath));
    candidates.push(path.join(STATIC_DIR, `${normalizedPath}.html`));
    candidates.push(path.join(STATIC_DIR, normalizedPath, 'index.html'));
  }

  const staticDirResolved = path.resolve(STATIC_DIR) + path.sep;
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(staticDirResolved) && resolved !== staticDirResolved.slice(0, -1)) continue;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
    pipeFileToResponse(res, resolved, 200, { 'Content-Type': getContentType(resolved) });
    return true;
  }

  const notFound = path.join(STATIC_DIR, '404.html');
  if (fs.existsSync(notFound)) {
    pipeFileToResponse(res, notFound, 404, { 'Content-Type': 'text/html; charset=utf-8' });
    return true;
  }
  return false;
}

const configuredRequestBodyMb = Number.parseInt(process.env.JACKY_MAX_REQUEST_BODY_MB || '24', 10);
const MAX_REQUEST_BODY_MB = Number.isFinite(configuredRequestBodyMb)
  ? Math.max(10, Math.min(64, configuredRequestBodyMb))
  : 24;
const MAX_REQUEST_BODY_BYTES = MAX_REQUEST_BODY_MB * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (contentType && !contentType.startsWith('application/json')) {
      reject(createHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json'));
      req.resume();
      return;
    }
    let raw = '';
    let receivedBytes = 0;
    let aborted = false;
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (declaredLength > MAX_REQUEST_BODY_BYTES) {
      reject(createHttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大：局部裁切图或参考图数据超过限制，请减少参考图数量或降低区域生成分辨率后重试。'));
      req.resume();
      return;
    }
    req.on('data', chunk => {
      if (aborted) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
        aborted = true;
        raw = ''; // 释放已缓冲内存
        // 不再 req.destroy()：直接重置连接会让客户端收到 ERR_CONNECTION_RESET，
        // 看不到任何错误信息。改为排空剩余入站数据，并以 413 优雅返回（catch -> sendHttpError）。
        req.resume();
        reject(createHttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大：局部裁切图或参考图数据超过限制，请减少参考图数量或降低区域生成分辨率后重试。'));
        return;
      }
      raw += buffer.toString('utf8');
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求 JSON 格式无效'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|fetch failed|networkerror|network request failed|load failed|network connection was lost|econnreset|socket hang up|terminated/i.test(message)) {
    return '网络连接失败。请检查服务器网络连接或稍后重试。';
  }
  if (/abort|timeout|timed out/i.test(message)) {
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000}秒）。高分辨率图片生成需要更长时间，请稍后重试。`;
  }
  // 截断非预定义错误消息，避免泄露内部信息（文件路径、堆栈等）
  return message.length > 200 ? message.slice(0, 200) + '…' : message;
}

function validateEnumValue(value, validValues, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!validValues.has(value)) {
    throw new Error(`${fieldName} 参数无效`);
  }
  return value;
}

function normalizeGptImageAdvancedParams(params = {}) {
  const quality = validateEnumValue(params.gptImageQuality, GPT_IMAGE_QUALITIES, 'quality');
  const style = validateEnumValue(params.gptImageStyle, GPT_IMAGE_STYLES, 'style');
  const background = validateEnumValue(params.gptImageBackground, GPT_IMAGE_BACKGROUNDS, 'background');

  return {
    quality: quality || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.quality,
    style: style || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.style,
    background: background || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.background,
  };
}

function validateCreatePayload(body) {
  if (!body || typeof body !== 'object') throw new Error('请求体不能为空');
  const configuredModel = resolveDesktopModel(body.modelConfigId, 'image');
  body.apiKey = configuredModel.apiKey;
  body.baseUrl = configuredModel.baseUrl;
  body.protocol = configuredModel.protocol;
  body.model = configuredModel.modelId;
  body.modelPreset = configuredModel.builtinPreset;
  if (!VALID_PROTOCOLS.has(body.protocol)) throw new Error('协议类型无效，必须为 google、openai 或 grok');
  if (body.mode !== 'text-to-image' && body.mode !== 'image-to-image') throw new Error('任务模式无效');
  if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) throw new Error('提示词不能为空');
  if (typeof body.model !== 'string' || body.model.trim().length === 0) throw new Error('模型名称不能为空');
  if (!Number.isInteger(body.parallelCount) || body.parallelCount < 1 || body.parallelCount > 4) throw new Error('并发数量无效');

  body.webSearchEnabled = Boolean(body.webSearchEnabled);
  body.imageSearchEnabled = Boolean(body.imageSearchEnabled);
  if ((body.webSearchEnabled || body.imageSearchEnabled) && body.protocol !== 'google') {
    throw new Error('当前模型协议不支持搜索接地');
  }
  const searchModels = [body.model, body.modelPreset].filter(Boolean).map(String);
  const supportsWebSearch = [
    'gemini-3-pro-image-preview',
    'gemini-3-pro-image',
    'gemini-3.1-flash-image-preview',
    'gemini-3.1-flash-image',
  ].some(model => searchModels.includes(model));
  const supportsImageSearch = [
    'gemini-3.1-flash-image-preview',
    'gemini-3.1-flash-image',
  ].some(model => searchModels.includes(model));
  if (body.webSearchEnabled && !supportsWebSearch) throw new Error('当前模型不支持联网搜索');
  if (body.imageSearchEnabled && !supportsImageSearch) throw new Error('当前模型不支持图片搜索');

  if (!Array.isArray(body.images)) body.images = [];
  if (body.mask != null) {
    if (!body.mask || typeof body.mask !== 'object') throw new Error('蒙版数据无效');
    if (typeof body.mask.data !== 'string' || body.mask.data.length === 0) throw new Error('蒙版图像数据为空');
    if (body.mask.mimeType !== 'image/png') throw new Error('蒙版必须转换为 PNG 格式');
    if (body.mask.representation !== 'alpha' && body.mask.representation !== 'black-white') {
      throw new Error('蒙版表示格式无效');
    }
    if (!Number.isInteger(body.mask.width) || body.mask.width <= 0 || !Number.isInteger(body.mask.height) || body.mask.height <= 0) {
      throw new Error('蒙版尺寸无效');
    }
    if (body.protocol === 'openai' && body.mask.representation !== 'alpha') {
      throw new Error('OpenAI 图片编辑需要 Alpha PNG 蒙版');
    }
    if ((body.protocol === 'google' || body.protocol === 'grok') && body.mask.representation !== 'black-white') {
      throw new Error('当前模型协议需要黑白语义蒙版');
    }
  }
  body.baseUrl = normalizeProtocolBaseUrl(body.protocol, body.baseUrl);
  if (!body.baseUrl) throw new Error('缺少 API 基础地址');
  // 开源版：不做模型级参数规范化，前端负责传递正确的参数，后端无条件透传
}

function createTask(body, req) {
  validateCreatePayload(body);
  const limitConfig = getLimitConfig();
  if (isShuttingDown || isRejectNewTasksEnabled()) {
    throw createHttpError(503, 'SERVER_NOT_ACCEPTING_TASKS', LIMIT_ERROR_MESSAGES.notAcceptingTasks, limitConfig.retryAfterSeconds);
  }
  const source = enforceRateLimit(req, body, limitConfig);
  enforceQueueCapacity(source, limitConfig);

  const taskId = randomUUID();
  const now = new Date().toISOString();
  const requestForDb = {
    mode: body.mode,
    source: 'jacky',
    modelConfigId: body.modelConfigId,
    protocol: body.protocol,
    baseUrl: body.baseUrl,
    prompt: body.prompt,
    outputSize: body.outputSize,
    customSize: body.customSize,
    aspectRatio: body.aspectRatio,
    temperature: body.temperature,
    webSearchEnabled: body.webSearchEnabled,
    imageSearchEnabled: body.imageSearchEnabled,
    model: body.model,
    modelPreset: body.modelPreset,
    gptImageQuality: body.gptImageQuality,
    gptImageStyle: body.gptImageStyle,
    gptImageBackground: body.gptImageBackground,
    parallelCount: body.parallelCount,
    images: body.images.map((img, index) => ({
      index: index + 1,
      mimeType: img.mimeType,
      role: img.role,
      byteLength: typeof img.data === 'string' ? Buffer.byteLength(img.data, 'base64') : 0,
      digest: typeof img.data === 'string' && img.data
        ? createHash('sha256').update(img.data).digest('hex').slice(0, 16)
        : undefined,
    })),
    mask: body.mask ? {
      mimeType: body.mask.mimeType,
      representation: body.mask.representation,
      width: body.mask.width,
      height: body.mask.height,
      inverted: Boolean(body.mask.inverted),
    } : undefined,
  };
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO tasks (id, status, mode, request_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, TASK_STATUS.QUEUED, body.mode, JSON.stringify(requestForDb), now);
    const insertItem = db.prepare(`
      INSERT INTO task_items (task_id, item_index, status, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (let index = 0; index < body.parallelCount; index++) {
      insertItem.run(taskId, index, TASK_STATUS.QUEUED, now);
    }
  });
  tx();

  if (requestForDb.images.some(image => image.role === 'angle-structure-reference' || image.role === 'angle-reference')) {
    console.log('[seat-cover-angle-request]', JSON.stringify({
      taskId,
      protocol: requestForDb.protocol,
      model: requestForDb.model,
      aspectRatio: requestForDb.aspectRatio,
      outputSize: requestForDb.outputSize,
      promptLength: requestForDb.prompt.length,
      images: requestForDb.images,
    }));
  }

  apiKeys.set(taskId, body.apiKey);
  taskRefImages.set(taskId, body.images);
  if (body.mask) taskMasks.set(taskId, body.mask);
  taskSources.set(taskId, source);
  // 递增 pending 计数
  if (source.ip) pendingCountByIp.set(source.ip, (pendingCountByIp.get(source.ip) || 0) + 1);
  if (source.apiKeyHash) pendingCountByApiKeyHash.set(source.apiKeyHash, (pendingCountByApiKeyHash.get(source.apiKeyHash) || 0) + 1);
  queue.push(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();
  drainQueue();
  return taskId;
}

function roundToMultiple(value, multiple) {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function greatestCommonDivisor(a, b) {
  let left = Math.abs(Math.trunc(a));
  let right = Math.abs(Math.trunc(b));
  while (right !== 0) {
    [left, right] = [right, left % right];
  }
  return left || 1;
}

function leastCommonMultiple(a, b) {
  return Math.abs(a * b) / greatestCommonDivisor(a, b);
}

function parseImageSize(size) {
  const match = String(size || '').match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/);
  if (!match) return undefined;

  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
}

function isImageSizeWithinLimits(width, height, maxSide) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;

  const limit = typeof maxSide === 'number' && maxSide > 0 ? maxSide : Number.POSITIVE_INFINITY;
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const pixels = width * height;

  return (
    longSide <= limit &&
    width % CUSTOM_IMAGE_SIZE_LIMITS.multiple === 0 &&
    height % CUSTOM_IMAGE_SIZE_LIMITS.multiple === 0 &&
    longSide / shortSide <= CUSTOM_IMAGE_SIZE_LIMITS.maxAspectRatio &&
    pixels >= CUSTOM_IMAGE_SIZE_LIMITS.minPixels &&
    pixels <= CUSTOM_IMAGE_SIZE_LIMITS.maxPixels
  );
}

function fitGptImageResolutionToLimits(width, height, ratioWidth, ratioHeight) {
  const maxSide = 3840;
  if (isImageSizeWithinLimits(width, height, maxSide)) {
    return `${width}x${height}`;
  }

  const multiple = CUSTOM_IMAGE_SIZE_LIMITS.multiple;
  const scaleStep = leastCommonMultiple(
    multiple / greatestCommonDivisor(ratioWidth, multiple),
    multiple / greatestCommonDivisor(ratioHeight, multiple),
  );
  const maxScale = Math.min(
    maxSide / ratioWidth,
    maxSide / ratioHeight,
    Math.sqrt(CUSTOM_IMAGE_SIZE_LIMITS.maxPixels / (ratioWidth * ratioHeight)),
  );
  const fittedScale = Math.floor(maxScale / scaleStep) * scaleStep;
  if (fittedScale <= 0) return undefined;

  const fittedWidth = ratioWidth * fittedScale;
  const fittedHeight = ratioHeight * fittedScale;
  return isImageSizeWithinLimits(fittedWidth, fittedHeight, maxSide)
    ? `${fittedWidth}x${fittedHeight}`
    : undefined;
}

function getGptImageSize(outputSize, aspectRatio) {
  if (outputSize === 'auto' || outputSize === '512' || aspectRatio === 'auto') return undefined;
  const match = String(aspectRatio || '').match(/^(\d+):(\d+)$/);
  if (!match) return undefined;

  const ratioWidth = Number(match[1]);
  const ratioHeight = Number(match[2]);
  if (!ratioWidth || !ratioHeight) return undefined;

  let width;
  let height;

  if (ratioWidth === ratioHeight) {
    const side = outputSize === '1K' ? 1024 : outputSize === '2K' ? 2048 : 3840;
    width = side;
    height = side;
  } else if (outputSize === '1K') {
    const shortSide = 1024;
    width = ratioWidth > ratioHeight
      ? roundToMultiple(shortSide * ratioWidth / ratioHeight, 16)
      : shortSide;
    height = ratioWidth > ratioHeight
      ? shortSide
      : roundToMultiple(shortSide * ratioHeight / ratioWidth, 16);
  } else {
    if (outputSize !== '2K' && outputSize !== '4K') return undefined;
    const longSide = outputSize === '2K' ? 2048 : 3840;
    width = ratioWidth > ratioHeight
      ? longSide
      : roundToMultiple(longSide * ratioWidth / ratioHeight, 16);
    height = ratioWidth > ratioHeight
      ? roundToMultiple(longSide * ratioHeight / ratioWidth, 16)
      : longSide;
  }

  return fitGptImageResolutionToLimits(width, height, ratioWidth, ratioHeight);
}

function normalizeCustomImageSize(size, maxSide) {
  const parsed = parseImageSize(size);
  if (!parsed) return undefined;

  const limit = typeof maxSide === 'number' && maxSide > 0 ? maxSide : Number.POSITIVE_INFINITY;
  const width = Math.min(roundToMultiple(parsed.width, CUSTOM_IMAGE_SIZE_LIMITS.multiple), limit);
  const height = Math.min(roundToMultiple(parsed.height, CUSTOM_IMAGE_SIZE_LIMITS.multiple), limit);
  if (!isImageSizeWithinLimits(width, height, maxSide)) return undefined;

  return `${width}x${height}`;
}

function getSupportedGptImageSize(model, outputSize, aspectRatio) {
  return getGptImageSize(outputSize, aspectRatio);
}

function resolveGptImageRequestSize(request) {
  const customSize = normalizeCustomImageSize(request.customSize, 4096);
  if (customSize) return customSize;
  if (request.outputSize === 'auto') return 'auto';
  return getSupportedGptImageSize(request.model, request.outputSize, request.aspectRatio);
}

function getGptImageRequestAdvancedParams(request) {
  return normalizeGptImageAdvancedParams(request);
}

function createGptImageRequestInit(apiKey, request, resolvedSize, options = {}) {
  const prompt = request.prompt;
  const advancedParams = getGptImageRequestAdvancedParams(request);
  const stream = Boolean(options.stream);

  if (request.mode === 'image-to-image') {
    const formData = new FormData();
    formData.append('model', request.model);
    formData.append('prompt', prompt);
    formData.append('n', '1');
    if (stream) {
      formData.append('stream', 'true');
    }
    if (advancedParams) {
      formData.append('quality', advancedParams.quality);
      formData.append('background', advancedParams.background);
      formData.append('output_format', 'png');
      if (advancedParams.style === 'vivid' || advancedParams.style === 'natural') {
        formData.append('style', advancedParams.style);
      }
    }
    if (resolvedSize) {
      formData.append('size', resolvedSize);
    }

    request.images.forEach((img, index) => {
      const mimeType = img.mimeType || 'image/png';
      const extension = mimeType.split('/')[1] || 'png';
      const bytes = Buffer.from(img.data, 'base64');
      const blob = new Blob([bytes], { type: mimeType });
      formData.append('image', blob, `image-${index}.${extension}`);
    });

    if (request.mask) {
      const maskBytes = Buffer.from(request.mask.data, 'base64');
      const maskBlob = new Blob([maskBytes], { type: 'image/png' });
      formData.append('mask', maskBlob, 'mask.png');
    }

    return {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    };
  }

  const payload = {
    prompt,
    model: request.model,
    ...(stream ? { stream: true } : {}),
    ...(resolvedSize ? { size: resolvedSize } : {}),
    ...(advancedParams ? {
      quality: advancedParams.quality,
      background: advancedParams.background,
      output_format: 'png',
      ...(advancedParams.style === 'vivid' || advancedParams.style === 'natural' ? { style: advancedParams.style } : {}),
    } : {}),
    ...(request.images.length > 0 ? { image: request.images.map(img => `data:${img.mimeType};base64,${img.data}`) } : {}),
  };

  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  };
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isLikelyHtmlResponse(text) {
  const trimmed = String(text || '').trim().toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || trimmed.startsWith('<head') || trimmed.startsWith('<body');
}

function summarizeUnexpectedResponse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (isLikelyHtmlResponse(trimmed)) {
    return '上游返回了 HTML 页面而不是 JSON。通常是 baseUrl 配置错误、请求被站点网关拦截，或该地址并非兼容的图片 API。';
  }
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

function getMessageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();

  const error = payload.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message.trim()) return error.message.trim();
    if (typeof error.code === 'string' && error.code.trim()) return error.code.trim();
  }

  return '';
}

function getErrorMessageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.error) return getMessageFromPayload(payload);

  const type = typeof payload.type === 'string' ? payload.type.toLowerCase() : '';
  if (type === 'error' || type === 'upstream_error') return getMessageFromPayload(payload);

  return '';
}

function getUpstreamErrorText(text) {
  const trimmed = String(text || '').trim();
  const data = parseJsonSafely(trimmed);
  const message = getErrorMessageFromPayload(data) || getMessageFromPayload(data);
  if (message) return message;
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

function truncateForLog(value, maxLength = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function summarizeGeminiInlineData(value) {
  if (!value || typeof value !== 'object') return undefined;
  const data = typeof value.data === 'string' ? value.data : '';
  return {
    mimeType: value.mimeType || value.mime_type,
    hasData: data.length > 0,
    dataLength: data.length,
  };
}

function summarizeGeminiPart(part) {
  if (!part || typeof part !== 'object') return { type: typeof part };
  const inlineData = part.inlineData || part.inline_data;
  const fileData = part.fileData || part.file_data;
  const partSummary = {
    keys: Object.keys(part),
  };
  if (typeof part.text === 'string') partSummary.text = truncateForLog(part.text, 800);
  if (inlineData) partSummary.inlineData = summarizeGeminiInlineData(inlineData);
  if (fileData && typeof fileData === 'object') {
    partSummary.fileData = {
      mimeType: fileData.mimeType || fileData.mime_type,
      fileUri: fileData.fileUri || fileData.file_uri || fileData.uri,
    };
  }
  return partSummary;
}

function buildGeminiNoImageDebug(data, response, responseText) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  return {
    status: response?.status,
    contentType: response?.headers?.get?.('content-type') || undefined,
    bodyLength: String(responseText || '').length,
    topLevelKeys: data && typeof data === 'object' ? Object.keys(data) : [],
    promptFeedback: data?.promptFeedback || data?.prompt_feedback,
    candidates: candidates.slice(0, 4).map((candidate, index) => {
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      return {
        index,
        finishReason: candidate?.finishReason || candidate?.finish_reason,
        finishMessage: truncateForLog(candidate?.finishMessage || candidate?.finish_message, 500),
        safetyRatings: candidate?.safetyRatings || candidate?.safety_ratings,
        contentRole: candidate?.content?.role,
        partCount: parts.length,
        parts: parts.slice(0, 8).map(summarizeGeminiPart),
      };
    }),
  };
}

function getUpstreamDebugSummary(debug) {
  const candidate = Array.isArray(debug?.candidates) ? debug.candidates[0] : undefined;
  const textPart = candidate?.parts?.find(part => typeof part?.text === 'string' && part.text);
  const pieces = [];
  if (candidate?.finishReason) pieces.push(`finishReason=${candidate.finishReason}`);
  if (textPart?.text) pieces.push(`text=${textPart.text}`);
  if (debug?.promptFeedback?.blockReason || debug?.prompt_feedback?.block_reason) {
    pieces.push(`blockReason=${debug.promptFeedback?.blockReason || debug.prompt_feedback?.block_reason}`);
  }
  return truncateForLog(pieces.join('; '), 180);
}

function normalizeImagePayloadValue(imageData) {
  if (!imageData || typeof imageData !== 'string') return undefined;
  if (imageData.startsWith('data:image')) return imageData.split(',')[1] || imageData;
  if (/^https?:\/\//i.test(imageData)) return `URL:${imageData}`;
  return imageData;
}

function getStringImagePayloadValue(data) {
  if (!data || typeof data !== 'object') return undefined;
  const direct = data.b64_json || data.url || data.image_url || data.imageUrl || data.image;
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object' && typeof direct.url === 'string') return direct.url;

  const mimeType = String(data.mimeType || data.mime_type || '').toLowerCase();
  const payloadType = String(data.type || '').toLowerCase();
  if (typeof data.data === 'string' && (mimeType.startsWith('image/') || payloadType.includes('image'))) {
    return data.data;
  }

  const outputType = typeof data.type === 'string' ? data.type.toLowerCase() : '';
  if (outputType.includes('image') && typeof data.result === 'string') return data.result;
  return undefined;
}

function getImagePayloadValue(data, depth = 0) {
  if (!data || depth > 6) return undefined;
  if (Array.isArray(data)) {
    for (const item of data) {
      const value = getImagePayloadValue(item, depth + 1);
      if (value) return value;
    }
    return undefined;
  }
  if (typeof data !== 'object') return undefined;

  const firstImage = Array.isArray(data.data)
    ? data.data.find(item => item && typeof item === 'object' && getStringImagePayloadValue(item))
    : undefined;
  const imageData = getStringImagePayloadValue(firstImage) || getStringImagePayloadValue(data);
  if (imageData) return imageData;

  return getImagePayloadValue(data.result, depth + 1)
    || getImagePayloadValue(data.response, depth + 1)
    || getImagePayloadValue(data.output, depth + 1)
    || getImagePayloadValue(data.output_image, depth + 1)
    || getImagePayloadValue(data.outputImage, depth + 1)
    || getImagePayloadValue(data.images, depth + 1);
}

function extractImagePayload(data) {
  const imageData = normalizeImagePayloadValue(getImagePayloadValue(data));
  if (!imageData) throw new Error('响应中无图片数据');
  return imageData;
}

function parseImageEventStream(text) {
  const payloads = [];
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n').trim();
    dataLines = [];
    if (!raw || raw === '[DONE]') return;
    const parsed = parseJsonSafely(raw);
    if (parsed) payloads.push(parsed);
  };

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();

  return payloads;
}

function isPartialImageEvent(payload) {
  const type = typeof payload?.type === 'string' ? payload.type.toLowerCase() : '';
  return type.includes('partial');
}

function extractImagePayloadFromEventStream(text) {
  const payloads = parseImageEventStream(text);
  const errorMessage = payloads.map(getErrorMessageFromPayload).find(Boolean);

  for (const payload of [...payloads].reverse()) {
    if (isPartialImageEvent(payload)) continue;
    try {
      return extractImagePayload(payload);
    } catch {
      // Keep scanning earlier events.
    }
  }

  if (errorMessage) throw new Error(errorMessage);
  throw new Error('响应中无图片数据');
}

async function parseGptImageResponse(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const responseText = await readResponseTextBounded(response);

  if (!response.ok) {
    const errorText = getUpstreamErrorText(responseText);
    throw new Error(`API 请求失败: ${response.status}${errorText ? ` ${errorText}` : ''}`);
  }

  if (contentType.includes('text/event-stream')) {
    return extractImagePayloadFromEventStream(responseText);
  }

  if (isLikelyHtmlResponse(responseText)) {
    throw new Error('上游返回了 HTML 页面而不是 JSON。通常是 baseUrl 配置错误、请求被站点网关拦截，或该地址并非兼容的图片 API。');
  }

  const data = parseJsonSafely(responseText);
  if (!data) {
    const summary = summarizeUnexpectedResponse(responseText);
    throw new Error(summary ? `响应 JSON 格式无效: ${summary}` : '响应 JSON 格式无效');
  }

  const errorMessage = getErrorMessageFromPayload(data);
  if (errorMessage) throw new Error(errorMessage);

  return extractImagePayload(data);
}

async function requestGptImage(apiKey, request, resolvedSize, options = {}) {
  const baseUrl = options.baseUrl || resolveJackyApiBaseUrl();
  const endpoint = request.mode === 'image-to-image'
    ? '/v1/images/edits'
    : '/v1/images/generations';
  const response = await fetchWithTimeout(
    `${baseUrl}${endpoint}`,
    createGptImageRequestInit(apiKey, request, resolvedSize, options),
    NON_IDEMPOTENT_IMAGE_RETRY_COUNT
  );
  return parseGptImageResponse(response);
}

function getGrokResolution(outputSize) {
  if (outputSize === '2K' || outputSize === '2k') return '2k';
  if (outputSize === '1K' || outputSize === '1k') return '1k';
  return undefined;
}

function getGrokAspectRatio(aspectRatio) {
  if (!aspectRatio || aspectRatio === 'auto') return undefined;
  return String(aspectRatio);
}

function toGrokImageDataUrl(img) {
  if (!img || typeof img !== 'object') return '';
  if (typeof img.dataUrl === 'string' && img.dataUrl.startsWith('data:')) return img.dataUrl;
  const mimeType = img.mimeType || 'image/png';
  const data = typeof img.data === 'string' ? img.data : '';
  if (!data) return '';
  if (data.startsWith('data:')) return data;
  return `data:${mimeType};base64,${data}`;
}

function getSemanticMaskPrompt(prompt) {
  return `${prompt}\n\n蒙版编辑规则：输入图片中的第 1 张是干净原图，第 2 张及之后（如有）是用户参考图，最后一张是黑白语义蒙版。白色区域是唯一允许编辑的区域，黑色区域必须保持不变；蒙版只表示位置，绝不是目标颜色、材质、纹理或光照。用户参考图是必须遵循的视觉证据，生成内容必须明显继承提示词要求的结构、外观或综合特征。严格保持原图构图、相机位置、透视、未编辑区域、文字和颜色稳定。`;
}

function toMaskDataUrl(mask) {
  if (!mask?.data) return '';
  return `data:${mask.mimeType || 'image/png'};base64,${mask.data}`;
}

function getGeminiMaskedEditParts(request, options = {}) {
  const images = Array.isArray(request.images) ? request.images : [];
  const prompt = request.mask ? getSemanticMaskPrompt(request.prompt) : request.prompt;
  const includeImageRoleInstructions = options.includeImageRoleInstructions !== false;
  const parts = [{ text: prompt }];

  images.forEach((image, index) => {
    const role = image?.role;
    const label = role === 'angle-structure-reference'
      ? '输入图片 1：低细节角度结构引导图，也是摄影机位与构图的最高优先级蓝图。必须严格复刻它的相机所在区域、镜头朝向、左右关系、透视、消失点、景别、裁切、座椅位置、遮挡关系和画面占比；后续原车资料图与它发生机位冲突时，始终以输入图片 1 为准。禁止复制图中的车型、车身、门板、中控、颜色、材质、纹理、迷彩图案、缝线、座套设计、背景或渲染风格。若提示词明确要求躺倒或抬起状态，座椅动作以提示词为准。'
      : role === 'angle-reference'
        ? '输入图片 1：固定角度参考图，也是主构图输入。它是摄影机位、拍摄方向、左右关系、透视、景别、裁切范围和座椅状态的最高优先级蓝图；必须严格跟随它的构图，不得只把它当作封面或普通参考图。'
        : role === 'vehicle-reference'
          ? `原车资料图 ${index + 1}：只用于确认目标车辆身份、车型内饰结构、颜色和配置，不用于决定摄影机位。`
          : role === 'seat-product-reference'
            ? `原厂座椅资料图 ${index + 1}：只读取座椅本体的头枕、靠背、侧翼、坐垫、底座、调节部件、面料和配色。图中的方向盘、中控、门板、车厢、车窗、车外环境和背景全部是无效场景信息，绝对不能进入输出；输出必须仍是纯白底独立座椅产品图。`
            : role === 'base-image'
          ? '输入图片 1：干净原图。它是最终构图、颜色和未编辑区域的唯一基准。'
          : role === 'cover-reference'
            ? `座套产品资料图 ${index + 1}：只用于确认座套材质、颜色、纹理、缝线、包边和拼接方式。`
            : index === 0
              ? '输入图片 1：干净原图。它是最终构图、颜色和未编辑区域的唯一基准。'
              : `用户参考图 ${index + 1}：这是必须遵循的视觉证据。生成内容必须明显继承提示词要求的参考特征。`;
    if (includeImageRoleInstructions) parts.push({ text: label });
    parts.push({ inlineData: { data: image.data, mimeType: image.mimeType } });
  });
  if (request.mask) {
    if (includeImageRoleInstructions) parts.push({ text: '最后一张图片：黑白语义蒙版。白色区域编辑，黑色区域保持不变；不要把蒙版的黑白颜色复制到结果中。' });
    parts.push({ inlineData: { data: request.mask.data, mimeType: request.mask.mimeType } });
  }
  return parts;
}

function getGeminiRequestTemperature(request) {
  return request.temperature;
}

function createGrokImageRequestInit(apiKey, request, options = {}) {
  const prompt = request.mask ? getSemanticMaskPrompt(request.prompt) : request.prompt;
  const stream = Boolean(options.stream);
  const aspectRatio = getGrokAspectRatio(request.aspectRatio);
  const resolution = getGrokResolution(request.outputSize);
  const images = Array.isArray(request.images) ? request.images : [];

  if (request.mode === 'image-to-image') {
    if (images.length === 0) {
      throw new Error('图生图模式需要至少一张参考图');
    }
    const dataUrls = images.map(toGrokImageDataUrl).filter(Boolean);
    const maskDataUrl = toMaskDataUrl(request.mask);
    if (maskDataUrl) dataUrls.push(maskDataUrl);
    if (dataUrls.length === 0) {
      throw new Error('参考图数据无效');
    }
    const payload = {
      model: request.model,
      prompt,
      response_format: 'url',
      ...(stream ? { stream: true } : {}),
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      ...(resolution ? { resolution } : {}),
      ...(dataUrls.length === 1 ? { image: dataUrls[0] } : { images: dataUrls }),
    };
    return {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    };
  }

  const payload = {
    model: request.model,
    prompt,
    response_format: 'url',
    ...(stream ? { stream: true } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
  };

  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  };
}

async function requestGrokImage(apiKey, request, options = {}) {
  const baseUrl = options.baseUrl || resolveJackyApiBaseUrl();
  const endpoint = request.mode === 'image-to-image'
    ? '/v1/images/edits'
    : '/v1/images/generations';
  const response = await fetchWithTimeout(
    `${baseUrl}${endpoint}`,
    createGrokImageRequestInit(apiKey, request, options),
    NON_IDEMPOTENT_IMAGE_RETRY_COUNT
  );
  return parseGptImageResponse(response);
}

// ===== 加强网络连接：启用 TCP keepalive，防止 Docker 回环连接被静默断开 =====
// Node.js 内置 fetch 基于 undici，默认不发送 TCP keepalive，
// 导致长时间等待响应（如 4K 图片生成）时连接被 Docker 网络层丢弃。
// 通过 setGlobalDispatcher 配置 undici Agent 的 keepalive 和超时参数。
try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 60 * 1000,         // 空闲连接保持 60 秒
    keepAliveMaxTimeout: 10 * 60 * 1000, // 最大保持 10 分钟
    connect: {
      keepAlive: true,
      keepAliveInitialDelay: 15000,
      timeout: 60 * 1000,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 500,
    },
    bodyTimeout: REQUEST_TIMEOUT_MS,     // 等待响应体的超时（与 abort 超时一致）
    headersTimeout: REQUEST_TIMEOUT_MS,  // 图片生成可能长时间等待响应头，需与任务超时一致
  }));
  console.log('[network] undici Agent 已配置: TCP keepalive=15s, timeout=30min');
} catch (e) {
  console.warn('[network] undici Agent 配置失败，使用默认设置:', e?.message || e);
}

function getNetworkErrorCode(error) {
  return error?.cause?.code || error?.code || '';
}

function isRetryableFetchError(error) {
  const code = String(getNetworkErrorCode(error));
  const message = error instanceof Error ? error.message : String(error);
  return [
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ETIMEDOUT',
  ].includes(code) || /fetch failed|socket hang up|network connection was lost/i.test(message);
}

async function fetchWithTimeout(url, init, retryCount = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const parentSignal = init?.signal;
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal });
    } catch (error) {
      lastError = error;
      if (parentSignal?.aborted || error?.name === 'AbortError') throw error;
      if (attempt >= retryCount || !isRetryableFetchError(error)) throw error;
      const delayMs = 1000 * (attempt + 1);
      console.warn('[network] upstream request failed, retrying', {
        url: String(url).replace(/([?&](?:key|api_key)=)[^&]+/gi, '$1<redacted>'),
        attempt: attempt + 1,
        retryInMs: delayMs,
        code: getNetworkErrorCode(error),
        message: error instanceof Error ? error.message : String(error),
      });
      await new Promise(resolve => setTimeout(resolve, delayMs));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function generateJackyImage(apiKey, request) {
  // 开源版：根据前端传入的 protocol 字段路由到对应的 API 协议
  const baseUrl = request.baseUrl || resolveJackyApiBaseUrl();
  if (request.protocol === 'openai') {
    return requestGptImage(apiKey, request, resolveGptImageRequestSize(request), { baseUrl, signal: request.signal });
  }
  if (request.protocol === 'grok') {
    return requestGrokImage(apiKey, request, { baseUrl, signal: request.signal });
  }
  // 默认走 Google Gemini 协议
  return generateJackyGeminiImage(apiKey, request, { baseUrl, signal: request.signal });
}

async function readResponseTextBounded(response, maxBytes = MAX_UPSTREAM_RESPONSE_BYTES) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('上游响应超过大小限制');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('上游响应超过大小限制');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : undefined;
}

function extractGeminiSearchGrounding(data) {
  const metadata = data?.candidates?.[0]?.groundingMetadata || data?.candidates?.[0]?.grounding_metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;

  const chunks = Array.isArray(metadata.groundingChunks)
    ? metadata.groundingChunks
    : Array.isArray(metadata.grounding_chunks)
      ? metadata.grounding_chunks
      : [];
  const sources = chunks.flatMap(chunk => {
    const web = chunk?.web;
    const image = chunk?.image;
    const source = image || web;
    const uri = source?.uri;
    if (typeof uri !== 'string' || !uri) return [];
    return [{
      uri,
      title: typeof source.title === 'string' ? source.title : undefined,
      type: image ? 'image' : 'web',
    }];
  });
  const searchEntryPoint = metadata.searchEntryPoint || metadata.search_entry_point;
  const searchEntryPointHtml = searchEntryPoint?.renderedContent || searchEntryPoint?.rendered_content;
  const webSearchQueries = normalizeStringArray(metadata.webSearchQueries || metadata.web_search_queries);
  const imageSearchQueries = normalizeStringArray(metadata.imageSearchQueries || metadata.image_search_queries);

  if (!searchEntryPointHtml && !webSearchQueries?.length && !imageSearchQueries?.length && sources.length === 0) {
    return undefined;
  }
  return {
    webSearchQueries,
    imageSearchQueries,
    searchEntryPointHtml: typeof searchEntryPointHtml === 'string' ? searchEntryPointHtml : undefined,
    sources: sources.length > 0 ? sources : undefined,
  };
}

function getGeminiPartImagePayload(part) {
  const inlineData = part?.inlineData || part?.inline_data;
  const inlineImage = normalizeImagePayloadValue(inlineData?.data || inlineData?.b64_json);
  if (inlineImage) return inlineImage;

  const fileData = part?.fileData || part?.file_data;
  const fileUri = fileData?.fileUri || fileData?.file_uri || fileData?.uri;
  if (typeof fileUri === 'string' && /^https?:\/\//i.test(fileUri)) return `URL:${fileUri}`;

  // Some Gemini-compatible proxies return generated images as Markdown links
  // in a text part instead of Gemini's standard inlineData field.
  const text = typeof part?.text === 'string' ? part.text : '';
  const markdownImageUrl = text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i)?.[1];
  const directImageUrl = text.match(/https?:\/\/[^\s)\]]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s)\]]*)?/i)?.[0];
  const textImageUrl = markdownImageUrl || directImageUrl;
  if (textImageUrl) return `URL:${textImageUrl}`;

  return normalizeImagePayloadValue(getImagePayloadValue(part));
}

function extractGeminiImageResult(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const image = getGeminiPartImagePayload(part);
      if (image) {
        return {
          image,
          searchGrounding: extractGeminiSearchGrounding(data),
        };
      }
    }
  }

  const compatibleImage = normalizeImagePayloadValue(getImagePayloadValue(data));
  if (compatibleImage) {
    return {
      image: compatibleImage,
      searchGrounding: extractGeminiSearchGrounding(data),
    };
  }

  throw new Error('响应中无图片数据');
}

function getGeminiSearchTools(request) {
  const searchTypes = {};
  if (request.webSearchEnabled) searchTypes.webSearch = {};
  if (request.imageSearchEnabled) searchTypes.imageSearch = {};
  if (Object.keys(searchTypes).length === 0) return undefined;
  return [{ googleSearch: { searchTypes } }];
}

function getGeminiUpstreamModel(request) {
  // The configured model ID is authoritative. Never silently rename it for
  // a provider: different compatible gateways may expose different aliases.
  return request.model;
}

const GEMINI_IMAGE_ASPECT_RATIOS = new Set([
  '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3',
  '4:5', '5:4', '8:1', '9:16', '16:9', '21:9',
]);

function getGeminiImageConfig(request) {
  const imageConfig = {};
  if (request.outputSize && request.outputSize !== 'auto') imageConfig.imageSize = request.outputSize;
  if (request.aspectRatio && request.aspectRatio !== 'auto' && GEMINI_IMAGE_ASPECT_RATIOS.has(request.aspectRatio)) {
    imageConfig.aspectRatio = request.aspectRatio;
  }
  return Object.keys(imageConfig).length > 0 ? imageConfig : undefined;
}

function getGeminiImageResponseFormat(request) {
  const image = {};
  if (request.outputSize && request.outputSize !== 'auto') image.imageSize = request.outputSize;
  if (request.aspectRatio && request.aspectRatio !== 'auto' && GEMINI_IMAGE_ASPECT_RATIOS.has(request.aspectRatio)) {
    image.aspectRatio = request.aspectRatio;
  }
  return Object.keys(image).length > 0 ? { type: 'image', image } : { type: 'image' };
}

function getGeminiInteractionResponseFormat(request) {
  const responseFormat = { type: 'image' };
  if (request.outputSize && request.outputSize !== 'auto') responseFormat.image_size = request.outputSize;
  if (request.aspectRatio && request.aspectRatio !== 'auto' && GEMINI_IMAGE_ASPECT_RATIOS.has(request.aspectRatio)) {
    responseFormat.aspect_ratio = request.aspectRatio;
  }
  return responseFormat;
}

function isGeminiInteractionImageModel(model) {
  return /^gemini-3(?:\.1)?-(?:pro|flash|flash-lite)-image(?:$|-)/.test(String(model || ''));
}

function shouldUseGeminiInteractions(upstreamModel, baseUrl) {
  const host = (() => {
    try {
      return new URL(baseUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return isGeminiInteractionImageModel(upstreamModel)
    && (host === 'generativelanguage.googleapis.com' || host.endsWith('.generativelanguage.googleapis.com'));
}

function isApilioGeminiImageProxy(model, baseUrl) {
  const host = (() => {
    try {
      return new URL(baseUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return isGeminiInteractionImageModel(model) && host === 'api.apilio.ai';
}

function getGeminiInteractionInput(request) {
  return getGeminiMaskedEditParts(request).flatMap(part => {
    if (typeof part?.text === 'string') return [{ type: 'text', text: part.text }];
    const inlineData = part?.inlineData || part?.inline_data;
    if (inlineData?.data) {
      return [{
        type: 'image',
        data: inlineData.data,
        mime_type: inlineData.mimeType || inlineData.mime_type || 'image/png',
      }];
    }
    return [];
  });
}

function getGeminiInteractionTools(request) {
  const searchTypes = [];
  if (request.webSearchEnabled) searchTypes.push('web_search');
  if (request.imageSearchEnabled) searchTypes.push('image_search');
  return searchTypes.length ? [{ type: 'google_search', search_types: searchTypes }] : undefined;
}

function extractGeminiInteractionImageResult(data) {
  const image = normalizeImagePayloadValue(getImagePayloadValue(data));
  if (image) {
    return {
      image,
      searchGrounding: extractGeminiSearchGrounding(data),
    };
  }
  throw new Error('响应中无图片数据');
}

async function requestGeminiInteractionImage(apiKey, request, options = {}) {
  const baseUrl = options.baseUrl || resolveJackyApiBaseUrl();
  const upstreamModel = getGeminiUpstreamModel(request);
  const tools = getGeminiInteractionTools(request);
  const response = await fetchWithTimeout(`${baseUrl}/v1beta/interactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      model: upstreamModel,
      input: getGeminiInteractionInput(request),
      response_format: getGeminiInteractionResponseFormat(request),
      ...(tools ? { tools } : {}),
    }),
    signal: options.signal,
  }, NON_IDEMPOTENT_IMAGE_RETRY_COUNT);

  if (!response.ok) {
    const errorText = await readResponseTextBounded(response, 2 * 1024 * 1024);
    throw new Error(`API 请求失败: ${response.status} ${errorText}`);
  }

  const responseText = await readResponseTextBounded(response);
  if (isLikelyHtmlResponse(responseText)) {
    throw new Error('上游返回了 HTML 页面而不是 JSON。通常是 baseUrl 配置错误、请求被站点网关拦截，或该地址并非兼容的图片 API。');
  }
  const data = parseJsonSafely(responseText);
  if (!data) {
    const summary = summarizeUnexpectedResponse(responseText);
    throw new Error(summary ? `响应 JSON 格式无效: ${summary}` : '响应 JSON 格式无效');
  }
  try {
    return extractGeminiInteractionImageResult(data);
  } catch (error) {
    if (error instanceof Error && error.message === '响应中无图片数据') {
      error.upstreamDebug = buildGeminiNoImageDebug(data, response, responseText);
    }
    throw error;
  }
}

async function readJsonResponseWithoutWaitingForSocketClose(response, options = {}) {
  if (!response.body || typeof response.body.getReader !== 'function') return readResponseTextBounded(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let decodedText = '';
  let bodyBytes = 0;
  let transportChunks = 0;
  let completedFromJson = false;
  const startedAt = Date.now();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        decodedText += decoder.decode();
        break;
      }
      if (!value) continue;
      transportChunks += 1;
    bodyBytes += value.byteLength;
    if (bodyBytes > MAX_UPSTREAM_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('上游响应超过大小限制');
    }
      decodedText += decoder.decode(value, { stream: true });

      // Some compatible proxies send a complete JSON document but keep the
      // chunked HTTP response open. JSON.parse is a reliable completion test;
      // once it succeeds, the image can be consumed immediately.
      const trimmed = decodedText.trim();
      if ((trimmed.endsWith('}') || trimmed.endsWith(']')) && parseJsonSafely(trimmed)) {
        completedFromJson = true;
        break;
      }
    }
  } finally {
    if (completedFromJson) {
      try {
        await reader.cancel();
      } catch {
        // The proxy may close concurrently after sending the complete JSON.
      }
    }
  }

  console.log('[image-upstream-body]', {
    provider: options.provider || 'google',
    model: options.model || '',
    bodyBytes,
    bodyElapsedMs: Date.now() - startedAt,
    completedFromJson,
    transportChunks,
  });
  return decodedText;
}

async function parseGeminiImageResponse(response, options = {}) {
  if (!response.ok) {
    const errorText = await readJsonResponseWithoutWaitingForSocketClose(response, options);
    throw new Error(`API 请求失败: ${response.status} ${errorText}`);
  }

  const responseText = await readJsonResponseWithoutWaitingForSocketClose(response, options);
  if (isLikelyHtmlResponse(responseText)) {
    throw new Error('上游返回了 HTML 页面而不是 JSON。通常是 baseUrl 配置错误、请求被站点网关拦截，或该地址并非兼容的图片 API。');
  }
  const data = parseJsonSafely(responseText);
  if (!data) {
    const summary = summarizeUnexpectedResponse(responseText);
    throw new Error(summary ? `响应 JSON 格式无效: ${summary}` : '响应 JSON 格式无效');
  }
  try {
    return extractGeminiImageResult(data);
  } catch (error) {
    if (error instanceof Error && error.message === '响应中无图片数据') {
      error.upstreamDebug = buildGeminiNoImageDebug(data, response, responseText);
    }
    throw error;
  }
}

async function requestApilioGeminiImage(apiKey, request, options = {}) {
  const baseUrl = options.baseUrl || resolveJackyApiBaseUrl();
  // Apilio's published example sends every inline image first and a single text
  // part last. Keep this proxy-specific ordering instead of interleaving role
  // labels and images as the native Gemini request does.
  const sourceParts = getGeminiMaskedEditParts(request, { includeImageRoleInstructions: false });
  const imageParts = sourceParts.filter(part => part?.inlineData || part?.inline_data);
  const text = sourceParts
    .filter(part => typeof part?.text === 'string' && part.text.trim())
    .map(part => part.text.trim())
    .join('\n\n');
  const parts = [...imageParts, ...(text ? [{ text }] : [])];
  const imageConfig = getGeminiImageConfig(request);
  const endpointPath = `/v1beta/models/${encodeURIComponent(request.model)}:generateContent`;
  const body = JSON.stringify({
    contents: [{ parts, role: 'user' }],
    generationConfig: {
      ...(imageConfig ? { imageConfig } : {}),
      responseModalities: ['IMAGE'],
    },
  });
  const requestStartedAt = Date.now();
  const requestDebug = {
    provider: 'apilio',
    endpointPath,
    model: request.model,
    requestBodyBytes: Buffer.byteLength(body),
    imageCount: imageParts.length,
    imageBytes: imageParts.reduce((sum, part) => {
      const inlineData = part.inlineData || part.inline_data;
      return sum + Math.floor(String(inlineData?.data || '').length * 3 / 4);
    }, 0),
    textLength: text.length,
    partOrder: text ? ['images', 'text'] : ['images'],
  };
  console.log('[image-upstream-request]', requestDebug);

  try {
    const response = await fetchWithTimeout(`${baseUrl}${endpointPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'identity',
        'Authorization': `Bearer ${apiKey}`,
        'Connection': 'close',
      },
      body,
      signal: options.signal,
    }, NON_IDEMPOTENT_IMAGE_RETRY_COUNT);

    console.log('[image-upstream-response]', {
      provider: 'apilio',
      model: request.model,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      contentLength: response.headers.get('content-length') || '',
      transferEncoding: response.headers.get('transfer-encoding') || '',
      contentEncoding: response.headers.get('content-encoding') || '',
      connection: response.headers.get('connection') || '',
      headersElapsedMs: Date.now() - requestStartedAt,
    });

    return await parseGeminiImageResponse(response, {
      provider: 'apilio',
      model: request.model,
    });
  } catch (error) {
    if (error && typeof error === 'object') {
      error.upstreamDebug = {
        ...requestDebug,
        elapsedMs: Date.now() - requestStartedAt,
        ...(error.upstreamDebug && typeof error.upstreamDebug === 'object' ? error.upstreamDebug : {}),
      };
    }
    throw error;
  }
}

async function generateJackyGeminiImage(apiKey, request, options = {}) {
  const baseUrl = options.baseUrl || resolveJackyApiBaseUrl();
  const parts = getGeminiMaskedEditParts(request);
  const tools = getGeminiSearchTools(request);
  const upstreamModel = getGeminiUpstreamModel(request);
  if (isApilioGeminiImageProxy(request.model, baseUrl)) {
    return requestApilioGeminiImage(apiKey, request, { baseUrl, signal: options.signal });
  }
  if (shouldUseGeminiInteractions(upstreamModel, baseUrl)) {
    return requestGeminiInteractionImage(apiKey, request, { baseUrl, signal: options.signal });
  }
  const responseFormat = getGeminiImageResponseFormat(request);
  const response = await fetchWithTimeout(`${baseUrl}/v1beta/models/${encodeURIComponent(upstreamModel)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      ...(tools ? { tools } : {}),
      generationConfig: {
        temperature: getGeminiRequestTemperature(request),
        responseModalities: ['TEXT', 'IMAGE'],
        responseFormat,
      },
    }),
    signal: options.signal,
  }, NON_IDEMPOTENT_IMAGE_RETRY_COUNT);

  if (!response.ok) {
    const errorText = await readResponseTextBounded(response, 2 * 1024 * 1024);
    throw new Error(`API 请求失败: ${response.status} ${errorText}`);
  }

  const responseText = await readResponseTextBounded(response);
  if (isLikelyHtmlResponse(responseText)) {
    throw new Error('上游返回了 HTML 页面而不是 JSON。通常是 baseUrl 配置错误、请求被站点网关拦截，或该地址并非兼容的图片 API。');
  }
  const data = parseJsonSafely(responseText);
  if (!data) {
    const summary = summarizeUnexpectedResponse(responseText);
    throw new Error(summary ? `响应 JSON 格式无效: ${summary}` : '响应 JSON 格式无效');
  }
  try {
    return extractGeminiImageResult(data);
  } catch (error) {
    if (error instanceof Error && error.message === '响应中无图片数据') {
      error.upstreamDebug = buildGeminiNoImageDebug(data, response, responseText);
    }
    throw error;
  }
}

function drainQueue() {
  const maxConcurrency = getMaxServerConcurrency();
  while (queue.length > 0) {
    const taskId = queue[0];
    const task = db.prepare('SELECT request_json FROM tasks WHERE id = ?').get(taskId);
    const req = task ? JSON.parse(task.request_json) : null;
    const imageSlots = req?.parallelCount || 1;

    // 容量足够 → 放行。容量不足时唯一例外：当前空闲（activeCount===0）且该任务
    // 自身就超过总并发，允许其独占运行（否则永远无法被调度）；其余情况一律等待
    // 在飞任务腾出名额。
    const fitsWithinLimit = activeCount + imageSlots <= maxConcurrency;
    const oversizedTaskCanRunAlone = activeCount === 0 && imageSlots > maxConcurrency;
    if (!fitsWithinLimit && !oversizedTaskCanRunAlone) break;

    queue.shift();
    activeCount += imageSlots;
    const runPromise = runTask(taskId).catch(error => {
      console.error('[task] unexpected task failure', taskId, error);
      try {
        db.prepare("UPDATE tasks SET status = 'failed', error = ?, completed_at = ?, expires_at = ? WHERE id = ? AND status IN ('排队中', 'queued', 'processing')")
          .run(`任务执行异常: ${normalizeError(error)}`, new Date().toISOString(), new Date(Date.now() + TASK_TTL_MS).toISOString(), taskId);
        db.prepare("UPDATE task_items SET status = 'failed', error = ?, completed_at = ? WHERE task_id = ? AND status IN ('排队中', 'queued', 'processing')")
          .run(`任务执行异常: ${normalizeError(error)}`, new Date().toISOString(), taskId);
      } catch (fallbackError) {
        console.error('[task] failed to persist unexpected task failure', taskId, fallbackError);
      }
    }).finally(() => {
      activeCount -= imageSlots;
      runningTaskPromises.delete(runPromise);
      taskAbortControllers.delete(taskId);
      cleanupTaskRuntimeState(taskId);
      drainQueue();
    });
    runningTaskPromises.add(runPromise);
  }
}

async function generateSingleImage(apiKey, request, taskId, index, signal) {
  try {
    signal?.throwIfAborted?.();
    const generated = await generateJackyImage(apiKey, { ...request, signal });
    const image = typeof generated === 'string' ? generated : generated.image;
    const searchGrounding = typeof generated === 'string' ? undefined : generated.searchGrounding;
    const expanded = image.startsWith('MULTI_URL:') ? image.substring(10).split('|||').map(url => `URL:${url}`) : [image];
    const diskRefs = [];
    for (let subIdx = 0; subIdx < expanded.length; subIdx++) {
      const img = expanded[subIdx];
      if (img.startsWith('URL:')) {
        const remoteUrl = img.substring(4);
        const result = await downloadUrlToDisk(taskId, index, subIdx, remoteUrl, signal);
        diskRefs.push(`URL:${result.httpUrl}`);
      } else {
        const buffer = Buffer.from(img, 'base64');
        const result = saveImageToDisk(taskId, index, subIdx, buffer, 'image/png');
        diskRefs.push(`URL:${result.httpUrl}`);
      }
    }
    db.prepare("UPDATE task_items SET status = 'completed', image_data = ?, completed_at = ? WHERE task_id = ? AND item_index = ? AND status = 'processing'")
      .run(JSON.stringify(diskRefs), new Date().toISOString(), taskId, index);
    return { success: true, images: diskRefs, searchGrounding };
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return { success: false, cancelled: true, error: '任务已取消' };
    if (error?.upstreamDebug) {
      console.error('[image-upstream-no-image]', JSON.stringify(error.upstreamDebug));
    }
    console.error('[image] generation attempt failed', {
      taskId,
      index,
      model: request.model,
      protocol: request.protocol,
      baseUrl: request.baseUrl,
      code: getNetworkErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
      cause: error?.cause instanceof Error ? error.cause.message : undefined,
      upstreamDebug: error?.upstreamDebug,
    });
    const upstreamDebugSummary = getUpstreamDebugSummary(error?.upstreamDebug);
    const message = isRetryableFetchError(error)
      ? `网络连接中断，已停止自动重试以避免重复扣费。上游可能已经接单，请先到上游后台确认后再手动重试。原始错误: ${normalizeError(error)}`
      : `${normalizeError(error)}${upstreamDebugSummary ? `；上游响应摘要：${upstreamDebugSummary}` : ''}`;
    db.prepare("UPDATE task_items SET status = 'failed', error = ?, completed_at = ? WHERE task_id = ? AND item_index = ? AND status = 'processing'")
      .run(message, new Date().toISOString(), taskId, index);
    return { success: false, error: message };
  }
}

async function runTask(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const apiKey = apiKeys.get(taskId);
  if (!task || !apiKey || ![TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED].includes(task.status)) {
    cleanupTaskRuntimeState(taskId);
    return;
  }

  const controller = new AbortController();
  taskAbortControllers.set(taskId, controller);
  const signal = controller.signal;
  const request = JSON.parse(task.request_json);
  const refImages = taskRefImages.get(taskId);
  if (refImages && refImages.length > 0) {
    request.images = refImages;
  }
  const mask = taskMasks.get(taskId);
  if (mask) request.mask = mask;
  db.prepare("UPDATE tasks SET status = 'processing' WHERE id = ? AND status IN ('排队中', 'queued')").run(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();

  // 所有图片标记为 processing
  for (let index = 0; index < request.parallelCount; index++) {
    db.prepare("UPDATE task_items SET status = 'processing', created_at = ? WHERE task_id = ? AND item_index = ?")
      .run(new Date().toISOString(), taskId, index);
  }

  // 真正并发生成所有图片
  const itemResults = await Promise.allSettled(
    Array.from({ length: request.parallelCount }, (_, index) =>
      generateSingleImage(apiKey, request, taskId, index, signal)
    )
  );

  // 汇总结果
  const images = [];
  const searchGrounding = [];
  const errors = [];
  for (const result of itemResults) {
    if (result.status === 'fulfilled' && result.value.success) {
      images.push(...result.value.images);
      if (result.value.searchGrounding) searchGrounding.push(result.value.searchGrounding);
    } else {
      const msg = result.status === 'fulfilled'
        ? result.value.error
        : normalizeError(result.reason);
      errors.push(msg);
    }
  }

  if (signal.aborted || db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId)?.status === TASK_STATUS.CANCELLED) {
    cleanupTaskRuntimeState(taskId);
    taskAbortControllers.delete(taskId);
    broadcastTask(taskId);
    broadcastQueueStatus();
    return;
  }
  const completedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
  if (images.length > 0) {
    const warning = errors.length > 0 ? `${errors.length} 张图片生成失败: ${errors.join('; ')}` : null;
    db.prepare(`
      UPDATE tasks SET status = 'completed', result_json = ?, warning = ?, completed_at = ?, expires_at = ? WHERE id = ?
    `).run(JSON.stringify({
      images,
      ...(searchGrounding.length > 0 ? { searchGrounding } : {}),
    }), warning, completedAt, expiresAt, taskId);
  } else {
    db.prepare(`
      UPDATE tasks SET status = 'failed', error = ?, completed_at = ?, expires_at = ? WHERE id = ?
    `).run(`所有图片生成失败: ${errors.join('; ')}`, completedAt, expiresAt, taskId);
  }
  cleanupTaskRuntimeState(taskId);
  taskAbortControllers.delete(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();
}

function serializeTask(task) {
  if (!task) return null;
  if (task.expires_at && Date.parse(task.expires_at) <= Date.now()) {
    return { id: task.id, status: 'expired', error: '该任务已超出取回时间' };
  }
  const result = task.result_json ? JSON.parse(task.result_json) : undefined;
  return {
    id: task.id,
    status: task.status,
    mode: task.mode,
    result,
    error: task.error,
    warning: task.warning,
    createdAt: task.created_at,
    completedAt: task.completed_at,
    expiresAt: task.expires_at,
  };
}

function deleteTask(taskId) {
  deleteTaskImageFiles(taskId);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM task_items WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  });
  tx();
  cleanupTaskRuntimeState(taskId);
  broadcastQueueStatus();
}

function cancelTask(taskId) {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
    if (!task) return false;
    if ([TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED].includes(task.status)) return true;
    db.prepare(`UPDATE tasks SET status = ?, error = ?, completed_at = ?, expires_at = ? WHERE id = ? AND status IN (?, ?, ?)`)
      .run(TASK_STATUS.CANCELLED, '任务已取消', now, new Date(Date.now() + TASK_TTL_MS).toISOString(), taskId,
        TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED, TASK_STATUS.PROCESSING);
    db.prepare(`UPDATE task_items SET status = ?, error = ?, completed_at = ? WHERE task_id = ? AND status IN (?, ?)`)
      .run(TASK_STATUS.CANCELLED, '任务已取消', now, taskId, TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING);
    return true;
  });
  const existed = tx();
  if (!existed) return false;
  const queueIndex = queue.indexOf(taskId);
  if (queueIndex >= 0) queue.splice(queueIndex, 1);
  taskAbortControllers.get(taskId)?.abort();
  cleanupTaskRuntimeState(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();
  return true;
}

function cleanupExpiredTasks() {
  const ids = db.prepare('SELECT id FROM tasks WHERE expires_at IS NOT NULL AND expires_at <= ?').all(new Date().toISOString());
  let successCount = 0;
  let failCount = 0;
  for (const row of ids) {
    broadcastTaskExpired(row.id);
    try {
      deleteTask(row.id);
      successCount++;
    } catch (error) {
      failCount++;
      console.warn(`[cleanup] 过期任务删除失败: taskId=${row.id}`, error?.message || error);
    }
  }
  if (ids.length > 0) {
    console.log(`[cleanup] 本轮过期清理: 检查${ids.length}个任务, 成功${successCount}个, 失败${failCount}个`);
  }
}

// ===== WebSocket broadcasting =====

function safeSendJson(ws, payload) {
  try {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  } catch (error) {
    console.warn('[ws] send failed', error?.message || error);
  }
}

function broadcastTask(taskId) {
  if (!taskId) return;
  let cachedPayload;
  for (const [ws, set] of taskSubscriptions) {
    if (!set.has(taskId)) continue;
    if (cachedPayload === undefined) {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      const task = serializeTask(row) || { id: taskId, status: 'expired', error: '该任务已超出取回时间' };
      cachedPayload = { type: 'task', task };
    }
    safeSendJson(ws, cachedPayload);
    if (isTerminalTaskStatus(cachedPayload.task.status)) {
      set.delete(taskId);
    }
  }
}

function broadcastTaskExpired(taskId) {
  const payload = { type: 'task', task: { id: taskId, status: 'expired', error: '该任务已超出取回时间' } };
  for (const [ws, set] of taskSubscriptions) {
    if (!set.has(taskId)) continue;
    safeSendJson(ws, payload);
    set.delete(taskId);
  }
}

function flushQueueBroadcast() {
  queueBroadcastTimer = null;
  if (!queueBroadcastPending) return;
  queueBroadcastPending = false;
  if (queueSubscribers.size === 0) return;
  const stats = getQueueStats();
  const payload = { type: 'queueStatus', stats };
  for (const ws of queueSubscribers) {
    safeSendJson(ws, payload);
  }
}

function broadcastQueueStatus() {
  queueBroadcastPending = true;
  if (queueBroadcastTimer) return;
  queueBroadcastTimer = setTimeout(flushQueueBroadcast, 200);
}

function handleSubscribeTasks(ws, taskIds) {
  if (!Array.isArray(taskIds)) return;
  let set = taskSubscriptions.get(ws);
  if (!set) {
    set = new Set();
    taskSubscriptions.set(ws, set);
  }
  for (const id of taskIds.slice(0, WS_MAX_TASK_IDS_PER_MESSAGE)) {
    if (typeof id !== 'string' || !id) continue;
    // 已达单连接订阅上限且是新 id 时停止，避免无限增长。
    if (!set.has(id) && set.size >= WS_MAX_SUBSCRIPTIONS_PER_SOCKET) break;
    set.add(id);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    const task = serializeTask(row) || { id, status: 'expired', error: '该任务已超出取回时间' };
    safeSendJson(ws, { type: 'task', task });
    if (isTerminalTaskStatus(task.status)) {
      set.delete(id);
    }
  }
}

function handleUnsubscribeTasks(ws, taskIds) {
  const set = taskSubscriptions.get(ws);
  if (!set || !Array.isArray(taskIds)) return;
  for (const id of taskIds) {
    set.delete(id);
  }
}

function handleSubscribeQueue(ws) {
  queueSubscribers.add(ws);
  safeSendJson(ws, { type: 'queueStatus', stats: getQueueStats() });
}

function handleClientMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    safeSendJson(ws, { type: 'error', code: 'INVALID_JSON', message: '消息不是合法 JSON' });
    return;
  }
  if (!msg || typeof msg.type !== 'string') {
    safeSendJson(ws, { type: 'error', code: 'INVALID_TYPE', message: '消息缺少 type' });
    return;
  }
  switch (msg.type) {
    case 'subscribeTasks':
      handleSubscribeTasks(ws, msg.taskIds);
      break;
    case 'unsubscribeTasks':
      handleUnsubscribeTasks(ws, msg.taskIds);
      break;
    case 'subscribeQueue':
      handleSubscribeQueue(ws);
      break;
    case 'unsubscribeQueue':
      queueSubscribers.delete(ws);
      break;
    case 'ping':
      safeSendJson(ws, { type: 'pong' });
      break;
    default:
      safeSendJson(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `未知的 type: ${msg.type}` });
  }
}

function setupWebSocketServer() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  wss.on('connection', ws => {
    wsAlive.set(ws, { lastPong: Date.now(), missed: 0 });

    ws.on('message', data => {
      handleClientMessage(ws, data.toString());
    });

    ws.on('pong', () => {
      const state = wsAlive.get(ws);
      if (state) {
        state.lastPong = Date.now();
        state.missed = 0;
      }
    });

    ws.on('close', () => {
      taskSubscriptions.delete(ws);
      queueSubscribers.delete(ws);
      wsAlive.delete(ws);
    });

    ws.on('error', error => {
      console.warn('[ws] connection error', error?.message || error);
    });
  });

  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const state = wsAlive.get(ws);
      if (!state) continue;
      if (Date.now() - state.lastPong > WS_HEARTBEAT_INTERVAL_MS + WS_PONG_GRACE_MS) {
        state.missed += 1;
        if (state.missed >= 2) {
          try { ws.terminate(); } catch { /* ignore */ }
          continue;
        }
      }
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, WS_HEARTBEAT_INTERVAL_MS).unref();

  return wss;
}

function closeHttpServer(server) {
  if (!server || typeof server.close !== 'function') return Promise.resolve();
  return new Promise(resolve => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function closeWebSocketServer(wss) {
  if (!wss || typeof wss.close !== 'function') return Promise.resolve();
  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'Server shutting down');
    } catch {
      // ignore
    }
  }
  return new Promise(resolve => {
    try {
      wss.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function waitForRunningTasks() {
  const running = Array.from(runningTaskPromises);
  if (running.length === 0) return;
  await Promise.allSettled(running);
}

function abortRunningTasks(reason = '服务器正在关闭') {
  for (const controller of taskAbortControllers.values()) {
    try { controller.abort(new Error(reason)); } catch { controller.abort(); }
  }
}

function checkpointTaskDatabase() {
  try {
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    console.log('[shutdown] SQLite WAL checkpoint 完成', result);
  } catch (error) {
    console.warn('[shutdown] SQLite WAL checkpoint 失败', error?.message || error);
  }
}

function closeTaskDatabase() {
  try {
    db.close();
  } catch (error) {
    console.warn('[shutdown] SQLite 关闭失败', error?.message || error);
  }
}

function registerShutdownHandlers() {
  const handleShutdownSignal = signal => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      isShuttingDown = true;
      console.log(`[shutdown] 收到 ${signal}，开始优雅退出`);

      await Promise.allSettled([
        closeHttpServer(httpServerRef),
        closeWebSocketServer(wsServerRef),
      ]);

       await Promise.race([
         waitForRunningTasks(),
         new Promise(resolve => setTimeout(resolve, 3_000)),
       ]);
       abortRunningTasks();
       await Promise.race([
         waitForRunningTasks(),
         new Promise(resolve => setTimeout(resolve, 3_000)),
       ]);
      checkpointTaskDatabase();
      closeTaskDatabase();
      process.exit(0);
    })().catch(error => {
      console.error('[shutdown] 优雅退出失败', error);
      closeTaskDatabase();
      process.exit(1);
    });

    return shutdownPromise;
  };

  process.on('SIGTERM', () => {
    void handleShutdownSignal('SIGTERM');
  });

  process.on('SIGINT', () => {
    void handleShutdownSignal('SIGINT');
  });
}

async function handleApi(req, res, pathname) {
  try {
    const apiPathname = pathname.replace(/\/+$/, '');

    if (process.env.JACKY_DESKTOP_MODE === '1' && req.headers.host !== `127.0.0.1:${PORT}`) {
      sendJson(res, 400, { error: 'Invalid host' });
      return true;
    }

    const isDesktopControlRoute = apiPathname === '/api/jacky/desktop/shutdown'
      || apiPathname === '/api/jacky/desktop/model-registry';
    if (!isDesktopControlRoute && !isAuthorizedRendererRequest(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/jacky/queue-status') {
      sendJson(res, 200, getQueueStats());
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/jacky/desktop/shutdown') {
      const controlToken = String(process.env.JACKY_DESKTOP_CONTROL_TOKEN || '');
      const requestToken = String(req.headers['x-jacky-desktop-token'] || '');
      if (!controlToken || requestToken !== controlToken) {
        sendJson(res, 403, { error: 'Forbidden' });
        return true;
      }

      sendJson(res, 202, { ok: true });
      setImmediate(() => process.emit('SIGTERM'));
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/jacky/desktop/model-registry') {
      const controlToken = String(process.env.JACKY_DESKTOP_CONTROL_TOKEN || '');
      const requestToken = String(req.headers['x-jacky-desktop-token'] || '');
      if (!controlToken || requestToken !== controlToken) {
        sendJson(res, 403, { error: 'Forbidden' });
        return true;
      }
      const registry = await readJsonBody(req);
      const modelCount = replaceDesktopModelRegistry(registry);
      sendJson(res, 200, { ok: true, modelCount });
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/jacky/seat-cover-prompts') {
      try {
        sendJson(res, 200, { prompts: loadSeatCoverAnglePrompts(), defaults: loadSeatCoverAnglePrompts(DEFAULT_SEAT_COVER_PROMPT_DIR) });
      } catch (error) {
        sendJson(res, 500, { error: normalizeError(error), prompts: {} });
      }
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/jacky/seat-cover-prompts') {
      try {
        const body = await readJsonBody(req);
        const fileName = saveSeatCoverAnglePrompt(body?.name, body?.content);
        sendJson(res, 200, { ok: true, fileName });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: normalizeError(error) });
      }
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/jacky/prompts') {
      const promptsPath = path.join(__dirname, 'prompts.json');
      try {
        if (!fs.existsSync(promptsPath)) {
          sendJson(res, 200, []);
          return true;
        }
        const raw = fs.readFileSync(promptsPath, 'utf8');
        const data = JSON.parse(raw);
        sendJson(res, 200, Array.isArray(data) ? data : []);
      } catch {
        sendJson(res, 200, []);
      }
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/jacky/blacklist') {
      const blacklistPath = path.join(__dirname, 'blacklist.json');
      try {
        if (!fs.existsSync(blacklistPath)) {
          sendJson(res, 200, { keywords: [] });
          return true;
        }
        const raw = fs.readFileSync(blacklistPath, 'utf8');
        const data = JSON.parse(raw);
        sendJson(res, 200, { keywords: Array.isArray(data.keywords) ? data.keywords : [] });
      } catch {
        sendJson(res, 200, { keywords: [] });
      }
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/jacky/config') {
      const env = getRuntimeEnv();
      const rawMode = String(env.PROMPT_GALLERY_MODE || '2').trim();
      const mode = ['1', '2', '3'].includes(rawMode) ? rawMode : '2';
      sendJson(
        res,
        200,
        {
          promptGalleryMode: mode,
          promptGalleryPasswordEnabled: String(env.PROMPT_GALLERY_PASSWORD || '').trim().length > 0,
        },
        {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      );
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/jacky/prompt-gallery/verify') {
      const env = getRuntimeEnv();
      const expected = String(env.PROMPT_GALLERY_PASSWORD || '').trim();
      if (!expected) {
        sendJson(res, 200, { ok: true });
        return true;
      }

      const body = await readJsonBody(req);
      const password = String(body?.password || '');
      const ok = hashPromptGalleryPassword(password) === hashPromptGalleryPassword(expected);
      sendJson(res, 200, { ok });
      return true;
    }

    const imageMatch = apiPathname.match(/^\/api\/jacky\/images\/([^/]+)\/(\d+)$/);
    if (req.method === 'GET' && imageMatch) {
      const taskId = imageMatch[1];
      const index = Number(imageMatch[2]);
      if (!/^[a-zA-Z0-9-]+$/.test(taskId)) {
        sendJson(res, 400, { error: 'Invalid taskId' });
        return true;
      }
      try {
        if (!fs.existsSync(IMAGE_DIR)) {
          sendJson(res, 404, { error: 'Not Found' });
          return true;
        }
        // 常见情况：subIndex=0、扩展名 png/jpg/webp，直接拼路径命中，
        // 避免对整个 IMAGE_DIR 做同步 readdir 全目录扫描（随图片数线性变慢）。
        let filePath = null;
        for (const ext of ['png', 'jpg', 'webp']) {
          const candidate = path.join(IMAGE_DIR, `${taskId}-${index}-0.${ext}`);
          if (fs.existsSync(candidate)) { filePath = candidate; break; }
        }
        // 兜底：扩展名异常或存在多子图（极少）时才回退到目录扫描。
        if (!filePath) {
          const prefix = `${taskId}-${index}-`;
          const files = fs.readdirSync(IMAGE_DIR)
            .filter(name => name.startsWith(prefix))
            .sort();
          if (files.length > 0) filePath = path.join(IMAGE_DIR, files[0]);
        }
        if (!filePath) {
          sendJson(res, 404, { error: 'Not Found' });
          return true;
        }
        const stat = fs.statSync(filePath);
        pipeFileToResponse(res, filePath, 200, {
          'Content-Type': getContentType(filePath),
          'Content-Length': stat.size,
          'Cache-Control': 'private, max-age=3600',
        });
      } catch {
        sendJson(res, 404, { error: 'Not Found' });
      }
      return true;
    }

    // ===== 文本 AI 代理（流式 + 非流式，多文本协议） =====
    if (req.method === 'POST' && apiPathname === '/api/jacky/proxy/text') {
      try {
        const body = await readJsonBody(req);
        const configuredModel = resolveDesktopModel(body.modelConfigId, 'text');
        const { protocol, baseUrl, apiKey, modelId: model } = configuredModel;
        const { stream, requestBody } = body;

        const normalizedBaseUrl = normalizeProtocolBaseUrl(protocol, baseUrl);
        let targetUrl;
        const authHeaders = { 'Content-Type': 'application/json' };

        if (protocol === 'google' || protocol === 'google-gemini') {
          targetUrl = stream
            ? `${normalizedBaseUrl}/v1beta/models/${encodeURIComponent(model || '')}:streamGenerateContent?alt=sse`
            : `${normalizedBaseUrl}/v1beta/models/${encodeURIComponent(model || '')}:generateContent`;
          authHeaders['x-goog-api-key'] = apiKey;
          authHeaders['Authorization'] = `Bearer ${apiKey}`;
        } else if (protocol === 'anthropic-messages') {
          targetUrl = `${normalizedBaseUrl}/v1/messages`;
          authHeaders['x-api-key'] = apiKey;
          authHeaders['anthropic-version'] = '2023-06-01';
        } else if (protocol === 'openai-chat-completions') {
          targetUrl = `${normalizedBaseUrl}/v1/chat/completions`;
          authHeaders['Authorization'] = `Bearer ${apiKey}`;
        } else {
          targetUrl = `${normalizedBaseUrl}/v1/responses`;
          authHeaders['Authorization'] = `Bearer ${apiKey}`;
        }

        if (stream) {
          authHeaders['Accept'] = 'text/event-stream';
        }

        let forwardedBody;
        if (requestBody) {
          forwardedBody = requestBody;
        } else {
          const clean = { ...body };
          delete clean.protocol;
          delete clean.baseUrl;
          delete clean.apiKey;
          delete clean.model;
          delete clean.modelConfigId;
          delete clean.stream;
          delete clean.requestBody;
          forwardedBody = clean;
        }

        const proxyController = new AbortController();
        const abortProxy = () => proxyController.abort();
        req.once('aborted', abortProxy);
        res.once('close', abortProxy);
        const upstream = await fetchWithTimeout(targetUrl, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(forwardedBody),
          signal: proxyController.signal,
        });

        if (stream && upstream.ok) {
          res.writeHead(upstream.status, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          const reader = upstream.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { res.end(); return true; }
              res.write(value);
            }
          } catch {
            try { await upstream.body?.cancel?.(); } catch { /* ignore */ }
            res.end();
          }
          req.removeListener('aborted', abortProxy);
          res.removeListener('close', abortProxy);
          return true;
        }

        let data = null;
        try { data = await upstream.json(); } catch { /* ignore */ }
        req.removeListener('aborted', abortProxy);
        res.removeListener('close', abortProxy);
        sendJson(res, upstream.status, data || { error: `上游返回 ${upstream.status}` });
      } catch (error) {
        if (error && error.message && /abort|timeout/i.test(error.message)) {
          sendJson(res, 504, { error: '代理请求上游超时' });
        } else {
          sendJson(res, 502, { error: normalizeError(error) });
        }
      }
      return true;
    }

    // ===== 模型检查代理（按协议查询模型列表） =====
    if (req.method === 'GET' && apiPathname === '/api/jacky/proxy/models') {
      try {
        const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const configuredModel = resolveDesktopModel(parsed.searchParams.get('modelConfigId'));
        const { baseUrl, apiKey, protocol } = configuredModel;

        const normalizedBaseUrl = normalizeProtocolBaseUrl(protocol, baseUrl);
        let modelsUrl = `${normalizedBaseUrl}/v1/models`;
        const headers = {};

        if (protocol === 'google' || protocol === 'google-gemini') {
          modelsUrl = `${normalizedBaseUrl}/v1beta/models`;
          headers['x-goog-api-key'] = apiKey;
          headers['Authorization'] = `Bearer ${apiKey}`;
        } else if (protocol === 'anthropic-messages') {
          headers['x-api-key'] = apiKey;
          headers['anthropic-version'] = '2023-06-01';
        } else {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const response = await fetchWithTimeout(modelsUrl, { method: 'GET', headers });
        let data = null;
        try { data = await response.json(); } catch { /* ignore */ }
        sendJson(res, response.status, data);
      } catch (error) {
        sendJson(res, 502, { error: normalizeError(error) });
      }
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/jacky/tasks') {
      const body = await readJsonBody(req);
      const taskId = createTask(body, req);
      sendJson(res, 202, { taskId });
      return true;
    }

    const match = apiPathname.match(/^\/api\/jacky\/tasks\/([^/]+)(?:\/(ack|cancel))?$/);
    if (!match) return false;
    const taskId = decodeURIComponent(match[1]);
    const action = match[2];

    if (req.method === 'GET' && !action) {
      const task = serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
      sendJson(res, task ? 200 : 404, task || { id: taskId, status: 'expired', error: '该任务已超出取回时间' });
      return true;
    }

    if (req.method === 'POST' && action === 'ack') {
      const ACK_GRACE_MS = 120 * 1000;
      const existing = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
      if (existing) {
        db.prepare('UPDATE tasks SET expires_at = ? WHERE id = ?').run(
          new Date(Date.now() + ACK_GRACE_MS).toISOString(), taskId
        );
      }
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'POST' && action === 'cancel') {
      const cancelled = cancelTask(taskId);
      sendJson(res, cancelled ? 200 : 404, cancelled ? { ok: true } : { error: '任务不存在' });
      return true;
    }

    sendJson(res, 405, { error: 'Method Not Allowed' });
    return true;
  } catch (error) {
    if (isHttpError(error)) {
      sendHttpError(res, error);
    } else if (error && typeof error.statusCode === 'number') {
      sendJson(res, error.statusCode, { error: normalizeError(error) });
    } else {
      sendJson(res, 400, { error: normalizeError(error) });
    }
    return true;
  }
}

initDatabase();
ensureSeatCoverPromptDirectory();
ensureImageDir();
cleanupExpiredTasks();
setInterval(cleanupExpiredTasks, CLEANUP_INTERVAL_MS).unref();
setInterval(cleanupRateLimitBuckets, CLEANUP_INTERVAL_MS).unref();

const startServer = () => {
  const wss = setupWebSocketServer();
  const httpServer = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOSTNAME}:${PORT}`}`);
    if (parsedUrl.pathname?.startsWith('/api/jacky/')) {
      const handled = await handleApi(req, res, parsedUrl.pathname);
      if (handled || res.headersSent || res.writableEnded) return;
    }
    if (!IS_DEV) {
      if (serveStatic(req, res, parsedUrl.pathname || '/')) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    handle(req, res, req.url || '/');
  });

  const nextUpgradeHandler = IS_DEV && typeof app.getUpgradeHandler === 'function'
    ? app.getUpgradeHandler()
    : null;

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url || '/', `http://${req.headers.host || `${HOSTNAME}:${PORT}`}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === '/api/jacky/ws') {
      const expectedOrigin = `http://127.0.0.1:${PORT}`;
      if (!isAuthorizedRendererRequest(req) || req.headers.origin !== expectedOrigin) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
      return;
    }
    if (nextUpgradeHandler) {
      nextUpgradeHandler(req, socket, head);
      return;
    }
    socket.destroy();
  });

  httpServer.listen(PORT, HOSTNAME, () => {
    const localUrl = `http://localhost:${PORT}`;
    const listenUrl = `http://${HOSTNAME}:${PORT}`;
    console.log(`Jacky Image server ready on ${localUrl}`);
    if (HOSTNAME !== 'localhost' && HOSTNAME !== '127.0.0.1') {
      console.log(`Listening on ${listenUrl}`);
    }
  });

  wsServerRef = wss;
  httpServerRef = httpServer;
};

registerShutdownHandlers();

if (IS_DEV) {
  app.prepare().then(startServer);
} else {
  startServer();
}

import type { AspectRatio, OutputSize } from '@/lib/gemini-config';
import type { GptImageBackground, GptImageQuality, GptImageStyle } from '@/lib/model-capabilities';
import {
  getCompleteImageModels,
  getCompleteTextModels,
  getImageModelById,
  getTextModelById,
  loadRegistry,
  type ProviderProtocol,
} from '@/lib/jacky-models';
import {
  normalizeModelBaseUrl,
  normalizeTextModelBaseUrl,
} from '@/lib/model-endpoints';
import type { TextProviderProtocol } from '@/lib/jacky-text-protocol';

export type ImageReferenceRole =
  | 'vehicle-reference'
  | 'seat-product-reference'
  | 'angle-reference'
  | 'angle-structure-reference'
  | 'base-image'
  | 'cover-reference';

export interface ImageReference {
  data: string;
  mimeType: string;
  /** Optional semantic role used by providers that support labeled multimodal parts. */
  role?: ImageReferenceRole;
}

export interface MaskReference extends ImageReference {
  representation: 'alpha' | 'black-white';
  width: number;
  height: number;
  inverted?: boolean;
}

export interface ModelStatus {
  modelId: string;
  available: boolean;
  actualName?: string;
  message?: string;
}

const MODEL_CHECK_TIMEOUT = 30000;
const TASK_REQUEST_TIMEOUT = 30000;
const CREATE_TASK_TIMEOUT = 60000;

export type JackyTaskMode = 'text-to-image' | 'image-to-image';
export type JackyTaskStatus = 'queued' | '排队中' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface CreateJackyTaskInput {
  modelConfigId: string;
  mode: JackyTaskMode;
  prompt: string;
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature: number;
  webSearchEnabled?: boolean;
  imageSearchEnabled?: boolean;
  model: string;
  gptImageQuality?: GptImageQuality;
  gptImageStyle?: GptImageStyle;
  gptImageBackground?: GptImageBackground;
  parallelCount: number;
  images: ImageReference[];
  mask?: MaskReference;
}

export interface JackyTaskResponse {
  id: string;
  status: JackyTaskStatus;
  mode?: JackyTaskMode;
  result?: {
    images?: string[];
    searchGrounding?: SearchGroundingMetadata[];
  };
  error?: string;
  warning?: string;
  createdAt?: string;
  completedAt?: string;
  expiresAt?: string;
}

export interface SearchGroundingSource {
  title?: string;
  uri: string;
  type?: 'web' | 'image';
}

export interface SearchGroundingMetadata {
  webSearchQueries?: string[];
  imageSearchQueries?: string[];
  searchEntryPointHtml?: string;
  sources?: SearchGroundingSource[];
}

export interface JackyQueueStatus {
  concurrencyLimit: number;
  configuredConcurrency: number;
  processingCount: number;
  queuedCount: number;
  pendingCount?: number;
  maxQueueSize?: number;
  remainingQueueSlots?: number;
  displayConcurrency: number;
  displayQueued: number;
  acceptingNewTasks: boolean;
  rateLimitWindowMs?: number;
  rateLimitMaxRequestsPerIp?: number;
  rateLimitMaxRequestsPerApiKey?: number;
  retryAfterSeconds?: number;
  serverMessage?: string;
}

export class JackyTaskError extends Error {
  statusCode: number;
  code?: string;
  retryAfter?: number;

  constructor(message: string, statusCode: number, code?: string, retryAfter?: number) {
    super(message);
    this.name = 'JackyTaskError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

interface CreateTaskResponse {
  taskId?: string;
}

function getObjectProperty(data: unknown, key: string): unknown {
  return typeof data === 'object' && data !== null && key in data
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

async function parseTaskResponse<T>(response: Response): Promise<T> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = getObjectProperty(data, 'error');
    const code = getObjectProperty(data, 'code');
    const retryAfter = getObjectProperty(data, 'retryAfter');
    throw new JackyTaskError(
      typeof error === 'string' ? error : `任务请求失败: ${response.status}`,
      response.status,
      typeof code === 'string' ? code : undefined,
      typeof retryAfter === 'number' ? retryAfter : undefined,
    );
  }
  return data as T;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function normalizeModelCheckError(error: unknown): Error {
  const errorMessage = getErrorMessage(error);
  const lowerMessage = errorMessage.toLowerCase();

  if (
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('abort') ||
    lowerMessage.includes('请求超时')
  ) {
    return new Error('模型检查超时，请稍后重试。');
  }

  if (
    lowerMessage.includes('failed to fetch') ||
    lowerMessage.includes('fetch failed') ||
    lowerMessage.includes('networkerror') ||
    lowerMessage.includes('network request failed') ||
    lowerMessage.includes('load failed') ||
    lowerMessage.includes('network connection was lost') ||
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('socket hang up') ||
    lowerMessage.includes('terminated')
  ) {
    return new Error('网络连接失败。请检查网络连接或稍后重试。');
  }

  return error instanceof Error ? error : new Error(errorMessage);
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = MODEL_CHECK_TIMEOUT,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('请求超时');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function createJackyTask(input: CreateJackyTaskInput): Promise<string> {
  const response = await fetchWithTimeout('/api/jacky/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }, CREATE_TASK_TIMEOUT);
  const data = await parseTaskResponse<CreateTaskResponse>(response);
  if (!data?.taskId) throw new Error('创建任务失败：后端未返回任务 ID');
  return data.taskId;
}

export async function checkModelsAvailability(
  targetModelIds?: string[],
): Promise<ModelStatus[]> {
  try {
    const registry = loadRegistry();
    const completeImageModels = getCompleteImageModels(registry);
    const completeTextModels = getCompleteTextModels(registry);
    const configuredModels = [
      ...completeImageModels.map((model) => ({
        id: model.id,
        name: model.name,
        modelId: model.modelId,
      })),
      ...completeTextModels.map((model) => ({
        id: model.id,
        name: model.name,
        modelId: model.modelId,
      })),
    ];

    const filteredModels = targetModelIds && targetModelIds.length > 0
      ? configuredModels.filter((model) => targetModelIds.includes(model.id))
      : configuredModels;

    if (filteredModels.length === 0) {
      return [];
    }

    return Promise.all(filteredModels.map(async (model) => {
      try {
        if (!model.modelId) {
          return {
            modelId: model.id,
            actualName: model.name,
            available: false,
            message: '模型配置不完整',
          };
        }

        // 统一通过后端代理使用 /v1/models（NewAPI 兼容）
        const proxyUrl = `/api/jacky/proxy/models?modelConfigId=${encodeURIComponent(model.id)}`;
        const response = await fetch(proxyUrl, { method: 'GET', cache: 'no-store' });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          return {
            modelId: model.id,
            actualName: model.name,
            available: false,
            message: `${response.status}${detail ? ` ${detail.slice(0, 120)}` : ''}`,
          };
        }
        const data = await response.json().catch(() => ({})) as {
          data?: Array<{ id?: string; model?: string }>;
          models?: Array<{ name?: string }>;
        };
        const exists = (
          (Array.isArray(data.data) && data.data.some(
            (item) => String(item?.id || item?.model || '') === model.modelId,
          ))
          || (Array.isArray(data.models) && data.models.some(
            (item) => String(item?.name || '').replace(/^models\//, '') === model.modelId,
          ))
        );
        return {
          modelId: model.id,
          actualName: model.name,
          available: exists,
          message: exists ? model.modelId : `未在 /models 中找到 ${model.modelId}`,
        };
      } catch (error) {
        return {
          modelId: model.id,
          actualName: model.name,
          available: false,
          message: getErrorMessage(error),
        };
      }
    }));
  } catch (error) {
    throw normalizeModelCheckError(error);
  }
}

export function resolveImageTaskProvider(modelId: string): { modelConfigId: string; protocol: ProviderProtocol; modelId: string } {
  const registry = loadRegistry();
  const model = getImageModelById(registry, modelId);
  if (!model) throw new Error(`未找到图片模型配置: ${modelId}`);
  const normalizedBaseUrl = normalizeModelBaseUrl(model.protocol, model.baseUrl);
  return {
    modelConfigId: model.id,
    protocol: model.protocol,
    modelId: model.modelId,
  };
}

export function resolveTextTaskProvider(modelId: string): { modelConfigId: string; protocol: TextProviderProtocol } {
  const registry = loadRegistry();
  const model = getTextModelById(registry, modelId);
  if (!model) throw new Error(`未找到文本模型配置: ${modelId}`);
  return {
    modelConfigId: model.id,
    protocol: model.protocol,
  };
}

export async function getJackyTask(taskId: string): Promise<JackyTaskResponse> {
  const response = await fetchWithTimeout(`/api/jacky/tasks/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    cache: 'no-store',
  }, TASK_REQUEST_TIMEOUT);
  return parseTaskResponse(response);
}

export async function getJackyQueueStatus(): Promise<JackyQueueStatus> {
  const response = await fetchWithTimeout('/api/jacky/queue-status', {
    method: 'GET',
    cache: 'no-store',
  }, TASK_REQUEST_TIMEOUT);
  return parseTaskResponse(response);
}

export async function ackJackyTask(taskId: string): Promise<void> {
  await fetch(`/api/jacky/tasks/${encodeURIComponent(taskId)}/ack`, {
    method: 'POST',
  }).catch(() => undefined);
}

export async function cancelJackyTask(taskId: string): Promise<void> {
  await fetch(`/api/jacky/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: 'POST',
  }).then(async (response) => {
    if (!response.ok && response.status !== 404) {
      const data = await response.json().catch(() => null);
      throw new JackyTaskError(
        typeof data?.error === 'string' ? data.error : `取消任务失败: ${response.status}`,
        response.status,
      );
    }
  });
}

// ===== 向后兼容别名 =====
/** @deprecated Use JackyTaskMode */
export type CcodeTaskMode = JackyTaskMode;
/** @deprecated Use JackyTaskStatus */
export type CcodeTaskStatus = JackyTaskStatus;
/** @deprecated Use CreateJackyTaskInput */
export type CreateCcodeTaskInput = CreateJackyTaskInput;
/** @deprecated Use JackyTaskResponse */
export type CcodeTaskResponse = JackyTaskResponse;
/** @deprecated Use JackyQueueStatus */
export type CcodeQueueStatus = JackyQueueStatus;
/** @deprecated Use JackyTaskError */
export const CcodeTaskError = JackyTaskError;
/** @deprecated Use createJackyTask */
export const createCcodeTask = createJackyTask;
/** @deprecated Use checkModelsAvailability */
export const checkCcodeModelsAvailability = checkModelsAvailability;
/** @deprecated Use getJackyTask */
export const getCcodeTask = getJackyTask;
/** @deprecated Use getJackyQueueStatus */
export const getCcodeQueueStatus = getJackyQueueStatus;
/** @deprecated Use ackJackyTask */
export const ackCcodeTask = ackJackyTask;
/** @deprecated Use cancelJackyTask */
export const cancelCcodeTask = cancelJackyTask;

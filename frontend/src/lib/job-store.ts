import type { SearchGroundingMetadata } from '@/lib/ccode-task-client';
import type { GptImageBackground, GptImageQuality, GptImageStyle } from '@/lib/model-capabilities';
import { makeStoredBlobRef, type ImageDownloadProgressItem } from '@/lib/image-downloader';
import { openImageDb, IMG_STORE } from '@/lib/image-db';

export type Mode = 'text-to-image' | 'image-to-image' | 'prompt-gallery';
export type OutputSize = 'auto' | '512' | '1K' | '2K' | '4K';
export type AspectRatio = 'auto' | '1:1' | '1:4' | '1:8' | '2:3' | '3:2' | '3:4' | '4:1' | '4:3' | '4:5' | '5:4' | '8:1' | '9:16' | '16:9' | '21:9';

export interface RefImageData {
  id: string;
  name: string;
  dataUrl: string;
  mimeType: string;
  badge?: string;
}

export interface MaskImageData extends RefImageData {
  representation: 'alpha' | 'black-white';
  width: number;
  height: number;
  inverted?: boolean;
}

export interface ImageDownloadProgress {
  total: number;
  completed: number;
  failed: number;
  items: ImageDownloadProgressItem[];
}

export interface StoredJob {
  id: string;
  status: 'queued' | '排队中' | 'processing' | 'completed' | 'failed';
  mode: Mode;
  prompt: string;
  output_size: OutputSize;
  custom_size?: string;
  temperature: number;
  webSearchEnabled?: boolean;
  imageSearchEnabled?: boolean;
  aspect_ratio: AspectRatio;
  model: string;
  gptImageQuality?: GptImageQuality;
  gptImageStyle?: GptImageStyle;
  gptImageBackground?: GptImageBackground;
  created_at: string;
  error?: string;
  networkError?: boolean;
  /** true 表示后端明确判定该失败任务不可恢复（API 错误 / 服务器重启 / 已过期 / 已删除）。
   * 仅在 status==='failed' 时有意义；undefined 视为非终态，允许"查看进度" */
  terminal?: boolean;
  warning?: string;
  imageData?: string;
  parallelCount?: number;
  images?: string[];
  serverTaskId?: string;
  serverTaskAcked?: boolean;
  refImages?: RefImageData[];
  maskImage?: MaskImageData;
  originalPrompt?: string;
  blobUrls?: string[];
  imageDownloadProgress?: ImageDownloadProgress;
  searchGrounding?: SearchGroundingMetadata[];
}

// 复用单例连接层；保留这两个导出名以兼容现有调用方（如 useWorkspaceJobs）。
export { IMG_STORE };
export const openDB = openImageDb;

export function getImageSrc(imageData: string): string {
  if (imageData.startsWith('blob:')) {
    return imageData;
  }

  if (imageData.startsWith('URL:')) {
    return imageData.substring(4);
  }

  if (imageData.startsWith('MULTI_URL:')) {
    return imageData.substring(10).split('|||')[0];
  }

  if (imageData.startsWith('IDB:') || imageData.startsWith('FILE:')) {
    return '';
  }

  return `data:image/png;base64,${imageData}`;
}

function toPersistedImageRefs(result: StoredJob): string[] | undefined {
  return result.images?.map((image, index) => (
    image.startsWith('blob:') ? makeStoredBlobRef(result.id, index) : image
  ));
}

function toDesktopPersistedJob(result: StoredJob): StoredJob {
  const images = toPersistedImageRefs(result);
  const persisted = {
    ...result,
    ...(images ? { images, imageData: images[0] } : {}),
  };
  delete persisted.blobUrls;
  delete persisted.imageDownloadProgress;
  return persisted;
}

export async function saveImage(result: StoredJob) {
  void result;
}

export async function deleteImage(jobId: string) {
  void jobId;
}

export function loadJobs(): StoredJob[] {
  if (typeof window === 'undefined') return [];
  const desktopRecords = window.jackyDesktop?.records;
  if (!desktopRecords) return [];
  const storedJobs = desktopRecords.loadJobs();
  return Array.isArray(storedJobs) ? storedJobs as StoredJob[] : [];
}

export function saveJobs(jobs: StoredJob[]) {
  if (typeof window === 'undefined') return;

  const desktopRecords = window.jackyDesktop?.records;
  if (!desktopRecords) {
    throw new Error('Jacky Image 仅支持桌面版使用记录存储');
  }
  const result = desktopRecords.saveJobs(jobs.map(toDesktopPersistedJob));
  if (!result?.ok) throw new Error(result?.error || '使用记录写入本地文件失败');
}

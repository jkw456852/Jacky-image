/// <reference lib="webworker" />

import { AutoProcessor, RawImage, SamModel, Tensor, env } from '@huggingface/transformers';
import { cleanSmartBinaryMask } from './smart-mask-utils';

type SmartPoint = { x: number; y: number; label: 0 | 1 };

type WorkerRequest =
  | { type: 'load' }
  | { type: 'analyze'; width: number; height: number; rgba: ArrayBuffer }
  | { type: 'segment'; points: SmartPoint[] }
  | { type: 'reset' };

type WorkerResponse =
  | { type: 'status'; status: string; progress?: number }
  | { type: 'ready'; device: string }
  | { type: 'analyzed'; width: number; height: number }
  | {
    type: 'mask';
    width: number;
    height: number;
    defaultIndex: number;
    candidates: Array<{
      score: number;
      pixelCount: number;
      removedPixels: number;
      filledHolePixels: number;
      data: ArrayBuffer;
    }>;
  }
  | { type: 'error'; message: string };

// SlimSAM is fast, but on weak boundaries it often collapses to regions that
// merely share colour/texture with the clicked pixel. The base SAM encoder is
// larger, but produces substantially more object-aware masks and is cached
// after its first download.
const MODEL_ID = 'Xenova/sam-vit-base';

env.allowLocalModels = false;
env.useBrowserCache = true;

type ProcessedSamImage = Record<string, unknown> & {
  reshaped_input_sizes: number[][];
  original_sizes: number[][];
};

type SamRuntimeOutput = {
  pred_masks: Tensor;
  iou_scores: { data: ArrayLike<number> };
};

type SamRuntimeModel = {
  (inputs: Record<string, unknown>): Promise<SamRuntimeOutput>;
  get_image_embeddings(inputs: ProcessedSamImage): Promise<Record<string, unknown>>;
};

type SamRuntimeProcessor = {
  (image: RawImage): Promise<ProcessedSamImage>;
  post_process_masks(
    masks: Tensor,
    originalSizes: number[][],
    reshapedSizes: number[][],
    options?: { mask_threshold?: number; binarize?: boolean },
  ): Promise<Tensor[]>;
};

let model: SamRuntimeModel | null = null;
let processor: SamRuntimeProcessor | null = null;
let imageProcessed: ProcessedSamImage | null = null;
let imageEmbeddings: Record<string, unknown> | null = null;
let currentDevice = 'wasm';
let loadingPromise: Promise<void> | null = null;

function send(message: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer });
}

async function loadModel() {
  if (model && processor) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    const progress_callback = (progress: unknown) => {
      const value = typeof progress === 'object' && progress !== null && 'progress' in progress
        && typeof progress.progress === 'number' ? progress.progress : undefined;
      send({ type: 'status', status: '正在下载智能选区模型…', progress: value });
    };

    if (hasWebGpu) {
      try {
        send({ type: 'status', status: '正在加载智能选区模型（WebGPU）…' });
        model = await SamModel.from_pretrained(MODEL_ID, {
          device: 'webgpu',
          dtype: 'fp16',
          progress_callback,
        }) as unknown as SamRuntimeModel;
        currentDevice = 'webgpu';
      } catch {
        model = null;
      }
    }

    if (!model) {
      send({ type: 'status', status: '正在加载智能选区模型（兼容模式）…' });
      model = await SamModel.from_pretrained(MODEL_ID, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback,
      }) as unknown as SamRuntimeModel;
      currentDevice = 'wasm';
    }

    processor = await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback }) as unknown as SamRuntimeProcessor;
    send({ type: 'ready', device: currentDevice });
  })().finally(() => {
    loadingPromise = null;
  });

  return loadingPromise;
}

async function analyze(width: number, height: number, rgba: ArrayBuffer) {
  await loadModel();
  if (!model || !processor) throw new Error('智能选区模型未加载');
  if (width <= 0 || height <= 0 || rgba.byteLength < width * height * 4) {
    throw new Error('智能选区收到的图片像素无效');
  }
  send({ type: 'status', status: '正在分析图片，请稍候…' });
  // Construct the image directly from transferred pixels. RawImage.fromURL()
  // internally fetches data: URLs, which is correctly blocked by the desktop
  // Content-Security-Policy and previously made analysis fail intermittently.
  const image = new RawImage(new Uint8ClampedArray(rgba), width, height, 4);
  imageProcessed = await processor(image);
  imageEmbeddings = await model.get_image_embeddings(imageProcessed);
  send({ type: 'analyzed', width: image.width, height: image.height });
}

async function segment(points: SmartPoint[]) {
  if (!model || !processor || !imageProcessed || !imageEmbeddings) {
    throw new Error('请先分析当前图片');
  }
  if (points.length === 0) throw new Error('至少需要一个选区点击点');

  const reshaped = imageProcessed.reshaped_input_sizes[0];
  const pointValues = points.flatMap(point => [
    Math.min(1, Math.max(0, point.x)) * reshaped[1],
    Math.min(1, Math.max(0, point.y)) * reshaped[0],
  ]);
  const labelValues = points.map(point => BigInt(point.label));
  const input_points = new Tensor('float32', pointValues, [1, 1, points.length, 2]);
  const input_labels = new Tensor('int64', labelValues, [1, 1, points.length]);
  const { pred_masks, iou_scores } = await model({
    ...imageEmbeddings,
    input_points,
    input_labels,
  });
  const masks = await processor.post_process_masks(
    pred_masks,
    imageProcessed.original_sizes,
    imageProcessed.reshaped_input_sizes,
    { binarize: false },
  );
  const mask = masks[0].slice(0);
  const scores = Array.from(iou_scores.data as Float32Array);
  const tensorCandidateCount = mask.dims[0] || scores.length;
  const maskHeight = mask.dims[1];
  const maskWidth = mask.dims[2];
  const pixelTotal = maskWidth * maskHeight;
  const candidateCount = Math.min(scores.length, tensorCandidateCount);
  const maskLogits = mask.data as Float32Array;
  const positivePoints = points.filter(point => point.label === 1);
  const negativePoints = points.filter(point => point.label === 0);
  let bestIndex = 0;
  let bestRank = Number.NEGATIVE_INFINITY;
  const candidateStats: Array<{
    index: number;
    activePixels: number;
    areaRatio: number;
    positiveHits: number;
    negativeHits: number;
    data: Uint8Array;
    removedPixels: number;
    filledHolePixels: number;
  }> = [];

  // SAM intentionally emits multiple interpretations (small part, object,
  // larger context). Its predicted IoU alone can prefer a broad mask. Rank the
  // candidates against the user's positive/negative clicks as well, and reject
  // implausible near-full-frame selections.
  for (let candidate = 0; candidate < candidateCount; candidate += 1) {
    const binary = new Uint8Array(pixelTotal);
    const candidateOffset = candidate * pixelTotal;
    for (let pixel = 0; pixel < pixelTotal; pixel += 1) {
      binary[pixel] = maskLogits[candidateOffset + pixel] > 0 ? 1 : 0;
    }
    const cleaned = cleanSmartBinaryMask(binary, maskWidth, maskHeight, points);
    const contains = (point: SmartPoint) => {
      const x = Math.min(maskWidth - 1, Math.max(0, Math.floor(point.x * maskWidth)));
      const y = Math.min(maskHeight - 1, Math.max(0, Math.floor(point.y * maskHeight)));
      return cleaned.data[y * maskWidth + x] === 1;
    };
    const positiveHits = positivePoints.reduce((total, point) => total + Number(contains(point)), 0);
    const negativeHits = negativePoints.reduce((total, point) => total + Number(contains(point)), 0);
    const activePixels = cleaned.pixelCount;
    const areaRatio = activePixels / Math.max(1, pixelTotal);
    candidateStats.push({
      index: candidate,
      activePixels,
      areaRatio,
      positiveHits,
      negativeHits,
      data: cleaned.data,
      removedPixels: cleaned.removedPixels,
      filledHolePixels: cleaned.filledHolePixels,
    });
    const broadMaskPenalty = areaRatio > 0.72 ? (areaRatio - 0.72) * 4 : 0;
    const emptyPenalty = activePixels < 16 ? 4 : 0;
    const rank = (scores[candidate] || 0)
      + positiveHits * 1.4
      - (positivePoints.length - positiveHits) * 3
      - negativeHits * 2.5
      - broadMaskPenalty
      - emptyPenalty;
    if (rank > bestRank) {
      bestRank = rank;
      bestIndex = candidate;
    }
  }

  if (positivePoints.length === 1 && negativePoints.length === 0) {
    const plausibleScales = candidateStats
      .filter(candidate => candidate.positiveHits === 1 && candidate.activePixels >= 16 && candidate.areaRatio <= 0.72)
      .sort((a, b) => a.activePixels - b.activePixels);
    if (plausibleScales.length > 0) {
      // A single SAM click normally returns part/object/context masks. Choosing
      // the median scale makes a click on a seat select the seat rather than a
      // same-colour panel or tiny trim detail, while avoiding the whole scene.
      bestIndex = plausibleScales[Math.floor(plausibleScales.length / 2)].index;
    }
  }
  const orderedStats = [...candidateStats].sort((a, b) => a.activePixels - b.activePixels);
  const candidates = orderedStats.map(candidate => {
    const output = new Uint8Array(pixelTotal);
    for (let index = 0; index < output.length; index += 1) {
      output[index] = candidate.data[index] === 1 ? 255 : 0;
    }
    return {
      score: scores[candidate.index] || 0,
      pixelCount: candidate.activePixels,
      removedPixels: candidate.removedPixels,
      filledHolePixels: candidate.filledHolePixels,
      data: output.buffer,
    };
  });
  const defaultIndex = Math.max(0, orderedStats.findIndex(candidate => candidate.index === bestIndex));
  send({
    type: 'mask',
    width: maskWidth,
    height: maskHeight,
    defaultIndex,
    candidates,
  }, candidates.map(candidate => candidate.data));
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    if (event.data.type === 'load') await loadModel();
    if (event.data.type === 'analyze') await analyze(event.data.width, event.data.height, event.data.rgba);
    if (event.data.type === 'segment') await segment(event.data.points);
    if (event.data.type === 'reset') {
      imageProcessed = null;
      imageEmbeddings = null;
    }
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};

export {};


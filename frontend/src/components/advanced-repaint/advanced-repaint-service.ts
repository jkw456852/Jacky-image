import {
  ackJackyTask,
  createJackyTask,
  getJackyTask,
  resolveImageTaskProvider,
  type ImageReference,
} from '@/lib/ccode-task-client';
import { downloadAndStoreImages } from '@/lib/image-downloader';
import { getAspectRatioOptions, getModelMaxRefImages, getSizeOptions, type GptImageAdvancedParams, type ParallelCount } from '@/lib/model-capabilities';
import type { ModelId } from '@/lib/gemini-config';
import type { AspectRatio, OutputSize } from '@/lib/job-store';
import { getMaskStrategyForModel, processMaskForTarget, type MaskDraft } from '@/lib/mask-utils';
import { generateUUID } from '@/lib/uuid';
import { closestAspectRatio, loadRepaintImage } from './advanced-repaint-utils';
import type { RepaintReferenceImage, RepaintReferenceRole } from './types';

export interface AdvancedRepaintGenerationParams {
  model: ModelId;
  temperature: number;
  webSearchEnabled: boolean;
  imageSearchEnabled: boolean;
  parallelCount: ParallelCount;
  gptImageAdvancedParams: GptImageAdvancedParams;
}

export interface GenerateRepaintRegionInput {
  sourceCropDataUrl: string;
  maskDataUrl: string;
  prompt: string;
  referenceRole: RepaintReferenceRole;
  references: RepaintReferenceImage[];
  params: AdvancedRepaintGenerationParams;
  onProgress?: (status: string) => void;
}

const POLL_INTERVAL = 1500;
const POLL_TIMEOUT = 10 * 60 * 1000;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type OptimizedRaster = {
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
};

const OUTPUT_SIZE_MAX_SIDE: Partial<Record<OutputSize, number>> = {
  '512': 512,
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
};

export function resolveAdaptiveRepaintOutputSize(
  model: ModelId,
  width: number,
  height: number,
): { outputSize: OutputSize; outputMaxSide?: number; willUpscale: boolean } {
  const available = getSizeOptions(model).map(option => option.value);
  const fixed = (['512', '1K', '2K', '4K'] as OutputSize[]).filter(value => available.includes(value));
  const targetMaxSide = Math.max(width, height);
  const matching = fixed.find(value => (OUTPUT_SIZE_MAX_SIDE[value] || 0) >= targetMaxSide);
  const outputSize = matching || fixed.at(-1) || (available.includes('auto') ? 'auto' : '1K');
  const outputMaxSide = OUTPUT_SIZE_MAX_SIDE[outputSize];
  return {
    outputSize,
    outputMaxSide,
    willUpscale: typeof outputMaxSide === 'number' && outputMaxSide < targetMaxSide,
  };
}

function getRepaintRequestMaxSide(outputSize: OutputSize, sourceMaxSide: number): number {
  const outputMaxSide = OUTPUT_SIZE_MAX_SIDE[outputSize] || 3072;
  return Math.min(sourceMaxSide, outputMaxSide);
}

function getDataUrlMimeType(dataUrl: string, fallback: string): string {
  return /^data:([^;,]+)/.exec(dataUrl)?.[1] || fallback;
}

async function optimizeRasterForRequest(
  dataUrl: string,
  maxSide: number,
  mimeType: 'image/webp' | 'image/jpeg',
  quality: number,
): Promise<OptimizedRaster> {
  const image = await loadRepaintImage(dataUrl);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持局部图片压缩');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);
  const optimizedDataUrl = canvas.toDataURL(mimeType, quality);
  return {
    dataUrl: optimizedDataUrl,
    mimeType: getDataUrlMimeType(optimizedDataUrl, mimeType),
    width,
    height,
  };
}

function referenceInstruction(role: RepaintReferenceRole, referenceCount: number): string {
  if (referenceCount <= 0) return 'No separate reference images are provided. Infer the requested edit from the source crop and user request.';
  const mandatoryPrefix = `The following ${referenceCount} user-provided reference image${referenceCount === 1 ? '' : 's'} are mandatory visual evidence. The edited object must visibly inherit the requested traits from them; do not treat them as optional inspiration. `;
  if (role === 'structure') {
    return mandatoryPrefix + 'Use them as structural guides. Match the relevant silhouette, shape, geometry, proportions, edge logic, layout, and construction clearly inside the masked area. Do not copy unrelated subjects, backgrounds, lighting, text, branding, or identity.';
  }
  if (role === 'appearance') {
    return mandatoryPrefix + 'Use them as appearance guides. Match the relevant color, material, texture, finish, pattern, and visual character clearly. Preserve the source geometry unless the user explicitly asks to change it.';
  }
  return mandatoryPrefix + 'Use them as general visual guides and make the requested reference traits clearly recognizable inside the masked area. Do not copy unrelated reference content.';
}

export function buildUniversalRepaintPrompt(
  userPrompt: string,
  referenceRole: RepaintReferenceRole,
  referenceCount: number,
): string {
  return `You are performing precise, general-purpose localized image editing.

LOCAL EDITING PROTOCOL:
- The source image is a context crop taken from a larger original image.
- A dedicated mask is provided. Edit only the editable mask area and preserve every unmasked pixel as closely as the model allows.
- A protocol-native mask is provided separately: Banana and Grok receive a black-white semantic mask where white is editable and black is preserved; GPT Image receives an Alpha PNG through its dedicated mask parameter. The mask is positional metadata only and must never influence color, material, texture, or lighting.
- Preserve the source crop framing, camera/viewpoint, perspective, scale, lighting direction, shadows, color response, depth of field, surrounding geometry, and all unrelated content.
- Make the new content connect naturally to the preserved boundary. Avoid seams, halos, duplicated edges, floating fragments, broken contours, warped nearby objects, accidental text, watermarks, frames, or layout changes.
- Do not expand the edit beyond the selected area, even if the request describes a larger concept. Use surrounding pixels only as context.
- Return one clean edited image matching the source crop composition. Do not return a comparison layout, annotations, mask visualization, or explanation.

REFERENCE POLICY:
${referenceInstruction(referenceRole, referenceCount)}

USER REQUEST:
${userPrompt.trim()}`;
}

async function resolveGeneratedImages(taskId: string, refs: string[]): Promise<string[]> {
  const download = await downloadAndStoreImages(`advanced-repaint-${taskId}`, refs);
  return Promise.all(refs.map(async (ref, index) => {
    if (ref.startsWith('URL:')) {
      const blobUrl = download.blobUrls[index];
      if (!blobUrl) throw new Error(`第 ${index + 1} 张生成图下载失败`);
      return blobUrl;
    }
    if (/^https?:\/\//i.test(ref)) {
      const response = await fetch(ref);
      if (!response.ok) throw new Error(`生成图下载失败：${response.status}`);
      return URL.createObjectURL(await response.blob());
    }
    return ref;
  }));
}

export async function generateAdvancedRepaintRegion(input: GenerateRepaintRegionInput): Promise<string[]> {
  const provider = resolveImageTaskProvider(input.params.model);
  const strategy = getMaskStrategyForModel(input.params.model);
  const imageLimit = getModelMaxRefImages(input.params.model);
  const availableReferenceSlots = Math.max(0, imageLimit - 1 - (strategy.consumesImageSlot ? 1 : 0));
  const references = input.references.slice(0, availableReferenceSlots);
  if (input.references.length > references.length) {
    input.onProgress?.('当前模型输入位有限，已使用前 ' + references.length + ' 张参考图');
  }

  const originalSource = await loadRepaintImage(input.sourceCropDataUrl);
  const originalWidth = originalSource.naturalWidth || originalSource.width;
  const originalHeight = originalSource.naturalHeight || originalSource.height;
  const adaptiveOutput = resolveAdaptiveRepaintOutputSize(input.params.model, originalWidth, originalHeight);
  const resolutionStatus = adaptiveOutput.willUpscale
    ? '当前模型最高仅支持 ' + adaptiveOutput.outputSize + '，低于区域原始尺寸 ' + originalWidth + '×' + originalHeight + '，结果可能变软'
    : '区域 ' + originalWidth + '×' + originalHeight + '，自动使用 ' + adaptiveOutput.outputSize + ' 生成';
  input.onProgress?.(resolutionStatus);
  const requestMaxSide = getRepaintRequestMaxSide(adaptiveOutput.outputSize, Math.max(originalWidth, originalHeight));
  const [optimizedSource, optimizedReferences] = await Promise.all([
    optimizeRasterForRequest(input.sourceCropDataUrl, requestMaxSide, 'image/webp', 0.88),
    Promise.all(references.map(reference => (
      optimizeRasterForRequest(reference.dataUrl, Math.min(requestMaxSide, 1536), 'image/webp', 0.84)
    ))),
  ]);
  const sourceWidth = optimizedSource.width;
  const sourceHeight = optimizedSource.height;
  const ratioOptions = getAspectRatioOptions(input.params.model, adaptiveOutput.outputSize).map(item => item.value);
  const aspectRatio = closestAspectRatio(sourceWidth, sourceHeight, ratioOptions) as AspectRatio;

  const maskDraft: MaskDraft = {
    id: generateUUID(),
    name: '高级重绘区域蒙版.png',
    originalDataUrl: input.maskDataUrl,
    mimeType: 'image/png',
    analysis: {
      width: sourceWidth,
      height: sourceHeight,
      hasTransparency: false,
      isGrayscale: true,
      detectedSource: 'luminance',
    },
    sourceMode: 'luminance',
    threshold: 128,
    softEdges: false,
    inverted: false,
  };
  const processedMask = await processMaskForTarget(maskDraft, optimizedSource.dataUrl, strategy);
  const images: ImageReference[] = [
    { data: optimizedSource.dataUrl.split(',')[1] || optimizedSource.dataUrl, mimeType: optimizedSource.mimeType },
    ...optimizedReferences.map(reference => ({
      data: reference.dataUrl.split(',')[1] || reference.dataUrl,
      mimeType: reference.mimeType,
    })),
  ];
  const taskId = await createJackyTask({
    modelConfigId: provider.modelConfigId,
    mode: 'image-to-image',
    prompt: buildUniversalRepaintPrompt(input.prompt, input.referenceRole, references.length),
    outputSize: adaptiveOutput.outputSize,
    customSize: undefined,
    aspectRatio,
    temperature: input.params.temperature,
    webSearchEnabled: input.params.webSearchEnabled,
    imageSearchEnabled: input.params.imageSearchEnabled,
    model: provider.modelId,
    gptImageQuality: input.params.gptImageAdvancedParams.quality,
    gptImageStyle: input.params.gptImageAdvancedParams.style,
    gptImageBackground: input.params.gptImageAdvancedParams.background,
    parallelCount: input.params.parallelCount,
    images,
    mask: {
      data: processedMask.dataUrl.split(',')[1] || processedMask.dataUrl,
      mimeType: processedMask.mimeType,
      representation: processedMask.representation,
      width: processedMask.width,
      height: processedMask.height,
      inverted: processedMask.inverted,
    },
  });

  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < POLL_TIMEOUT) {
      const task = await getJackyTask(taskId);
      if (task.status === 'completed') {
        const refs = task.result?.images || [];
        if (refs.length === 0) throw new Error('模型已完成任务，但没有返回图片');
        input.onProgress?.('正在下载并准备局部结果…');
        return await resolveGeneratedImages(taskId, refs);
      }
      if (task.status === 'failed' || task.status === 'expired') {
        throw new Error(task.error || `生成任务${task.status === 'expired' ? '已过期' : '失败'}`);
      }
      input.onProgress?.(task.status === 'queued' || task.status === '排队中' ? '排队中…' : '正在生成局部图…');
      await sleep(POLL_INTERVAL);
    }
    throw new Error('局部生成等待超时，请稍后重试');
  } finally {
    await ackJackyTask(taskId);
  }
}

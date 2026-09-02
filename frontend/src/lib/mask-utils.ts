import { getImageModelById, loadRegistry, type ProviderProtocol } from '@/lib/jacky-models';

export type MaskSourceMode = 'auto' | 'alpha' | 'luminance' | 'color';
export type MaskRepresentation = 'alpha' | 'black-white';

export interface MaskAnalysis {
  width: number;
  height: number;
  hasTransparency: boolean;
  isGrayscale: boolean;
  detectedSource: Exclude<MaskSourceMode, 'auto'>;
}

export interface MaskDraft {
  id: string;
  name: string;
  originalDataUrl: string;
  mimeType: string;
  analysis: MaskAnalysis;
  sourceMode: MaskSourceMode;
  threshold: number;
  softEdges: boolean;
  inverted: boolean;
}

export interface ProcessedMask {
  dataUrl: string;
  mimeType: 'image/png';
  representation: MaskRepresentation;
  width: number;
  height: number;
  sourceMode: Exclude<MaskSourceMode, 'auto'>;
  inverted: boolean;
}

export interface MaskStrategy {
  representation: MaskRepresentation;
  label: string;
  description: string;
  precise: boolean;
  consumesImageSlot: boolean;
}

export interface TransformMaskOptions {
  sourceMode: Exclude<MaskSourceMode, 'auto'>;
  threshold: number;
  softEdges: boolean;
  inverted: boolean;
  representation: MaskRepresentation;
  width?: number;
  height?: number;
}

export function getMaskStrategy(protocol: ProviderProtocol): MaskStrategy {
  if (protocol === 'openai') {
    return {
      representation: 'alpha',
      label: 'Alpha PNG（自动）',
      description: '透明区域编辑，不透明区域保留；自动匹配第 1 张参考图尺寸。',
      precise: true,
      consumesImageSlot: false,
    };
  }

  if (protocol === 'google') {
    return {
      representation: 'black-white',
      label: '黑白语义蒙版（自动）',
      description: '自动转换为纯黑白蒙版；白色区域编辑、黑色区域保留，并作为最后一张图片发送。',
      precise: false,
      consumesImageSlot: true,
    };
  }

  return {
    representation: 'black-white',
    label: '黑白语义蒙版（自动）',
    description: '自动转换为纯黑白蒙版；白色区域编辑、黑色区域保留，并保持第 1 张参考图尺寸。',
    precise: false,
    consumesImageSlot: true,
  };
}

export function getMaskStrategyForModel(modelId: string): MaskStrategy {
  const registry = loadRegistry();
  const configured = getImageModelById(registry, modelId)
    || registry.imageModels.find(model => model.modelId === modelId);

  if (configured) return getMaskStrategy(configured.protocol);
  if (modelId.startsWith('gpt-image')) return getMaskStrategy('openai');
  if (modelId.startsWith('grok-')) return getMaskStrategy('grok');
  return getMaskStrategy('google');
}

export function resolveMaskSourceMode(
  requested: MaskSourceMode,
  analysis: Pick<MaskAnalysis, 'detectedSource'>,
): Exclude<MaskSourceMode, 'auto'> {
  return requested === 'auto' ? analysis.detectedSource : requested;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function getLuminance(red: number, green: number, blue: number): number {
  return clampByte(red * 0.2126 + green * 0.7152 + blue * 0.0722);
}

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

function getDominantColor(
  source: Uint8ClampedArray,
  width?: number,
  height?: number,
): RgbColor {
  const pixelCount = Math.floor(source.length / 4);
  const validDimensions = Boolean(
    width
    && height
    && width > 0
    && height > 0
    && width * height === pixelCount,
  );
  const samples: number[] = [];

  if (validDimensions && width && height) {
    const perimeter = Math.max(1, width * 2 + height * 2 - 4);
    const step = Math.max(1, Math.floor(perimeter / 4096));

    for (let x = 0; x < width; x += step) {
      samples.push(x, (height - 1) * width + x);
    }
    for (let y = step; y < height - 1; y += step) {
      samples.push(y * width, y * width + width - 1);
    }
  } else {
    const step = Math.max(1, Math.floor(pixelCount / 4096));
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += step) {
      samples.push(pixelIndex);
    }
  }

  const buckets = new Map<number, { count: number; red: number; green: number; blue: number }>();
  for (const pixelIndex of samples) {
    const index = pixelIndex * 4;
    if (source[index + 3] < 16) continue;
    const red = source[index];
    const green = source[index + 1];
    const blue = source[index + 2];
    const key = (red >> 4) << 8 | (green >> 4) << 4 | (blue >> 4);
    const bucket = buckets.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
    bucket.count += 1;
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    buckets.set(key, bucket);
  }

  let dominant: { count: number; red: number; green: number; blue: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!dominant || bucket.count > dominant.count) dominant = bucket;
  }

  if (!dominant) return { red: 0, green: 0, blue: 0 };
  return {
    red: dominant.red / dominant.count,
    green: dominant.green / dominant.count,
    blue: dominant.blue / dominant.count,
  };
}

function getColorDistance(red: number, green: number, blue: number, background: RgbColor): number {
  return clampByte(Math.max(
    Math.abs(red - background.red),
    Math.abs(green - background.green),
    Math.abs(blue - background.blue),
  ));
}

export function transformMaskPixels(
  source: Uint8ClampedArray,
  options: TransformMaskOptions,
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const threshold = clampByte(options.threshold);
  const backgroundColor = options.sourceMode === 'color'
    ? getDominantColor(source, options.width, options.height)
    : null;

  for (let index = 0; index < source.length; index += 4) {
    const red = source[index];
    const green = source[index + 1];
    const blue = source[index + 2];
    const alpha = source[index + 3];
    const sourceValue = options.sourceMode === 'alpha'
      ? 255 - alpha
      : options.sourceMode === 'color' && backgroundColor
        ? getColorDistance(red, green, blue, backgroundColor)
        : getLuminance(red, green, blue);

    let editWeight = options.softEdges
      ? sourceValue
      : (sourceValue >= threshold ? 255 : 0);
    if (options.inverted) editWeight = 255 - editWeight;

    if (options.representation === 'alpha') {
      output[index] = 255;
      output[index + 1] = 255;
      output[index + 2] = 255;
      output[index + 3] = 255 - editWeight;
    } else {
      output[index] = editWeight;
      output[index + 1] = editWeight;
      output[index + 2] = editWeight;
      output[index + 3] = 255;
    }
  }

  return output;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('蒙版图像读取失败'));
    image.src = dataUrl;
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('蒙版文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function drawImageData(image: HTMLImageElement, width: number, height: number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器不支持蒙版画布处理');
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

export async function analyzeMaskDataUrl(dataUrl: string): Promise<MaskAnalysis> {
  const image = await loadImage(dataUrl);
  const imageData = drawImageData(image, image.naturalWidth || image.width, image.naturalHeight || image.height);
  let hasTransparency = false;
  let isGrayscale = true;

  for (let index = 0; index < imageData.data.length; index += 4) {
    const red = imageData.data[index];
    const green = imageData.data[index + 1];
    const blue = imageData.data[index + 2];
    const alpha = imageData.data[index + 3];
    if (alpha < 250) hasTransparency = true;
    if (Math.max(red, green, blue) - Math.min(red, green, blue) > 6) isGrayscale = false;
    if (hasTransparency && !isGrayscale) break;
  }

  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
    hasTransparency,
    isGrayscale,
    detectedSource: hasTransparency ? 'alpha' : isGrayscale ? 'luminance' : 'color',
  };
}

export async function createMaskDraft(file: File): Promise<MaskDraft> {
  const originalDataUrl = await readFileAsDataUrl(file);
  const analysis = await analyzeMaskDataUrl(originalDataUrl);
  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    originalDataUrl,
    mimeType: file.type || 'image/png',
    analysis,
    sourceMode: 'auto',
    threshold: analysis.detectedSource === 'color' ? 32 : 128,
    softEdges: analysis.hasTransparency,
    inverted: false,
  };
}

export async function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  const image = await loadImage(dataUrl);
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  };
}

export async function processMaskForTarget(
  draft: MaskDraft,
  targetDataUrl: string,
  strategy: MaskStrategy,
): Promise<ProcessedMask> {
  const [maskImage, targetImage] = await Promise.all([
    loadImage(draft.originalDataUrl),
    loadImage(targetDataUrl),
  ]);
  const targetSize = {
    width: targetImage.naturalWidth || targetImage.width,
    height: targetImage.naturalHeight || targetImage.height,
  };
  const maskWidth = maskImage.naturalWidth || maskImage.width;
  const maskHeight = maskImage.naturalHeight || maskImage.height;
  const maskAspectRatio = maskWidth / maskHeight;
  const targetAspectRatio = targetSize.width / targetSize.height;
  const aspectRatioDelta = Math.abs(maskAspectRatio - targetAspectRatio)
    / Math.max(maskAspectRatio, targetAspectRatio);
  if (aspectRatioDelta > 0.002) {
    throw new Error(`蒙版比例与目标图片不一致：蒙版 ${maskWidth}×${maskHeight}，目标图片 ${targetSize.width}×${targetSize.height}。请使用与目标图片相同比例的蒙版。`);
  }
  const sourceImageData = drawImageData(maskImage, targetSize.width, targetSize.height);
  const sourceMode = resolveMaskSourceMode(draft.sourceMode, draft.analysis);
  const transformed = transformMaskPixels(sourceImageData.data, {
    sourceMode,
    threshold: draft.threshold,
    softEdges: strategy.representation === 'alpha' && draft.softEdges,
    inverted: draft.inverted,
    representation: strategy.representation,
    width: targetSize.width,
    height: targetSize.height,
  });

  const canvas = document.createElement('canvas');
  canvas.width = targetSize.width;
  canvas.height = targetSize.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持蒙版画布处理');
  const outputPixels = new Uint8ClampedArray(transformed.length);
  outputPixels.set(transformed);
  context.putImageData(new ImageData(outputPixels, targetSize.width, targetSize.height), 0, 0);



  return {
    dataUrl: canvas.toDataURL('image/png'),
    mimeType: 'image/png',
    representation: strategy.representation,
    width: targetSize.width,
    height: targetSize.height,
    sourceMode,
    inverted: draft.inverted,
  };
}

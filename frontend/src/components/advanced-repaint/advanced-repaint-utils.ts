import type { RepaintBounds, RepaintRegion } from './types';

export interface MaskComponent {
  pixelIndices: Int32Array;
  pixelCount: number;
  bounds: RepaintBounds;
}

export interface DetectMaskOptions {
  alphaThreshold?: number;
  minPixels?: number;
  mergeGap?: number;
}

const EIGHT_NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const;

function boundsDistance(a: RepaintBounds, b: RepaintBounds): { x: number; y: number } {
  const aRight = a.x + a.width - 1;
  const aBottom = a.y + a.height - 1;
  const bRight = b.x + b.width - 1;
  const bBottom = b.y + b.height - 1;
  return {
    x: Math.max(0, Math.max(a.x - bRight - 1, b.x - aRight - 1)),
    y: Math.max(0, Math.max(a.y - bBottom - 1, b.y - aBottom - 1)),
  };
}

function mergeBounds(a: RepaintBounds, b: RepaintBounds): RepaintBounds {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

export function detectMaskComponents(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options: DetectMaskOptions = {},
): MaskComponent[] {
  const alphaThreshold = options.alphaThreshold ?? 12;
  const minPixels = options.minPixels ?? 24;
  const mergeGap = Math.max(0, Math.round(options.mergeGap ?? 4));
  const pixelCount = width * height;
  if (rgba.length < pixelCount * 4 || width <= 0 || height <= 0) return [];

  const active = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    if (rgba[index * 4 + 3] > alphaThreshold) active[index] = 1;
  }

  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let components: MaskComponent[] = [];

  for (let start = 0; start < pixelCount; start += 1) {
    if (!active[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      for (const [dx, dy] of EIGHT_NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!active[next] || visited[next]) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }

    if (tail >= minPixels) {
      components.push({
        // Keep large masks in a compact typed array. Besides using much less
        // memory than number[], this prevents later code from accidentally
        // spreading hundreds of thousands of indexes as function arguments.
        pixelIndices: queue.slice(0, tail),
        pixelCount: tail,
        bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
      });
    }
  }

  if (mergeGap > 0 && components.length > 1) {
    const parent = components.map((_, index) => index);
    const find = (value: number): number => {
      let node = value;
      while (parent[node] !== node) {
        parent[node] = parent[parent[node]];
        node = parent[node];
      }
      return node;
    };
    const union = (a: number, b: number) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent[rootB] = rootA;
    };

    for (let a = 0; a < components.length; a += 1) {
      for (let b = a + 1; b < components.length; b += 1) {
        const distance = boundsDistance(components[a].bounds, components[b].bounds);
        if (distance.x <= mergeGap && distance.y <= mergeGap) union(a, b);
      }
    }

    const merged = new Map<number, MaskComponent>();
    components.forEach((component, index) => {
      const root = find(index);
      const current = merged.get(root);
      if (!current) {
        merged.set(root, {
          pixelIndices: component.pixelIndices,
          pixelCount: component.pixelCount,
          bounds: { ...component.bounds },
        });
        return;
      }
      const combined = new Int32Array(current.pixelIndices.length + component.pixelIndices.length);
      combined.set(current.pixelIndices, 0);
      combined.set(component.pixelIndices, current.pixelIndices.length);
      current.pixelIndices = combined;
      current.pixelCount += component.pixelCount;
      current.bounds = mergeBounds(current.bounds, component.bounds);
    });
    // Do not use splice(...values) here: a fragmented high-resolution mask can
    // contain enough components to overflow the JavaScript argument stack.
    components = Array.from(merged.values());
  }

  return components.sort((a, b) => {
    const deltaY = a.bounds.y - b.bounds.y;
    if (deltaY !== 0) return deltaY;
    return a.bounds.x - b.bounds.x;
  });
}

export function calculateContextCropBounds(
  bounds: RepaintBounds,
  imageWidth: number,
  imageHeight: number,
  paddingRatio = 0.22,
  minPadding = 24,
): RepaintBounds {
  const padding = Math.max(minPadding, Math.round(Math.max(bounds.width, bounds.height) * paddingRatio));
  const x = Math.max(0, bounds.x - padding);
  const y = Math.max(0, bounds.y - padding);
  const right = Math.min(imageWidth, bounds.x + bounds.width + padding);
  const bottom = Math.min(imageHeight, bounds.y + bounds.height + padding);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

export function parseAspectRatio(value: string): number | null {
  if (!value || value === 'auto') return null;
  const [width, height] = value.split(':').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
}

export function closestAspectRatio(sourceWidth: number, sourceHeight: number, ratios: string[]): string {
  const sourceRatio = sourceWidth / Math.max(1, sourceHeight);
  const numeric = ratios
    .map(value => ({ value, ratio: parseAspectRatio(value) }))
    .filter((item): item is { value: string; ratio: number } => item.ratio !== null);
  if (numeric.length === 0) return ratios.includes('auto') ? 'auto' : '1:1';
  return numeric.reduce((best, item) => (
    Math.abs(Math.log(item.ratio / sourceRatio)) < Math.abs(Math.log(best.ratio / sourceRatio)) ? item : best
  )).value;
}

export function loadRepaintImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片读取失败'));
    image.src = src;
  });
}

export async function createRegionAssets(
  sourceDataUrl: string,
  imageWidth: number,
  imageHeight: number,
  component: MaskComponent,
  paddingRatio: number,
): Promise<Pick<RepaintRegion, 'tightBounds' | 'cropBounds' | 'sourceCropDataUrl' | 'maskDataUrl'>> {
  const source = await loadRepaintImage(sourceDataUrl);
  const cropBounds = calculateContextCropBounds(component.bounds, imageWidth, imageHeight, paddingRatio);
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = cropBounds.width;
  sourceCanvas.height = cropBounds.height;
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('浏览器不支持局部裁切');
  sourceContext.drawImage(
    source,
    cropBounds.x,
    cropBounds.y,
    cropBounds.width,
    cropBounds.height,
    0,
    0,
    cropBounds.width,
    cropBounds.height,
  );

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = cropBounds.width;
  maskCanvas.height = cropBounds.height;
  const maskContext = maskCanvas.getContext('2d');
  if (!maskContext) throw new Error('浏览器不支持蒙版裁切');
  const maskPixels = maskContext.createImageData(cropBounds.width, cropBounds.height);
  for (let index = 0; index < maskPixels.data.length; index += 4) maskPixels.data[index + 3] = 255;
  for (const pixelIndex of component.pixelIndices) {
    const sourceX = pixelIndex % imageWidth;
    const sourceY = Math.floor(pixelIndex / imageWidth);
    const localX = sourceX - cropBounds.x;
    const localY = sourceY - cropBounds.y;
    if (localX < 0 || localY < 0 || localX >= cropBounds.width || localY >= cropBounds.height) continue;
    const target = (localY * cropBounds.width + localX) * 4;
    maskPixels.data[target] = 255;
    maskPixels.data[target + 1] = 255;
    maskPixels.data[target + 2] = 255;
  }
  maskContext.putImageData(maskPixels, 0, 0);

  return {
    tightBounds: { ...component.bounds },
    cropBounds,
    sourceCropDataUrl: sourceCanvas.toDataURL('image/png'),
    maskDataUrl: maskCanvas.toDataURL('image/png'),
  };
}

export function drawImageCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
  offsetX = 0,
  offsetY = 0,
) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(
    image,
    (width - drawWidth) / 2 + offsetX,
    (height - drawHeight) / 2 + offsetY,
    drawWidth,
    drawHeight,
  );
}

async function createLuminanceAlphaMask(maskUrl: string, width: number, height: number, blendRadius: number) {
  const maskImage = await loadRepaintImage(maskUrl);
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('浏览器不支持蒙版合成');
  sourceContext.drawImage(maskImage, 0, 0, width, height);
  const pixels = sourceContext.getImageData(0, 0, width, height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const alpha = Math.round(
      pixels.data[index] * 0.2126
      + pixels.data[index + 1] * 0.7152
      + pixels.data[index + 2] * 0.0722,
    );
    pixels.data[index] = 255;
    pixels.data[index + 1] = 255;
    pixels.data[index + 2] = 255;
    pixels.data[index + 3] = alpha;
  }
  sourceContext.putImageData(pixels, 0, 0);
  if (blendRadius <= 0) return sourceCanvas;

  const blurredCanvas = document.createElement('canvas');
  blurredCanvas.width = width;
  blurredCanvas.height = height;
  const blurredContext = blurredCanvas.getContext('2d');
  if (!blurredContext) return sourceCanvas;
  blurredContext.filter = `blur(${Math.max(0, blendRadius)}px)`;
  blurredContext.drawImage(sourceCanvas, 0, 0);
  blurredContext.filter = 'none';
  return blurredCanvas;
}

export function getCommittableRepaintRegions(regions: RepaintRegion[]): RepaintRegion[] {
  return regions.filter(region => region.enabled && Boolean(region.selectedCandidateId));
}

export function hasDiscardableRepaintWork(regions: RepaintRegion[]): boolean {
  return regions.some(region => (
    region.prompt.trim().length > 0
    || region.references.length > 0
    || region.candidates.length > 0
  ));
}

export function getRepaintCompositionKey(regions: RepaintRegion[]): string {
  return JSON.stringify(regions.map(region => {
    const selectedCandidate = region.candidates.find(candidate => candidate.id === region.selectedCandidateId);
    return {
      id: region.id,
      order: region.order,
      enabled: region.enabled,
      selectedCandidateId: region.selectedCandidateId || '',
      selectedCandidateUrl: selectedCandidate?.imageUrl || '',
      cropBounds: region.cropBounds,
      maskDataUrl: region.maskDataUrl,
      compositeMaskDataUrl: region.compositeMaskDataUrl || '',
      patchOffsetX: region.patchOffsetX || 0,
      patchOffsetY: region.patchOffsetY || 0,
    };
  }));
}

export async function composeRepaintResult(
  sourceDataUrl: string,
  regions: RepaintRegion[],
  blendRadius: number,
): Promise<string> {
  const source = await loadRepaintImage(sourceDataUrl);
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const resultCanvas = document.createElement('canvas');
  resultCanvas.width = width;
  resultCanvas.height = height;
  const resultContext = resultCanvas.getContext('2d');
  if (!resultContext) throw new Error('浏览器不支持结果合成');
  resultContext.drawImage(source, 0, 0, width, height);

  const ordered = [...regions].sort((a, b) => a.order - b.order);
  for (const region of ordered) {
    if (!region.enabled || !region.selectedCandidateId) continue;
    const candidate = region.candidates.find(item => item.id === region.selectedCandidateId);
    if (!candidate) continue;
    const generated = await loadRepaintImage(candidate.imageUrl);
    const patchCanvas = document.createElement('canvas');
    patchCanvas.width = region.cropBounds.width;
    patchCanvas.height = region.cropBounds.height;
    const patchContext = patchCanvas.getContext('2d');
    if (!patchContext) continue;
    drawImageCover(
      patchContext,
      generated,
      patchCanvas.width,
      patchCanvas.height,
      region.patchOffsetX || 0,
      region.patchOffsetY || 0,
    );
    const alphaMask = await createLuminanceAlphaMask(
      region.compositeMaskDataUrl || region.maskDataUrl,
      patchCanvas.width,
      patchCanvas.height,
      blendRadius,
    );
    patchContext.globalCompositeOperation = 'destination-in';
    patchContext.drawImage(alphaMask, 0, 0);
    patchContext.globalCompositeOperation = 'source-over';
    resultContext.drawImage(patchCanvas, region.cropBounds.x, region.cropBounds.y);
  }

  return resultCanvas.toDataURL('image/png');
}

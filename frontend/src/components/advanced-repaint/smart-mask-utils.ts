export type SmartMaskPoint = { x: number; y: number; label: 0 | 1 };

export interface CleanSmartMaskOptions {
  anchorSearchRadius?: number;
  holeAreaRatio?: number;
  maxHolePixels?: number;
}

export interface CleanSmartMaskResult {
  data: Uint8Array;
  pixelCount: number;
  componentCount: number;
  keptComponentCount: number;
  removedPixels: number;
  filledHolePixels: number;
}

const EIGHT_NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const;

const FOUR_NEIGHBORS = [
  [0, -1], [-1, 0], [1, 0], [0, 1],
] as const;

function pointToPixel(point: SmartMaskPoint, width: number, height: number) {
  return {
    x: Math.min(width - 1, Math.max(0, Math.floor(point.x * width))),
    y: Math.min(height - 1, Math.max(0, Math.floor(point.y * height))),
  };
}

function nearestComponentLabel(
  labels: Int32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
) {
  const direct = labels[y * width + x];
  if (direct > 0) return direct;
  let nearestLabel = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const minX = Math.max(0, x - radius);
  const maxX = Math.min(width - 1, x + radius);
  const minY = Math.max(0, y - radius);
  const maxY = Math.min(height - 1, y + radius);
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const label = labels[py * width + px];
      if (label <= 0) continue;
      const dx = px - x;
      const dy = py - y;
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestLabel = label;
      }
    }
  }
  return nearestLabel;
}

function labelForegroundComponents(mask: Uint8Array, width: number, height: number) {
  const pixelTotal = width * height;
  const labels = new Int32Array(pixelTotal);
  const queue = new Int32Array(pixelTotal);
  const componentSizes: number[] = [0];
  let componentCount = 0;

  for (let start = 0; start < pixelTotal; start += 1) {
    if (mask[start] === 0 || labels[start] !== 0) continue;
    componentCount += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = componentCount;

    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);
      for (const [dx, dy] of EIGHT_NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] === 0 || labels[next] !== 0) continue;
        labels[next] = componentCount;
        queue[tail++] = next;
      }
    }
    componentSizes[componentCount] = tail;
  }

  return { labels, componentSizes, componentCount };
}

function keepAnchoredComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  points: SmartMaskPoint[],
  options: CleanSmartMaskOptions,
) {
  const { labels, componentSizes, componentCount } = labelForegroundComponents(mask, width, height);
  const positivePoints = points.filter(point => point.label === 1);
  const anchorSearchRadius = options.anchorSearchRadius
    ?? Math.max(3, Math.min(24, Math.round(Math.min(width, height) * 0.012)));
  const keptLabels = new Set<number>();

  for (const point of positivePoints) {
    const pixel = pointToPixel(point, width, height);
    const label = nearestComponentLabel(labels, width, height, pixel.x, pixel.y, anchorSearchRadius);
    if (label > 0) keptLabels.add(label);
  }

  if (keptLabels.size === 0 && componentCount > 0) {
    let largestLabel = 1;
    for (let label = 2; label <= componentCount; label += 1) {
      if ((componentSizes[label] || 0) > (componentSizes[largestLabel] || 0)) largestLabel = label;
    }
    keptLabels.add(largestLabel);
  }

  const output = new Uint8Array(mask.length);
  let pixelCount = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!keptLabels.has(labels[index])) continue;
    output[index] = 1;
    pixelCount += 1;
  }

  return {
    data: output,
    pixelCount,
    componentCount,
    keptComponentCount: keptLabels.size,
    removedPixels: Math.max(0, componentSizes.reduce((sum, size) => sum + (size || 0), 0) - pixelCount),
  };
}

function markExteriorBackground(mask: Uint8Array, width: number, height: number) {
  const exterior = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number) => {
    if (mask[index] !== 0 || exterior[index] !== 0) return;
    exterior[index] = 1;
    queue[tail++] = index;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const current = queue[head++];
    const x = current % width;
    const y = Math.floor(current / width);
    for (const [dx, dy] of FOUR_NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      enqueue(ny * width + nx);
    }
  }
  return exterior;
}

function fillSmallHoles(
  mask: Uint8Array,
  width: number,
  height: number,
  foregroundPixels: number,
  points: SmartMaskPoint[],
  options: CleanSmartMaskOptions,
) {
  if (foregroundPixels === 0) return 0;
  const exterior = markExteriorBackground(mask, width, height);
  const visited = new Uint8Array(mask.length);
  const protectedBackground = new Uint8Array(mask.length);
  for (const point of points) {
    if (point.label !== 0) continue;
    const pixel = pointToPixel(point, width, height);
    const radius = 2;
    for (let y = Math.max(0, pixel.y - radius); y <= Math.min(height - 1, pixel.y + radius); y += 1) {
      for (let x = Math.max(0, pixel.x - radius); x <= Math.min(width - 1, pixel.x + radius); x += 1) {
        protectedBackground[y * width + x] = 1;
      }
    }
  }

  const holeAreaRatio = options.holeAreaRatio ?? 0.006;
  const automaticLimit = Math.min(
    4096,
    Math.max(24, Math.round(foregroundPixels * holeAreaRatio)),
    Math.max(24, Math.round(mask.length * 0.0004)),
  );
  const holeLimit = Math.max(0, Math.round(options.maxHolePixels ?? automaticLimit));
  if (holeLimit === 0) return 0;

  const queue = new Int32Array(mask.length);
  let filledHolePixels = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 0 || exterior[start] !== 0 || visited[start] !== 0) continue;
    let head = 0;
    let tail = 0;
    let isProtected = false;
    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const current = queue[head++];
      if (protectedBackground[current] !== 0) isProtected = true;
      const x = current % width;
      const y = Math.floor(current / width);
      for (const [dx, dy] of FOUR_NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] !== 0 || exterior[next] !== 0 || visited[next] !== 0) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }

    if (tail > holeLimit || isProtected) continue;
    for (let index = 0; index < tail; index += 1) mask[queue[index]] = 1;
    filledHolePixels += tail;
  }
  return filledHolePixels;
}

export function cleanSmartBinaryMask(
  source: Uint8Array,
  width: number,
  height: number,
  points: SmartMaskPoint[],
  options: CleanSmartMaskOptions = {},
): CleanSmartMaskResult {
  const pixelTotal = width * height;
  if (width <= 0 || height <= 0 || source.length < pixelTotal) {
    return {
      data: new Uint8Array(),
      pixelCount: 0,
      componentCount: 0,
      keptComponentCount: 0,
      removedPixels: 0,
      filledHolePixels: 0,
    };
  }

  const binary = new Uint8Array(pixelTotal);
  for (let index = 0; index < pixelTotal; index += 1) binary[index] = source[index] > 0 ? 1 : 0;
  const anchored = keepAnchoredComponents(binary, width, height, points, options);
  const filledHolePixels = fillSmallHoles(
    anchored.data,
    width,
    height,
    anchored.pixelCount,
    points,
    options,
  );
  return {
    ...anchored,
    pixelCount: anchored.pixelCount + filledHolePixels,
    filledHolePixels,
  };
}

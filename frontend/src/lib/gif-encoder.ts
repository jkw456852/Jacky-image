import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { saveBlobToDownloads } from '@/lib/local-download';
import { GIF_GRID_COLS, GIF_GRID_ROWS } from '@/lib/gif-job-store';

export interface EncodeGifOptions {
  frameDelayMs: number;
  /** 0 = 无限循环；正整数 = 循环 N 次；负数 = 仅播放一次（不循环） */
  repeat: number;
  /** 用户自定义内缩百分比（0-5），从每帧四周等比例裁掉 */
  framePaddingPercent?: number;
}

export interface GridCell {
  index: number;
  /** PNG dataURL，供微调器以 <img> 渲染 */
  dataUrl: string;
  width: number;
  height: number;
}

export interface ExtractedGrid {
  cells: GridCell[];
  cellWidth: number;
  cellHeight: number;
}

interface FrameSource {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('网格图加载失败，无法切帧'));
    img.src = src;
  });
}

function createCanvasContext(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('当前浏览器不支持 Canvas 2D，无法合成 GIF');
  }
  return ctx;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 固定切割：网格图分辨率受严格约束（3264×2448，4×3），直接按行列等分即可。
 * paddingPercent 从每格四周等比例内缩，去掉模型可能渗到边缘的少量噪声。
 */
function computeFixedFrameSources(
  naturalWidth: number,
  naturalHeight: number,
  paddingPercent: number,
): { sources: FrameSource[]; cellW: number; cellH: number } {
  const baseCellW = Math.floor(naturalWidth / GIF_GRID_COLS);
  const baseCellH = Math.floor(naturalHeight / GIF_GRID_ROWS);
  if (baseCellW <= 0 || baseCellH <= 0) {
    throw new Error('网格图过小，无法切出 3×4 帧');
  }

  const pct = clamp(paddingPercent, 0, 5);
  const insetX = Math.round((baseCellW * pct) / 100);
  const insetY = Math.round((baseCellH * pct) / 100);
  const cellW = Math.max(8, baseCellW - insetX * 2);
  const cellH = Math.max(8, baseCellH - insetY * 2);

  const sources: FrameSource[] = [];
  for (let row = 0; row < GIF_GRID_ROWS; row++) {
    for (let col = 0; col < GIF_GRID_COLS; col++) {
      sources.push({
        sx: col * baseCellW + insetX,
        sy: row * baseCellH + insetY,
        sw: cellW,
        sh: cellH,
      });
    }
  }
  return { sources, cellW, cellH };
}

/**
 * 核心编码：把一组等尺寸帧像素合成 GIF。
 * 合并全部帧做一次全局量化，保证整段动画调色板一致。
 */
function encodeFramesToBlob(
  frames: Uint8ClampedArray[],
  width: number,
  height: number,
  options: EncodeGifOptions,
): Blob {
  if (frames.length === 0) {
    throw new Error('没有可编码的帧');
  }

  const pixelsPerFrame = width * height * 4;
  const merged = new Uint8ClampedArray(pixelsPerFrame * frames.length);
  frames.forEach((f, i) => merged.set(f, i * pixelsPerFrame));
  const palette = quantize(merged, 256, { format: 'rgb565' });

  const gif = GIFEncoder();
  frames.forEach((data, i) => {
    const indexed = applyPalette(data, palette);
    if (i === 0) {
      gif.writeFrame(indexed, width, height, {
        palette,
        delay: options.frameDelayMs,
        repeat: options.repeat,
        dispose: 2,
      });
    } else {
      gif.writeFrame(indexed, width, height, {
        delay: options.frameDelayMs,
        dispose: 2,
      });
    }
  });

  gif.finish();
  const view = gif.bytes();
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return new Blob([copy], { type: 'image/gif' });
}

/**
 * 自动模式：固定切割网格图为 12 帧并直接合成 GIF。
 */
export async function encodeGifFromGrid(
  gridImageUrl: string,
  options: EncodeGifOptions,
): Promise<Blob> {
  const img = await loadImageElement(gridImageUrl);
  const naturalWidth = img.naturalWidth || img.width;
  const naturalHeight = img.naturalHeight || img.height;
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    throw new Error('网格图无效，尺寸为 0');
  }

  const { sources, cellW, cellH } = computeFixedFrameSources(
    naturalWidth,
    naturalHeight,
    options.framePaddingPercent ?? 0,
  );

  const frameCtx = createCanvasContext(cellW, cellH);
  const frames: Uint8ClampedArray[] = [];
  for (const src of sources) {
    const safeSx = clamp(src.sx, 0, naturalWidth - cellW);
    const safeSy = clamp(src.sy, 0, naturalHeight - cellH);
    frameCtx.clearRect(0, 0, cellW, cellH);
    frameCtx.drawImage(img, safeSx, safeSy, cellW, cellH, 0, 0, cellW, cellH);
    frames.push(frameCtx.getImageData(0, 0, cellW, cellH).data);
  }

  return encodeFramesToBlob(frames, cellW, cellH, options);
}

/**
 * 微调模式第一步：固定切割网格图为 12 个独立单元格（不做内缩），
 * 返回每帧 PNG dataURL 供全屏编辑器渲染与对齐。
 */
export async function extractGridCells(gridImageUrl: string): Promise<ExtractedGrid> {
  const img = await loadImageElement(gridImageUrl);
  const naturalWidth = img.naturalWidth || img.width;
  const naturalHeight = img.naturalHeight || img.height;
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    throw new Error('网格图无效，尺寸为 0');
  }

  const { sources, cellW, cellH } = computeFixedFrameSources(naturalWidth, naturalHeight, 0);
  const ctx = createCanvasContext(cellW, cellH);
  const cells: GridCell[] = sources.map((src, index) => {
    const safeSx = clamp(src.sx, 0, naturalWidth - cellW);
    const safeSy = clamp(src.sy, 0, naturalHeight - cellH);
    ctx.clearRect(0, 0, cellW, cellH);
    ctx.drawImage(img, safeSx, safeSy, cellW, cellH, 0, 0, cellW, cellH);
    return {
      index,
      dataUrl: ctx.canvas.toDataURL('image/png'),
      width: cellW,
      height: cellH,
    };
  });

  return { cells, cellWidth: cellW, cellHeight: cellH };
}

/**
 * 微调模式第二步：把编辑器已合成好的等尺寸帧编码成 GIF。
 */
export function encodeFramesToGif(
  frames: ImageData[],
  options: EncodeGifOptions,
): Blob {
  if (frames.length === 0) {
    throw new Error('没有可编码的帧');
  }
  const { width, height } = frames[0];
  return encodeFramesToBlob(frames.map(f => f.data), width, height, options);
}

export async function triggerGifDownload(blob: Blob, fileName: string): Promise<void> {
  await saveBlobToDownloads(blob, fileName);
}

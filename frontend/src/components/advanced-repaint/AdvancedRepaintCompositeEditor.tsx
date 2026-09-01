'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { drawImageCover, loadRepaintImage } from './advanced-repaint-utils';
import type { RepaintRegion } from './types';

export type RepaintCompositeEditTool = 'move' | 'mask-add' | 'mask-erase';

interface AdvancedRepaintCompositeEditorProps {
  sourceDataUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  regions: RepaintRegion[];
  selectedRegionId?: string;
  blendRadius: number;
  editTool: RepaintCompositeEditTool;
  brushSize: number;
  onUpdateRegion: (regionId: string, patch: Partial<RepaintRegion>) => void;
}

interface RuntimeLayer {
  region: RepaintRegion;
  generated: HTMLImageElement;
  maskCanvas: HTMLCanvasElement;
  maskAlphaCanvas: HTMLCanvasElement;
  blurredMaskCanvas: HTMLCanvasElement;
  patchCanvas: HTMLCanvasElement;
}

interface RuntimeComposition {
  source: HTMLImageElement;
  layers: Map<string, RuntimeLayer>;
}

type ActiveInteraction =
  | {
    kind: 'move';
    pointerId: number;
    regionId: string;
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
  }
  | {
    kind: 'mask';
    pointerId: number;
    regionId: string;
    lastX: number;
    lastY: number;
    erase: boolean;
  };

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  return canvas;
}

function syncMaskAlpha(maskCanvas: HTMLCanvasElement, alphaCanvas: HTMLCanvasElement) {
  const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
  const alphaContext = alphaCanvas.getContext('2d');
  if (!maskContext || !alphaContext) return;
  const pixels = maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
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
  alphaContext.clearRect(0, 0, alphaCanvas.width, alphaCanvas.height);
  alphaContext.putImageData(pixels, 0, 0);
}

function drawMaskStroke(
  layer: RuntimeLayer,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  brushSize: number,
  erase: boolean,
) {
  const maskContext = layer.maskCanvas.getContext('2d');
  const alphaContext = layer.maskAlphaCanvas.getContext('2d');
  if (!maskContext || !alphaContext) return;

  maskContext.save();
  maskContext.globalCompositeOperation = 'source-over';
  maskContext.strokeStyle = erase ? '#000000' : '#ffffff';
  maskContext.fillStyle = erase ? '#000000' : '#ffffff';
  maskContext.lineWidth = brushSize;
  maskContext.lineCap = 'round';
  maskContext.lineJoin = 'round';
  maskContext.beginPath();
  maskContext.moveTo(startX, startY);
  maskContext.lineTo(endX, endY);
  maskContext.stroke();
  if (startX === endX && startY === endY) {
    maskContext.beginPath();
    maskContext.arc(endX, endY, brushSize / 2, 0, Math.PI * 2);
    maskContext.fill();
  }
  maskContext.restore();

  alphaContext.save();
  alphaContext.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  alphaContext.strokeStyle = '#ffffff';
  alphaContext.fillStyle = '#ffffff';
  alphaContext.lineWidth = brushSize;
  alphaContext.lineCap = 'round';
  alphaContext.lineJoin = 'round';
  alphaContext.beginPath();
  alphaContext.moveTo(startX, startY);
  alphaContext.lineTo(endX, endY);
  alphaContext.stroke();
  if (startX === endX && startY === endY) {
    alphaContext.beginPath();
    alphaContext.arc(endX, endY, brushSize / 2, 0, Math.PI * 2);
    alphaContext.fill();
  }
  alphaContext.restore();
}

export function AdvancedRepaintCompositeEditor({
  sourceDataUrl,
  sourceWidth,
  sourceHeight,
  regions,
  selectedRegionId,
  blendRadius,
  editTool,
  brushSize,
  onUpdateRegion,
}: AdvancedRepaintCompositeEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<RuntimeComposition | null>(null);
  const regionsRef = useRef(regions);
  const blendRadiusRef = useRef(blendRadius);
  regionsRef.current = regions;
  blendRadiusRef.current = blendRadius;
  const loadSequenceRef = useRef(0);
  const interactionRef = useRef<ActiveInteraction | null>(null);
  const temporaryOffsetRef = useRef<{ regionId: string; x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [cursor, setCursor] = useState({ x: 0, y: 0, visible: false });

  const assetKey = useMemo(() => JSON.stringify(regions.map(region => {
    const candidate = region.candidates.find(item => item.id === region.selectedCandidateId);
    return {
      id: region.id,
      enabled: region.enabled,
      candidate: candidate?.imageUrl || '',
      mask: region.compositeMaskDataUrl || region.maskDataUrl,
      cropBounds: region.cropBounds,
    };
  })), [regions]);

  const renderComposition = useCallback(() => {
    const canvas = canvasRef.current;
    const runtime = runtimeRef.current;
    if (!canvas || !runtime) return;
    if (canvas.width !== sourceWidth) canvas.width = sourceWidth;
    if (canvas.height !== sourceHeight) canvas.height = sourceHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, sourceWidth, sourceHeight);
    context.drawImage(runtime.source, 0, 0, sourceWidth, sourceHeight);

    const ordered = [...regionsRef.current].sort((a, b) => a.order - b.order);
    for (const region of ordered) {
      if (!region.enabled || !region.selectedCandidateId) continue;
      const layer = runtime.layers.get(region.id);
      if (!layer) continue;
      layer.region = region;
      const { width, height, x, y } = region.cropBounds;
      if (layer.patchCanvas.width !== width) layer.patchCanvas.width = width;
      if (layer.patchCanvas.height !== height) layer.patchCanvas.height = height;
      if (layer.blurredMaskCanvas.width !== width) layer.blurredMaskCanvas.width = width;
      if (layer.blurredMaskCanvas.height !== height) layer.blurredMaskCanvas.height = height;
      const patchContext = layer.patchCanvas.getContext('2d');
      const blurredMaskContext = layer.blurredMaskCanvas.getContext('2d');
      if (!patchContext || !blurredMaskContext) continue;

      const temporaryOffset = temporaryOffsetRef.current?.regionId === region.id
        ? temporaryOffsetRef.current
        : null;
      const offsetX = temporaryOffset?.x ?? region.patchOffsetX ?? 0;
      const offsetY = temporaryOffset?.y ?? region.patchOffsetY ?? 0;
      patchContext.clearRect(0, 0, width, height);
      patchContext.globalCompositeOperation = 'source-over';
      drawImageCover(patchContext, layer.generated, width, height, offsetX, offsetY);

      blurredMaskContext.clearRect(0, 0, width, height);
      blurredMaskContext.save();
      const currentBlendRadius = blendRadiusRef.current;
      blurredMaskContext.filter = currentBlendRadius > 0 ? `blur(${currentBlendRadius}px)` : 'none';
      blurredMaskContext.drawImage(layer.maskAlphaCanvas, 0, 0, width, height);
      blurredMaskContext.restore();

      patchContext.globalCompositeOperation = 'destination-in';
      patchContext.drawImage(layer.blurredMaskCanvas, 0, 0);
      patchContext.globalCompositeOperation = 'source-over';
      context.drawImage(layer.patchCanvas, x, y);
    }
  }, [sourceHeight, sourceWidth]);

  useEffect(() => {
    const sequence = ++loadSequenceRef.current;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    void (async () => {
      const source = await loadRepaintImage(sourceDataUrl);
      const layers = new Map<string, RuntimeLayer>();
      for (const region of regionsRef.current) {
        if (!region.enabled || !region.selectedCandidateId) continue;
        const candidate = region.candidates.find(item => item.id === region.selectedCandidateId);
        if (!candidate) continue;
        const [generated, maskImage] = await Promise.all([
          loadRepaintImage(candidate.imageUrl),
          loadRepaintImage(region.compositeMaskDataUrl || region.maskDataUrl),
        ]);
        const maskCanvas = createCanvas(region.cropBounds.width, region.cropBounds.height);
        const maskContext = maskCanvas.getContext('2d');
        if (!maskContext) continue;
        maskContext.fillStyle = '#000000';
        maskContext.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
        maskContext.drawImage(maskImage, 0, 0, maskCanvas.width, maskCanvas.height);
        const maskAlphaCanvas = createCanvas(maskCanvas.width, maskCanvas.height);
        syncMaskAlpha(maskCanvas, maskAlphaCanvas);
        layers.set(region.id, {
          region,
          generated,
          maskCanvas,
          maskAlphaCanvas,
          blurredMaskCanvas: createCanvas(maskCanvas.width, maskCanvas.height),
          patchCanvas: createCanvas(maskCanvas.width, maskCanvas.height),
        });
      }
      if (cancelled || sequence !== loadSequenceRef.current) return;
      runtimeRef.current = { source, layers };
      setLoading(false);
      window.requestAnimationFrame(renderComposition);
    })().catch(error => {
      if (!cancelled && sequence === loadSequenceRef.current) {
        const message = error instanceof Error ? error.message : '合成编辑资源加载失败';
        console.error('[advanced-repaint] Composite editor initialization failed', error);
        setLoadError(message);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [assetKey, renderComposition, sourceDataUrl]);

  useEffect(() => {
    renderComposition();
  }, [blendRadius, regions, renderComposition]);

  useEffect(() => {
    interactionRef.current = null;
    temporaryOffsetRef.current = null;
    setDragging(false);
    renderComposition();
  }, [editTool, selectedRegionId, renderComposition]);

  const toSourcePoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (sourceWidth / rect.width),
      y: (event.clientY - rect.top) * (sourceHeight / rect.height),
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !selectedRegionId) return;
    const runtime = runtimeRef.current;
    const layer = runtime?.layers.get(selectedRegionId);
    if (!layer) return;
    const point = toSourcePoint(event);
    const localX = point.x - layer.region.cropBounds.x;
    const localY = point.y - layer.region.cropBounds.y;
    if (localX < 0 || localY < 0 || localX >= layer.region.cropBounds.width || localY >= layer.region.cropBounds.height) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (editTool === 'move') {
      interactionRef.current = {
        kind: 'move',
        pointerId: event.pointerId,
        regionId: selectedRegionId,
        startX: point.x,
        startY: point.y,
        startOffsetX: layer.region.patchOffsetX || 0,
        startOffsetY: layer.region.patchOffsetY || 0,
      };
      setDragging(true);
      return;
    }

    const erase = editTool === 'mask-erase';
    interactionRef.current = {
      kind: 'mask',
      pointerId: event.pointerId,
      regionId: selectedRegionId,
      lastX: localX,
      lastY: localY,
      erase,
    };
    drawMaskStroke(layer, localX, localY, localX, localY, brushSize, erase);
    renderComposition();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = toSourcePoint(event);
    setCursor({ x: point.x, y: point.y, visible: true });
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const runtime = runtimeRef.current;
    const layer = runtime?.layers.get(interaction.regionId);
    if (!layer) return;
    event.preventDefault();

    if (interaction.kind === 'move') {
      temporaryOffsetRef.current = {
        regionId: interaction.regionId,
        x: interaction.startOffsetX + point.x - interaction.startX,
        y: interaction.startOffsetY + point.y - interaction.startY,
      };
      renderComposition();
      return;
    }

    const localX = point.x - layer.region.cropBounds.x;
    const localY = point.y - layer.region.cropBounds.y;
    drawMaskStroke(
      layer,
      interaction.lastX,
      interaction.lastY,
      localX,
      localY,
      brushSize,
      interaction.erase,
    );
    interaction.lastX = localX;
    interaction.lastY = localY;
    renderComposition();
  };

  const finishInteraction = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    interactionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (interaction.kind === 'move') {
      const offset = temporaryOffsetRef.current;
      temporaryOffsetRef.current = null;
      setDragging(false);
      if (offset) {
        onUpdateRegion(interaction.regionId, {
          patchOffsetX: Math.round(offset.x),
          patchOffsetY: Math.round(offset.y),
        });
      }
      renderComposition();
      return;
    }

    const layer = runtimeRef.current?.layers.get(interaction.regionId);
    if (layer) {
      onUpdateRegion(interaction.regionId, {
        compositeMaskDataUrl: layer.maskCanvas.toDataURL('image/png'),
      });
    }
  };

  const cursorClass = editTool === 'move'
    ? dragging ? 'cursor-grabbing' : 'cursor-grab'
    : 'cursor-none';
  const selectedRegion = regions.find(region => region.id === selectedRegionId);

  return (
    <div className="absolute inset-0">
      <canvas
        ref={canvasRef}
        width={sourceWidth}
        height={sourceHeight}
        className={cn('absolute inset-0 h-full w-full touch-none', cursorClass)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishInteraction}
        onPointerCancel={finishInteraction}
        onPointerEnter={() => setCursor(current => ({ ...current, visible: true }))}
        onPointerLeave={() => setCursor(current => ({ ...current, visible: false }))}
        aria-label="高级重绘合成调整画布"
      />

      {editTool === 'move' && selectedRegion && (
        <div
          className="pointer-events-none absolute border border-dashed border-cyan-400/90 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
          style={{
            left: `${(selectedRegion.cropBounds.x / sourceWidth) * 100}%`,
            top: `${(selectedRegion.cropBounds.y / sourceHeight) * 100}%`,
            width: `${(selectedRegion.cropBounds.width / sourceWidth) * 100}%`,
            height: `${(selectedRegion.cropBounds.height / sourceHeight) * 100}%`,
          }}
        />
      )}

      {editTool !== 'move' && cursor.visible && (
        <span
          className={cn(
            'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]',
            editTool === 'mask-add' ? 'border-emerald-300 bg-emerald-400/15' : 'border-rose-300 bg-rose-400/15',
          )}
          style={{
            left: `${(cursor.x / sourceWidth) * 100}%`,
            top: `${(cursor.y / sourceHeight) * 100}%`,
            width: `${(brushSize / sourceWidth) * 100}%`,
            height: `${(brushSize / sourceHeight) * 100}%`,
          }}
        />
      )}

      {(loading || loadError) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20 px-6 text-center text-xs text-white backdrop-blur-[1px]">
          {loadError || '正在准备合成编辑…'}
        </div>
      )}
    </div>
  );
}

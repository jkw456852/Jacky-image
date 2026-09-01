'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { AdvancedRepaintViewport } from './AdvancedRepaintViewport';
import type { RepaintRegion, RepaintSelectionMode, RepaintTool } from './types';

export interface SmartSelectionPoint {
  x: number;
  y: number;
  label: 0 | 1;
}

export interface AdvancedRepaintCanvasHandle {
  getMaskImageData: () => ImageData | null;
  clear: () => void;
  undo: () => void;
  redo: () => void;
  hasPaint: () => boolean;
  applyBinaryMask: (data: Uint8Array, width: number, height: number, mode: RepaintSelectionMode) => void;
}

interface AdvancedRepaintCanvasProps {
  sourceUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  tool: RepaintTool;
  selectionMode?: RepaintSelectionMode;
  brushSize: number;
  zoom: number;
  onZoomChange?: (zoom: number) => void;
  readOnly?: boolean;
  regions?: RepaintRegion[];
  selectedRegionId?: string;
  smartMaskDataUrl?: string | null;
  smartPoints?: SmartSelectionPoint[];
  smartReady?: boolean;
  onSmartPoint?: (point: SmartSelectionPoint, refineCurrent: boolean) => void;
  onSelectRegion?: (regionId: string) => void;
  onMaskChange?: (hasMask: boolean) => void;
}

const MAX_HISTORY = 20;

type Point = { x: number; y: number };
type RectDraft = { start: Point; end: Point };

export const AdvancedRepaintCanvas = forwardRef<AdvancedRepaintCanvasHandle, AdvancedRepaintCanvasProps>(
  function AdvancedRepaintCanvas({
    sourceUrl,
    sourceWidth,
    sourceHeight,
    tool,
    selectionMode = 'add',
    brushSize,
    zoom,
    onZoomChange,
    readOnly = false,
    regions = [],
    selectedRegionId,
    smartMaskDataUrl,
    smartPoints = [],
    smartReady = false,
    onSmartPoint,
    onSelectRegion,
    onMaskChange,
  }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef(false);
    const lastPointRef = useRef<Point | null>(null);
    const undoStackRef = useRef<ImageData[]>([]);
    const redoStackRef = useRef<ImageData[]>([]);
    const [cursor, setCursor] = useState({ x: 0, y: 0, visible: false });
    const [rectDraft, setRectDraft] = useState<RectDraft | null>(null);

    const getContext = () => canvasRef.current?.getContext('2d', { willReadFrequently: true }) || null;

    const snapshot = () => {
      const canvas = canvasRef.current;
      const context = getContext();
      if (!canvas || !context) return null;
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };

    const pushHistory = () => {
      const current = snapshot();
      if (!current) return;
      undoStackRef.current.push(current);
      if (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift();
      redoStackRef.current = [];
    };

    const updateMaskState = () => {
      const data = snapshot()?.data;
      if (!data) return onMaskChange?.(false);
      let painted = false;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 8) {
          painted = true;
          break;
        }
      }
      onMaskChange?.(painted);
    };

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || sourceWidth <= 0 || sourceHeight <= 0) return;
      canvas.width = sourceWidth;
      canvas.height = sourceHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context?.clearRect(0, 0, sourceWidth, sourceHeight);
      undoStackRef.current = [];
      redoStackRef.current = [];
      setRectDraft(null);
      onMaskChange?.(false);
    }, [sourceUrl, sourceWidth, sourceHeight, onMaskChange]);

    useImperativeHandle(ref, () => ({
      getMaskImageData: () => snapshot(),
      clear: () => {
        const canvas = canvasRef.current;
        const context = getContext();
        if (!canvas || !context) return;
        pushHistory();
        context.clearRect(0, 0, canvas.width, canvas.height);
        updateMaskState();
      },
      undo: () => {
        const context = getContext();
        const current = snapshot();
        const previous = undoStackRef.current.pop();
        if (!context || !current || !previous) return;
        redoStackRef.current.push(current);
        context.putImageData(previous, 0, 0);
        updateMaskState();
      },
      redo: () => {
        const context = getContext();
        const current = snapshot();
        const next = redoStackRef.current.pop();
        if (!context || !current || !next) return;
        undoStackRef.current.push(current);
        context.putImageData(next, 0, 0);
        updateMaskState();
      },
      hasPaint: () => {
        const data = snapshot()?.data;
        if (!data) return false;
        for (let index = 3; index < data.length; index += 4) {
          if (data[index] > 8) return true;
        }
        return false;
      },
      applyBinaryMask: (data, width, height, mode) => {
        const canvas = canvasRef.current;
        const context = getContext();
        if (!canvas || !context || data.length < width * height) return;
        pushHistory();
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = width;
        maskCanvas.height = height;
        const maskContext = maskCanvas.getContext('2d');
        if (!maskContext) return;
        const pixels = maskContext.createImageData(width, height);
        for (let index = 0; index < width * height; index += 1) {
          const alpha = data[index];
          const offset = index * 4;
          pixels.data[offset] = 255;
          pixels.data[offset + 1] = 30;
          pixels.data[offset + 2] = 92;
          pixels.data[offset + 3] = alpha > 0 ? Math.max(80, Math.round(alpha * 0.76)) : 0;
        }
        maskContext.putImageData(pixels, 0, 0);
        if (mode === 'replace') context.clearRect(0, 0, canvas.width, canvas.height);
        context.globalCompositeOperation = mode === 'subtract' ? 'destination-out' : 'source-over';
        context.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
        context.globalCompositeOperation = 'source-over';
        updateMaskState();
      },
    }));

    const toCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = event.currentTarget;
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * (canvas.width / rect.width),
        y: (event.clientY - rect.top) * (canvas.height / rect.height),
      };
    };

    const prepareBrushContext = (context: CanvasRenderingContext2D) => {
      context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
      context.strokeStyle = 'rgba(255, 30, 92, 0.76)';
      context.fillStyle = 'rgba(255, 30, 92, 0.76)';
      context.lineWidth = brushSize;
      context.lineCap = 'round';
      context.lineJoin = 'round';
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (readOnly) return;
      const point = toCanvasPoint(event);

      if (tool === 'smart') {
        if (!smartReady || (event.button !== 0 && event.button !== 2)) return;
        event.preventDefault();
        onSmartPoint?.({
          x: point.x / event.currentTarget.width,
          y: point.y / event.currentTarget.height,
          label: event.button === 2 || event.altKey ? 0 : 1,
        }, event.ctrlKey || event.metaKey || event.altKey || event.button === 2);
        return;
      }

      if (event.button !== 0) return;
      const context = getContext();
      if (!context) return;
      pushHistory();
      drawingRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      lastPointRef.current = point;

      if (tool === 'rectangle') {
        setRectDraft({ start: point, end: point });
        return;
      }

      prepareBrushContext(context);
      context.beginPath();
      context.arc(point.x, point.y, brushSize / 2, 0, Math.PI * 2);
      context.fill();
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
      const point = toCanvasPoint(event);
      setCursor({ ...point, visible: true });
      if (!drawingRef.current || readOnly) return;
      if (tool === 'rectangle') {
        setRectDraft(current => current ? { ...current, end: point } : null);
        return;
      }
      const context = getContext();
      const last = lastPointRef.current;
      if (!context || !last) return;
      prepareBrushContext(context);
      context.beginPath();
      context.moveTo(last.x, last.y);
      context.lineTo(point.x, point.y);
      context.stroke();
      lastPointRef.current = point;
    };

    const handlePointerEnd = (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      const context = getContext();
      const draft = rectDraft;
      drawingRef.current = false;
      lastPointRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (tool === 'rectangle' && context && draft) {
        const x = Math.min(draft.start.x, draft.end.x);
        const y = Math.min(draft.start.y, draft.end.y);
        const width = Math.abs(draft.end.x - draft.start.x);
        const height = Math.abs(draft.end.y - draft.start.y);
        if (selectionMode === 'replace') context.clearRect(0, 0, event.currentTarget.width, event.currentTarget.height);
        context.globalCompositeOperation = selectionMode === 'subtract' ? 'destination-out' : 'source-over';
        context.fillStyle = 'rgba(255, 30, 92, 0.76)';
        context.fillRect(x, y, width, height);
        context.globalCompositeOperation = 'source-over';
        setRectDraft(null);
      }
      updateMaskState();
    };

    const cursorClass = readOnly
      ? 'cursor-default'
      : tool === 'rectangle' || tool === 'smart'
        ? 'cursor-crosshair'
        : 'cursor-none';

    return (
      <AdvancedRepaintViewport sourceWidth={sourceWidth} sourceHeight={sourceHeight} zoom={zoom} onZoomChange={onZoomChange}>
          <img src={sourceUrl} alt="高级重绘原图" className="absolute inset-0 h-full w-full select-none object-fill" draggable={false} />
          <canvas
            ref={canvasRef}
            className={cn('absolute inset-0 h-full w-full touch-none', cursorClass)}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onPointerLeave={() => setCursor(current => ({ ...current, visible: false }))}
            onPointerEnter={() => setCursor(current => ({ ...current, visible: true }))}
            onContextMenu={event => { if (tool === 'smart') event.preventDefault(); }}
          />

          {tool === 'smart' && smartMaskDataUrl && !readOnly && (
            <img src={smartMaskDataUrl} alt="智能识别候选选区" className="pointer-events-none absolute inset-0 h-full w-full object-fill" />
          )}

          {tool === 'smart' && !readOnly && smartPoints.map((point, index) => (
            <span
              key={`${point.x}-${point.y}-${index}`}
              className={cn(
                'pointer-events-none absolute flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white text-[10px] font-bold text-white shadow',
                point.label === 1 ? 'bg-emerald-500' : 'bg-rose-600',
              )}
              style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
            >
              {point.label === 1 ? '+' : '−'}
            </span>
          ))}

          {tool === 'rectangle' && rectDraft && !readOnly && (
            <div
              className="pointer-events-none absolute border-2 border-primary bg-primary/20"
              style={{
                left: `${(Math.min(rectDraft.start.x, rectDraft.end.x) / sourceWidth) * 100}%`,
                top: `${(Math.min(rectDraft.start.y, rectDraft.end.y) / sourceHeight) * 100}%`,
                width: `${(Math.abs(rectDraft.end.x - rectDraft.start.x) / sourceWidth) * 100}%`,
                height: `${(Math.abs(rectDraft.end.y - rectDraft.start.y) / sourceHeight) * 100}%`,
              }}
            />
          )}

          {readOnly && regions.map(region => (
            <button
              key={region.id}
              type="button"
              onClick={() => onSelectRegion?.(region.id)}
              className={cn(
                'absolute border-2 transition-colors',
                region.id === selectedRegionId
                  ? 'border-primary bg-primary/10 shadow-[0_0_0_2px_rgba(255,255,255,0.75)]'
                  : 'border-white/90 bg-black/5 hover:border-primary',
              )}
              style={{
                left: `${(region.cropBounds.x / sourceWidth) * 100}%`,
                top: `${(region.cropBounds.y / sourceHeight) * 100}%`,
                width: `${(region.cropBounds.width / sourceWidth) * 100}%`,
                height: `${(region.cropBounds.height / sourceHeight) * 100}%`,
              }}
              aria-label={`选择${region.name}`}
            >
              <span className="absolute -left-2 -top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground shadow-lg">
                {region.order + 1}
              </span>
            </button>
          ))}

          {!readOnly && cursor.visible && (tool === 'brush' || tool === 'eraser') && (
            <div
              className={cn(
                'pointer-events-none absolute rounded-full border shadow-sm',
                tool === 'eraser' ? 'border-white bg-black/15' : 'border-white bg-rose-500/25',
              )}
              style={{
                width: `${(brushSize / sourceWidth) * 100}%`,
                aspectRatio: '1',
                left: `${(cursor.x / sourceWidth) * 100}%`,
                top: `${(cursor.y / sourceHeight) * 100}%`,
                transform: 'translate(-50%, -50%)',
              }}
            />
          )}
      </AdvancedRepaintViewport>
    );
  },
);

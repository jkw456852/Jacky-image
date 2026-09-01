'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface AdvancedRepaintViewportProps {
  sourceWidth: number;
  sourceHeight: number;
  zoom: number;
  onZoomChange?: (zoom: number) => void;
  children: ReactNode;
  className?: string;
}

interface ViewportSize {
  width: number;
  height: number;
}

interface PanState {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
}

const VIEWPORT_PADDING = 32;
const MIN_ZOOM = 40;
const MAX_ZOOM = 240;
const WHEEL_ZOOM_STEP = 10;

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
}

export function calculateRepaintDisplayWidth(
  viewportWidth: number,
  viewportHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  zoom: number,
): number {
  if (viewportWidth <= 0 || viewportHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return 0;
  const availableWidth = Math.max(1, viewportWidth - VIEWPORT_PADDING);
  const availableHeight = Math.max(1, viewportHeight - VIEWPORT_PADDING);
  const fitWidth = Math.min(availableWidth, availableHeight * (sourceWidth / sourceHeight));
  return Math.max(1, fitWidth * (zoom / 100));
}

export function getRepaintWheelZoom(currentZoom: number, deltaY: number): number {
  if (deltaY === 0) return currentZoom;
  const direction = deltaY < 0 ? 1 : -1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom + direction * WHEEL_ZOOM_STEP));
}

export function AdvancedRepaintViewport({
  sourceWidth,
  sourceHeight,
  zoom,
  onZoomChange,
  children,
  className,
}: AdvancedRepaintViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef(false);
  const spacePressedRef = useRef(false);
  const panRef = useRef<PanState | null>(null);
  const [viewportSize, setViewportSize] = useState<ViewportSize | null>(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const [panning, setPanning] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateSize = () => {
      const next = { width: viewport.clientWidth, height: viewport.clientHeight };
      setViewportSize(current => current?.width === next.width && current.height === next.height ? current : next);
    };

    updateSize();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateSize);
      return () => window.removeEventListener('resize', updateSize);
    }

    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const releaseSpace = () => {
      spacePressedRef.current = false;
      panRef.current = null;
      setSpacePressed(false);
      setPanning(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || (isEditableTarget(event.target) && !hoveredRef.current)) return;
      spacePressedRef.current = true;
      setSpacePressed(true);
      if (hoveredRef.current) event.preventDefault();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') releaseSpace();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', releaseSpace);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', releaseSpace);
    };
  }, []);

  const displayWidth = useMemo(() => {
    if (!viewportSize || sourceWidth <= 0 || sourceHeight <= 0) return null;
    return calculateRepaintDisplayWidth(viewportSize.width, viewportSize.height, sourceWidth, sourceHeight, zoom);
  }, [sourceHeight, sourceWidth, viewportSize, zoom]);

  const handleWheel = useCallback((event: WheelEvent) => {
    if (!onZoomChange) return;
    event.preventDefault();
    event.stopPropagation();
    const nextZoom = getRepaintWheelZoom(zoom, event.deltaY);
    if (nextZoom !== zoom) onZoomChange(nextZoom);
  }, [onZoomChange, zoom]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !onZoomChange) return;
    frame.addEventListener('wheel', handleWheel, { passive: false });
    return () => frame.removeEventListener('wheel', handleWheel);
  }, [handleWheel, onZoomChange]);

  const handlePointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !spacePressedRef.current) return;
    const viewport = event.currentTarget;
    event.preventDefault();
    event.stopPropagation();
    viewport.setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    setPanning(true);
  }, []);

  const handlePointerMoveCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
    event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
  }, []);

  const finishPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    panRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <div
      ref={viewportRef}
      className={cn(
        'relative h-[clamp(420px,58dvh,640px)] min-h-0 overflow-auto rounded-2xl bg-[radial-gradient(circle_at_center,rgba(148,163,184,0.12),transparent_65%)] overscroll-contain',
        spacePressed && (panning ? '[&_*]:!cursor-grabbing' : '[&_*]:!cursor-grab'),
        className,
      )}
      onMouseEnter={() => { hoveredRef.current = true; }}
      onMouseLeave={() => { hoveredRef.current = false; }}
      onPointerDownCapture={handlePointerDownCapture}
      onPointerMoveCapture={handlePointerMoveCapture}
      onPointerUpCapture={finishPan}
      onPointerCancelCapture={finishPan}
      title="鼠标滚轮缩放；按住空格并用鼠标左键拖动画布"
    >
      <div className="flex h-max min-h-full w-max min-w-full items-center justify-center p-4">
        <div
          ref={frameRef}
          className="relative shrink-0 overflow-hidden rounded-xl border border-border/80 bg-black shadow-2xl shadow-black/10"
          style={{
            width: displayWidth ? displayWidth + 'px' : zoom + '%',
            maxWidth: displayWidth ? 'none' : '960px',
            aspectRatio: sourceWidth + ' / ' + sourceHeight,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

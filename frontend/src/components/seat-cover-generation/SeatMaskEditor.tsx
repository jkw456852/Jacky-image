'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Brush, Check, ChevronLeft, ChevronRight, Eraser, Loader2, MousePointer2, Redo2, ScanSearch, SquareDashed, Trash2, Undo2, X } from 'lucide-react';
import { AdvancedRepaintCanvas, type AdvancedRepaintCanvasHandle, type SmartSelectionPoint } from '@/components/advanced-repaint/AdvancedRepaintCanvas';
import { Button } from '@/components/ui/button';
import type { RepaintTool } from '@/components/advanced-repaint/types';
import type { SeatCoverScope } from './types';

interface SeatMaskEditorProps {
  sourceUrl: string;
  scope: SeatCoverScope;
  initialMaskDataUrl?: string;
  onCancel: () => void;
  onSave: (maskDataUrl: string) => void;
}

type SmartMaskCandidate = {
  data: Uint8Array;
  score: number;
  pixelCount: number;
};

type SmartMaskState = {
  data: Uint8Array;
  width: number;
  height: number;
  previewUrl: string;
  candidates: SmartMaskCandidate[];
  candidateIndex: number;
};

type SmartWorkerMessage =
  | { type: 'status'; status: string; progress?: number }
  | { type: 'ready'; device: string }
  | { type: 'analyzed'; width: number; height: number }
  | { type: 'mask'; width: number; height: number; defaultIndex: number; candidates: Array<{ data: ArrayBuffer; score?: number; pixelCount?: number }> }
  | { type: 'error'; message: string };

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('底图读取失败'));
    image.src = source;
  });
}

async function readPixels(source: string) {
  const image = await loadImage(source);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法读取座椅底图');
  context.drawImage(image, 0, 0, width, height);
  return { width, height, rgba: context.getImageData(0, 0, width, height).data.buffer };
}

async function maskDataUrlToBinary(dataUrl: string): Promise<{ data: Uint8Array; width: number; height: number }> {
  const image = await loadImage(dataUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法读取座椅蒙版');
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const output = new Uint8Array(width * height);
  let hasTransparency = false;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] < 250) { hasTransparency = true; break; }
  }
  for (let index = 0; index < output.length; index += 1) {
    const offset = index * 4;
    output[index] = hasTransparency ? pixels[offset + 3] : Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
  }
  return { data: output, width, height };
}

function maskImageDataToDataUrl(imageData: ImageData): string {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法导出座椅蒙版');
  const output = context.createImageData(imageData.width, imageData.height);
  for (let index = 0; index < imageData.width * imageData.height; index += 1) {
    const offset = index * 4;
    const selected = imageData.data[offset + 3] > 8 ? 255 : 0;
    output.data[offset] = selected;
    output.data[offset + 1] = selected;
    output.data[offset + 2] = selected;
    output.data[offset + 3] = 255;
  }
  context.putImageData(output, 0, 0);
  return canvas.toDataURL('image/png');
}

function createSmartMaskPreview(data: Uint8Array, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const pixels = context.createImageData(width, height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    pixels.data[offset] = 34;
    pixels.data[offset + 1] = 197;
    pixels.data[offset + 2] = 94;
    pixels.data[offset + 3] = data[index] > 0 ? 150 : 0;
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

function seatSeeds(scope: SeatCoverScope): Array<{ x: number; y: number; label: 1 }> {
  const front = [{ x: 0.34, y: 0.60, label: 1 as const }, { x: 0.66, y: 0.60, label: 1 as const }];
  const rear = [{ x: 0.28, y: 0.68, label: 1 as const }, { x: 0.50, y: 0.68, label: 1 as const }, { x: 0.72, y: 0.68, label: 1 as const }];
  return scope === 'front' ? front : scope === 'rear' ? rear : [...front, ...rear];
}

function waitForWorker<T extends SmartWorkerMessage['type']>(
  worker: Worker,
  expected: T,
  onStatus: (message: string) => void,
): Promise<Extract<SmartWorkerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent<SmartWorkerMessage>) => {
      const message = event.data;
      if (message.type === 'status') {
        onStatus(message.progress == null ? message.status : `${message.status} ${Math.round(message.progress)}%`);
        return;
      }
      if (message.type === 'error') {
        worker.removeEventListener('message', handler);
        reject(new Error(message.message));
        return;
      }
      if (message.type !== expected) return;
      worker.removeEventListener('message', handler);
      resolve(message as Extract<SmartWorkerMessage, { type: T }>);
    };
    worker.addEventListener('message', handler);
  });
}

export function SeatMaskEditor({ sourceUrl, scope, initialMaskDataUrl, onCancel, onSave }: SeatMaskEditorProps) {
  const canvasRef = useRef<AdvancedRepaintCanvasHandle>(null);
  const smartWorkerRef = useRef<Worker | null>(null);
  const smartReadyPromiseRef = useRef<Promise<Worker> | null>(null);
  const smartAnalyzedSourceRef = useRef<string | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState<RepaintTool>('brush');
  const [brushSize, setBrushSize] = useState(72);
  const [zoom, setZoom] = useState(100);
  const [hasMask, setHasMask] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [smartBusy, setSmartBusy] = useState(false);
  const [smartReady, setSmartReady] = useState(false);
  const [smartPoints, setSmartPoints] = useState<SmartSelectionPoint[]>([]);
  const [smartMask, setSmartMask] = useState<SmartMaskState | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let cancelled = false;
    void loadImage(sourceUrl).then(image => {
      if (!cancelled) setDimensions({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
    }).catch(error => setStatus(error instanceof Error ? error.message : '底图读取失败'));
    return () => { cancelled = true; };
  }, [sourceUrl]);

  useEffect(() => () => {
    smartWorkerRef.current?.terminate();
    smartWorkerRef.current = null;
    smartReadyPromiseRef.current = null;
    smartAnalyzedSourceRef.current = null;
  }, [sourceUrl]);

  useEffect(() => {
    if (!initialMaskDataUrl || dimensions.width <= 0) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void maskDataUrlToBinary(initialMaskDataUrl).then(mask => {
        if (!cancelled) canvasRef.current?.applyBinaryMask(mask.data, mask.width, mask.height, 'replace');
      }).catch(error => setStatus(error instanceof Error ? error.message : '蒙版恢复失败'));
    }, 50);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [dimensions.width, initialMaskDataUrl]);

  const ensureSmartAnalyzed = useCallback(async (): Promise<Worker> => {
    let worker = smartWorkerRef.current;
    if (!worker) {
      worker = new Worker(new URL('../advanced-repaint/sam-selection.worker.ts', import.meta.url), { type: 'module' });
      smartWorkerRef.current = worker;
      const ready = waitForWorker(worker, 'ready', setStatus).then(() => worker!);
      smartReadyPromiseRef.current = ready;
      worker.postMessage({ type: 'load' });
    }

    try {
      await smartReadyPromiseRef.current;
      if (smartAnalyzedSourceRef.current !== sourceUrl) {
        setStatus('正在分析当前底图…');
        const pixels = await readPixels(sourceUrl);
        const analyzed = waitForWorker(worker, 'analyzed', setStatus);
        worker.postMessage({ type: 'analyze', ...pixels }, [pixels.rgba]);
        await analyzed;
        smartAnalyzedSourceRef.current = sourceUrl;
      }
      setSmartReady(true);
      return worker;
    } catch (error) {
      worker.terminate();
      smartWorkerRef.current = null;
      smartReadyPromiseRef.current = null;
      smartAnalyzedSourceRef.current = null;
      setSmartReady(false);
      throw error;
    }
  }, [sourceUrl]);

  const clearSmartCandidate = useCallback(() => {
    setSmartMask(null);
    setSmartPoints([]);
    setSmartBusy(false);
  }, []);

  const beginSmartSelection = useCallback(() => {
    setTool('smart');
    clearSmartCandidate();
    setSmartBusy(true);
    setStatus('正在准备点击式智能选区…');
    void ensureSmartAnalyzed()
      .then(() => setStatus('智能选区已就绪：左键点击漏选的座椅，Ctrl 补点，Alt 或右键排除。'))
      .catch(error => setStatus(error instanceof Error ? error.message : '智能选区加载失败'))
      .finally(() => setSmartBusy(false));
  }, [clearSmartCandidate, ensureSmartAnalyzed]);

  const autoDetect = async () => {
    setDetecting(true);
    setSmartBusy(true);
    setStatus('正在加载智能识别模型…');
    try {
      const worker = await ensureSmartAnalyzed();
      let union: Uint8Array | null = null;
      let width = dimensions.width;
      let height = dimensions.height;
      const seeds = seatSeeds(scope);
      for (let index = 0; index < seeds.length; index += 1) {
        setStatus(`正在识别座椅 ${index + 1}/${seeds.length}…`);
        const response = waitForWorker(worker, 'mask', setStatus);
        worker.postMessage({ type: 'segment', points: [seeds[index]] });
        const result = await response;
        const candidate = result.candidates[result.defaultIndex] || result.candidates[0];
        if (!candidate) continue;
        const current = new Uint8Array(candidate.data);
        width = result.width;
        height = result.height;
        if (!union || union.length !== current.length) union = new Uint8Array(current.length);
        for (let pixel = 0; pixel < current.length; pixel += 1) {
          if (current[pixel] > union[pixel]) union[pixel] = current[pixel];
        }
      }
      if (!union) throw new Error('没有识别到座椅区域，请使用智能补选或画笔手动涂抹');
      canvasRef.current?.applyBinaryMask(union, width, height, 'replace');
      setTool('smart');
      clearSmartCandidate();
      setStatus('自动识别已应用。可继续左键点击漏选座椅进行智能补选，Alt 或右键点击可修正边界。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '座椅识别失败，请使用智能补选或手动涂抹');
    } finally {
      setDetecting(false);
      setSmartBusy(false);
    }
  };

  const handleSmartPoint = useCallback((point: SmartSelectionPoint, refineCurrent: boolean) => {
    if (!smartReady || smartBusy) return;
    if (smartMask && !refineCurrent) {
      canvasRef.current?.applyBinaryMask(smartMask.data, smartMask.width, smartMask.height, 'add');
    }
    const nextPoints = smartMask && !refineCurrent ? [point] : [...smartPoints, point];
    setSmartMask(null);
    setSmartPoints(nextPoints);
    setSmartBusy(true);
    setStatus(point.label === 0 ? '正在使用排除点修正智能选区…' : '正在识别点击的座椅或部件…');
    void ensureSmartAnalyzed().then(async worker => {
      const response = waitForWorker(worker, 'mask', setStatus);
      worker.postMessage({ type: 'segment', points: nextPoints });
      const result = await response;
      const candidates: SmartMaskCandidate[] = result.candidates.map(candidate => ({
        data: new Uint8Array(candidate.data),
        score: candidate.score || 0,
        pixelCount: candidate.pixelCount || 0,
      }));
      if (!candidates.length) throw new Error('没有识别到可用对象，请换一个位置点击');
      const candidateIndex = Math.min(candidates.length - 1, Math.max(0, result.defaultIndex));
      const selected = candidates[candidateIndex];
      setSmartMask({
        data: selected.data,
        width: result.width,
        height: result.height,
        previewUrl: createSmartMaskPreview(selected.data, result.width, result.height),
        candidates,
        candidateIndex,
      });
      setStatus('已识别对象：可继续 Ctrl 补点或 Alt/右键排除，也可将当前选区加入/移出蒙版。');
    }).catch(error => {
      setSmartPoints([]);
      setStatus(error instanceof Error ? error.message : '智能选区识别失败');
    }).finally(() => setSmartBusy(false));
  }, [ensureSmartAnalyzed, smartBusy, smartMask, smartPoints, smartReady]);

  const applySmartCandidate = useCallback((mode: 'add' | 'subtract') => {
    if (!smartMask) return;
    canvasRef.current?.applyBinaryMask(smartMask.data, smartMask.width, smartMask.height, mode);
    setSmartMask(null);
    setSmartPoints([]);
    setStatus(mode === 'add' ? '智能选区已加入蒙版，可继续点击其他漏选区域。' : '智能选区已从蒙版移除，可继续修正。');
  }, [smartMask]);

  const changeSmartCandidateScale = useCallback((delta: number) => {
    if (!smartMask || smartMask.candidates.length < 2) return;
    const candidateIndex = Math.min(smartMask.candidates.length - 1, Math.max(0, smartMask.candidateIndex + delta));
    if (candidateIndex === smartMask.candidateIndex) return;
    const selected = smartMask.candidates[candidateIndex];
    setSmartMask({
      ...smartMask,
      data: selected.data,
      previewUrl: createSmartMaskPreview(selected.data, smartMask.width, smartMask.height),
      candidateIndex,
    });
  }, [smartMask]);

  const selectTool = (nextTool: RepaintTool) => {
    if (nextTool === 'smart') {
      beginSmartSelection();
      return;
    }
    setTool(nextTool);
    clearSmartCandidate();
  };

  const save = () => {
    const imageData = canvasRef.current?.getMaskImageData();
    if (!imageData || !canvasRef.current?.hasPaint()) {
      setStatus('请先识别或涂抹座椅区域');
      return;
    }
    onSave(maskImageDataToDataUrl(imageData));
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/75 p-3" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="flex max-h-[96dvh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div><h3 className="font-semibold">座椅区域蒙版</h3><p className="text-xs text-muted-foreground">自动识别后可继续点击漏选座椅做智能补选，也可用画笔、橡皮擦修正；滚轮缩放，空格 + 左键拖动画布。</p></div>
          <button type="button" onClick={onCancel} className="rounded-full p-2 hover:bg-muted" aria-label="关闭"><X className="size-5" /></button>
        </header>
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <Button size="sm" variant="outline" onClick={() => void autoDetect()} disabled={detecting || smartBusy}>{detecting ? <Loader2 className="size-4 animate-spin" /> : <ScanSearch className="size-4" />}自动识别座椅</Button>
          <Button size="sm" variant={tool === 'smart' ? 'default' : 'outline'} onClick={beginSmartSelection} disabled={detecting || smartBusy}><MousePointer2 className="size-4" />智能补选</Button>
          <Button size="sm" variant={tool === 'brush' ? 'default' : 'outline'} onClick={() => selectTool('brush')}><Brush className="size-4" />补涂</Button>
          <Button size="sm" variant={tool === 'eraser' ? 'default' : 'outline'} onClick={() => selectTool('eraser')}><Eraser className="size-4" />擦除</Button>
          <Button size="sm" variant={tool === 'rectangle' ? 'default' : 'outline'} onClick={() => selectTool('rectangle')}><SquareDashed className="size-4" />矩形</Button>
          <label className="ml-1 flex items-center gap-2 text-xs text-muted-foreground">画笔大小<input type="range" min="8" max="240" value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} /></label>
          <Button size="icon-sm" variant="ghost" onClick={() => canvasRef.current?.undo()} title="撤销"><Undo2 className="size-4" /></Button>
          <Button size="icon-sm" variant="ghost" onClick={() => canvasRef.current?.redo()} title="重做"><Redo2 className="size-4" /></Button>
          <Button size="sm" variant="ghost" onClick={() => canvasRef.current?.clear()}><Trash2 className="size-4" />清空</Button>
          {status && <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">{status}</span>}
        </div>
        {tool === 'smart' && <div className="flex flex-wrap items-center gap-2 border-b bg-muted/35 px-4 py-2 text-xs text-muted-foreground">
          <span>左键点击对象；Ctrl/⌘ + 左键补充识别点；Alt + 左键或右键点击排除区域。</span>
          {smartBusy && <Loader2 className="size-4 animate-spin" />}
          {smartMask && <>
            {smartMask.candidates.length > 1 && <div className="ml-auto flex items-center gap-1"><Button size="icon-sm" variant="outline" disabled={smartMask.candidateIndex === 0} onClick={() => changeSmartCandidateScale(-1)} title="缩小识别范围"><ChevronLeft className="size-4" /></Button><span className="min-w-20 text-center">对象尺度 {smartMask.candidateIndex + 1}/{smartMask.candidates.length}</span><Button size="icon-sm" variant="outline" disabled={smartMask.candidateIndex === smartMask.candidates.length - 1} onClick={() => changeSmartCandidateScale(1)} title="扩大识别范围"><ChevronRight className="size-4" /></Button></div>}
            <Button size="sm" onClick={() => applySmartCandidate('add')}><Check className="size-4" />加入蒙版</Button>
            <Button size="sm" variant="outline" onClick={() => applySmartCandidate('subtract')}><Eraser className="size-4" />移出蒙版</Button>
            <Button size="sm" variant="ghost" onClick={clearSmartCandidate}>取消本次识别</Button>
          </>}
        </div>}
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {dimensions.width > 0 ? <AdvancedRepaintCanvas
            ref={canvasRef}
            sourceUrl={sourceUrl}
            sourceWidth={dimensions.width}
            sourceHeight={dimensions.height}
            tool={tool}
            selectionMode="add"
            brushSize={brushSize}
            zoom={zoom}
            onZoomChange={setZoom}
            smartMaskDataUrl={smartMask?.previewUrl}
            smartPoints={smartPoints}
            smartReady={smartReady && !smartBusy}
            onSmartPoint={handleSmartPoint}
            onMaskChange={setHasMask}
          /> : <div className="flex h-[50dvh] items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />正在读取底图…</div>}
        </div>
        <footer className="flex items-center justify-between gap-3 border-t px-4 py-3"><span className="text-xs text-muted-foreground">{hasMask ? '已设置可重绘区域' : '尚未设置可重绘区域'}</span><div className="flex gap-2"><Button variant="outline" onClick={onCancel}>取消</Button><Button onClick={save} disabled={!hasMask}><Check className="size-4" />保存蒙版</Button></div></footer>
      </div>
    </div>
  );
}

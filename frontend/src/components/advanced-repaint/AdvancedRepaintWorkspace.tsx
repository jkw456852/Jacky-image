'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Brush, Check, Crop, Download, Eraser, Eye, EyeOff, Loader2, Minus, Move, Plus,
  Redo2, RotateCcw, ScanLine, ScanSearch, Sparkles, Thermometer, Trash2, Undo2, Upload, WandSparkles,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { GeminiSearchGroundingControl } from '@/components/GeminiSearchGroundingControl';
import { GptImageAdvancedParamsControl } from '@/components/GptImageAdvancedParamsControl';
import { HistoryImagePreview } from '@/components/workspace/results/HistoryImagePreview';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import {
  DEFAULT_GPT_IMAGE_ADVANCED_PARAMS,
  findReferenceCapableModel,
  getGptImageAdvancedParamsForModel,
  getModelMaxRefImages,
  getSupportsTemperature,
  supportsGptImageAdvancedParams,
  supportsImageSearchGrounding,
  supportsWebSearchGrounding,
  type GptImageAdvancedParams,
} from '@/lib/model-capabilities';
import { getModelOptions, type ModelId, type ModelOption } from '@/lib/gemini-config';
import { generateUUID } from '@/lib/uuid';
import { cn } from '@/lib/utils';
import { getClipboardImageFiles } from '@/lib/clipboard-image';
import {
  clearDesktopTaskSource,
  publishDesktopTaskSource,
  type DesktopTaskStatus,
  type DesktopTaskSummary,
} from '@/lib/desktop-task-status';
import { AdvancedRepaintCanvas, type AdvancedRepaintCanvasHandle, type SmartSelectionPoint } from './AdvancedRepaintCanvas';
import { AdvancedRepaintCompositeEditor, type RepaintCompositeEditTool } from './AdvancedRepaintCompositeEditor';
import { AdvancedRepaintReferencePicker } from './AdvancedRepaintReferencePicker';
import { AdvancedRepaintViewport } from './AdvancedRepaintViewport';
import { composeRepaintResult, createRegionAssets, detectMaskComponents, getCommittableRepaintRegions, getRepaintCompositionKey, hasDiscardableRepaintWork, loadRepaintImage } from './advanced-repaint-utils';
import { generateAdvancedRepaintRegion, type AdvancedRepaintGenerationParams } from './advanced-repaint-service';
import type { RepaintReferenceImage, RepaintRegion, RepaintSelectionMode, RepaintTool } from './types';

const ADVANCED_REPAINT_TASK_SOURCE = 'advanced-repaint';

interface AdvancedRepaintWorkspaceProps {
  wideMode?: boolean;
  hasApiKey: boolean;
  onConfigureApiKey: () => void;
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void;
  initialSourceDataUrl?: string;
  initialSourceFileName?: string;
  initialReferences?: RepaintReferenceImage[];
  onApplyResult?: (dataUrl: string) => void;
}

export type RepaintParams = {
  model: ModelId;
  temperature: number;
  webSearchEnabled: boolean;
  imageSearchEnabled: boolean;
  parallelCount: 1 | 2 | 3 | 4;
  gptImageAdvancedParams: GptImageAdvancedParams;
};

type SmartSelectionStatus = 'idle' | 'loading' | 'analyzing' | 'ready' | 'segmenting' | 'error';

type SmartMaskCandidate = {
  data: Uint8Array;
  score: number;
  pixelCount: number;
  removedPixels: number;
  filledHolePixels: number;
};

type SmartMaskState = {
  data: Uint8Array;
  width: number;
  height: number;
  score: number;
  previewUrl: string;
  candidates: SmartMaskCandidate[];
  candidateIndex: number;
};

function smartCandidateStatus(candidate: SmartMaskCandidate) {
  const cleanupSummary = [
    candidate.removedPixels > 0 ? `清除 ${candidate.removedPixels.toLocaleString()} 个噪点` : '',
    candidate.filledHolePixels > 0 ? `填补 ${candidate.filledHolePixels.toLocaleString()} 个孔洞像素` : '',
  ].filter(Boolean).join('，');
  const multipartHint = candidate.removedPixels > Math.max(256, candidate.pixelCount * 0.08)
    ? '；若头枕等分离部件未选中，请 Ctrl 点击补全'
    : '';
  return cleanupSummary
    ? `已精修：${cleanupSummary}；可调整对象尺度${multipartHint}`
    : `已按物体边界识别；可调整对象尺度，Ctrl 补选，Alt/右键排除`;
}

type SmartWorkerMessage =
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

const DEFAULT_PARAMS: RepaintParams = {
  model: 'gemini-3-pro-image-preview' as ModelId,
  temperature: 0.35,
  webSearchEnabled: false,
  imageSearchEnabled: false,
  parallelCount: 1,
  gptImageAdvancedParams: DEFAULT_GPT_IMAGE_ADVANCED_PARAMS,
};

export function getRepaintModelOptions(): ModelOption[] {
  return getModelOptions().filter(option => getModelMaxRefImages(option.value) > 0);
}

export function normalizeRepaintParamsForModel(current: RepaintParams, model: ModelId): RepaintParams {
  return {
    ...current,
    model,
    webSearchEnabled: supportsWebSearchGrounding(model) && current.webSearchEnabled,
    imageSearchEnabled: supportsImageSearchGrounding(model) && current.imageSearchEnabled,
    gptImageAdvancedParams: getGptImageAdvancedParamsForModel(model, current.gptImageAdvancedParams),
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

async function createSmartImagePixels(sourceUrl: string) {
  const image = await loadRepaintImage(sourceUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法读取智能选区图片');
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  return { width, height, rgba: pixels.data.buffer };
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
    pixels.data[offset] = 255;
    pixels.data[offset + 1] = 30;
    pixels.data[offset + 2] = 92;
    pixels.data[offset + 3] = data[index] > 0 ? 145 : 0;
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

function statusLabel(region: RepaintRegion) {
  if (region.status === 'completed') return '已完成';
  if (region.status === 'failed') return '失败';
  if (region.status === 'queued') return '排队中';
  if (region.status === 'generating') return region.statusText || '生成中';
  return region.prompt.trim() ? '可生成' : '待填写';
}

export function AdvancedRepaintWorkspace({
  wideMode = false,
  hasApiKey,
  onConfigureApiKey,
  showToast,
  initialSourceDataUrl,
  initialSourceFileName = '座套候选结果.png',
  initialReferences = [],
  onApplyResult,
}: AdvancedRepaintWorkspaceProps) {
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<AdvancedRepaintCanvasHandle>(null);
  const smartWorkerRef = useRef<Worker | null>(null);
  const smartAnalyzedSourceRef = useRef<string | null>(null);
  const [sourceFileName, setSourceFileName] = useState(initialSourceDataUrl ? initialSourceFileName : '');
  const [sourceDataUrl, setSourceDataUrl] = useState<string | null>(initialSourceDataUrl || null);
  const [sourceDragOver, setSourceDragOver] = useState(false);
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState<RepaintTool>('brush');
  const [selectionMode, setSelectionMode] = useState<RepaintSelectionMode>('add');
  const [smartStatus, setSmartStatus] = useState<SmartSelectionStatus>('idle');
  const [smartStatusText, setSmartStatusText] = useState('');
  const [smartProgress, setSmartProgress] = useState<number>();
  const [smartPoints, setSmartPoints] = useState<SmartSelectionPoint[]>([]);
  const [smartMask, setSmartMask] = useState<SmartMaskState | null>(null);
  const [brushSize, setBrushSize] = useState(72);
  const [zoom, setZoom] = useState(100);
  const [hasMask, setHasMask] = useState(false);
  const [regions, setRegions] = useState<RepaintRegion[]>([]);
  const [selectedRegionId, setSelectedRegionId] = useState<string>();
  const [analyzing, setAnalyzing] = useState(false);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [mergeGap, setMergeGap] = useState(5);
  const [paddingRatio, setPaddingRatio] = useState(0.22);
  const [blendRadius, setBlendRadius] = useState(3);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(() => getRepaintModelOptions());
  const [temperatureOpen, setTemperatureOpen] = useState(false);
  const [params, setParams] = useState<RepaintParams>(() => {
    const options = getRepaintModelOptions();
    const model = findReferenceCapableModel(DEFAULT_PARAMS.model) || options[0]?.value || DEFAULT_PARAMS.model;
    return normalizeRepaintParamsForModel(DEFAULT_PARAMS, model);
  });
  const [resultDataUrl, setResultDataUrl] = useState<string | null>(null);
  const [compositing, setCompositing] = useState(false);
  const [previewMode, setPreviewMode] = useState<'mask' | 'result' | 'original'>('mask');
  const [compositeEditTool, setCompositeEditTool] = useState<RepaintCompositeEditTool | null>(null);
  const [compositeBrushSize, setCompositeBrushSize] = useState(48);
  const [referencePreview, setReferencePreview] = useState<{
    images: string[];
    alt: string;
    initialIndex: number;
  } | null>(null);
  const [discardRepaintDialogOpen, setDiscardRepaintDialogOpen] = useState(false);

  const selectedRegion = useMemo(
    () => regions.find(region => region.id === selectedRegionId) || regions[0],
    [regions, selectedRegionId],
  );
  const hasCompletedRegion = getCommittableRepaintRegions(regions).length > 0;
  const anyGenerating = regions.some(region => region.status === 'queued' || region.status === 'generating');
  const compositionKey = useMemo(() => getRepaintCompositionKey(regions), [regions]);
  const desktopRepaintTasks = useMemo<DesktopTaskSummary[]>(() => regions.flatMap(region => {
    if (region.status === 'ready') return [];
    const status: DesktopTaskStatus = region.status === 'generating' ? 'processing' : region.status;
    return [{
      id: `advanced-repaint:${region.id}`,
      status,
      title: `高级重绘 · ${region.name || `区域 ${region.order + 1}`}`,
      detail: region.status === 'failed' ? region.error || region.prompt : region.prompt,
    }];
  }), [regions]);

  useEffect(() => {
    publishDesktopTaskSource(ADVANCED_REPAINT_TASK_SOURCE, desktopRepaintTasks);
  }, [desktopRepaintTasks]);

  useEffect(() => () => clearDesktopTaskSource(ADVANCED_REPAINT_TASK_SOURCE), []);

  const updateRegion = useCallback((regionId: string, patch: Partial<RepaintRegion>) => {
    setRegions(current => current.map(region => region.id === regionId ? { ...region, ...patch } : region));
  }, []);

  useEffect(() => {
    const refreshModels = () => {
      const options = getRepaintModelOptions();
      setModelOptions(options);
      setParams(current => {
        if (options.some(option => option.value === current.model)) return current;
        const model = findReferenceCapableModel(current.model) || options[0]?.value || current.model;
        return normalizeRepaintParamsForModel(current, model);
      });
    };
    window.addEventListener('jacky-model-registry-updated', refreshModels);
    return () => window.removeEventListener('jacky-model-registry-updated', refreshModels);
  }, []);

  const clearSmartCandidate = useCallback(() => {
    setSmartPoints([]);
    setSmartMask(null);
    setSmartStatus(current => current === 'error' ? 'idle' : current);
  }, []);

  useEffect(() => {
    if (!initialSourceDataUrl) return;
    let cancelled = false;
    void loadRepaintImage(initialSourceDataUrl).then(image => {
      if (!cancelled) setSourceSize({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
    }).catch(error => {
      if (!cancelled) showToast?.(error instanceof Error ? error.message : '座套候选图读取失败', 'error');
    });
    return () => { cancelled = true; };
  }, [initialSourceDataUrl, initialSourceFileName, showToast]);

  useEffect(() => {
    const worker = new Worker(new URL('./sam-selection.worker.ts', import.meta.url), { type: 'module' });
    smartWorkerRef.current = worker;
    worker.onmessage = (event: MessageEvent<SmartWorkerMessage>) => {
      const message = event.data;
      if (message.type === 'status') {
        setSmartStatus(message.status.includes('分析') ? 'analyzing' : 'loading');
        setSmartStatusText(message.status);
        setSmartProgress(message.progress);
      }
      if (message.type === 'ready') {
        setSmartStatusText(message.device === 'webgpu' ? '智能模型已使用 WebGPU 加速' : '智能模型已使用兼容模式');
      }
      if (message.type === 'analyzed') {
        smartAnalyzedSourceRef.current = sourceDataUrl;
        setSmartStatus('ready');
        setSmartStatusText('图片分析完成，点击物体即可识别选区');
        setSmartProgress(undefined);
      }
      if (message.type === 'mask') {
        const candidates = message.candidates.map(candidate => ({
          data: new Uint8Array(candidate.data),
          score: candidate.score,
          pixelCount: candidate.pixelCount,
          removedPixels: candidate.removedPixels,
          filledHolePixels: candidate.filledHolePixels,
        }));
        const candidateIndex = Math.min(Math.max(0, message.defaultIndex), Math.max(0, candidates.length - 1));
        const selected = candidates[candidateIndex];
        if (!selected) {
          setSmartStatus('error');
          setSmartStatusText('智能模型没有返回有效选区');
          return;
        }
        setSmartMask({
          data: selected.data,
          width: message.width,
          height: message.height,
          score: selected.score,
          previewUrl: createSmartMaskPreview(selected.data, message.width, message.height),
          candidates,
          candidateIndex,
        });
        setSmartStatus('ready');
        setSmartStatusText(smartCandidateStatus(selected));
      }
      if (message.type === 'error') {
        setSmartStatus('error');
        setSmartStatusText(message.message);
      }
    };
    return () => {
      worker.terminate();
      if (smartWorkerRef.current === worker) smartWorkerRef.current = null;
    };
  }, [sourceDataUrl]);

  useEffect(() => {
    if (!sourceDataUrl || !hasCompletedRegion) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setCompositing(true);
      void composeRepaintResult(sourceDataUrl, regions, blendRadius)
        .then(async result => {
          await loadRepaintImage(result);
          return result;
        })
        .then(result => {
          if (!cancelled) {
            setResultDataUrl(result);
            setPreviewMode('result');
          }
        })
        .catch(error => { if (!cancelled) showToast?.(error instanceof Error ? error.message : '结果合成失败', 'error'); })
        .finally(() => { if (!cancelled) setCompositing(false); });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  // Region prompts, names, references and generation status do not affect the composed pixels.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blendRadius, compositionKey, hasCompletedRegion, showToast, sourceDataUrl]);

  const beginSmartSelection = useCallback(() => {
    setTool('smart');
    setSmartPoints([]);
    setSmartMask(null);
    if (!sourceDataUrl) return;
    if (smartAnalyzedSourceRef.current === sourceDataUrl) {
      setSmartStatus('ready');
      setSmartStatusText('图片分析完成，点击物体即可识别选区');
      return;
    }
    const worker = smartWorkerRef.current;
    if (!worker) {
      setSmartStatus('error');
      setSmartStatusText('智能选区服务尚未就绪，请稍后重试');
      return;
    }
    setSmartStatus('analyzing');
    setSmartStatusText('正在读取图片像素…');
    void createSmartImagePixels(sourceDataUrl)
      .then(payload => {
        // The RGBA buffer is transferred instead of copied and avoids fetching
        // a data: URL inside the worker (blocked by the desktop CSP).
        worker.postMessage({ type: 'analyze', ...payload }, [payload.rgba]);
      })
      .catch(error => {
        setSmartStatus('error');
        setSmartStatusText(error instanceof Error ? error.message : '智能选区读取图片失败');
      });
  }, [sourceDataUrl]);

  const applySmartCandidate = useCallback((mode: RepaintSelectionMode = selectionMode) => {
    if (!smartMask) return false;
    canvasRef.current?.applyBinaryMask(smartMask.data, smartMask.width, smartMask.height, mode);
    setSmartPoints([]);
    setSmartMask(null);
    setSmartStatusText('选区已应用，可继续点击其他物体');
    return true;
  }, [selectionMode, smartMask]);

  const changeSmartCandidateScale = useCallback((delta: number) => {
    if (!smartMask || smartMask.candidates.length < 2) return;
    const candidateIndex = Math.min(
      smartMask.candidates.length - 1,
      Math.max(0, smartMask.candidateIndex + delta),
    );
    if (candidateIndex === smartMask.candidateIndex) return;
    const selected = smartMask.candidates[candidateIndex];
    setSmartStatusText(smartCandidateStatus(selected));
    setSmartMask({
      ...smartMask,
      data: selected.data,
      score: selected.score,
      previewUrl: createSmartMaskPreview(selected.data, smartMask.width, smartMask.height),
      candidateIndex,
    });
  }, [smartMask]);

  const handleSmartPoint = useCallback((point: SmartSelectionPoint, refineCurrent: boolean) => {
    const worker = smartWorkerRef.current;
    if (!worker || smartStatus !== 'ready') return;
    if (smartMask && !refineCurrent) {
      canvasRef.current?.applyBinaryMask(smartMask.data, smartMask.width, smartMask.height, selectionMode);
    }
    const nextPoints = smartMask && !refineCurrent ? [point] : [...smartPoints, point];
    setSmartMask(null);
    setSmartPoints(nextPoints);
    setSmartStatus('segmenting');
    setSmartStatusText(point.label === 0 ? '正在使用排除点修正边界…' : '正在识别点击的物体…');
    worker.postMessage({ type: 'segment', points: nextPoints });
  }, [selectionMode, smartMask, smartPoints, smartStatus]);

  const selectTool = useCallback((nextTool: RepaintTool) => {
    if (nextTool === 'smart') {
      beginSmartSelection();
      return;
    }
    setTool(nextTool);
    clearSmartCandidate();
  }, [beginSmartSelection, clearSmartCandidate]);

  const handleSourceFile = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast?.('请选择图片文件', 'error');
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const image = await loadRepaintImage(dataUrl);
      setSourceFileName(file.name);
      setSourceDataUrl(dataUrl);
      setSourceSize({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
      setRegions([]);
      setSelectedRegionId(undefined);
      setResultDataUrl(null);
      setHasMask(false);
      setZoom(100);
      setPreviewMode('mask');
      setTool('brush');
      setSmartStatus('idle');
      setSmartStatusText('');
      setSmartProgress(undefined);
      setSmartPoints([]);
      setSmartMask(null);
      smartAnalyzedSourceRef.current = null;
      smartWorkerRef.current?.postMessage({ type: 'reset' });
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '图片读取失败', 'error');
    }
  };

  const handleSourceDragEnter = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!anyGenerating) setSourceDragOver(true);
  };

  const handleSourceDragLeave = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setSourceDragOver(false);
  };

  const handleSourceDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setSourceDragOver(false);
    if (anyGenerating) return;
    const files = Array.from(event.dataTransfer.files);
    const file = files.find(candidate => candidate.type.startsWith('image/')) || files[0];
    if (file) void handleSourceFile(file);
  };

  const handleSourcePaste = (event: React.ClipboardEvent<HTMLElement>) => {
    if (anyGenerating) return;
    const files = getClipboardImageFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void handleSourceFile(files[0]);
  };

  const analyzeRegions = async () => {
    if (!sourceDataUrl || !hasMask) return;
    const imageData = canvasRef.current?.getMaskImageData();
    if (!imageData) return;
    setAnalyzing(true);
    try {
      const components = detectMaskComponents(imageData.data, imageData.width, imageData.height, {
        mergeGap,
        minPixels: Math.max(16, Math.round((imageData.width * imageData.height) / 2_000_000)),
      });
      if (components.length === 0) {
        showToast?.('没有识别到有效涂抹区域，请扩大涂抹范围', 'error');
        return;
      }
      const assets = await Promise.all(components.map(component => (
        createRegionAssets(sourceDataUrl, imageData.width, imageData.height, component, paddingRatio)
      )));
      const nextRegions: RepaintRegion[] = components.map((component, index) => ({
        id: generateUUID(), name: `区域 ${index + 1}`, order: index, pixelCount: component.pixelCount,
        ...assets[index], prompt: '', referenceRole: initialReferences.length ? 'appearance' : 'general', references: initialReferences.map(reference => ({ ...reference })), candidates: [], status: 'ready', enabled: true,
      }));
      setRegions(nextRegions);
      setSelectedRegionId(nextRegions[0]?.id);
      setResultDataUrl(null);
      setPreviewMode('mask');
      showToast?.(`已识别 ${nextRegions.length} 个独立区域`, 'success');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '区域识别失败', 'error');
    } finally {
      setAnalyzing(false);
    }
  };

  const generationParams = useMemo<AdvancedRepaintGenerationParams>(() => ({
    model: params.model,
    temperature: params.temperature,
    webSearchEnabled: params.webSearchEnabled,
    imageSearchEnabled: params.imageSearchEnabled,
    parallelCount: params.parallelCount,
    gptImageAdvancedParams: params.gptImageAdvancedParams,
  }), [params]);

  const generateRegion = useCallback(async (regionId: string) => {
    const region = regions.find(item => item.id === regionId);
    if (!region || region.status === 'generating' || region.status === 'queued') return false;
    if (!hasApiKey) {
      onConfigureApiKey();
      return false;
    }
    if (!region.prompt.trim()) {
      updateRegion(regionId, { error: '请先填写这个区域的修改需求' });
      return false;
    }

    updateRegion(regionId, { status: 'queued', statusText: '正在创建任务…', error: undefined });
    try {
      const images = await generateAdvancedRepaintRegion({
        sourceCropDataUrl: region.sourceCropDataUrl,
        maskDataUrl: region.maskDataUrl,
        prompt: region.prompt,
        referenceRole: region.referenceRole,
        references: region.references,
        params: generationParams,
        onProgress: statusText => updateRegion(regionId, {
          status: statusText.includes('排队') ? 'queued' : 'generating',
          statusText,
        }),
      });
      const candidates = images.map(imageUrl => ({ id: generateUUID(), imageUrl }));
      updateRegion(regionId, {
        candidates,
        selectedCandidateId: candidates[0]?.id,
        status: 'completed',
        statusText: undefined,
        error: undefined,
        enabled: true,
      });
      return true;
    } catch (error) {
      updateRegion(regionId, {
        status: 'failed',
        statusText: undefined,
        error: error instanceof Error ? error.message : '局部生成失败',
      });
      return false;
    }
  }, [generationParams, hasApiKey, onConfigureApiKey, regions, updateRegion]);

  const generateAll = async () => {
    const pending = regions.filter(region => region.prompt.trim() && region.status !== 'generating' && region.status !== 'queued');
    if (pending.length === 0) {
      showToast?.('请至少为一个区域填写修改需求', 'error');
      return;
    }
    setGeneratingAll(true);
    let successCount = 0;
    for (const region of pending) {
      if (await generateRegion(region.id)) successCount += 1;
    }
    setGeneratingAll(false);
    showToast?.(`批量生成完成：${successCount}/${pending.length}`, successCount > 0 ? 'success' : 'error');
  };

  const removeRegion = (regionId: string) => {
    setRegions(current => {
      const next = current
        .filter(region => region.id !== regionId)
        .map((region, order) => ({ ...region, order, name: /^区域 \d+$/.test(region.name) ? `区域 ${order + 1}` : region.name }));
      setSelectedRegionId(next[0]?.id);
      return next;
    });
  };

  const resetWorkspace = () => {
    setSourceDataUrl(null);
    setSourceFileName('');
    setSourceSize({ width: 0, height: 0 });
    setRegions([]);
    setSelectedRegionId(undefined);
    setResultDataUrl(null);
    setHasMask(false);
    setPreviewMode('mask');
    setCompositeEditTool(null);
    setTool('brush');
    setSmartStatus('idle');
    setSmartStatusText('');
    setSmartProgress(undefined);
    setSmartPoints([]);
    setSmartMask(null);
    smartAnalyzedSourceRef.current = null;
    smartWorkerRef.current?.postMessage({ type: 'reset' });
  };

  const downloadResult = async () => {
    if (!sourceDataUrl || !hasCompletedRegion) return;
    try {
      setCompositing(true);
      const latestResult = await composeRepaintResult(sourceDataUrl, regions, blendRadius);
      setResultDataUrl(latestResult);
      const link = document.createElement('a');
      link.href = latestResult;
      link.download = `${sourceFileName.replace(/\.[^.]+$/, '') || 'advanced-repaint'}-高级重绘.png`;
      link.click();
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '下载前合成失败', 'error');
    } finally {
      setCompositing(false);
    }
  };

  const applyResult = async () => {
    if (!sourceDataUrl || !hasCompletedRegion || !onApplyResult) return;
    try {
      setCompositing(true);
      const latestResult = await composeRepaintResult(sourceDataUrl, regions, blendRadius);
      setResultDataUrl(latestResult);
      onApplyResult(latestResult);
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '应用局部重绘结果失败', 'error');
    } finally {
      setCompositing(false);
    }
  };

  const commitEnabledRegionsAndContinue = async () => {
    if (!sourceDataUrl || !hasCompletedRegion) return;
    try {
      setCompositing(true);
      const latestResult = await composeRepaintResult(sourceDataUrl, regions, blendRadius);
      const image = await loadRepaintImage(latestResult);
      setSourceDataUrl(latestResult);
      setSourceSize({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
      setRegions([]);
      setSelectedRegionId(undefined);
      setResultDataUrl(null);
      setHasMask(false);
      setZoom(100);
      setPreviewMode('mask');
      setCompositeEditTool(null);
      setTool('brush');
      setSmartStatus('idle');
      setSmartStatusText('');
      setSmartProgress(undefined);
      setSmartPoints([]);
      setSmartMask(null);
      smartAnalyzedSourceRef.current = null;
      smartWorkerRef.current?.postMessage({ type: 'reset' });
      showToast?.('已固定当前启用的满意区域，可以继续绘制其他区域', 'success');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '固定局部结果失败', 'error');
    } finally {
      setCompositing(false);
    }
  };


  const discardRegionsAndReturnToMask = useCallback(() => {
    setRegions([]);
    setSelectedRegionId(undefined);
    setResultDataUrl(null);
    setPreviewMode('mask');
    setCompositeEditTool(null);
  }, []);

  const requestReturnToMask = useCallback(() => {
    if (hasDiscardableRepaintWork(regions)) {
      setDiscardRepaintDialogOpen(true);
      return;
    }
    discardRegionsAndReturnToMask();
  }, [discardRegionsAndReturnToMask, regions]);

  const resetSelectedCompositeAdjustments = useCallback(() => {
    if (!selectedRegion) return;
    updateRegion(selectedRegion.id, {
      compositeMaskDataUrl: undefined,
      patchOffsetX: 0,
      patchOffsetY: 0,
    });
  }, [selectedRegion, updateRegion]);

  if (sourceDataUrl && (sourceSize.width <= 0 || sourceSize.height <= 0)) {
    return <div className="flex min-h-[52dvh] items-center justify-center rounded-2xl border bg-card text-sm text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />正在读取座套候选结果…</div>;
  }

  if (!sourceDataUrl) {
    return (
      <section className={cn('mx-auto w-full max-w-5xl', wideMode && 'xl:flex xl:min-h-0 xl:flex-1 xl:flex-col')}>
        <div className="rounded-3xl border border-border bg-card p-5 shadow-sm sm:p-8">
          <div className="mx-auto max-w-2xl text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <WandSparkles className="h-7 w-7" />
            </div>
            <h2 className="text-2xl font-semibold tracking-tight">高级重绘</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              在一张大图上涂抹多个区域，系统会自动拆成独立局部任务，分别生成后再按蒙版和原始坐标精确贴回。
            </p>
          </div>
          <button
            type="button"
            onClick={() => sourceInputRef.current?.click()}
            onDragEnter={handleSourceDragEnter}
            onDragOver={handleSourceDragEnter}
            onDragLeave={handleSourceDragLeave}
            onDrop={handleSourceDrop}
            onPaste={handleSourcePaste}
            className={cn('group mx-auto mt-8 flex min-h-64 w-full max-w-3xl flex-col items-center justify-center rounded-3xl border border-dashed bg-muted/30 px-6 text-center transition hover:border-primary/60 hover:bg-primary/[0.03]', sourceDragOver ? 'border-primary bg-primary/10 ring-2 ring-primary/20' : 'border-border')}
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full border bg-background shadow-sm transition group-hover:-translate-y-0.5">
              <Upload className="h-5 w-5" />
            </span>
            <span className="mt-4 font-medium">上传需要局部修改的原始图片</span>
            <span className="mt-1 text-xs text-muted-foreground">支持 PNG、JPG、WebP，可点击、拖拽或 Ctrl+V 粘贴图片</span>
          </button>
          <input ref={sourceInputRef} type="file" accept="image/*" className="hidden" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void handleSourceFile(file); }} />
        </div>
      </section>
    );
  }

  return (
    <section className={cn('w-full space-y-4', wideMode && 'xl:flex xl:min-h-0 xl:flex-1 xl:flex-col xl:space-y-3')}>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-sm">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <WandSparkles className="h-5 w-5 text-primary" />
            <h2 className="font-semibold">高级重绘</h2>
            {regions.length > 0 && <Badge variant="secondary">{regions.length} 个区域</Badge>}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{sourceFileName} · {sourceSize.width} × {sourceSize.height}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl border bg-muted/35 px-2 py-1.5" title="模型和候选数量会应用到每个区域；输出分辨率会根据每个裁切区域的原始像素尺寸自动选择，避免低清结果放大贴回。">
            <span className="hidden px-1 text-[10px] text-muted-foreground 2xl:inline">区域生成</span>
            <select
              value={params.model}
              onChange={event => setParams(current => normalizeRepaintParamsForModel(current, event.target.value as ModelId))}
              disabled={modelOptions.length === 0 || anyGenerating}
              className="h-7 max-w-36 rounded-md border-0 bg-transparent px-1.5 text-[11px] outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              aria-label="局部生成模型"
            >
              {modelOptions.length === 0 && <option value={params.model}>未配置可编辑模型</option>}
              {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <span className="rounded-md bg-background px-2 py-1 text-[10px] text-muted-foreground shadow-sm" title="按每个区域的裁切像素尺寸自动选择 1K、2K 或 4K">
              分辨率自动匹配
            </span>
            <select
              value={params.parallelCount}
              onChange={event => setParams(current => ({ ...current, parallelCount: Number(event.target.value) as RepaintParams['parallelCount'] }))}
              className="h-7 rounded-md border-0 bg-transparent px-1.5 text-[11px] outline-none focus:ring-2 focus:ring-ring"
              aria-label="每个区域候选数量"
            >
              {[1, 2, 3, 4].map(count => <option key={count} value={count}>每区 {count} 张</option>)}
            </select>
          </div>

          <GeminiSearchGroundingControl
            model={params.model}
            webSearchEnabled={params.webSearchEnabled}
            imageSearchEnabled={params.imageSearchEnabled}
            onChange={patch => setParams(current => ({ ...current, ...patch }))}
            size="sm"
          />

          {getSupportsTemperature(params.model) && (
            <Popover open={temperatureOpen} onOpenChange={setTemperatureOpen}>
              <PopoverTrigger
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1')}
                title="温度（0=精确，1=均衡，2=创意）"
              >
                <Thermometer className="h-3.5 w-3.5" />
                <span className="text-[11px]">温度 {params.temperature.toFixed(2)}</span>
              </PopoverTrigger>
              <PopoverContent className="w-64" align="start">
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">生成温度</span>
                    <span className="tabular-nums text-muted-foreground">{params.temperature.toFixed(2)}</span>
                  </div>
                  <Slider
                    value={[params.temperature]}
                    min={0}
                    max={2}
                    step={0.05}
                    onValueChange={value => setParams(current => ({ ...current, temperature: value[0] ?? 0.35 }))}
                  />
                  <div className="grid grid-cols-4 gap-1">
                    {[0, 0.35, 1, 2].map(value => (
                      <Button key={value} type="button" variant="outline" size="xs" onClick={() => setParams(current => ({ ...current, temperature: value }))}>
                        {value === 0 ? '精确' : value === 0.35 ? '稳定' : value === 1 ? '均衡' : '创意'}
                      </Button>
                    ))}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          )}

          {supportsGptImageAdvancedParams(params.model) && (
            <GptImageAdvancedParamsControl
              value={params.gptImageAdvancedParams}
              onChange={gptImageAdvancedParams => setParams(current => ({ ...current, gptImageAdvancedParams }))}
              variant="outline"
              size="sm"
            />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => sourceInputRef.current?.click()}
            onDragEnter={handleSourceDragEnter}
            onDragOver={handleSourceDragEnter}
            onDragLeave={handleSourceDragLeave}
            onDrop={handleSourceDrop}
            onPaste={handleSourcePaste}
            disabled={anyGenerating}
            className={sourceDragOver ? 'border-primary bg-primary/10 ring-2 ring-primary/20' : undefined}
            title="点击、拖拽或 Ctrl+V 更换原图"
          >
            <Upload className="h-4 w-4" />换图
          </Button>
          <Button variant="ghost" size="sm" onClick={resetWorkspace} disabled={anyGenerating}>
            <RotateCcw className="h-4 w-4" />重置
          </Button>
        </div>
        <input ref={sourceInputRef} type="file" accept="image/*" className="hidden" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void handleSourceFile(file); }} />
      </div>

      <div className={cn('grid min-h-0 gap-4', wideMode ? 'xl:flex-1 xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.72fr)]' : 'xl:grid-cols-[minmax(0,1.35fr)_400px]')}>
        <div className="min-w-0 space-y-3">
          <div className="rounded-2xl border border-border bg-card p-3 shadow-sm">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {regions.length === 0 ? (
                <>
                  <div className="flex rounded-xl border bg-muted/40 p-1">
                    <Button type="button" size="sm" variant={tool === 'brush' ? 'default' : 'ghost'} onClick={() => selectTool('brush')}><Brush className="h-4 w-4" />画笔</Button>
                    <Button type="button" size="sm" variant={tool === 'rectangle' ? 'default' : 'ghost'} onClick={() => selectTool('rectangle')}><Crop className="h-4 w-4" />框选</Button>
                    <Button type="button" size="sm" variant={tool === 'smart' ? 'default' : 'ghost'} onClick={() => selectTool('smart')}>
                      {smartStatus === 'loading' || smartStatus === 'analyzing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}智能选区
                    </Button>
                    <Button type="button" size="sm" variant={tool === 'eraser' ? 'default' : 'ghost'} onClick={() => selectTool('eraser')}><Eraser className="h-4 w-4" />橡皮擦</Button>
                  </div>
                  {(tool === 'brush' || tool === 'eraser') && (
                    <div className="flex min-w-44 items-center gap-2 rounded-xl border px-3 py-1.5">
                      <span className="text-xs text-muted-foreground">大小</span>
                      <Slider value={[brushSize]} min={8} max={240} step={2} onValueChange={value => setBrushSize(value[0])} />
                      <span className="w-8 text-right text-xs tabular-nums">{brushSize}</span>
                    </div>
                  )}
                  {(tool === 'rectangle' || tool === 'smart') && (
                    <div className="flex rounded-xl border bg-muted/30 p-1" title="选择新选区如何作用到已有蒙版">
                      <Button size="xs" variant={selectionMode === 'replace' ? 'secondary' : 'ghost'} onClick={() => setSelectionMode('replace')}>替换</Button>
                      <Button size="xs" variant={selectionMode === 'add' ? 'secondary' : 'ghost'} onClick={() => setSelectionMode('add')}>添加</Button>
                      <Button size="xs" variant={selectionMode === 'subtract' ? 'secondary' : 'ghost'} onClick={() => setSelectionMode('subtract')}>减去</Button>
                    </div>
                  )}
                  {tool === 'smart' && (
                    <>
                      <Badge variant={smartStatus === 'error' ? 'destructive' : 'secondary'} className="max-w-72 truncate" title={smartStatusText}>
                        {smartStatus === 'segmenting' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                        {smartProgress !== undefined ? Math.round(smartProgress) + '% · ' : ''}{smartStatusText || '准备智能选区'}
                      </Badge>
                      {smartMask && smartMask.candidates.length > 1 && (
                        <div className="flex items-center rounded-xl border bg-muted/30 p-1" title="SAM 会返回局部、物体和上下文等不同尺度，可在应用前切换">
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={smartMask.candidateIndex === 0}
                            onClick={() => changeSmartCandidateScale(-1)}
                          >缩小</Button>
                          <span className="px-2 text-[10px] tabular-nums text-muted-foreground">
                            对象尺度 {smartMask.candidateIndex + 1}/{smartMask.candidates.length}
                          </span>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={smartMask.candidateIndex === smartMask.candidates.length - 1}
                            onClick={() => changeSmartCandidateScale(1)}
                          >扩大</Button>
                        </div>
                      )}
                      {smartMask && <Button size="sm" onClick={() => applySmartCandidate()}><Check className="h-4 w-4" />应用选区</Button>}
                      {(smartMask || smartPoints.length > 0) && <Button variant="outline" size="sm" onClick={clearSmartCandidate}>清除识别</Button>}
                    </>
                  )}
                  <Button variant="outline" size="icon-sm" title="撤销" onClick={() => canvasRef.current?.undo()}><Undo2 className="h-4 w-4" /></Button>
                  <Button variant="outline" size="icon-sm" title="重做" onClick={() => canvasRef.current?.redo()}><Redo2 className="h-4 w-4" /></Button>
                  <Button variant="outline" size="sm" onClick={() => { canvasRef.current?.clear(); clearSmartCandidate(); }}><Trash2 className="h-4 w-4" />清空</Button>
                </>
              ) : (
                <>
                  <Badge variant="secondary"><Check className="mr-1 h-3.5 w-3.5" />区域已拆分</Badge>
                  <div className="flex rounded-lg border bg-muted/30 p-0.5">
                    <Button size="xs" variant={previewMode === 'mask' ? 'secondary' : 'ghost'} onClick={() => setPreviewMode('mask')}>区域标记</Button>
                    {hasCompletedRegion && (
                      <>
                        <Button size="xs" variant={previewMode === 'original' ? 'secondary' : 'ghost'} onClick={() => { setPreviewMode('original'); setCompositeEditTool(null); }}>原图</Button>
                        <Button size="xs" variant={previewMode === 'result' ? 'secondary' : 'ghost'} onClick={() => setPreviewMode('result')}>合成结果</Button>
                      </>
                    )}
                  </div>
                  {previewMode === 'result' && hasCompletedRegion && selectedRegion?.selectedCandidateId && (
                    <>
                      <div className="flex rounded-xl border bg-muted/30 p-1" title="调整当前区域的贴回位置和最终合成蒙版">
                        <Button
                          size="xs"
                          variant={compositeEditTool === 'move' ? 'secondary' : 'ghost'}
                          onClick={() => setCompositeEditTool(current => current === 'move' ? null : 'move')}
                        ><Move className="h-3.5 w-3.5" />移动拼贴</Button>
                        <Button
                          size="xs"
                          variant={compositeEditTool === 'mask-add' ? 'secondary' : 'ghost'}
                          onClick={() => setCompositeEditTool(current => current === 'mask-add' ? null : 'mask-add')}
                        ><Brush className="h-3.5 w-3.5" />增加蒙版</Button>
                        <Button
                          size="xs"
                          variant={compositeEditTool === 'mask-erase' ? 'secondary' : 'ghost'}
                          onClick={() => setCompositeEditTool(current => current === 'mask-erase' ? null : 'mask-erase')}
                        ><Eraser className="h-3.5 w-3.5" />擦除蒙版</Button>
                      </div>
                      {(compositeEditTool === 'mask-add' || compositeEditTool === 'mask-erase') && (
                        <label className="flex min-w-40 items-center gap-2 rounded-xl border px-3 py-1.5 text-xs">
                          <span className="shrink-0">画笔 {compositeBrushSize}px</span>
                          <Slider value={[compositeBrushSize]} min={8} max={240} step={2} onValueChange={value => setCompositeBrushSize(value[0])} />
                        </label>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        title="恢复当前区域最初的贴回位置和蒙版"
                        onClick={resetSelectedCompositeAdjustments}
                      ><RotateCcw className="h-4 w-4" />重置区域调整</Button>
                    </>
                  )}
                  <Button variant="outline" size="sm" onClick={requestReturnToMask} disabled={anyGenerating} title="返回修改蒙版前会提示确认，当前区域结果不会自动保留">
                    <Brush className="h-4 w-4" />返回修改蒙版
                  </Button>
                  {hasCompletedRegion && (
                    <Button size="sm" onClick={() => void commitEnabledRegionsAndContinue()} disabled={compositing || anyGenerating} title="只固定当前启用且已选结果的区域，然后继续绘制其他区域">
                      <Check className="h-4 w-4" />固定满意区域并继续
                    </Button>
                  )}
                  {hasCompletedRegion && (
                    <>
                      <label className="flex min-w-32 items-center gap-2 text-xs">
                        <span className="shrink-0 text-muted-foreground">羽化 {blendRadius}px</span>
                        <Slider value={[blendRadius]} min={0} max={16} step={1} onValueChange={value => setBlendRadius(value[0])} />
                      </label>
                      {onApplyResult && <Button size="sm" onClick={() => void applyResult()} disabled={!resultDataUrl || compositing}>
                        <Check className="h-4 w-4" />应用到座套结果
                      </Button>}
                      <Button size="sm" variant={onApplyResult ? 'outline' : 'default'} onClick={() => void downloadResult()} disabled={!resultDataUrl || compositing}>
                        <Download className="h-4 w-4" />下载结果
                      </Button>
                    </>
                  )}
                </>
              )}

              <div className="ml-auto flex items-center gap-1">
                <span className="mr-1 hidden text-[10px] text-muted-foreground 2xl:inline">
                  {compositeEditTool === 'move'
                    ? '在选中区域内拖动生成图层 · 蒙版位置保持不变'
                    : compositeEditTool === 'mask-add'
                      ? '涂抹以扩大生成结果显示范围'
                      : compositeEditTool === 'mask-erase'
                        ? '涂抹以恢复原图并收缩蒙版'
                        : '滚轮缩放 · 空格+左键拖动画布'}
                </span>
                <Button variant="outline" size="icon-sm" onClick={() => setZoom(value => Math.max(40, value - 20))}><Minus className="h-4 w-4" /></Button>
                <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">{zoom}%</span>
                <Button variant="outline" size="icon-sm" onClick={() => setZoom(value => Math.min(240, value + 20))}><Plus className="h-4 w-4" /></Button>
              </div>

              {regions.length === 0 && (
                <Button className="ml-1" size="sm" disabled={!hasMask || analyzing} onClick={() => void analyzeRegions()}>
                  {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}识别并拆分区域
                </Button>
              )}
            </div>

            {previewMode === 'mask' || !hasCompletedRegion ? (
              <AdvancedRepaintCanvas
                ref={canvasRef}
                sourceUrl={sourceDataUrl}
                sourceWidth={sourceSize.width}
                sourceHeight={sourceSize.height}
                tool={tool}
                selectionMode={selectionMode}
                smartMaskDataUrl={smartMask?.previewUrl}
                smartPoints={smartPoints}
                smartReady={smartStatus === 'ready'}
                onSmartPoint={handleSmartPoint}
                brushSize={brushSize}
                zoom={zoom}
                onZoomChange={setZoom}
                readOnly={regions.length > 0}
                regions={regions}
                selectedRegionId={selectedRegion?.id}
                onSelectRegion={setSelectedRegionId}
                onMaskChange={setHasMask}
              />
            ) : (
              <AdvancedRepaintViewport sourceWidth={sourceSize.width} sourceHeight={sourceSize.height} zoom={zoom} onZoomChange={setZoom}>
                {previewMode === 'result' && compositeEditTool ? (
                  <AdvancedRepaintCompositeEditor
                    sourceDataUrl={sourceDataUrl}
                    sourceWidth={sourceSize.width}
                    sourceHeight={sourceSize.height}
                    regions={regions}
                    selectedRegionId={selectedRegion?.id}
                    blendRadius={blendRadius}
                    editTool={compositeEditTool}
                    brushSize={compositeBrushSize}
                    onUpdateRegion={updateRegion}
                  />
                ) : (
                  <img
                    src={previewMode === 'result' && resultDataUrl ? resultDataUrl : sourceDataUrl}
                    alt={previewMode === 'result' ? '高级重绘合成结果' : '高级重绘原图'}
                    className="absolute inset-0 h-full w-full object-fill"
                  />
                )}
              </AdvancedRepaintViewport>
            )}

            {regions.length === 0 && (
              <div className="mt-3 grid gap-3 rounded-xl border bg-muted/25 p-3 sm:grid-cols-3">
                <label className="space-y-1.5"><span className="flex justify-between text-xs"><span>区域连接容差</span><span className="text-muted-foreground">{mergeGap}px</span></span><Slider value={[mergeGap]} min={0} max={20} step={1} onValueChange={value => setMergeGap(value[0])} /></label>
                <label className="space-y-1.5"><span className="flex justify-between text-xs"><span>上下文边距</span><span className="text-muted-foreground">{Math.round(paddingRatio * 100)}%</span></span><Slider value={[paddingRatio]} min={0.1} max={0.45} step={0.01} onValueChange={value => setPaddingRatio(value[0])} /></label>
                <div className="text-xs leading-5 text-muted-foreground">相邻笔迹会按容差合并；裁切时自动保留周围上下文，便于模型理解光线、结构和透视。</div>
              </div>
            )}
          </div>

        </div>

        <aside className={cn('min-w-0 rounded-2xl border border-border bg-card shadow-sm', wideMode && 'xl:min-h-0 xl:overflow-hidden')}>
          {regions.length === 0 ? (
            <div className="flex h-full min-h-80 flex-col items-center justify-center px-8 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted"><Brush className="h-5 w-5 text-muted-foreground" /></span>
              <h3 className="mt-4 text-sm font-semibold">先涂抹需要修改的位置</h3>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">每一块连通涂抹会成为一个独立区域。确认后，将分别配置修改需求和参考图。</p>
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="border-b p-3">
                <div className="flex items-center justify-between gap-2">
                  <div><h3 className="text-sm font-semibold">区域任务</h3><p className="text-xs text-muted-foreground">眼睛开启的区域会参与合成和固定</p></div>
                  <Button size="sm" onClick={() => void generateAll()} disabled={generatingAll || anyGenerating}>
                    {generatingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}全部生成
                  </Button>
                </div>
                <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                  {regions.map(region => (
                    <button key={region.id} type="button" onClick={() => setSelectedRegionId(region.id)} className={cn('min-w-24 rounded-xl border px-3 py-2 text-left transition', selectedRegion?.id === region.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/60')}>
                      <span className="block truncate text-xs font-medium">{region.name}</span>
                      <span className={cn('mt-1 block text-[10px]', region.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{statusLabel(region)}</span>
                    </button>
                  ))}
                </div>
              </div>

              {selectedRegion && (
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
                  <div className="grid grid-cols-2 gap-2">
                    <figure className="overflow-hidden rounded-xl border bg-muted/30">
                      <img src={selectedRegion.sourceCropDataUrl} alt="区域裁切原图" className="aspect-square h-full w-full object-contain" />
                      <figcaption className="border-t px-2 py-1.5 text-[10px] text-muted-foreground">上下文裁切图</figcaption>
                    </figure>
                    <figure className="mask-checkerboard overflow-hidden rounded-xl border">
                      <img src={selectedRegion.maskDataUrl} alt="区域黑白蒙版" className="aspect-square h-full w-full object-contain" />
                      <figcaption className="border-t bg-background/90 px-2 py-1.5 text-[10px] text-muted-foreground">黑白硬边界蒙版</figcaption>
                    </figure>
                  </div>

                  <div className="flex items-center gap-2">
                    <Input value={selectedRegion.name} onChange={event => updateRegion(selectedRegion.id, { name: event.target.value })} className="h-9" />
                    <Button variant={selectedRegion.enabled ? 'outline' : 'secondary'} size="icon-sm" onClick={() => updateRegion(selectedRegion.id, { enabled: !selectedRegion.enabled })} title={selectedRegion.enabled ? '从合成和固定中排除此区域' : '将此区域纳入合成和固定'}>
                      {selectedRegion.enabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => removeRegion(selectedRegion.id)} disabled={anyGenerating} title="删除区域"><Trash2 className="h-4 w-4" /></Button>
                  </div>

                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium">这个区域要修改成什么？</span>
                    <Textarea value={selectedRegion.prompt} onChange={event => updateRegion(selectedRegion.id, { prompt: event.target.value, error: undefined })} placeholder="例如：把这里替换成一盏磨砂玻璃吊灯，保持原来的视角、光线和空间透视。" className="min-h-28 resize-y" />
                  </label>

                  <AdvancedRepaintReferencePicker
                    references={selectedRegion.references}
                    referenceRole={selectedRegion.referenceRole}
                    onReferenceRoleChange={referenceRole => updateRegion(selectedRegion.id, { referenceRole })}
                    onAddReferences={incoming => {
                      const regionId = selectedRegion.id;
                      setRegions(current => current.map(region => region.id === regionId
                        ? { ...region, references: [...region.references, ...incoming].slice(0, 6) }
                        : region));
                    }}
                    onRemoveReference={referenceId => {
                      const regionId = selectedRegion.id;
                      setRegions(current => current.map(region => region.id === regionId
                        ? { ...region, references: region.references.filter(reference => reference.id !== referenceId) }
                        : region));
                    }}
                    onPreview={index => setReferencePreview({
                      images: selectedRegion.references.map(item => item.dataUrl),
                      alt: selectedRegion.references[index]?.name || '参考图',
                      initialIndex: index,
                    })}
                    showToast={showToast}
                  />

                  {selectedRegion.error && <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">{selectedRegion.error}</div>}

                  <Button className="w-full" onClick={() => void generateRegion(selectedRegion.id)} disabled={selectedRegion.status === 'generating' || selectedRegion.status === 'queued' || !selectedRegion.prompt.trim()}>
                    {selectedRegion.status === 'generating' || selectedRegion.status === 'queued' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    {selectedRegion.status === 'generating' || selectedRegion.status === 'queued' ? selectedRegion.statusText || '生成中…' : selectedRegion.candidates.length > 0 ? '重新生成这个区域' : '生成这个区域'}
                  </Button>

                  {selectedRegion.candidates.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between"><span className="text-xs font-medium">候选结果</span><span className="text-[10px] text-muted-foreground">点击选择贴回版本</span></div>
                      <div className="grid grid-cols-2 gap-2">
                        {selectedRegion.candidates.map((candidate, index) => (
                          <button key={candidate.id} type="button" onClick={() => updateRegion(selectedRegion.id, { selectedCandidateId: candidate.id, enabled: true })} className={cn('relative overflow-hidden rounded-xl border-2 bg-muted', selectedRegion.selectedCandidateId === candidate.id ? 'border-primary' : 'border-transparent hover:border-border')}>
                            <img src={candidate.imageUrl} alt={`候选 ${index + 1}`} className="aspect-square h-full w-full object-cover" />
                            <span className="absolute left-1.5 top-1.5 rounded-full bg-black/65 px-1.5 py-0.5 text-[10px] text-white">{index + 1}</span>
                            {selectedRegion.selectedCandidateId === candidate.id && <span className="absolute right-1.5 top-1.5 rounded-full bg-primary p-1 text-primary-foreground"><Check className="h-3 w-3" /></span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {discardRepaintDialogOpen && createPortal(
        <ConfirmDialog
          title="放弃当前重绘结果？"
          message={(
            <>
              返回修改蒙版会清空当前所有区域的提示词、候选结果和参考图，未应用的结果将无法恢复。
              <span className="mt-2 block text-warning">如果只想保留满意区域，请先关闭不满意区域，再点击“固定满意区域并继续”。</span>
            </>
          )}
          confirmText="放弃结果并返回"
          onConfirm={() => {
            setDiscardRepaintDialogOpen(false);
            discardRegionsAndReturnToMask();
          }}
          onCancel={() => setDiscardRepaintDialogOpen(false)}
        />,
        document.body,
      )}

      {referencePreview && createPortal(
        <HistoryImagePreview
          images={referencePreview.images}
          alt={referencePreview.alt}
          initialIndex={referencePreview.initialIndex}
          onClose={() => setReferencePreview(null)}
          showDownload={false}
          showCopy={false}
          showAddToAssets={false}
          showUseAsReference={false}
        />,
        document.body,
      )}
    </section>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Check, ChevronRight, Copy, Download, FileDown, FileUp, FolderOpen, FolderPlus, Images, Loader2, Pencil, Plus, RefreshCw, ScanSearch, Trash2, Upload, WandSparkles, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { GptImageAdvancedParamsControl } from '@/components/GptImageAdvancedParamsControl';
import { AdvancedRepaintWorkspace } from '@/components/advanced-repaint/AdvancedRepaintWorkspace';
import type { RepaintReferenceImage } from '@/components/advanced-repaint/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { getClipboardImageFiles } from '@/lib/clipboard-image';
import { getImageDimensions } from '@/lib/mask-utils';
import { getModelOptions, type ModelId } from '@/lib/gemini-config';
import {
  DEFAULT_GPT_IMAGE_ADVANCED_PARAMS,
  getGptImageAdvancedParamsForModel,
  getModelMaxRefImages,
  getSizeOptions,
  getSupportsTemperature,
  supportsGptImageAdvancedParams,
  supportsImageSearchGrounding,
  supportsWebSearchGrounding,
} from '@/lib/model-capabilities';
import { deleteStoredBlobs, parseStoredBlobRef, revokeBlobUrls } from '@/lib/image-downloader';
import { prepareUploadImage } from '@/lib/upload-image-cache';
import { saveBlobToDownloads } from '@/lib/local-download';
import { clearDesktopTaskSource, publishDesktopTaskSource, type DesktopTaskStatus, type DesktopTaskSummary } from '@/lib/desktop-task-status';
import { generateUUID } from '@/lib/uuid';
import { buildAnglePrompt, generateSeatCoverAngle, generateSeatCoverFitting } from './seat-cover-generation-service';
import { appendCandidateSlots, candidateStatus, hasRetryableCandidates, normalizeCandidateSlots, normalizeExistingCandidates } from './candidate-utils';
import { getVehicleReferenceLimit, scoreVehicleReferences, selectVehicleReferences } from './reference-selection';
import { SeatMaskEditor } from './SeatMaskEditor';
import { useSeatCoverProjects } from './project-store';
import { resolveSeatCoverImageBlob } from './image-source';
import { SEAT_COVER_ANGLE_PRESETS, SEAT_COVER_STAGE_LABELS } from './presets';
import { PromptTemplateEditor } from './PromptTemplateEditor';
import { extractSeatCoverAngleRule, loadSeatCoverPromptBundle, saveSeatCoverAnglePrompt } from './prompt-templates';
import type {
  SeatCoverAnglePreset,
  SeatCoverAngleTask,
  SeatCoverCandidate,
  SeatCoverFittingTask,
  SeatCoverGenerationConfig,
  SeatCoverImageAsset,
  SeatCoverScope,
  SeatCoverStage,
  SeatCoverTaskStatus,
  SeatCoverWorkspaceState,
} from './types';

const DESKTOP_TASK_SOURCE = 'seat-cover-generation';

type ImageListKey = 'vehicleImages' | 'frontCoverImages' | 'rearCoverImages';

type SeatCandidateRepaintTarget = {
  taskId: string;
  candidateId: string;
  sourceUrl: string;
  fileName: string;
};

function createDefaultConfig(): SeatCoverGenerationConfig {
  const model = getModelOptions().find(option => option.value === 'gemini-3-pro-image-preview' && getModelMaxRefImages(option.value) >= 2)?.value
    || getModelOptions().find(option => getModelMaxRefImages(option.value) >= 2)?.value
    || 'gemini-3-pro-image-preview';
  return {
    model: model as ModelId,
    outputSize: '2K',
    parallelCount: 1,
    temperature: 0.35,
    webSearchEnabled: false,
    imageSearchEnabled: false,
    gptImageAdvancedParams: getGptImageAdvancedParamsForModel(model, DEFAULT_GPT_IMAGE_ADVANCED_PARAMS),
  };
}

function statusText(status: SeatCoverTaskStatus): string {
  return { draft: '待生成', queued: '排队中', generating: '生成中', completed: '已完成', failed: '失败' }[status];
}

function scopeText(scope: SeatCoverScope): string {
  return SEAT_COVER_STAGE_LABELS[scope];
}

function getTaskAccent(name: string, index: number) {
  let hash = 0;
  for (let charIndex = 0; charIndex < name.length; charIndex += 1) hash = (hash * 31 + name.charCodeAt(charIndex)) >>> 0;
  const hues = [198, 258, 334, 24, 152, 286, 48, 218];
  const hue = hues[(hash + index) % hues.length];
  return {
    solid: `hsl(${hue} 72% 48%)`,
    border: `hsl(${hue} 62% 72%)`,
    background: `linear-gradient(135deg, hsla(${hue}, 82%, 55%, 0.10) 0%, transparent 36%)`,
  };
}

function desktopStatus(status: SeatCoverTaskStatus): DesktopTaskStatus | null {
  if (status === 'draft') return null;
  return status === 'generating' ? 'processing' : status;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}

async function imageAssetFromReference(id: string, name: string, imageRef: string, imageUrl?: string): Promise<SeatCoverImageAsset> {
  const blob = await resolveSeatCoverImageBlob(imageRef, imageUrl);
  const dataUrl = await blobToDataUrl(blob);
  let width: number | undefined;
  let height: number | undefined;
  try {
    const dimensions = await getImageDimensions(dataUrl);
    width = dimensions.width;
    height = dimensions.height;
  } catch {
    // The generation service retries dimension detection before falling back.
  }
  return { id, name, preview: imageUrl || imageRef, dataUrl, mimeType: blob.type || 'image/png', width, height };
}

function UploadBox({ title, hint, images, onUpload, onRemove }: {
  title: string;
  hint: string;
  images: SeatCoverImageAsset[];
  onUpload: (files: File[]) => void;
  onRemove: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const submitFiles = (files: File[]) => {
    const imageFiles = files.filter(file => file.type.startsWith('image/'));
    if (imageFiles.length > 0) onUpload(imageFiles);
  };

  const handleDragEnter = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setIsDragOver(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    submitFiles(Array.from(event.dataTransfer.files));
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = getClipboardImageFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    submitFiles(files);
  };

  return (
    <section
      aria-label={title + '图片上传区域'}
      tabIndex={0}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
      className={cn(
        'relative rounded-2xl border bg-card/70 p-3 transition-colors',
        isDragOver ? 'border-primary bg-primary/10 ring-2 ring-primary/20' : 'border-border/70',
      )}
    >
      {isDragOver && <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-background/90 text-sm font-medium text-primary">松开以上传图片</div>}
      <div className="mb-2 flex items-start justify-between gap-3">
        <div><h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 text-[11px] text-muted-foreground">{hint}</p></div>
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} title="点击、拖拽或 Ctrl+V 上传图片"><Upload className="mr-1.5 size-3.5" />上传</Button>
        <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={event => {
          submitFiles(Array.from(event.target.files || []));
          event.target.value = '';
        }} />
      </div>
      {images.length === 0 ? <div className="flex min-h-24 items-center justify-center rounded-xl border border-dashed text-xs text-muted-foreground">还没有上传图片，可拖拽或 Ctrl+V 粘贴</div> : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">{images.map(image => (
          <div key={image.id} className="group relative aspect-[4/3] overflow-hidden rounded-lg bg-muted">
            <img src={image.preview || image.dataUrl} alt={image.name} className="h-full w-full object-cover" />
            <button type="button" onClick={() => onRemove(image.id)} className="absolute right-1 top-1 rounded-full bg-black/65 p-1 text-white opacity-0 group-hover:opacity-100"><X className="size-3" /></button>
          </div>
        ))}</div>
      )}
    </section>
  );
}

function ConfigBox({ config, models, onChange }: {
  config: SeatCoverGenerationConfig;
  models: Array<{ value: string; label: string }>;
  onChange: (patch: Partial<SeatCoverGenerationConfig>) => void;
}) {
  const availableSizes = getSizeOptions(config.model).map(option => option.value).filter(value => value === '1K' || value === '2K' || value === '4K');
  const supportsTemperature = getSupportsTemperature(config.model);
  const supportsAdvancedParams = supportsGptImageAdvancedParams(config.model);
  const handleModelChange = (model: ModelId) => {
    const nextSizes = getSizeOptions(model).map(option => option.value).filter(value => value === '1K' || value === '2K' || value === '4K');
    onChange({
      model,
      outputSize: nextSizes.includes(config.outputSize) ? config.outputSize : (nextSizes.at(-1) || '1K') as SeatCoverGenerationConfig['outputSize'],
      webSearchEnabled: supportsWebSearchGrounding(model) ? config.webSearchEnabled : false,
      imageSearchEnabled: supportsImageSearchGrounding(model) ? config.imageSearchEnabled : false,
      gptImageAdvancedParams: getGptImageAdvancedParamsForModel(model, config.gptImageAdvancedParams),
    });
  };
  return (
    <section className="rounded-2xl border border-border/70 bg-card/70 p-3">
      <h3 className="mb-2 text-sm font-semibold">全局生成配置</h3>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs text-muted-foreground">生图模型<select value={config.model} onChange={event => handleModelChange(event.target.value as ModelId)} className="mt-1 h-9 w-full rounded-lg border bg-background px-2 text-sm">{models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label>
        <label className="text-xs text-muted-foreground">分辨率<select value={config.outputSize} onChange={event => onChange({ outputSize: event.target.value as SeatCoverGenerationConfig['outputSize'] })} className="mt-1 h-9 w-full rounded-lg border bg-background px-2 text-sm">{(availableSizes.length ? availableSizes : ['1K', '2K', '4K']).map(size => <option key={size} value={size}>{size}</option>)}</select></label>
        <label className="text-xs text-muted-foreground">每个角度生成<select value={config.parallelCount} onChange={event => onChange({ parallelCount: Number(event.target.value) as SeatCoverGenerationConfig['parallelCount'] })} className="mt-1 h-9 w-full rounded-lg border bg-background px-2 text-sm">{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count} 张</option>)}</select></label>
        {supportsTemperature && <label className="text-xs text-muted-foreground">温度<Input className="mt-1" type="number" min="0" max="1" step="0.05" value={config.temperature} onChange={event => onChange({ temperature: Math.max(0, Math.min(1, Number(event.target.value) || 0)) })} /></label>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
        {supportsWebSearchGrounding(config.model) && <label className="flex items-center gap-2"><input type="checkbox" checked={config.webSearchEnabled} onChange={event => onChange({ webSearchEnabled: event.target.checked })} />联网搜索</label>}
        {supportsImageSearchGrounding(config.model) && <label className="flex items-center gap-2"><input type="checkbox" checked={config.imageSearchEnabled} onChange={event => onChange({ imageSearchEnabled: event.target.checked })} />联网搜图</label>}
        {supportsAdvancedParams && <div className="ml-auto flex items-center gap-2"><span className="font-medium text-foreground">GPT Image 2 专属配置</span><GptImageAdvancedParamsControl value={config.gptImageAdvancedParams} onChange={gptImageAdvancedParams => onChange({ gptImageAdvancedParams })} variant="outline" size="sm" /></div>}
      </div>
    </section>
  );
}

export function SeatCoverImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        event.preventDefault();
        setSpaceHeld(true);
      }
      if (event.key === 'Escape') onClose();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        event.preventDefault();
        setSpaceHeld(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [onClose]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const handleWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      setScale(current => Math.min(6, Math.max(1, current * factor)));
    };
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, []);

  const reset = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!spaceHeld || event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y };
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    setPan({ x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY });
  };

  const stopDragging = () => {
    dragRef.current = null;
  };

  return (
    <div className="fixed inset-0 z-[160] flex flex-col bg-black/90 p-3" onClick={onClose}>
      <div className="flex shrink-0 items-center justify-between gap-3 px-1 pb-2 text-white">
        <span className="text-xs text-white/75">滚轮缩放 · 按住空格 + 鼠标左键拖动查看局部 · Esc 关闭</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/70">{Math.round(scale * 100)}%</span>
          <button type="button" onClick={reset} className="rounded-md bg-white/15 px-2 py-1 text-xs hover:bg-white/25">重置视图</button>
          <button type="button" onClick={onClose} className="rounded-full bg-white/15 p-2 text-white hover:bg-white/25" aria-label="关闭大图"><X className="size-5" /></button>
        </div>
      </div>
      <div
        ref={viewportRef}
        data-testid="seat-cover-lightbox-viewport"
        className={`min-h-0 flex-1 overflow-hidden rounded-xl ${spaceHeld ? 'cursor-grab' : 'cursor-default'}`}
        onClick={event => event.stopPropagation()}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDragging}
        onMouseLeave={stopDragging}
        onDoubleClick={reset}
      >
        <div className="flex h-full w-full items-center justify-center">
          <img
            src={src}
            alt="大图预览"
            draggable={false}
            className="max-h-full max-w-full select-none object-contain"
            style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`, transformOrigin: 'center center' }}
          />
        </div>
      </div>
    </div>
  );
}

export function SeatCoverGenerationWorkspace({ hasApiKey, onConfigureApiKey, showToast }: {
  hasApiKey: boolean;
  onConfigureApiKey: () => void;
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void;
}) {
  const defaultConfig = useMemo(() => createDefaultConfig(), []);
  const { state, setState, hydrated, projects, activeProjectId, actions: projectActions } = useSeatCoverProjects(defaultConfig);
  const [uploading, setUploading] = useState(false);
  const [customBaseDragOver, setCustomBaseDragOver] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [referenceEditorTaskId, setReferenceEditorTaskId] = useState<string | null>(null);
  const [promptEditor, setPromptEditor] = useState<{ preset: SeatCoverAnglePreset; value: string; defaultValue: string } | null>(null);
  const [promptEditorLoading, setPromptEditorLoading] = useState(false);
  const [maskEditorTaskId, setMaskEditorTaskId] = useState<string | null>(null);
  const [candidateRepaintTarget, setCandidateRepaintTarget] = useState<SeatCandidateRepaintTarget | null>(null);
  const [repaintWindowSessionId, setRepaintWindowSessionId] = useState<string | null>(null);
  const [projectNameDialog, setProjectNameDialog] = useState<{ projectId: string; mode: 'create' | 'rename' } | null>(null);
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const projectImportRef = useRef<HTMLInputElement>(null);
  const runningGenerationRequestsRef = useRef(new Set<string>());
  const models = useMemo(() => getModelOptions().filter(option => getModelMaxRefImages(option.value) >= 2), []);
  const activeProject = projects.find(project => project.id === activeProjectId) || projects[0];
  const desktopTasks = useMemo<DesktopTaskSummary[]>(() => [
    ...state.angleTasks.flatMap(task => {
      const status = desktopStatus(task.status);
      const pendingCount = task.candidates.filter(candidate => candidateStatus(candidate) !== 'completed').length;
      return status ? [{ id: `seat-cover-angle:${task.id}`, status, title: `原车角度 · ${task.presetName}`, detail: `${state.vehicleModel} ${state.vehicleYear}`.trim(), count: pendingCount || state.globalConfig.parallelCount }] : [];
    }),
    ...state.fittingTasks.flatMap(task => {
      const status = desktopStatus(task.status);
      const pendingCount = task.candidates.filter(candidate => candidateStatus(candidate) !== 'completed').length;
      return status ? [{ id: `seat-cover-fitting:${task.id}`, status, title: `座套上椅 · ${task.angleName}`, detail: scopeText(task.seatScope), count: pendingCount || task.customConfig?.parallelCount || state.globalConfig.parallelCount }] : [];
    }),
  ], [state.angleTasks, state.fittingTasks, state.globalConfig.parallelCount, state.vehicleModel, state.vehicleYear]);

  useEffect(() => {
    publishDesktopTaskSource(DESKTOP_TASK_SOURCE, desktopTasks);
  }, [desktopTasks]);

  useEffect(() => () => clearDesktopTaskSource(DESKTOP_TASK_SOURCE), []);

  const patchState = useCallback((patch: Partial<SeatCoverWorkspaceState>) => setState(current => ({ ...current, ...patch })), [setState]);
  const patchConfig = useCallback((patch: Partial<SeatCoverGenerationConfig>) => setState(current => ({ ...current, globalConfig: { ...current.globalConfig, ...patch } })), [setState]);

  const openPromptEditor = useCallback(async (preset: SeatCoverAnglePreset) => {
    setPromptEditorLoading(true);
    try {
      const references = selectVehicleReferences(state.globalConfig.model, state.vehicleImages, preset);
      const bridge = window.jackyDesktop?.promptEditorWindow;
      if (bridge) {
        const result = await bridge.open({
          preset,
          context: {
            model: state.globalConfig.model,
            vehicleModel: state.vehicleModel,
            vehicleYear: state.vehicleYear,
            vehicleTrim: state.vehicleTrim,
            extraPrompt: state.extraPrompt,
            referenceCount: references.length,
            webSearchEnabled: state.globalConfig.webSearchEnabled,
            imageSearchEnabled: state.globalConfig.imageSearchEnabled,
          },
        });
        if (result.ok) return;
        showToast?.(result.error || '独立提示词窗口打开失败，已切换到应用内编辑器', 'error');
      }
      const bundle = await loadSeatCoverPromptBundle();
      const currentRule = bundle.prompts[preset.name] || '';
      const defaultRule = bundle.defaults[preset.name] || preset.promptHint || '';
      const currentTemplate = currentRule || defaultRule;
      setPromptEditor({
        preset,
        value: extractSeatCoverAngleRule(currentTemplate),
        defaultValue: extractSeatCoverAngleRule(defaultRule),
      });
    } finally {
      setPromptEditorLoading(false);
    }
  }, [showToast, state.extraPrompt, state.globalConfig.imageSearchEnabled, state.globalConfig.model, state.globalConfig.webSearchEnabled, state.vehicleImages, state.vehicleModel, state.vehicleTrim, state.vehicleYear]);

  const uploadImages = useCallback(async (files: File[], key: ImageListKey) => {
    setUploading(true);
    try {
      const prepared = await Promise.all(files.map(file => prepareUploadImage(file)));
      const next: SeatCoverImageAsset[] = prepared.map(image => ({
        id: image.id,
        name: image.name,
        dataUrl: image.dataUrl,
        preview: image.preview,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        originalSize: image.originalSize,
        processedSize: image.processedSize,
      }));
      setState(current => ({ ...current, [key]: [...current[key], ...next] }));
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '图片上传失败', 'error');
    } finally {
      setUploading(false);
    }
  }, [setState, showToast]);

  const removeImage = useCallback((key: ImageListKey, id: string) => setState(current => ({ ...current, [key]: current[key].filter(image => image.id !== id) })), [setState]);
  const patchAngleTask = useCallback((id: string, patch: Partial<SeatCoverAngleTask>) => setState(current => ({ ...current, angleTasks: current.angleTasks.map(task => task.id === id ? { ...task, ...patch } : task) })), [setState]);
  const patchFittingTask = useCallback((id: string, patch: Partial<SeatCoverFittingTask>) => setState(current => ({ ...current, fittingTasks: current.fittingTasks.map(task => task.id === id ? { ...task, ...patch } : task) })), [setState]);

  const createAngleTasks = useCallback(() => {
    if (!state.selectedPresetIds.length) return showToast?.('请先选择至少一个生成角度', 'info');
    setState(current => {
      const existing = new Set(current.angleTasks.map(task => task.presetId));
      const additions: SeatCoverAngleTask[] = current.selectedPresetIds.filter(id => !existing.has(id)).map(id => {
        const preset = SEAT_COVER_ANGLE_PRESETS.find(item => item.id === id)!;
        return { id: `angle-${generateUUID()}`, presetId: id, presetName: preset.name, seatScope: preset.seatScope, status: 'draft', candidates: [] };
      });
      return { ...current, angleTasks: [...current.angleTasks, ...additions] };
    });
    showToast?.('角度任务已建立，可逐个生成或一键生成全部', 'success');
  }, [setState, showToast, state.selectedPresetIds]);

  const runAngleTask = useCallback(async (
    taskId: string,
    taskOverride?: SeatCoverAngleTask,
    options?: { candidateId?: string; forceAll?: boolean },
  ) => {
    if (!hasApiKey) return onConfigureApiKey();
    const task = taskOverride || state.angleTasks.find(item => item.id === taskId);
    const preset = task && SEAT_COVER_ANGLE_PRESETS.find(item => item.id === task.presetId);
    if (!task || !preset) return;
    if (task.status === 'queued' || task.status === 'generating') {
      showToast?.('这个角度正在生成中，已拦截重复提交以避免重复扣费', 'info');
      return;
    }
    if (!state.vehicleModel.trim() || !state.vehicleYear.trim()) return showToast?.('请先填写车型和年份', 'info');
    if (!state.vehicleImages.length) return showToast?.('请先上传原车内饰资料图', 'info');

    const desiredCount = state.globalConfig.parallelCount;
    let slots = options?.candidateId
      ? normalizeExistingCandidates(task.candidates)
      : normalizeCandidateSlots(task.candidates, desiredCount, task.id);
    const regenerateWholeGroup = Boolean(options?.forceAll || (!options?.candidateId && !hasRetryableCandidates(slots)));
    if (regenerateWholeGroup && task.status === 'completed' && !window.confirm(`“${task.presetName}”已有完成结果。重新生成会再次调用上游并可能再次扣费，确定继续吗？`)) {
      return;
    }
    if (regenerateWholeGroup) {
      // Keep the previous completed candidates visible and append a fresh group.
      // Only the newly created slots are marked generating below, so a full
      // regeneration never destroys the user's existing results.
      slots = appendCandidateSlots(task.candidates, desiredCount, task.id);
    }
    const targetIds = options?.candidateId
      ? [options.candidateId]
      : slots.filter(candidate => candidateStatus(candidate) !== 'completed').map(candidate => candidate.id);
    if (!targetIds.length) return;
    if (options?.candidateId && !slots.some(candidate => candidate.id === options.candidateId)) {
      return showToast?.('要重试的候选已不存在', 'error');
    }

    const selectedReferences = selectVehicleReferences(
      state.globalConfig.model,
      state.vehicleImages,
      preset,
      task.referenceSelectionMode === 'manual' ? task.referenceImageIds : undefined,
    );
    if (!selectedReferences.length) return showToast?.('当前模型没有可用的原车参考图位置', 'error');

    const requestKey = `angle:${taskId}:${options?.candidateId || 'group'}`;
    if (runningGenerationRequestsRef.current.has(requestKey)) {
      showToast?.('这张正在生成中，已拦截重复提交以避免重复扣费', 'info');
      return;
    }
    runningGenerationRequestsRef.current.add(requestKey);

    const targetSet = new Set(targetIds);
    setState(current => ({
      ...current,
      angleTasks: current.angleTasks.map(item => item.id === taskId ? {
        ...item,
        status: 'queued',
        error: undefined,
        lastUsedReferenceImageIds: selectedReferences.map(image => image.id),
        candidates: slots.map(candidate => targetSet.has(candidate.id) ? { ...candidate, status: 'generating', error: undefined, selected: false } : candidate),
      } : item),
    }));

    try {
      const result = await generateSeatCoverAngle({
        vehicleModel: state.vehicleModel,
        vehicleYear: state.vehicleYear,
        vehicleTrim: state.vehicleTrim,
        extraPrompt: state.extraPrompt,
        preset,
        vehicleImages: selectedReferences,
        config: { ...state.globalConfig, parallelCount: targetIds.length as SeatCoverGenerationConfig['parallelCount'] },
        onProgress: message => patchAngleTask(taskId, { status: message.includes('排队') ? 'queued' : 'generating' }),
      });
      setState(current => ({
        ...current,
        angleTasks: current.angleTasks.map(item => {
          if (item.id !== taskId) return item;
          let resultIndex = 0;
          const candidates = item.candidates.map(candidate => {
            if (!targetSet.has(candidate.id)) return candidate;
            const imageRef = result.imageRefs[resultIndex];
            const imageUrl = result.blobUrls[resultIndex];
            resultIndex += 1;
            return imageRef
              ? { ...candidate, imageRef, imageUrl, selected: false, status: 'completed' as const, error: undefined }
              : { ...candidate, imageRef: '', imageUrl: undefined, selected: false, status: 'failed' as const, error: '模型未返回这一张候选图' };
          });
          const failed = candidates.filter(candidate => candidateStatus(candidate) === 'failed').length;
          return { ...item, status: failed ? 'failed' : 'completed', candidates, error: failed ? `${failed} 张候选生成失败，可单独重试` : undefined };
        }),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : '角度生成失败';
      setState(current => ({
        ...current,
        angleTasks: current.angleTasks.map(item => item.id === taskId ? {
          ...item,
          status: 'failed',
          error: message,
          candidates: item.candidates.map(candidate => targetSet.has(candidate.id) ? { ...candidate, status: 'failed', error: message } : candidate),
        } : item),
      }));
      showToast?.(message, 'error');
    } finally {
      runningGenerationRequestsRef.current.delete(requestKey);
    }
  }, [hasApiKey, onConfigureApiKey, patchAngleTask, setState, showToast, state]);

  const runAllAngles = useCallback(() => {
    const existingPresetIds = new Set(state.angleTasks.map(task => task.presetId));
    const additions: SeatCoverAngleTask[] = state.selectedPresetIds.filter(id => !existingPresetIds.has(id)).map(id => {
      const preset = SEAT_COVER_ANGLE_PRESETS.find(item => item.id === id)!;
      return { id: `angle-${generateUUID()}`, presetId: id, presetName: preset.name, seatScope: preset.seatScope, status: 'draft', candidates: [] };
    });
    const all = [...state.angleTasks, ...additions];
    const runnable = all.filter(task => task.status !== 'queued' && task.status !== 'generating' && (task.status !== 'completed' || hasRetryableCandidates(normalizeCandidateSlots(task.candidates, state.globalConfig.parallelCount, task.id))));
    if (!runnable.length) return showToast?.('没有待生成或失败的角度任务', 'info');
    const imageCount = runnable.reduce((sum, task) => {
      const slots = normalizeCandidateSlots(task.candidates, state.globalConfig.parallelCount, task.id);
      return sum + (hasRetryableCandidates(slots) ? slots.filter(candidate => candidateStatus(candidate) !== 'completed').length : state.globalConfig.parallelCount);
    }, 0);
    if (imageCount > 12 && !window.confirm(`即将并发执行 ${runnable.length} 条角度任务，预计生成 ${imageCount} 张图片。确定继续吗？`)) return;
    if (additions.length) setState(current => ({ ...current, angleTasks: [...current.angleTasks, ...additions] }));
    runnable.forEach(task => { void runAngleTask(task.id, task); });
  }, [runAngleTask, setState, showToast, state.angleTasks, state.globalConfig.parallelCount, state.selectedPresetIds]);

  const toggleCandidate = useCallback((taskId: string, candidateId: string) => setState(current => ({
    ...current,
    angleTasks: current.angleTasks.map(task => task.id === taskId ? {
      ...task,
      candidates: task.candidates.map(candidate => candidate.id === candidateId ? { ...candidate, selected: !candidate.selected } : candidate),
    } : task),
  })), [setState]);

  const prepareFitting = useCallback(() => {
    const selected = state.angleTasks.flatMap(task => task.candidates.filter(candidate => candidate.selected).map(candidate => ({ task, candidate })));
    if (!selected.length) return showToast?.('请先勾选要进入座套上椅的角度结果', 'info');
    setState(current => ({
      ...current,
      stage: 'fitting',
      fittingTasks: selected.map(({ task, candidate }) => current.fittingTasks.find(item => item.id === `fit:${task.id}:${candidate.id}`) || {
        id: `fit:${task.id}:${candidate.id}`,
        angleTaskId: task.id,
        candidateId: candidate.id,
        angleName: task.presetName,
        seatScope: task.seatScope,
        baseImageRef: candidate.imageRef,
        baseImageUrl: candidate.imageUrl,
        baseImageWidth: candidate.width,
        baseImageHeight: candidate.height,
        status: 'draft',
        candidates: [],
      }),
    }));
  }, [setState, showToast, state.angleTasks]);

  const addCustomFittingBases = useCallback(async (files: File[]) => {
    setUploading(true);
    try {
      const prepared = await Promise.all(files.map(file => prepareUploadImage(file)));
      setState(current => ({
        ...current,
        fittingTasks: [...current.fittingTasks, ...prepared.map(image => ({
          id: `fit-custom-${generateUUID()}`,
          angleTaskId: 'custom',
          candidateId: image.id,
          angleName: image.name,
          seatScope: 'front' as const,
          baseImageRef: image.dataUrl,
          baseImageUrl: image.preview,
          baseImageWidth: image.width,
          baseImageHeight: image.height,
          status: 'draft' as const,
          candidates: [],
        }))],
      }));
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '底图上传失败', 'error');
    } finally {
      setUploading(false);
    }
  }, [setState, showToast]);

  const runFittingTask = useCallback(async (
    taskId: string,
    options?: { candidateId?: string; forceAll?: boolean },
  ) => {
    if (!hasApiKey) return onConfigureApiKey();
    const task = state.fittingTasks.find(item => item.id === taskId);
    if (!task || (!task.baseImageRef && !task.baseImageUrl)) return showToast?.('底图尚未准备好', 'error');
    if (task.status === 'queued' || task.status === 'generating') {
      showToast?.('这个座套任务正在生成中，已拦截重复提交以避免重复扣费', 'info');
      return;
    }
    const availableCovers = task.seatScope === 'front' ? state.frontCoverImages : task.seatScope === 'rear' ? state.rearCoverImages : [...state.frontCoverImages, ...state.rearCoverImages];
    if (!availableCovers.length) return showToast?.(`请先上传${scopeText(task.seatScope)}座套资料`, 'info');

    const mergedConfig = { ...state.globalConfig, ...(task.customConfig || {}) };
    const desiredCount = mergedConfig.parallelCount;
    let slots = options?.candidateId
      ? normalizeExistingCandidates(task.candidates)
      : normalizeCandidateSlots(task.candidates, desiredCount, task.id);
    const regenerateWholeGroup = Boolean(options?.forceAll || (!options?.candidateId && !hasRetryableCandidates(slots)));
    if (regenerateWholeGroup && task.status === 'completed' && !window.confirm(`“${task.angleName}”已有完成结果。重新生成会再次调用上游并可能再次扣费，确定继续吗？`)) {
      return;
    }
    if (regenerateWholeGroup) {
      slots = appendCandidateSlots(task.candidates, desiredCount, task.id);
    }
    const targetIds = options?.candidateId
      ? [options.candidateId]
      : slots.filter(candidate => candidateStatus(candidate) !== 'completed').map(candidate => candidate.id);
    if (!targetIds.length) return;
    if (options?.candidateId && !slots.some(candidate => candidate.id === options.candidateId)) {
      return showToast?.('要重试的候选已不存在', 'error');
    }
    const requestKey = `fitting:${taskId}:${options?.candidateId || 'group'}`;
    if (runningGenerationRequestsRef.current.has(requestKey)) {
      showToast?.('这张正在生成中，已拦截重复提交以避免重复扣费', 'info');
      return;
    }
    runningGenerationRequestsRef.current.add(requestKey);
    const targetSet = new Set(targetIds);
    setState(current => ({
      ...current,
      fittingTasks: current.fittingTasks.map(item => item.id === taskId ? {
        ...item,
        status: 'queued',
        error: undefined,
        candidates: slots.map(candidate => targetSet.has(candidate.id) ? { ...candidate, status: 'generating', error: undefined } : candidate),
      } : item),
    }));

    try {
      const baseImage = await imageAssetFromReference(task.candidateId, task.angleName, task.baseImageRef, task.baseImageUrl);
      if (task.baseImageWidth && task.baseImageHeight) {
        baseImage.width = task.baseImageWidth;
        baseImage.height = task.baseImageHeight;
      }
      const allowedSizes = getSizeOptions(mergedConfig.model).map(option => option.value).filter(value => value === '1K' || value === '2K' || value === '4K');
      const outputSize = allowedSizes.includes(mergedConfig.outputSize) ? mergedConfig.outputSize : (allowedSizes.at(-1) || '2K') as SeatCoverGenerationConfig['outputSize'];
      const config: SeatCoverGenerationConfig = {
        ...mergedConfig,
        parallelCount: targetIds.length as SeatCoverGenerationConfig['parallelCount'],
        outputSize,
        gptImageAdvancedParams: getGptImageAdvancedParamsForModel(mergedConfig.model, state.globalConfig.gptImageAdvancedParams),
      };
      const result = await generateSeatCoverFitting({
        vehicleModel: state.vehicleModel,
        vehicleYear: state.vehicleYear,
        extraPrompt: state.extraPrompt,
        scope: task.seatScope,
        baseImage,
        frontCoverImages: state.frontCoverImages,
        rearCoverImages: state.rearCoverImages,
        config,
        maskDataUrl: task.maskEnabled ? task.maskDataUrl : undefined,
        onProgress: message => patchFittingTask(taskId, { status: message.includes('排队') ? 'queued' : 'generating' }),
      });
      setState(current => ({
        ...current,
        fittingTasks: current.fittingTasks.map(item => {
          if (item.id !== taskId) return item;
          let resultIndex = 0;
          const candidates = item.candidates.map(candidate => {
            if (!targetSet.has(candidate.id)) return candidate;
            const imageRef = result.imageRefs[resultIndex];
            const imageUrl = result.blobUrls[resultIndex];
            resultIndex += 1;
            return imageRef
              ? { ...candidate, imageRef, imageUrl, selected: false, status: 'completed' as const, error: undefined }
              : { ...candidate, imageRef: '', imageUrl: undefined, selected: false, status: 'failed' as const, error: '模型未返回这一张候选图' };
          });
          const failed = candidates.filter(candidate => candidateStatus(candidate) === 'failed').length;
          return { ...item, status: failed ? 'failed' : 'completed', candidates, error: failed ? `${failed} 张候选生成失败，可单独重试` : undefined };
        }),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : '座套上椅失败';
      setState(current => ({
        ...current,
        fittingTasks: current.fittingTasks.map(item => item.id === taskId ? {
          ...item,
          status: 'failed',
          error: message,
          candidates: item.candidates.map(candidate => targetSet.has(candidate.id) ? { ...candidate, status: 'failed', error: message } : candidate),
        } : item),
      }));
      showToast?.(message, 'error');
    } finally {
      runningGenerationRequestsRef.current.delete(requestKey);
    }
  }, [hasApiKey, onConfigureApiKey, patchFittingTask, setState, showToast, state]);

  const runAllFitting = useCallback(() => {
    const runnable = state.fittingTasks.filter(task => {
      if (task.status === 'queued' || task.status === 'generating') return false;
      const desired = task.customConfig?.parallelCount || state.globalConfig.parallelCount;
      return task.status !== 'completed' || hasRetryableCandidates(normalizeCandidateSlots(task.candidates, desired, task.id));
    });
    if (!runnable.length) return showToast?.('没有待生成或失败的座套任务', 'info');
    const imageCount = runnable.reduce((sum, task) => {
      const desired = task.customConfig?.parallelCount || state.globalConfig.parallelCount;
      const slots = normalizeCandidateSlots(task.candidates, desired, task.id);
      return sum + (hasRetryableCandidates(slots) ? slots.filter(candidate => candidateStatus(candidate) !== 'completed').length : desired);
    }, 0);
    if (imageCount > 12 && !window.confirm(`即将并发执行 ${runnable.length} 条座套任务，预计生成 ${imageCount} 张图片。确定继续吗？`)) return;
    runnable.forEach(task => { void runFittingTask(task.id); });
  }, [runFittingTask, showToast, state.fittingTasks, state.globalConfig.parallelCount]);

  const removeFittingTask = useCallback(async (task: SeatCoverFittingTask) => {
    if (task.status === 'queued' || task.status === 'generating') return;
    if (!window.confirm(`确定删除“${task.angleName}”座套任务吗？`)) return;

    revokeBlobUrls(task.candidates.flatMap(candidate => candidate.imageUrl?.startsWith('blob:') ? [candidate.imageUrl] : []));
    const cacheJobs = new Map<string, number>();
    for (const candidate of task.candidates) {
      const stored = parseStoredBlobRef(candidate.imageRef);
      if (!stored) continue;
      cacheJobs.set(stored.jobId, Math.max(cacheJobs.get(stored.jobId) || 0, stored.imageIndex + 1));
    }
    await Promise.all(Array.from(cacheJobs, ([jobId, count]) => deleteStoredBlobs(jobId, count)));
    setState(current => ({ ...current, fittingTasks: current.fittingTasks.filter(item => item.id !== task.id) }));
    showToast?.('座套任务已删除', 'success');
  }, [setState, showToast]);

  const removeAngleTask = useCallback(async (task: SeatCoverAngleTask) => {
    if (task.status === 'queued' || task.status === 'generating') return;
    if (!window.confirm(`确定删除“${task.presetName}”原车角度任务吗？关联的座套上椅任务也会一起删除。`)) return;

    const linkedFittingTasks = state.fittingTasks.filter(item => item.angleTaskId === task.id);
    const cacheJobs = new Map<string, number>();
    const collectCacheJob = (imageRef: string) => {
      const stored = parseStoredBlobRef(imageRef);
      if (!stored) return;
      cacheJobs.set(stored.jobId, Math.max(cacheJobs.get(stored.jobId) || 0, stored.imageIndex + 1));
    };
    const blobUrls = [
      ...task.candidates.map(candidate => candidate.imageUrl),
      ...linkedFittingTasks.flatMap(item => item.candidates.map(candidate => candidate.imageUrl)),
    ].filter((url): url is string => Boolean(url?.startsWith('blob:')));
    revokeBlobUrls(blobUrls);
    task.candidates.forEach(candidate => collectCacheJob(candidate.imageRef));
    linkedFittingTasks.forEach(item => item.candidates.forEach(candidate => collectCacheJob(candidate.imageRef)));
    await Promise.all(Array.from(cacheJobs, ([jobId, count]) => deleteStoredBlobs(jobId, count)));

    setState(current => ({
      ...current,
      angleTasks: current.angleTasks.filter(item => item.id !== task.id),
      fittingTasks: current.fittingTasks.filter(item => item.angleTaskId !== task.id),
    }));
    showToast?.('原车角度任务及关联座套任务已删除', 'success');
  }, [setState, showToast, state.fittingTasks]);

  const removeCandidate = useCallback((taskId: string, candidate: SeatCoverCandidate, fromAngleTask: boolean) => {
    if (candidate.imageUrl?.startsWith('blob:')) revokeBlobUrls([candidate.imageUrl]);
    setState(current => {
      const updateTask = <T extends SeatCoverAngleTask | SeatCoverFittingTask>(task: T): T => {
        if (task.id !== taskId) return task;
        const candidates = task.candidates.filter(item => item.id !== candidate.id);
        const hasFailed = candidates.some(item => candidateStatus(item) === 'failed');
        const hasPending = candidates.some(item => candidateStatus(item) === 'pending');
        const status: SeatCoverTaskStatus = candidates.length === 0
          ? 'draft'
          : hasFailed
            ? 'failed'
            : hasPending
              ? 'draft'
              : 'completed';
        return { ...task, candidates, status, error: hasFailed ? task.error : undefined };
      };
      return fromAngleTask ? {
        ...current,
        angleTasks: current.angleTasks.map(updateTask),
        fittingTasks: current.fittingTasks.filter(task => task.candidateId !== candidate.id),
      } : {
        ...current,
        fittingTasks: current.fittingTasks.map(updateTask),
      };
    });
    showToast?.(candidateStatus(candidate) === 'failed' ? '失败候选已删除' : '候选结果已删除', 'success');
  }, [setState, showToast]);

  const applyCandidateRepaint = useCallback((dataUrl: string) => {
    if (!candidateRepaintTarget) return;
    if (candidateRepaintTarget.sourceUrl.startsWith('blob:')) revokeBlobUrls([candidateRepaintTarget.sourceUrl]);
    setState(current => ({
      ...current,
      fittingTasks: current.fittingTasks.map(task => task.id === candidateRepaintTarget.taskId ? {
        ...task,
        candidates: task.candidates.map(candidate => candidate.id === candidateRepaintTarget.candidateId ? {
          ...candidate,
          imageRef: dataUrl,
          imageUrl: dataUrl,
          status: 'completed',
          error: undefined,
        } : candidate),
      } : task),
    }));
    setCandidateRepaintTarget(null);
    setRepaintWindowSessionId(null);
    showToast?.('局部重绘结果已替换当前座套候选', 'success');
  }, [candidateRepaintTarget, setState, showToast]);

  const downloadCandidate = useCallback(async (candidate: SeatCoverCandidate, name: string) => {
    try {
      const blob = await resolveSeatCoverImageBlob(candidate.imageRef, candidate.imageUrl);
      await saveBlobToDownloads(blob, `${name.replace(/[\\/:*?"<>|]+/g, '-')}.png`);
      showToast?.('图片已保存到下载目录', 'success');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '下载失败', 'error');
    }
  }, [showToast]);

  const renderCandidates = (taskId: string, candidates: SeatCoverCandidate[], selectable: boolean) => (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{candidates.map((candidate, index) => {
      const status = candidateStatus(candidate);
      const retry = () => selectable
        ? void runAngleTask(taskId, undefined, { candidateId: candidate.id })
        : void runFittingTask(taskId, { candidateId: candidate.id });
      const fittingTask = selectable ? undefined : state.fittingTasks.find(task => task.id === taskId);
      return <div key={candidate.id} className={`group relative aspect-[4/3] overflow-hidden rounded-xl border bg-muted ${candidate.selected ? 'border-primary ring-2 ring-primary/25' : status === 'failed' ? 'border-destructive/60' : 'border-border/70'}`}>
        {(status === 'completed' || status === 'failed') && <button type="button" onClick={() => removeCandidate(taskId, candidate, selectable)} className="absolute left-2 top-2 z-10 rounded-md bg-destructive/90 p-1.5 text-destructive-foreground shadow-sm" aria-label="删除候选" title="删除候选"><Trash2 className="size-3.5" /></button>}
        {status === 'completed' && candidate.imageUrl ? <button type="button" onClick={() => selectable ? toggleCandidate(taskId, candidate.id) : setLightbox(candidate.imageUrl || null)} className="h-full w-full">
          <img src={candidate.imageUrl} alt="生成结果" className="h-full w-full object-cover" />
          {selectable && <span className={`absolute right-2 top-2 flex size-6 items-center justify-center rounded-full ${candidate.selected ? 'bg-primary text-primary-foreground' : 'bg-black/50 text-white'}`}><Check className="size-4" /></span>}
        </button> : <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-xs text-muted-foreground">
          {status === 'generating' ? <><Loader2 className="size-5 animate-spin" /><span>正在生成候选 {index + 1}</span></> : status === 'failed' ? <><span className="text-destructive">候选 {index + 1} 生成失败</span><div className="flex gap-1"><Button size="sm" variant="outline" onClick={retry}><RefreshCw className="size-3.5" />只重试此张</Button></div></> : <span>候选 {index + 1} 待生成</span>}
        </div>}
        {status === 'completed' && candidate.imageUrl && <div className="absolute bottom-2 left-2 right-2 flex items-end justify-between gap-2 opacity-0 transition-opacity group-hover:opacity-100"><div className="flex gap-1"><button type="button" onClick={() => setLightbox(candidate.imageUrl || null)} className="rounded-md bg-black/65 px-2 py-1 text-[10px] text-white">查看大图</button>{!selectable && <button type="button" onClick={() => void openCandidateRepaint(taskId, candidate, `${fittingTask?.angleName || '座套结果'}-候选${index + 1}.png`)} className="flex items-center gap-1 rounded-md bg-primary/90 px-2 py-1 text-[10px] text-primary-foreground"><WandSparkles className="size-3" />局部重绘</button>}</div><div className="flex gap-1"><button type="button" onClick={() => void downloadCandidate(candidate, `座套生成-${taskId}-${index + 1}`)} className="rounded-md bg-black/65 p-1.5 text-white" aria-label="下载图片"><Download className="size-3" /></button></div></div>}
      </div>;
    })}</div>
  );
  const hasRunningTasks = state.angleTasks.some(task => task.status === 'queued' || task.status === 'generating')
    || state.fittingTasks.some(task => task.status === 'queued' || task.status === 'generating');
  const anglePresetPlanIds = Array.from(new Set([...state.angleTasks.map(task => task.presetId), ...state.selectedPresetIds]));
  const angleTaskEstimate = anglePresetPlanIds.length;
  const angleImageEstimate = angleTaskEstimate * state.globalConfig.parallelCount;
  const fittingTaskEstimate = state.fittingTasks.length;
  const fittingImageEstimate = state.fittingTasks.reduce((sum, task) => sum + (task.customConfig?.parallelCount || state.globalConfig.parallelCount), 0);
  const referenceEditorTask = referenceEditorTaskId ? state.angleTasks.find(task => task.id === referenceEditorTaskId) : undefined;
  const referenceEditorPreset = referenceEditorTask ? SEAT_COVER_ANGLE_PRESETS.find(preset => preset.id === referenceEditorTask.presetId) : undefined;
  const referenceLimit = getVehicleReferenceLimit(state.globalConfig.model, referenceEditorPreset);
  const referenceScores = referenceEditorPreset ? scoreVehicleReferences(state.vehicleImages, referenceEditorPreset) : [];
  const displayedReferenceImages = referenceEditorPreset
    ? selectVehicleReferences(
      state.globalConfig.model,
      state.vehicleImages,
      referenceEditorPreset,
      referenceEditorTask?.referenceSelectionMode === 'manual' ? referenceEditorTask.referenceImageIds : undefined,
    )
    : [];
  const displayedReferenceIds = Array.from(new Set(displayedReferenceImages.map(image => image.id)));

  const promptEditorReferences = promptEditor ? selectVehicleReferences(state.globalConfig.model, state.vehicleImages, promptEditor.preset) : [];
  const promptEditorPreview = promptEditor ? buildAnglePrompt(
    state.vehicleModel,
    state.vehicleYear,
    state.vehicleTrim,
    state.extraPrompt,
    promptEditor.preset,
    promptEditorReferences.length,
    supportsWebSearchGrounding(state.globalConfig.model) && state.globalConfig.webSearchEnabled,
    supportsImageSearchGrounding(state.globalConfig.model) && state.globalConfig.imageSearchEnabled,
    promptEditor.value,
  ) : '';
  const maskEditorTask = maskEditorTaskId ? state.fittingTasks.find(task => task.id === maskEditorTaskId) : undefined;
  const candidateRepaintTask = candidateRepaintTarget ? state.fittingTasks.find(task => task.id === candidateRepaintTarget.taskId) : undefined;
  const candidateRepaintReferences: RepaintReferenceImage[] = candidateRepaintTask ? (
    candidateRepaintTask.seatScope === 'front'
      ? state.frontCoverImages
      : candidateRepaintTask.seatScope === 'rear'
        ? state.rearCoverImages
        : [...state.frontCoverImages, ...state.rearCoverImages]
  ).slice(0, 6).map(image => ({ id: image.id, name: image.name, dataUrl: image.dataUrl, mimeType: image.mimeType })) : [];

  const toggleReferenceImage = (imageId: string) => {
    if (!referenceEditorTask) return;
    const currentIds = [...displayedReferenceIds];
    const nextIds = currentIds.includes(imageId) ? currentIds.filter(id => id !== imageId) : currentIds.length < referenceLimit ? [...currentIds, imageId] : currentIds;
    if (!currentIds.includes(imageId) && currentIds.length >= referenceLimit) {
      showToast?.(`当前模型最多使用 ${referenceLimit} 张原车资料图，角度参考图另占 1 张`, 'info');
      return;
    }
    patchAngleTask(referenceEditorTask.id, { referenceSelectionMode: 'manual', referenceImageIds: nextIds });
  };

  const finishReferenceEditing = () => {
    if (referenceEditorTask?.referenceSelectionMode === 'manual') {
      const savedIds = referenceEditorTask.referenceImageIds || [];
      const hasStaleOrDuplicateIds = savedIds.length !== displayedReferenceIds.length
        || savedIds.some((id, index) => id !== displayedReferenceIds[index]);
      if (hasStaleOrDuplicateIds) {
        patchAngleTask(referenceEditorTask.id, { referenceImageIds: displayedReferenceIds });
      }
    }
    setReferenceEditorTaskId(null);
  };

  useEffect(() => {
    const repaintBridge = window.jackyDesktop?.repaintWindow;
    if (!repaintBridge) return;
    const removeResultListener = repaintBridge.onResult(value => {
      if (value.sessionId !== repaintWindowSessionId) return;
      applyCandidateRepaint(value.dataUrl);
    });
    const removeClosedListener = repaintBridge.onClosed(value => {
      if (value.sessionId === repaintWindowSessionId) {
        setRepaintWindowSessionId(null);
        setCandidateRepaintTarget(null);
      }
    });
    return () => {
      removeResultListener();
      removeClosedListener();
    };
  }, [applyCandidateRepaint, repaintWindowSessionId]);

  const openCandidateRepaint = async (taskId: string, candidate: SeatCoverCandidate, fileName: string) => {
    const repaintBridge = window.jackyDesktop?.repaintWindow;
    const fittingTask = state.fittingTasks.find(task => task.id === taskId);
    const references = fittingTask ? (
      fittingTask.seatScope === 'front'
        ? state.frontCoverImages
        : fittingTask.seatScope === 'rear'
          ? state.rearCoverImages
          : [...state.frontCoverImages, ...state.rearCoverImages]
    ).slice(0, 6).map(image => ({ id: image.id, name: image.name, dataUrl: image.dataUrl, mimeType: image.mimeType })) : [];
    const fallbackSource = candidate.imageUrl || candidate.imageRef;
    let sourceDataUrl = fallbackSource;
    try {
      sourceDataUrl = await blobToDataUrl(await resolveSeatCoverImageBlob(candidate.imageRef, candidate.imageUrl));
    } catch {
      // data URLs and already-resolved image URLs can be passed through directly.
    }
    const target = { taskId, candidateId: candidate.id, sourceUrl: sourceDataUrl, fileName };
    if (!repaintBridge) {
      setCandidateRepaintTarget(target);
      return;
    }
    try {
      const result = await repaintBridge.open({ sourceDataUrl, fileName, hasApiKey, references });
      if (!result.ok || !result.sessionId) throw new Error(result.error || '独立重绘窗口打开失败');
      setCandidateRepaintTarget(target);
      setRepaintWindowSessionId(result.sessionId);
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '独立重绘窗口打开失败', 'error');
      setCandidateRepaintTarget(target);
    }
  };

  const openProjectNameDialog = (projectId: string, mode: 'create' | 'rename', currentName = '') => {
    setProjectNameDraft(mode === 'create' && currentName === '未命名座套项目' ? '' : currentName);
    setProjectNameDialog({ projectId, mode });
  };

  const createAndNameProject = () => {
    const projectId = projectActions.createProject();
    openProjectNameDialog(projectId, 'create');
  };

  const saveProjectName = () => {
    if (!projectNameDialog) return;
    const name = projectNameDraft.trim();
    if (!name) {
      showToast?.('请输入项目名称', 'info');
      return;
    }
    projectActions.renameProject(projectNameDialog.projectId, name);
    setProjectNameDialog(null);
    setProjectNameDraft('');
    showToast?.(projectNameDialog.mode === 'create' ? '项目已创建' : '项目已重命名', 'success');
  };

  const cancelProjectNameDialog = () => {
    if (projectNameDialog?.mode === 'create' && projects.length > 1) {
      projectActions.deleteProject(projectNameDialog.projectId);
    }
    setProjectNameDialog(null);
    setProjectNameDraft('');
  };

  const handleImportProject = async (file: File) => {
    try {
      await projectActions.importProject(file);
      showToast?.('座套项目导入成功', 'success');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '座套项目导入失败', 'error');
    }
  };

  return (
    <div className="space-y-4 pb-8">
      <header className="rounded-2xl border border-border/70 bg-card/80 p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><div className="flex items-center gap-2"><Images className="size-5 text-primary" /><h2 className="text-lg font-semibold">座套生成</h2><Badge variant="secondary">{SEAT_COVER_ANGLE_PRESETS.length} 个预设角度</Badge></div><p className="mt-1 text-xs text-muted-foreground">先生成指定角度的原车内饰，再用可选座椅蒙版生成前排、后排或全车座套上椅效果。</p></div>
          <div className="flex rounded-xl bg-muted p-1">{([['angles', '原车角度生成'], ['fitting', '座套上椅']] as Array<[SeatCoverStage, string]>).map(([value, label]) => <button key={value} type="button" onClick={() => patchState({ stage: value })} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${state.stage === value ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}>{label}</button>)}</div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-background/60 p-2">
          <select value={activeProjectId} disabled={!hydrated || hasRunningTasks} onChange={event => projectActions.switchProject(event.target.value)} className="h-9 min-w-52 rounded-lg border bg-background px-2 text-sm" title={hasRunningTasks ? '任务进行中时不能切换项目' : '切换项目'}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          <Button size="sm" variant="outline" disabled={!hydrated || hasRunningTasks} onClick={createAndNameProject}><FolderPlus className="size-4" />新建</Button>
          <Button size="sm" variant="outline" disabled={!hydrated || !activeProject || hasRunningTasks} onClick={() => activeProject && openProjectNameDialog(activeProject.id, 'rename', activeProject.name)}><Pencil className="size-4" />重命名</Button>
          <Button size="sm" variant="outline" disabled={!hydrated || !activeProject || hasRunningTasks} onClick={() => activeProject && projectActions.duplicateProject(activeProject.id)}><Copy className="size-4" />复制</Button>
          <Button size="sm" variant="outline" disabled={!activeProject} onClick={() => { if (!activeProject) return; void projectActions.exportProject(activeProject.id).then(() => showToast?.('项目已导出到下载目录', 'success')).catch(error => showToast?.(error instanceof Error ? error.message : '项目导出失败', 'error')); }}><FileDown className="size-4" />导出</Button>
          <Button size="sm" variant="outline" disabled={!hydrated || hasRunningTasks} onClick={() => projectImportRef.current?.click()}><FileUp className="size-4" />导入</Button>
          <input ref={projectImportRef} type="file" accept=".json,.jacky-seat-project.json,application/json" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void handleImportProject(file); event.target.value = ''; }} />
          <Button size="sm" variant="ghost" className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={!hydrated || projects.length <= 1 || !activeProject || hasRunningTasks} onClick={() => { if (activeProject && window.confirm(`确定删除项目“${activeProject.name}”吗？`)) projectActions.deleteProject(activeProject.id); }}><Trash2 className="size-4" />删除项目</Button>
          <span className="w-full text-[11px] text-muted-foreground">所有上传资料、任务、候选、蒙版和配置都会自动保存，重启软件后可继续。</span>
        </div>
      </header>

      {state.stage === 'angles' ? <>
        <section className="grid gap-3 rounded-2xl border border-border/70 bg-card/70 p-4 md:grid-cols-3">
          <label className="text-xs text-muted-foreground">车型 *<Input className="mt-1" value={state.vehicleModel} onChange={event => patchState({ vehicleModel: event.target.value })} placeholder="例如：烈马 C017 迷彩款" /></label>
          <label className="text-xs text-muted-foreground">年份 *<Input className="mt-1" value={state.vehicleYear} onChange={event => patchState({ vehicleYear: event.target.value })} placeholder="例如：2026" /></label>
          <label className="text-xs text-muted-foreground">配置/版本<Input className="mt-1" value={state.vehicleTrim} onChange={event => patchState({ vehicleTrim: event.target.value })} placeholder="可选" /></label>
        </section>
        <UploadBox title="原车内饰资料" hint="可上传十几或几十张；系统会按角度自动筛选整体、中控、对应排座椅和关键细节图。" images={state.vehicleImages} onUpload={files => void uploadImages(files, 'vehicleImages')} onRemove={id => removeImage('vehicleImages', id)} />
        <div className="grid gap-3 md:grid-cols-2">
          <UploadBox title="前排座套资料" hint="前排座套摄影图、细节图和平铺图。" images={state.frontCoverImages} onUpload={files => void uploadImages(files, 'frontCoverImages')} onRemove={id => removeImage('frontCoverImages', id)} />
          <UploadBox title="后排座套资料" hint="后排座套摄影图、细节图和平铺图。" images={state.rearCoverImages} onUpload={files => void uploadImages(files, 'rearCoverImages')} onRemove={id => removeImage('rearCoverImages', id)} />
        </div>
        <ConfigBox config={state.globalConfig} models={models} onChange={patchConfig} />
        <label className="block text-xs text-muted-foreground">额外要求<Textarea className="mt-1" rows={2} value={state.extraPrompt} onChange={event => patchState({ extraPrompt: event.target.value })} placeholder="例如：保持左舵结构、不要改变中控颜色" /></label>

        <section className="rounded-2xl border border-border/70 bg-card/70 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">每个角度的专用提示词都在可编辑文本文件中，保存后下次生成立即生效。</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { const bridge = window.jackyDesktop?.seatCoverPrompts; if (!bridge) return showToast?.('桌面版才能直接打开提示词文件夹', 'info'); void bridge.openDirectory().then(result => { if (!result.ok) showToast?.(result.error || '提示词文件夹打开失败', 'error'); }); }}><FolderOpen className="size-4" />打开提示词文件夹</Button><Button size="sm" variant="outline" onClick={() => patchState({ selectedPresetIds: SEAT_COVER_ANGLE_PRESETS.map(preset => preset.id) })}>全选</Button><Button size="sm" variant="ghost" onClick={() => patchState({ selectedPresetIds: [] })}>清空</Button></div></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{SEAT_COVER_ANGLE_PRESETS.map(preset => {
            const selected = state.selectedPresetIds.includes(preset.id);
            return <div key={preset.id} className="min-w-0 space-y-1">
              <button type="button" onClick={() => patchState({ selectedPresetIds: selected ? state.selectedPresetIds.filter(id => id !== preset.id) : [...state.selectedPresetIds, preset.id] })} className={`w-full overflow-hidden rounded-xl border text-left ${selected ? 'border-primary ring-2 ring-primary/25' : 'border-border/70'}`}><div className="relative aspect-[4/3] bg-muted"><img src={preset.imagePath} alt={preset.name} className="h-full w-full object-cover" /><span className={`absolute right-2 top-2 flex size-6 items-center justify-center rounded-full ${selected ? 'bg-primary text-primary-foreground' : 'bg-black/50 text-white'}`}>{selected ? <Check className="size-4" /> : <Plus className="size-4" />}</span></div><div className="p-2"><div className="truncate text-xs font-medium">{preset.name}</div><div className="mt-1 text-[10px] text-muted-foreground">{scopeText(preset.seatScope)}</div></div></button>
              <Button size="sm" variant="ghost" className="h-7 w-full text-[11px]" onClick={() => void openPromptEditor(preset)} disabled={promptEditorLoading}><Pencil className="size-3" />编辑提示词</Button>
            </div>;
          })}</div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/55 p-3"><div className="text-xs"><div className="font-medium">任务量预估</div><div className="mt-1 text-muted-foreground">已选择/建立 {angleTaskEstimate} 个角度 · 每个角度 {state.globalConfig.parallelCount} 张 · 预计 {angleTaskEstimate} 条任务，共 {angleImageEstimate} 张图片</div></div><div className="flex gap-2"><Button variant="outline" onClick={createAngleTasks}><Plus className="size-4" />建立角度任务</Button><Button onClick={runAllAngles} disabled={!state.angleTasks.length && !state.selectedPresetIds.length}>一键生成全部</Button></div></div>
        </section>

        {state.angleTasks.length > 0 && <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold">按角度分类的任务</h3><p className="text-xs text-muted-foreground">失败候选可单张补生成；一键生成不会重复执行已经全部成功的角度。</p></div><Button onClick={prepareFitting}><ChevronRight className="size-4" />下一步：座套上椅</Button></div>
          {state.angleTasks.map((task, taskIndex) => {
            const accent = getTaskAccent(task.presetName, taskIndex);
            const preset = SEAT_COVER_ANGLE_PRESETS.find(item => item.id === task.presetId);
            const references = preset ? selectVehicleReferences(state.globalConfig.model, state.vehicleImages, preset, task.referenceSelectionMode === 'manual' ? task.referenceImageIds : undefined) : [];
            const retryable = hasRetryableCandidates(normalizeCandidateSlots(task.candidates, state.globalConfig.parallelCount, task.id));
            return <article key={task.id} className="relative overflow-hidden rounded-2xl border border-l-4 border-border/70 bg-card/70 p-4 shadow-sm" style={{ borderLeftColor: accent.solid, backgroundImage: accent.background }}>
              <div className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: accent.solid }} />
              <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-2"><span className="flex size-8 shrink-0 items-center justify-center rounded-xl text-xs font-bold text-white shadow-sm" style={{ backgroundColor: accent.solid }}>{String(taskIndex + 1).padStart(2, '0')}</span><div><h4 className="font-semibold">{task.presetName}</h4></div><Badge variant="outline">{scopeText(task.seatScope)}</Badge><Badge variant={task.status === 'failed' ? 'destructive' : 'secondary'}>{statusText(task.status)}</Badge></div><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setReferenceEditorTaskId(task.id)}><ScanSearch className="size-4" />参考图 {references.length}/{state.vehicleImages.length}</Button><Button size="sm" disabled={task.status === 'queued' || task.status === 'generating'} onClick={() => void runAngleTask(task.id)}>{task.status === 'completed' && !retryable ? <RefreshCw className="size-4" /> : <Images className="size-4" />}{task.status === 'completed' && !retryable ? '重新生成整组' : task.candidates.some(candidate => candidateStatus(candidate) === 'failed') ? '重试失败项' : '生成'}</Button><Button size="icon-sm" variant="ghost" disabled={task.status === 'queued' || task.status === 'generating'} onClick={() => void removeAngleTask(task)} aria-label="删除原车角度任务" title="删除原车角度任务"><Trash2 className="size-4 text-destructive" /></Button></div></div>
              
              {task.error && <p className="mt-2 text-xs text-destructive">{task.error}</p>}
              {task.candidates.length > 0 && <div className="mt-3">{renderCandidates(task.id, task.candidates, true)}</div>}
            </article>;
          })}
        </section>}
      </> : <>
        <div className="grid gap-3 md:grid-cols-2">
          <UploadBox title="前排座套资料" hint="继承自第一阶段，也可继续补充。" images={state.frontCoverImages} onUpload={files => void uploadImages(files, 'frontCoverImages')} onRemove={id => removeImage('frontCoverImages', id)} />
          <UploadBox title="后排座套资料" hint="继承自第一阶段，也可继续补充。" images={state.rearCoverImages} onUpload={files => void uploadImages(files, 'rearCoverImages')} onRemove={id => removeImage('rearCoverImages', id)} />
        </div>
        <section
          aria-label="座套底图上传区域"
          tabIndex={0}
          onDragEnter={event => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setCustomBaseDragOver(true); }}
          onDragOver={event => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setCustomBaseDragOver(true); }}
          onDragLeave={event => { event.preventDefault(); event.stopPropagation(); if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setCustomBaseDragOver(false); }}
          onDrop={event => {
            event.preventDefault();
            event.stopPropagation();
            setCustomBaseDragOver(false);
            const files = Array.from(event.dataTransfer.files).filter(file => file.type.startsWith('image/'));
            if (files.length) void addCustomFittingBases(files);
          }}
          onPaste={event => {
            const files = getClipboardImageFiles(event.clipboardData);
            if (!files.length) return;
            event.preventDefault();
            event.stopPropagation();
            void addCustomFittingBases(files);
          }}
          className={cn('relative rounded-2xl border border-dashed p-4 transition-colors', customBaseDragOver && 'border-primary bg-primary/10 ring-2 ring-primary/20')}
        >
          {customBaseDragOver && <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-background/90 text-sm font-medium text-primary">松开以上传座套底图</div>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><h3 className="text-sm font-semibold">自行上传座套底图</h3><p className="text-xs text-muted-foreground">每张图片会建立为一个独立任务；支持点击、拖拽或 Ctrl+V 上传。</p></div>
            <label className="cursor-pointer rounded-lg border px-3 py-2 text-xs"><Upload className="mr-1 inline size-3.5" />上传底图<input type="file" multiple accept="image/*" className="hidden" onChange={event => { const files = Array.from(event.target.files || []).filter(file => file.type.startsWith('image/')); if (files.length) void addCustomFittingBases(files); event.target.value = ''; }} /></label>
          </div>
        </section>
        <ConfigBox config={state.globalConfig} models={models} onChange={patchConfig} />
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/70 p-4"><div className="text-xs"><div className="font-medium">任务量预估</div><div className="mt-1 text-muted-foreground">已建立 {fittingTaskEstimate} 条座套任务 · 预计共生成 {fittingImageEstimate} 张图片；单任务自定义张数优先于全局设置。</div></div><Button onClick={runAllFitting} disabled={!state.fittingTasks.length}>一键生成全部座套效果</Button></div>
        <section className="space-y-3">{state.fittingTasks.length === 0 ? <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">还没有座套任务，请返回上一步勾选结果，或上传自己的底图。</div> : state.fittingTasks.map((task, taskIndex) => {
          const accent = getTaskAccent(task.angleName, taskIndex);
          const effective = { ...state.globalConfig, ...(task.customConfig || {}) };
          const retryable = hasRetryableCandidates(normalizeCandidateSlots(task.candidates, effective.parallelCount, task.id));
          return <article key={task.id} className="relative overflow-hidden rounded-2xl border border-l-4 border-border/70 bg-card/70 p-4 shadow-sm" style={{ borderLeftColor: accent.solid, backgroundImage: accent.background }}>
            <div className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: accent.solid }} />
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-2"><span className="flex size-8 shrink-0 items-center justify-center rounded-xl text-xs font-bold text-white shadow-sm" style={{ backgroundColor: accent.solid }}>{String(taskIndex + 1).padStart(2, '0')}</span><div><span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">座套上椅任务</span><h4 className="font-semibold">{task.angleName}</h4></div><Badge variant="outline">{scopeText(task.seatScope)}</Badge><Badge variant={task.status === 'failed' ? 'destructive' : 'secondary'}>{statusText(task.status)}</Badge>{task.maskEnabled && task.maskDataUrl && <Badge variant="secondary">座椅蒙版已启用</Badge>}</div><div className="flex flex-wrap items-center gap-1"><Button variant="outline" size="sm" disabled={!task.baseImageUrl || task.status === 'queued' || task.status === 'generating'} onClick={() => setMaskEditorTaskId(task.id)}><ScanSearch className="size-4" />{task.maskDataUrl ? '编辑蒙版' : '识别座椅'}</Button><Button variant="outline" size="sm" disabled={task.status === 'queued' || task.status === 'generating'} onClick={() => void runFittingTask(task.id)}>{task.status === 'completed' && !retryable ? <RefreshCw className="size-4" /> : <Images className="size-4" />}{task.status === 'completed' && !retryable ? '重新生成整组' : task.candidates.some(candidate => candidateStatus(candidate) === 'failed') ? '重试失败项' : '生成'}</Button><Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={task.status === 'queued' || task.status === 'generating'} onClick={() => void removeFittingTask(task)}><Trash2 className="size-4" />删除</Button></div></div>
            <div className="mt-3 grid gap-3 lg:grid-cols-[190px_1fr]"><button type="button" onClick={() => task.baseImageUrl && setLightbox(task.baseImageUrl)} className="relative aspect-[4/3] overflow-hidden rounded-xl border bg-muted">{task.baseImageUrl ? <img src={task.baseImageUrl} alt={task.angleName} className="h-full w-full object-cover" /> : <span className="text-xs text-muted-foreground">底图准备中</span>}{task.maskEnabled && task.maskDataUrl && <img src={task.maskDataUrl} alt="座椅蒙版" className="pointer-events-none absolute inset-0 h-full w-full object-fill opacity-45 mix-blend-screen" />}</button><div className="space-y-3"><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <label className="text-[11px] text-muted-foreground">座套区域<select value={task.seatScope} onChange={event => patchFittingTask(task.id, { seatScope: event.target.value as SeatCoverScope })} className="mt-1 h-8 w-full rounded-lg border bg-background px-2 text-xs"><option value="front">前排</option><option value="rear">后排</option><option value="both">前排 + 后排</option></select></label>
              <label className="text-[11px] text-muted-foreground">单任务模型<select value={task.customConfig?.model || ''} onChange={event => patchFittingTask(task.id, { customConfig: { ...(task.customConfig || {}), model: event.target.value ? event.target.value as ModelId : undefined } })} className="mt-1 h-8 w-full rounded-lg border bg-background px-2 text-xs"><option value="">继承全局</option>{models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label>
              <label className="text-[11px] text-muted-foreground">单任务张数<select value={task.customConfig?.parallelCount || ''} onChange={event => patchFittingTask(task.id, { customConfig: { ...(task.customConfig || {}), parallelCount: event.target.value ? Number(event.target.value) as SeatCoverGenerationConfig['parallelCount'] : undefined } })} className="mt-1 h-8 w-full rounded-lg border bg-background px-2 text-xs"><option value="">继承全局</option>{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count} 张</option>)}</select></label>
              <label className="text-[11px] text-muted-foreground">单任务分辨率<select value={task.customConfig?.outputSize || ''} onChange={event => patchFittingTask(task.id, { customConfig: { ...(task.customConfig || {}), outputSize: event.target.value ? event.target.value as SeatCoverGenerationConfig['outputSize'] : undefined } })} className="mt-1 h-8 w-full rounded-lg border bg-background px-2 text-xs"><option value="">继承全局</option>{['1K', '2K', '4K'].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
            </div><div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground"><span>当前配置：{effective.outputSize} · {effective.parallelCount} 张 · {effective.model}</span>{task.maskDataUrl && <label className="flex items-center gap-1.5"><input type="checkbox" checked={Boolean(task.maskEnabled)} onChange={event => patchFittingTask(task.id, { maskEnabled: event.target.checked })} />只重绘座椅蒙版区域</label>}</div>{task.error && <p className="text-xs text-destructive">{task.error}</p>}{task.candidates.length > 0 && renderCandidates(task.id, task.candidates, false)}</div></div>
          </article>;
        })}</section>
      </>}

      <Dialog open={Boolean(projectNameDialog)} onOpenChange={open => { if (!open) cancelProjectNameDialog(); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{projectNameDialog?.mode === 'create' ? '新建座套项目' : '重命名座套项目'}</DialogTitle>
            <DialogDescription>{projectNameDialog?.mode === 'create' ? '输入项目名称后创建并切换到新项目。' : '修改当前项目的显示名称，项目中的资料和任务不会改变。'}</DialogDescription>
          </DialogHeader>
          <form onSubmit={event => { event.preventDefault(); saveProjectName(); }} className="space-y-4">
            <label className="block text-xs font-medium text-muted-foreground">项目名称<Input autoFocus className="mt-1" value={projectNameDraft} onChange={event => setProjectNameDraft(event.target.value)} placeholder="例如：丰田凯美瑞-2024" maxLength={80} /></label>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={cancelProjectNameDialog}>取消</Button>
              <Button type="submit" disabled={!projectNameDraft.trim()}>{projectNameDialog?.mode === 'create' ? '创建项目' : '保存名称'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {promptEditor && <PromptTemplateEditor
        key={promptEditor.preset.id}
        open
        angleName={promptEditor.preset.name}
        value={promptEditor.value}
        defaultValue={promptEditor.defaultValue}
        preview={promptEditorPreview}
        onOpenChange={open => { if (!open) setPromptEditor(null); }}
        onReset={() => setPromptEditor(current => current ? { ...current, value: current.defaultValue } : current)}
        onDraftChange={value => setPromptEditor(current => current ? { ...current, value } : current)}
        onSave={async content => {
          const result = await saveSeatCoverAnglePrompt(promptEditor.preset.name, content);
          if (!result.ok) throw new Error(result.error || '提示词保存失败');
          setPromptEditor(current => current ? { ...current, value: content } : current);
        }}
        showToast={showToast}
      />}

      {referenceEditorTask && referenceEditorPreset && <div className="fixed inset-0 z-[105] flex items-center justify-center bg-black/70 p-4" onMouseDown={event => { if (event.target === event.currentTarget) finishReferenceEditing(); }}><div className="max-h-[90dvh] w-full max-w-5xl overflow-auto rounded-2xl border bg-background p-4 shadow-2xl"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">调整参考图 · {referenceEditorTask.presetName}</h3><p className="mt-1 text-xs text-muted-foreground">当前模型最多使用 {referenceLimit} 张原车资料图，预设角度图固定作为第 1 张主构图输入发送（不是封面），原车资料图排在后面。已选 {displayedReferenceIds.length}/{referenceLimit} 张（当前共有 {state.vehicleImages.length} 张原车资料图）。</p></div><button type="button" className="rounded-full p-2 hover:bg-muted" onClick={finishReferenceEditing}><X className="size-5" /></button></div><div className="mt-3 flex gap-2"><Button size="sm" variant="outline" onClick={() => patchAngleTask(referenceEditorTask.id, { referenceSelectionMode: 'auto', referenceImageIds: undefined })}><ScanSearch className="size-4" />恢复自动筛选</Button><span className="self-center text-xs text-muted-foreground">{referenceEditorPreset.name.startsWith('单品') ? '单品角度自动只选择对应座椅和细节图，并排除中控/驾驶舱场景，减少背景污染。' : '点击图片可手动增删；自动模式会优先整体图、中控、对应排座椅和关键细节。'}</span></div><div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{referenceScores.map(item => { const selected = displayedReferenceIds.includes(item.image.id); return <button key={item.image.id} type="button" onClick={() => toggleReferenceImage(item.image.id)} className={`overflow-hidden rounded-xl border text-left ${selected ? 'border-primary ring-2 ring-primary/25' : 'border-border/70'}`}><div className="relative aspect-[4/3] bg-muted"><img src={item.image.preview || item.image.dataUrl} alt={item.image.name} className="h-full w-full object-cover" /><span className={`absolute right-2 top-2 flex size-6 items-center justify-center rounded-full ${selected ? 'bg-primary text-primary-foreground' : 'bg-black/50 text-white'}`}>{selected ? <Check className="size-4" /> : <Plus className="size-4" />}</span></div><div className="p-2"><div className="truncate text-xs font-medium">{item.image.name}</div><div className="mt-1 line-clamp-2 text-[10px] text-muted-foreground">{item.reasons.join(' · ')}</div></div></button>; })}</div><div className="mt-4 flex justify-end"><Button onClick={finishReferenceEditing}>完成</Button></div></div></div>}

      {candidateRepaintTarget && !repaintWindowSessionId && <div className="fixed inset-0 z-[130] flex flex-col bg-background">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-card px-4 py-3 shadow-sm">
          <div><div className="flex items-center gap-2"><WandSparkles className="size-5 text-primary" /><h3 className="font-semibold">座套结果局部重绘</h3><Badge variant="secondary">{candidateRepaintTask?.angleName || '座套候选'}</Badge></div><p className="mt-1 text-xs text-muted-foreground">涂抹头枕、缝线、包边等有问题的局部区域；相关座套资料已自动继承为外观参考。</p></div>
          <Button variant="outline" onClick={() => setCandidateRepaintTarget(null)}><X className="size-4" />关闭</Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <AdvancedRepaintWorkspace
            key={`${candidateRepaintTarget.taskId}:${candidateRepaintTarget.candidateId}`}
            wideMode
            hasApiKey={hasApiKey}
            onConfigureApiKey={onConfigureApiKey}
            showToast={showToast}
            initialSourceDataUrl={candidateRepaintTarget.sourceUrl}
            initialSourceFileName={candidateRepaintTarget.fileName}
            initialReferences={candidateRepaintReferences}
            onApplyResult={applyCandidateRepaint}
          />
        </div>
      </div>}

      {maskEditorTask?.baseImageUrl && <SeatMaskEditor sourceUrl={maskEditorTask.baseImageUrl} scope={maskEditorTask.seatScope} initialMaskDataUrl={maskEditorTask.maskDataUrl} onCancel={() => setMaskEditorTaskId(null)} onSave={maskDataUrl => { patchFittingTask(maskEditorTask.id, { maskDataUrl, maskEnabled: true }); setMaskEditorTaskId(null); showToast?.('座椅蒙版已保存并启用', 'success'); }} />}
      {uploading && <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-xl border bg-background px-3 py-2 text-xs shadow-lg"><Loader2 className="size-4 animate-spin" />正在处理图片…</div>}
      {lightbox && <SeatCoverImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

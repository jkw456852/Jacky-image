'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, CloudUpload, FileText, ImagePlus, Info, Loader2, Save, Sparkles, X, Zap } from 'lucide-react';
import { AttachmentChips } from './AttachmentChips';
import { MaskUploadControl } from './MaskUploadControl';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MissingApiKeyDialog } from '@/components/MissingApiKeyDialog';
import { QuickPromptDialog } from '@/components/QuickPromptDialog';
import { PromptOptimizeDialog } from '@/components/PromptOptimizeDialog';
import { AgentAssetPickerDialog, AgentTextAssetPickerDialog } from '@/components/agent/AgentAssetPickerDialog';
import { GenerationParamsBar, type GenerationParamsValue } from '@/components/GenerationParamsBar';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import { streamPromptOptimize, type StreamPromptOptimizeHandle } from '@/lib/prompt-optimize-client';
import { loadJsonFromStorage, saveJsonToStorage } from '@/lib/settings-storage';
import { requireDefaultConfiguredTextModel } from '@/lib/model-endpoints';
import { addTextAsset, getAssetBlob, type ImageAsset, type TextAsset } from '@/lib/asset-store';
import { MODEL_IMAGE_LIMITS, MODEL_OPTIONS, type ModelId } from '@/lib/gemini-config';
import {
  DEFAULT_GPT_IMAGE_ADVANCED_PARAMS,
  detectClosestAspectRatio,
  findReferenceCapableModel,
  getAspectRatioOptions,
  getCustomSizeMaxSide,
  getGptImageAdvancedParamsForModel,
  getModelMaxRefImages,
  getValidOutputSizes,
  normalizeCustomImageSize,
  normalizeModel,
  supportsCustomSize,
  supportsImageSearchGrounding,
  supportsReferenceImages,
  supportsWebSearchGrounding,
  type GptImageAdvancedParams,
  type GptImageBackground,
  type GptImageQuality,
  type GptImageStyle,
  type ParallelCount,
} from '@/lib/model-capabilities';
import { prepareUploadImage, getOptimizationBadge } from '@/lib/upload-image-cache';
import {
  createMaskDraft,
  getMaskStrategyForModel,
  processMaskForTarget,
  type MaskDraft,
  type MaskSourceMode,
  type ProcessedMask,
} from '@/lib/mask-utils';
import { MAX_UPLOAD_SIZE_BYTES } from '@/lib/constants';
import { dispatchImageActionToast } from '@/lib/image-actions';
import type { AspectRatio, OutputSize, RefImageData } from '@/lib/job-store';
import type { ImageFormSettings } from '@/lib/form-settings';
import type { ImageToImageSubmitInput, TextToImageSubmitInput } from '@/lib/workspace-task-service';
import { cn } from '@/lib/utils';

const WORKBENCH_SETTINGS_KEY = 'jacky-image-generation-settings';
const T2I_SETTINGS_KEY = 'jacky-t2i-settings';
const I2I_SETTINGS_KEY = 'jacky-i2i-settings';
const MAX_ASSET_IMPORTS = 5;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  jfif: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function normalizeSelectedImageFile(file: File): File | null {
  if (file.type.startsWith('image/')) return file;
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const mimeType = IMAGE_MIME_BY_EXTENSION[extension];
  if (!mimeType) return null;
  return new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
}

type WorkbenchMode = 'text-to-image' | 'image-to-image';
type WorkbenchSettings = ImageFormSettings;

interface UploadedFile {
  id: string;
  name: string;
  preview: string;
  dataUrl: string;
  mimeType: string;
  badge?: string;
}

interface ImageGenerationWorkbenchProps {
  wideMode?: boolean;
  onSubmitText: (data: TextToImageSubmitInput) => void;
  onSubmitImage: (data: ImageToImageSubmitInput) => void;
  disabled?: boolean;
  onDraftConsumed?: () => void;
  onConfigureApiKey?: () => void;
  initialData?: {
    prompt?: string;
    outputSize?: OutputSize;
    customSize?: string;
    aspectRatio?: AspectRatio;
    temperature?: number;
    webSearchEnabled?: boolean;
    imageSearchEnabled?: boolean;
    model?: ModelId;
    gptImageQuality?: GptImageQuality;
    gptImageStyle?: GptImageStyle;
    gptImageBackground?: GptImageBackground;
    parallelCount?: ParallelCount;
    refImages?: RefImageData[];
  };
  referenceDraft?: {
    id: number;
    refImages: RefImageData[];
    prompt?: string;
  } | null;
}

function hasStoredSettings(settings: Partial<WorkbenchSettings>): boolean {
  return Object.keys(settings).length > 0;
}

function getSettingsFallback(preferImageSettings: boolean): Partial<WorkbenchSettings> {
  const saved = loadJsonFromStorage<WorkbenchSettings>(WORKBENCH_SETTINGS_KEY);
  if (hasStoredSettings(saved)) return saved;

  const primary = loadJsonFromStorage<WorkbenchSettings>(preferImageSettings ? I2I_SETTINGS_KEY : T2I_SETTINGS_KEY);
  if (hasStoredSettings(primary)) return primary;

  return loadJsonFromStorage<WorkbenchSettings>(preferImageSettings ? T2I_SETTINGS_KEY : I2I_SETTINGS_KEY);
}

export function ImageGenerationWorkbench({
  onSubmitText,
  onSubmitImage,
  disabled = false,
  onDraftConsumed,
  onConfigureApiKey,
  initialData,
  referenceDraft,
}: ImageGenerationWorkbenchProps) {
  const [prompt, setPrompt] = useState('');
  const [pendingFiles, setPendingFiles] = useState<UploadedFile[]>([]);
  const [maskDraft, setMaskDraft] = useState<MaskDraft | null>(null);
  const [processedMask, setProcessedMask] = useState<ProcessedMask | null>(null);
  const [maskLoading, setMaskLoading] = useState(false);
  const [maskError, setMaskError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const [model, setModel] = useState<ModelId>('gemini-3-pro-image-preview');
  const [outputSize, setOutputSize] = useState<OutputSize>('1K');
  const [customSize, setCustomSize] = useState<string | undefined>(undefined);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('1:1');
  const [temperature, setTemperature] = useState<number>(1);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [imageSearchEnabled, setImageSearchEnabled] = useState(false);
  const [gptImageAdvancedParams, setGptImageAdvancedParams] = useState<GptImageAdvancedParams>(DEFAULT_GPT_IMAGE_ADVANCED_PARAMS);
  const [parallelCount, setParallelCount] = useState<ParallelCount>(1);
  const [settingsReady, setSettingsReady] = useState(false);

  const [isDragOver, setIsDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [missingApiKeyDialogOpen, setMissingApiKeyDialogOpen] = useState(false);
  const [quickPromptOpen, setQuickPromptOpen] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [textAssetPickerOpen, setTextAssetPickerOpen] = useState(false);
  const [pendingTextAsset, setPendingTextAsset] = useState<TextAsset | null>(null);

  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizedText, setOptimizedText] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const optimizeHandleRef = useRef<StreamPromptOptimizeHandle | null>(null);
  const referenceImportBusyRef = useRef(false);

  const modelLimit = MODEL_IMAGE_LIMITS[model] || { max: getModelMaxRefImages(model), description: '最多 1 张参考图片' };
  const maxImages = modelLimit.max;
  const refsSupported = maxImages > 0;
  const maskStrategy = useMemo(() => getMaskStrategyForModel(model), [model]);
  const effectiveMaxImages = Math.max(0, maxImages - (maskDraft && maskStrategy.consumesImageSlot ? 1 : 0));
  const maskConsumesOverflow = Boolean(maskDraft && maskStrategy.consumesImageSlot && pendingFiles.length + 1 > maxImages);
  const currentMode: WorkbenchMode = pendingFiles.length > 0 ? 'image-to-image' : 'text-to-image';
  const autoLayoutLocked = outputSize === 'auto';
  const disabledMessage = '请先在设置中配置 Jacky API 密钥，配置完成后即可开始生成图片。';
  const referenceFallbackModel = refsSupported ? model : findReferenceCapableModel(model);
  const canAcceptReferences = Boolean(referenceFallbackModel);
  const availableReferenceSlots = referenceFallbackModel
    ? Math.max(0, getModelMaxRefImages(referenceFallbackModel) - (maskDraft && getMaskStrategyForModel(referenceFallbackModel).consumesImageSlot ? 1 : 0))
    : 0;

  const ensureReferenceModel = useCallback(() => {
    const currentMaxImages = getModelMaxRefImages(model);
    if (currentMaxImages > 0) {
      return {
        model,
        maxImages: currentMaxImages,
        strategy: getMaskStrategyForModel(model),
        outputSize,
      };
    }

    const switched = findReferenceCapableModel(model);
    if (!switched) return null;

    const switchedMaxImages = getModelMaxRefImages(switched);
    const nextSizes = getValidOutputSizes(switched);
    const nextSize = nextSizes.includes(outputSize) ? outputSize : nextSizes[0];
    setModel(switched);
    setOutputSize(nextSize);
    setWebSearchEnabled(current => supportsWebSearchGrounding(switched) && current);
    setImageSearchEnabled(current => supportsImageSearchGrounding(switched) && current);
    if (nextSize === 'auto') {
      setAspectRatio('auto');
      setCustomSize(undefined);
    } else {
      const ratios = getAspectRatioOptions(switched, nextSize).map(item => item.value);
      if (!ratios.includes(aspectRatio)) setAspectRatio(ratios[0] || '1:1');
      setCustomSize(current => supportsCustomSize(switched)
        ? normalizeCustomImageSize(current, getCustomSizeMaxSide(switched))
        : undefined);
    }
    setGptImageAdvancedParams(getGptImageAdvancedParamsForModel(switched, gptImageAdvancedParams));

    const label = MODEL_OPTIONS.find(option => option.value === switched)?.label || switched;
    dispatchImageActionToast(`已自动切换到支持参考图的模型：${label}`, 'info');
    return {
      model: switched,
      maxImages: switchedMaxImages,
      strategy: getMaskStrategyForModel(switched),
      outputSize: nextSize,
    };
  }, [aspectRatio, gptImageAdvancedParams, model, outputSize]);

  const handleParamsChange = useCallback((patch: Partial<GenerationParamsValue>) => {
    if (patch.model !== undefined) {
      setModel(patch.model);
      if (!supportsReferenceImages(patch.model)) {
        setPendingFiles((prev) => {
          if (prev.length > 0) {
            setUploadError('当前模型不支持参考图，已清除参考图和蒙版');
            return [];
          }
          return prev;
        });
        setMaskDraft(null);
        setProcessedMask(null);
        setMaskError(null);
      }
    }
    if (patch.outputSize !== undefined) setOutputSize(patch.outputSize);
    if ('customSize' in patch) setCustomSize(patch.customSize);
    if (patch.aspectRatio !== undefined) setAspectRatio(patch.aspectRatio);
    if (patch.temperature !== undefined) setTemperature(patch.temperature);
    if (patch.webSearchEnabled !== undefined) setWebSearchEnabled(patch.webSearchEnabled);
    if (patch.imageSearchEnabled !== undefined) setImageSearchEnabled(patch.imageSearchEnabled);
    if (patch.parallelCount !== undefined) setParallelCount(patch.parallelCount);
    if (patch.gptImageAdvancedParams !== undefined) setGptImageAdvancedParams(patch.gptImageAdvancedParams);
  }, []);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
  }, [prompt]);

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;

      const useInitial = Boolean(initialData);
      const saved = getSettingsFallback(Boolean(initialData?.refImages?.length));
      const nextModel = normalizeModel(useInitial && initialData?.model ? initialData.model : saved.model);
      const validSizes = getValidOutputSizes(nextModel);
      const nextOutputSize: OutputSize = useInitial && initialData?.outputSize && validSizes.includes(initialData.outputSize)
        ? initialData.outputSize
        : (saved.outputSize && validSizes.includes(saved.outputSize) ? saved.outputSize : validSizes[0]);
      const nextCustomSize = supportsCustomSize(nextModel) && nextOutputSize !== 'auto'
        ? normalizeCustomImageSize(useInitial ? initialData?.customSize : saved.customSize, getCustomSizeMaxSide(nextModel))
        : undefined;
      const validRatios = getAspectRatioOptions(nextModel, nextOutputSize).map(a => a.value);
      const nextAspectRatio: AspectRatio = useInitial && initialData?.aspectRatio && validRatios.includes(initialData.aspectRatio)
        ? initialData.aspectRatio
        : (saved.aspectRatio && validRatios.includes(saved.aspectRatio) ? saved.aspectRatio : (validRatios[0] || '1:1'));
      const nextTemperature = useInitial && typeof initialData?.temperature === 'number' && initialData.temperature >= 0 && initialData.temperature <= 2
        ? initialData.temperature
        : (typeof saved.temperature === 'number' && saved.temperature >= 0 && saved.temperature <= 2 ? saved.temperature : 1);
      const nextWebSearchEnabled = supportsWebSearchGrounding(nextModel)
        && Boolean(useInitial ? initialData?.webSearchEnabled : saved.webSearchEnabled);
      const nextImageSearchEnabled = supportsImageSearchGrounding(nextModel)
        && Boolean(useInitial ? initialData?.imageSearchEnabled : saved.imageSearchEnabled);
      const nextAdvancedParams = getGptImageAdvancedParamsForModel(nextModel, {
        quality: useInitial ? initialData?.gptImageQuality : saved.gptImageQuality,
        style: useInitial ? initialData?.gptImageStyle : saved.gptImageStyle,
        background: useInitial ? initialData?.gptImageBackground : saved.gptImageBackground,
      });
      const nextParallelCount: ParallelCount = useInitial && initialData?.parallelCount && [1, 2, 3, 4].includes(initialData.parallelCount)
        ? initialData.parallelCount
        : (saved.parallelCount && [1, 2, 3, 4].includes(saved.parallelCount) ? saved.parallelCount : 1);

      setModel(nextModel);
      setOutputSize(nextOutputSize);
      setCustomSize(nextCustomSize);
      setAspectRatio(nextAspectRatio);
      setTemperature(nextTemperature);
      setWebSearchEnabled(nextWebSearchEnabled);
      setImageSearchEnabled(nextImageSearchEnabled);
      setGptImageAdvancedParams(nextAdvancedParams);
      setParallelCount(nextParallelCount);
      if (useInitial) {
        setPrompt(initialData?.prompt || '');
        setPendingFiles((initialData?.refImages || []).map(img => ({
          id: img.id,
          name: img.name,
          preview: img.dataUrl,
          dataUrl: img.dataUrl,
          mimeType: img.mimeType,
          badge: img.badge || '已恢复',
        })));
      }

      setSettingsReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [initialData]);

  useEffect(() => {
    if (!settingsReady) return;
    saveJsonToStorage(WORKBENCH_SETTINGS_KEY, {
      model,
      outputSize,
      customSize,
      aspectRatio,
      temperature,
      webSearchEnabled,
      imageSearchEnabled,
      gptImageQuality: gptImageAdvancedParams.quality,
      gptImageStyle: gptImageAdvancedParams.style,
      gptImageBackground: gptImageAdvancedParams.background,
      parallelCount,
    });
  }, [model, outputSize, customSize, aspectRatio, temperature, webSearchEnabled, imageSearchEnabled, gptImageAdvancedParams, parallelCount, settingsReady]);

  const handleOptimize = useCallback(() => {
    const textModel = requireDefaultConfiguredTextModel('promptOptimize');
    if (!prompt.trim()) return;

    optimizeHandleRef.current?.abort();
    setOptimizedText('');
    setOptimizeError(null);
    setOptimizing(true);
    setOptimizeOpen(true);

    const images = pendingFiles.map(f => ({ dataUrl: f.dataUrl, mimeType: f.mimeType }));
    const handle = streamPromptOptimize(
      { modelConfigId: textModel.id, model: textModel.id, mode: currentMode, prompt: prompt.trim(), ...(images.length > 0 ? { images } : {}) },
      {
        onDelta(token) { setOptimizedText(prev => prev + token); },
        onDone() { setOptimizing(false); },
        onError(err) { setOptimizeError(err.message); setOptimizing(false); },
      },
      textModel.baseUrl,
    );
    optimizeHandleRef.current = handle;
  }, [currentMode, pendingFiles, prompt]);

  const handleOptimizeCancel = useCallback(() => {
    optimizeHandleRef.current?.abort();
    optimizeHandleRef.current = null;
    setOptimizing(false);
    setOptimizedText('');
    setOptimizeError(null);
  }, []);

  const handleOptimizeAccept = useCallback(() => {
    if (optimizedText) setPrompt(optimizedText);
    optimizeHandleRef.current = null;
    setOptimizedText('');
    setOptimizeError(null);
  }, [optimizedText]);

  const consumedDraftRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!referenceDraft?.refImages.length) return;
    if (consumedDraftRef.current === referenceDraft.id) return;
    consumedDraftRef.current = referenceDraft.id;
    if (referenceDraft.prompt) {
      setPrompt(referenceDraft.prompt);
    }

    let activeModel = model;
    let activeMax = maskDraft && maskStrategy.consumesImageSlot ? effectiveMaxImages : maxImages;
    if (!supportsReferenceImages(activeModel) || activeMax <= 0) {
      const switched = findReferenceCapableModel(activeModel);
      if (!switched) {
        setUploadError('当前没有支持参考图的模型，请先在设置中配置可编辑模型');
        onDraftConsumed?.();
        return;
      }
      activeModel = switched;
      activeMax = getModelMaxRefImages(switched);
      setModel(switched);
      const nextSizes = getValidOutputSizes(switched);
      const nextSize = nextSizes.includes(outputSize) ? outputSize : nextSizes[0];
      setOutputSize(nextSize);
      if (nextSize === 'auto') {
        setAspectRatio('auto');
        setCustomSize(undefined);
      } else {
        const ratios = getAspectRatioOptions(switched, nextSize).map((item) => item.value);
        if (!ratios.includes(aspectRatio)) setAspectRatio(ratios[0] || '1:1');
        if (!supportsCustomSize(switched)) setCustomSize(undefined);
      }
      setGptImageAdvancedParams(getGptImageAdvancedParamsForModel(switched, gptImageAdvancedParams));
      const label = MODEL_OPTIONS.find((o) => o.value === switched)?.label || switched;
      dispatchImageActionToast(`已切换到支持参考图的模型：${label}`, 'info');
    }

    setPendingFiles((prev) => {
      const existingIds = new Set(prev.map((file) => file.id));
      const remainingSlots = Math.max(0, activeMax - prev.length);
      if (remainingSlots <= 0) {
        setUploadError(`${MODEL_OPTIONS.find((o) => o.value === activeModel)?.label} 最多支持 ${activeMax} 张参考图`);
        return prev;
      }
      const incoming: UploadedFile[] = referenceDraft.refImages
        .filter((img) => !existingIds.has(img.id))
        .slice(0, remainingSlots)
        .map((img) => ({
          id: img.id,
          name: img.name,
          preview: img.dataUrl,
          dataUrl: img.dataUrl,
          mimeType: img.mimeType,
          badge: img.badge || '参考',
        }));
      if (incoming.length < referenceDraft.refImages.length) {
        setUploadError(`${MODEL_OPTIONS.find((o) => o.value === activeModel)?.label} 最多支持 ${activeMax} 张参考图，已添加可容纳的图片`);
      } else {
        setUploadError(null);
      }
      return incoming.length > 0 ? [...prev, ...incoming] : prev;
    });
    onDraftConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- referenceDraft.id is the stable identity; refImages is consumed via ref guard
  }, [effectiveMaxImages, maskDraft, maskStrategy.consumesImageSlot, maxImages, model, onDraftConsumed, referenceDraft?.id]);

  const updateMaskDraft = useCallback((updates: Partial<MaskDraft>) => {
    setMaskDraft(current => current ? { ...current, ...updates } : current);
  }, []);

  const handleMaskFile = useCallback(async (file: File) => {
    const normalizedFile = normalizeSelectedImageFile(file);
    if (!normalizedFile) {
      setMaskError('请选择图像格式的蒙版文件');
      return;
    }
    if (!ensureReferenceModel()) {
      setMaskError('当前没有支持参考图和蒙版的模型，请先在设置中配置可编辑模型');
      return;
    }
    if (normalizedFile.size > MAX_UPLOAD_SIZE_BYTES) {
      setMaskError('蒙版文件不能超过 10MB');
      return;
    }
    setMaskLoading(true);
    setMaskError(null);
    setProcessedMask(null);
    try {
      setMaskDraft(await createMaskDraft(normalizedFile));
    } catch (error) {
      setMaskError(error instanceof Error ? error.message : '蒙版文件读取失败');
    } finally {
      setMaskLoading(false);
    }
  }, [ensureReferenceModel]);

  useEffect(() => {
    const targetDataUrl = pendingFiles[0]?.dataUrl || maskDraft?.originalDataUrl;
    if (!maskDraft || !targetDataUrl) {
      setProcessedMask(null);
      return;
    }

    let cancelled = false;
    setMaskLoading(true);
    setMaskError(null);
    void processMaskForTarget(maskDraft, targetDataUrl, maskStrategy)
      .then(mask => {
        if (!cancelled) setProcessedMask(mask);
      })
      .catch(error => {
        if (!cancelled) {
          setProcessedMask(null);
          setMaskError(error instanceof Error ? error.message : '蒙版转换失败');
        }
      })
      .finally(() => {
        if (!cancelled) setMaskLoading(false);
      });

    return () => { cancelled = true; };
  }, [maskDraft, maskStrategy, pendingFiles]);

  const processFiles = useCallback(async (fileList: FileList | File[]) => {
    const filesToProcess = Array.from(fileList)
      .map(normalizeSelectedImageFile)
      .filter((file): file is File => Boolean(file));
    if (filesToProcess.length === 0) {
      setUploadError('请选择受支持的图像文件');
      return;
    }

    const selection = ensureReferenceModel();
    if (!selection) {
      setUploadError('当前没有支持参考图的模型，请先在设置中配置可编辑模型');
      return;
    }

    const activeEffectiveMax = Math.max(0, selection.maxImages - (maskDraft && selection.strategy.consumesImageSlot ? 1 : 0));
    if (pendingFiles.length + filesToProcess.length > activeEffectiveMax) {
      const maskNote = maskDraft && selection.strategy.consumesImageSlot ? '（蒙版占用 1 个图片输入位）' : '';
      const limit = MODEL_IMAGE_LIMITS[selection.model] || {
        max: selection.maxImages,
        description: `最多 ${selection.maxImages} 张参考图片`,
      };
      const label = MODEL_OPTIONS.find(option => option.value === selection.model)?.label || selection.model;
      setUploadError(`${label} ${limit.description}${maskNote}`);
      return;
    }

    if (referenceImportBusyRef.current) {
      setUploadError('参考图正在处理中，请完成后再继续添加');
      return;
    }
    referenceImportBusyRef.current = true;
    setLoading(true);
    setUploadError(null);

    const newFiles: UploadedFile[] = [];
    const failedNames: string[] = [];
    let firstDetectedRatio: AspectRatio | null = null;
    const activeRatioOptions = getAspectRatioOptions(selection.model, selection.outputSize);

    for (const file of filesToProcess) {
      try {
        const optimized = await prepareUploadImage(file);
        if (optimized.processedSize > MAX_UPLOAD_SIZE_BYTES) {
          failedNames.push(`${file.name}（压缩后仍超过 10MB）`);
          continue;
        }

        if (!autoLayoutLocked && newFiles.length === 0 && pendingFiles.length === 0) {
          firstDetectedRatio = detectClosestAspectRatio(optimized.width, optimized.height, activeRatioOptions);
        }

        newFiles.push({
          id: optimized.id,
          name: optimized.name,
          preview: optimized.preview,
          dataUrl: optimized.dataUrl,
          mimeType: optimized.mimeType,
          badge: getOptimizationBadge(optimized.originalSize, optimized.processedSize, optimized.cacheHit),
        });
      } catch {
        failedNames.push(file.name);
      }
    }

    setPendingFiles(prev => {
      const existingIds = new Set(prev.map(file => file.id));
      const uniqueNew = newFiles.filter(file => !existingIds.has(file.id));
      const remainingSlots = Math.max(0, activeEffectiveMax - prev.length);
      const accepted = uniqueNew.slice(0, remainingSlots);
      return accepted.length > 0 ? [...prev, ...accepted] : prev;
    });

    if (firstDetectedRatio && pendingFiles.length === 0) {
      setAspectRatio(firstDetectedRatio);
    }
    if (failedNames.length > 0) {
      setUploadError(`以下图片读取失败：${failedNames.join('、')}`);
    }
    setLoading(false);
    referenceImportBusyRef.current = false;
  }, [autoLayoutLocked, ensureReferenceModel, maskDraft, pendingFiles.length]);

  const handleImportAssets = useCallback(async (selectedAssets: ImageAsset[]) => {
    if (selectedAssets.length === 0) return;

    const selection = ensureReferenceModel();
    if (!selection) {
      setUploadError('当前没有支持参考图的模型，请先在设置中配置可编辑模型');
      return;
    }

    const activeEffectiveMax = Math.max(0, selection.maxImages - (maskDraft && selection.strategy.consumesImageSlot ? 1 : 0));
    const remainingSlots = Math.max(0, activeEffectiveMax - pendingFiles.length);
    if (remainingSlots <= 0) {
      const label = MODEL_OPTIONS.find(option => option.value === selection.model)?.label || selection.model;
      setUploadError(`${label} 最多支持 ${selection.maxImages} 张图片输入`);
      return;
    }

    if (referenceImportBusyRef.current) {
      setUploadError('参考图正在处理中，请完成后再继续添加');
      return;
    }
    referenceImportBusyRef.current = true;
    setLoading(true);
    setUploadError(null);

    const importedFiles: UploadedFile[] = [];
    const failedNames: string[] = [];
    let firstDetectedRatio: AspectRatio | null = null;
    const activeRatioOptions = getAspectRatioOptions(selection.model, selection.outputSize);

    for (const asset of selectedAssets.slice(0, Math.min(remainingSlots, MAX_ASSET_IMPORTS))) {
      try {
        const blob = await getAssetBlob(asset.id);
        if (!blob) {
          failedNames.push(asset.name);
          continue;
        }

        const rawFile = new File([blob], asset.name, { type: asset.mimeType || blob.type, lastModified: Date.now() });
        const file = normalizeSelectedImageFile(rawFile);
        if (!file) {
          failedNames.push(asset.name);
          continue;
        }
        const optimized = await prepareUploadImage(file);

        if (optimized.processedSize > MAX_UPLOAD_SIZE_BYTES) {
          failedNames.push(`${asset.name}（压缩后仍超过 10MB）`);
          continue;
        }

        if (!autoLayoutLocked && importedFiles.length === 0 && pendingFiles.length === 0) {
          firstDetectedRatio = detectClosestAspectRatio(optimized.width, optimized.height, activeRatioOptions);
        }

        importedFiles.push({
          id: optimized.id,
          name: optimized.name,
          preview: optimized.preview,
          dataUrl: optimized.dataUrl,
          mimeType: optimized.mimeType,
          badge: '素材库',
        });
      } catch {
        failedNames.push(asset.name);
      }
    }

    setPendingFiles(prev => {
      const existingIds = new Set(prev.map(file => file.id));
      const uniqueImported = importedFiles.filter(file => !existingIds.has(file.id));
      const accepted = uniqueImported.slice(0, Math.max(0, activeEffectiveMax - prev.length));
      return accepted.length > 0 ? [...prev, ...accepted] : prev;
    });

    if (firstDetectedRatio && pendingFiles.length === 0) {
      setAspectRatio(firstDetectedRatio);
    }

    if (selectedAssets.length > remainingSlots) {
      setUploadError(`当前模型最多还能导入 ${remainingSlots} 张参考图，已导入可容纳的图片`);
    } else if (failedNames.length > 0) {
      setUploadError(`以下素材导入失败：${failedNames.join('、')}`);
    }
    setLoading(false);
    referenceImportBusyRef.current = false;
  }, [autoLayoutLocked, ensureReferenceModel, maskDraft, pendingFiles.length]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!disabled && !loading && e.dataTransfer.files.length > 0) {
      void processFiles(e.dataTransfer.files);
    }
  }, [disabled, processFiles]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) setIsDragOver(true);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void processFiles(e.target.files);
      e.target.value = '';
    }
  };

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (disabled || loading || !canAcceptReferences) return;
      const target = e.target as HTMLElement;
      if (!formRef.current?.contains(target)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        void processFiles(imageFiles);
      }
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [canAcceptReferences, disabled, loading, processFiles]);

  const handleRemovePending = useCallback((id: string) => {
    setPendingFiles(prev => prev.filter(f => f.id !== id));
  }, []);

  const applyTextAsset = useCallback((asset: TextAsset) => {
    setPrompt(asset.content);
    setPendingTextAsset(null);
  }, []);

  const handleTextAssetConfirm = useCallback((asset: TextAsset) => {
    if (prompt.trim() && prompt.trim() !== asset.content.trim()) {
      setPendingTextAsset(asset);
      return;
    }
    applyTextAsset(asset);
  }, [applyTextAsset, prompt]);

  const handleSavePromptAsset = useCallback(async () => {
    if (!prompt.trim()) return;
    try {
      await addTextAsset({
        content: prompt,
        sourceKind: currentMode,
        sourceLabel: '生图工作台',
      });
      dispatchImageActionToast('提示词素材已保存', 'success');
    } catch (error) {
      dispatchImageActionToast(error instanceof Error ? error.message : '保存提示词素材失败', 'error');
    }
  }, [currentMode, prompt]);

  const handleSubmit = () => {
    if (!prompt.trim() || disabled || loading || maskLoading) return;
    if (maskDraft && (!processedMask || pendingFiles.length === 0 || maskConsumesOverflow)) return;

    const modelWithBilling = model;
    if (pendingFiles.length > 0) {
      onSubmitImage({
        prompt: prompt.trim(),
        files: pendingFiles,
        outputSize,
        customSize,
        aspectRatio,
        temperature,
        webSearchEnabled,
        imageSearchEnabled,
        model: modelWithBilling,
        gptImageQuality: gptImageAdvancedParams.quality,
        gptImageStyle: gptImageAdvancedParams.style,
        gptImageBackground: gptImageAdvancedParams.background,
        parallelCount,
        mask: processedMask || undefined,
      });
    } else {
      onSubmitText({
        prompts: [prompt.trim()],
        outputSize,
        customSize,
        aspectRatio,
        temperature,
        webSearchEnabled,
        imageSearchEnabled,
        model: modelWithBilling,
        gptImageQuality: gptImageAdvancedParams.quality,
        gptImageStyle: gptImageAdvancedParams.style,
        gptImageBackground: gptImageAdvancedParams.background,
        parallelCount,
      });
    }

    setPendingFiles([]);
    setMaskDraft(null);
    setProcessedMask(null);
    setMaskError(null);
    setPrompt('');
    setUploadError(null);
    onDraftConsumed?.();
  };

  const handleClearDraft = () => {
    setPrompt('');
    setPendingFiles([]);
    setMaskDraft(null);
    setProcessedMask(null);
    setMaskError(null);
    setUploadError(null);
    onDraftConsumed?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const canSubmit = prompt.trim().length > 0
    && !disabled
    && !loading
    && !maskLoading
    && (!maskDraft || (pendingFiles.length > 0 && Boolean(processedMask) && !maskConsumesOverflow));
  const canClear = prompt.trim().length > 0 || pendingFiles.length > 0 || Boolean(maskDraft);

  return (
    <div ref={formRef} className="space-y-4">
      <div className="bg-muted/50 border border-border rounded-xl shadow-md">
        {disabled ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-4 px-4 py-8 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Info className="h-5 w-5" />
            </div>
            <div className="max-w-md">
              <p className="text-base font-medium text-foreground">API 密钥未配置</p>
              <p className="mt-2 text-sm text-muted-foreground">{disabledMessage}</p>
            </div>
            <Button onClick={() => setMissingApiKeyDialogOpen(true)}>配置</Button>
          </div>
        ) : (
          <>
            <div className="p-4 pb-2">
              <div className="flex gap-3">
                <div
                  onDrop={canAcceptReferences ? handleDrop : undefined}
                  onDragOver={canAcceptReferences ? handleDragOver : (event) => event.preventDefault()}
                  onDragLeave={() => setIsDragOver(false)}
                  className={cn(
                    'relative flex-[3] overflow-hidden rounded-xl border-2 border-dashed px-6 py-8 text-center transition-all',
                    !canAcceptReferences
                      ? 'cursor-not-allowed border-border/60 bg-muted/30 opacity-60'
                      : isDragOver
                        ? 'border-primary bg-primary/20'
                        : 'cursor-pointer border-primary/30 bg-primary/5 hover:border-primary/50 hover:bg-primary/10',
                  )}
                >
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleFileSelect}
                    disabled={loading || !canAcceptReferences}
                    className="absolute inset-0 h-full w-full cursor-pointer overflow-hidden opacity-0 disabled:cursor-not-allowed"
                    style={{ fontSize: 0 }}
                  />
                  <CloudUpload className={cn('mx-auto mb-1 h-6 w-6', isDragOver && canAcceptReferences ? 'text-primary' : 'text-muted-foreground')} />
                  <p className="text-sm font-medium">
                    {!canAcceptReferences
                      ? '未配置支持参考图的模型'
                      : loading
                        ? '读取中...'
                        : isDragOver
                          ? '将图像拖放到这里'
                          : refsSupported
                            ? '参考图（可选）'
                            : '参考图（上传后自动切换模型）'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {canAcceptReferences ? '点击选择 · 拖放 · Ctrl+V 粘贴' : '请先在设置中配置可编辑模型'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pendingFiles.length} / {availableReferenceSlots} 张
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAssetPickerOpen(true)}
                  disabled={loading || !canAcceptReferences || pendingFiles.length >= availableReferenceSlots}
                  title={canAcceptReferences ? '从素材库导入参考图' : '未配置支持参考图的模型'}
                  className="flex flex-1 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 px-3 py-4 text-center transition-all hover:border-primary/50 hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ImagePlus className="h-6 w-6 text-muted-foreground" />
                  <span className="text-sm font-medium">素材库</span>
                  <span className="text-xs text-muted-foreground">{canAcceptReferences ? '导入参考图' : '不可用'}</span>
                </button>
              </div>
            </div>

            {pendingFiles.length > 0 && (
              <div className="px-4 pb-2">
                <AttachmentChips
                  files={pendingFiles}
                  onRemove={handleRemovePending}
                  sourceKind="upload"
                  sourceLabel="生图参考图"
                  prompt={prompt}
                  showDownload={false}
                  showCopy
                  showUseAsReference={false}
                />
              </div>
            )}

            <MaskUploadControl
              draft={maskDraft}
              processed={processedMask}
              strategy={maskStrategy}
              loading={maskLoading}
              error={maskConsumesOverflow
                ? `当前模型的语义蒙版会占用 1 个图片输入位，请减少参考图到 ${effectiveMaxImages} 张以内。`
                : maskError}
              targetReady={pendingFiles.length > 0}
              disabled={!canAcceptReferences || loading}
              onFile={file => void handleMaskFile(file)}
              onRemove={() => {
                setMaskDraft(null);
                setProcessedMask(null);
                setMaskError(null);
              }}
              onSourceModeChange={(sourceMode: MaskSourceMode) => updateMaskDraft({ sourceMode })}
              onThresholdChange={threshold => updateMaskDraft({ threshold })}
              onSoftEdgesChange={softEdges => updateMaskDraft({ softEdges })}
              onInvert={() => updateMaskDraft({ inverted: !maskDraft?.inverted })}
            />

            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={pendingFiles.length > 0 ? '描述如何调整参考图...' : '描述你想要生成的图像...'}
              rows={3}
              className="resize-none rounded-none border-0 bg-transparent px-3 pt-3 placeholder:text-placeholder focus-visible:border-0 focus-visible:ring-0 sm:px-4 sm:pt-4"
            />

            <div className="px-3 pt-2 pb-2 sm:px-4">
              <GenerationParamsBar
                value={{ model, outputSize, customSize, aspectRatio, temperature, webSearchEnabled, imageSearchEnabled, parallelCount, gptImageAdvancedParams }}
                onChange={handleParamsChange}
              />
            </div>

            <div className="ml-auto flex w-full justify-end gap-2 px-3 pb-2 sm:w-auto sm:px-4">
              <Button variant="ghost" size="icon" onClick={() => setQuickPromptOpen(true)} title="快速提示词">
                <Zap className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => setTextAssetPickerOpen(true)} title="导入提示词素材">
                <FileText className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => void handleSavePromptAsset()} disabled={!prompt.trim()} title="存为提示词素材">
                <Save className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={handleOptimize} disabled={!prompt.trim()} title="优化提示词">
                <Sparkles className="w-4 h-4" />
              </Button>
              <Button variant="outline" size="icon" onClick={handleClearDraft} disabled={!canClear} title="清空提示词和图片">
                <X className="w-5 h-5" />
              </Button>
              <Button onClick={handleSubmit} disabled={!canSubmit} size="icon" title={currentMode === 'image-to-image' ? '按图生图提交' : '按文生图提交'}>
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowUp className="w-5 h-5" />}
              </Button>
            </div>
          </>
        )}
      </div>

      {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
      <MissingApiKeyDialog
        open={missingApiKeyDialogOpen}
        onOpenChange={setMissingApiKeyDialogOpen}
        onConfigure={() => onConfigureApiKey?.()}
      />
      <QuickPromptDialog
        open={quickPromptOpen}
        onOpenChange={setQuickPromptOpen}
        currentMode={currentMode}
        currentPrompt={prompt}
        onSelect={setPrompt}
      />
      <PromptOptimizeDialog
        open={optimizeOpen}
        onOpenChange={(open) => { if (!open) handleOptimizeCancel(); setOptimizeOpen(open); }}
        originalPrompt={prompt}
        optimizedPrompt={optimizedText}
        loading={optimizing}
        error={optimizeError}
        onAccept={handleOptimizeAccept}
        onCancel={handleOptimizeCancel}
      />
      <AgentAssetPickerDialog
        open={assetPickerOpen}
        maxSelected={Math.min(MAX_ASSET_IMPORTS, Math.max(1, availableReferenceSlots - pendingFiles.length))}
        onOpenChange={setAssetPickerOpen}
        onConfirm={(assets) => void handleImportAssets(assets)}
      />
      <AgentTextAssetPickerDialog
        open={textAssetPickerOpen}
        onOpenChange={setTextAssetPickerOpen}
        onConfirm={handleTextAssetConfirm}
      />
      {pendingTextAsset && createPortal(
        <ConfirmDialog
          title="覆盖当前提示词"
          message="将用素材内容覆盖当前输入框，是否继续？"
          confirmText="覆盖"
          variant="default"
          onConfirm={() => applyTextAsset(pendingTextAsset)}
          onCancel={() => setPendingTextAsset(null)}
        />,
        document.body,
      )}
    </div>
  );
}

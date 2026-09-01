'use client';

import { useState, type DragEvent } from 'react';
import { FlipVertical2, ImagePlus, Loader2, ScanLine, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { getClipboardImageFiles } from '@/lib/clipboard-image';
import type { MaskDraft, MaskSourceMode, MaskStrategy, ProcessedMask } from '@/lib/mask-utils';

interface MaskUploadControlProps {
  draft: MaskDraft | null;
  processed: ProcessedMask | null;
  strategy: MaskStrategy;
  loading: boolean;
  error?: string | null;
  targetReady: boolean;
  disabled?: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
  onSourceModeChange: (mode: MaskSourceMode) => void;
  onThresholdChange: (value: number) => void;
  onSoftEdgesChange: (value: boolean) => void;
  onInvert: () => void;
}

const sourceOptions: { value: MaskSourceMode; label: string }[] = [
  { value: 'auto', label: '自动识别' },
  { value: 'alpha', label: '按 Alpha' },
  { value: 'luminance', label: '按亮度' },
  { value: 'color', label: '按颜色' },
];

export function MaskUploadControl({
  draft,
  processed,
  strategy,
  loading,
  error,
  targetReady,
  disabled = false,
  onFile,
  onRemove,
  onSourceModeChange,
  onThresholdChange,
  onSoftEdgesChange,
  onInvert,
}: MaskUploadControlProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const softEdgesActive = strategy.representation === 'alpha' && Boolean(draft?.softEdges);
  const activeSourceMode = draft?.sourceMode === 'auto' ? draft.analysis.detectedSource : draft?.sourceMode;

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    event.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    event.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setIsDragOver(false);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    if (disabled) return;
    const files = Array.from(event.dataTransfer.files);
    const file = files.find(candidate => candidate.type.startsWith('image/')) || files[0];
    if (file) onFile(file);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLElement>) => {
    if (disabled) return;
    const files = getClipboardImageFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    onFile(files[0]);
  };

  return (
    <section
      aria-label="遮罩蒙版上传区域"
      tabIndex={0}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
      className={cn(
        'relative mx-4 mb-3 overflow-hidden rounded-xl border bg-background/70 p-3 transition-colors',
        isDragOver && !disabled ? 'border-primary bg-primary/10 ring-2 ring-primary/20' : 'border-border/80',
      )}
    >
      {isDragOver && !disabled && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/90 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-4 py-3 text-sm font-medium text-primary shadow-sm">
            <ImagePlus className="h-4 w-4" />
            松开以上传蒙版
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <ScanLine className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">遮罩蒙版</h3>
            <span className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium',
              strategy.precise ? 'bg-primary/10 text-primary' : 'bg-warning/10 text-warning',
            )}>
              {strategy.precise ? '像素级' : '语义蒙版'}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{strategy.label} · {strategy.description}</p>
        </div>

        {draft && (
          <Button type="button" variant="ghost" size="icon-xs" onClick={onRemove} title="移除蒙版">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {!draft ? (
        <label className={cn(
          'mt-3 flex items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-4 text-sm transition-colors',
          disabled
            ? 'cursor-not-allowed border-border bg-muted/40 text-muted-foreground opacity-60'
            : 'cursor-pointer border-primary/35 bg-primary/5 hover:border-primary/60 hover:bg-primary/10',
        )}>
          <ImagePlus className="h-4 w-4 text-primary" />
          <span>点击、拖拽或 Ctrl+V 上传蒙版图</span>
          <span className="text-xs text-muted-foreground">透明 PNG、黑白、灰度或任意颜色蒙版</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/*"
            disabled={disabled}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onFile(file);
              event.target.value = '';
            }}
          />
        </label>
      ) : (
        <div className="mt-3 grid gap-3 lg:grid-cols-[168px_minmax(0,1fr)]">
          <div className="grid grid-cols-2 gap-2">
            <figure>
              <div className="mask-checkerboard flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-border">
                <img src={draft.originalDataUrl} alt="原始蒙版" className="h-full w-full object-contain" />
              </div>
              <figcaption className="mt-1 truncate text-center text-[10px] text-muted-foreground" title={draft.name}>原图</figcaption>
            </figure>
            <figure>
              <div className="mask-checkerboard flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-border">
                {loading ? (
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                ) : processed ? (
                  <img src={processed.dataUrl} alt="转换后的蒙版" className="h-full w-full object-contain" />
                ) : (
                  <span className="px-2 text-center text-[10px] text-muted-foreground">先上传第 1 张参考图</span>
                )}
              </div>
              <figcaption className="mt-1 text-center text-[10px] text-muted-foreground">模型格式</figcaption>
            </figure>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {sourceOptions.map(option => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onSourceModeChange(option.value)}
                  className={cn(
                    'rounded-md border px-2 py-1 text-[11px] transition-colors',
                    draft.sourceMode === option.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background text-muted-foreground hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              ))}
              <button
                type="button"
                onClick={onInvert}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors',
                  draft.inverted ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <FlipVertical2 className="h-3 w-3" />
                反相
              </button>
            </div>

            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={softEdgesActive}
                disabled={strategy.representation === 'black-white'}
                onChange={(event) => onSoftEdgesChange(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-border accent-primary"
              />
              {strategy.representation === 'black-white' ? '固定为纯黑白二值蒙版' : '保留 Alpha 柔边'}
            </label>

            <div className={cn('space-y-1.5', softEdgesActive && 'opacity-45')}>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{activeSourceMode === 'color' ? '颜色差异阈值' : '黑白阈值'}</span>
                <span>{draft.threshold}</span>
              </div>
              <Slider
                value={[draft.threshold]}
                min={0}
                max={255}
                step={1}
                disabled={softEdgesActive}
                onValueChange={value => onThresholdChange(value[0] ?? 128)}
              />
            </div>

            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
              <span>检测：{draft.analysis.hasTransparency ? '含 Alpha' : draft.analysis.isGrayscale ? '黑白 / 灰度' : '彩色蒙版（按颜色差异）'}</span>
              <span>原始：{draft.analysis.width}×{draft.analysis.height}</span>
              {processed && <span>输出：{processed.width}×{processed.height}</span>}
              {!targetReady && <span className="text-warning">等待第 1 张参考图</span>}
            </div>
          </div>
        </div>
      )}

      {disabled && !draft && (
        <p className="mt-2 text-xs text-warning">当前模型不支持图生图输入，因此无法使用蒙版。</p>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}

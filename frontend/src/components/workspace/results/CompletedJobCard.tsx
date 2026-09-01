'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Copy, Download, ExternalLink, Globe2, ImagePlus, Images, Maximize, RefreshCw, RotateCcw, Search, Thermometer, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Button, buttonVariants } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useImageLazyLoad } from '@/hooks/useImageLazyLoad';
import { getImageSrc, type StoredJob } from '@/lib/job-store';
import { resolveStoredImageRef, revokeBlobUrls } from '@/lib/image-downloader';
import { getModelDisplayName, getOutputSizeLabel } from '@/lib/model-capabilities';
import { cn } from '@/lib/utils';
import { HistoryImagePreview } from '@/components/workspace/results/HistoryImagePreview';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import {
  copyImagePayload,
  dispatchImageActionToast,
  runImageAction,
  type ImageActionPayload,
} from '@/lib/image-actions';

interface CompletedJobCardProps {
  job: StoredJob;
  onClear: () => void;
  onRetry: (job: StoredJob) => void;
  onRetryDownload?: (job: StoredJob) => void | Promise<void>;
}

interface DownloadProgressSummary {
  active: boolean;
  failed: number;
  message: string;
  percent: number;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getDownloadProgressSummary(progress: StoredJob['imageDownloadProgress']): DownloadProgressSummary | null {
  if (!progress || progress.total <= 0) return null;

  const active = progress.items.some(item => item.status === 'pending' || item.status === 'downloading');
  const failed = progress.failed;
  if (!active && failed === 0) return null;

  const loadedBytes = progress.items.reduce((sum, item) => sum + (item.loadedBytes || 0), 0);
  const knownTotalBytes = progress.items.reduce((sum, item) => sum + (item.totalBytes || 0), 0);
  const bytePercent = knownTotalBytes > 0
    ? Math.min(100, Math.round((loadedBytes / knownTotalBytes) * 100))
    : undefined;
  const completionPercent = Math.min(
    100,
    Math.round(((progress.completed + progress.failed) / progress.total) * 100)
  );
  const percent = bytePercent ?? completionPercent;
  const message = active
    ? knownTotalBytes > 0
      ? `正在取回 ${formatBytes(loadedBytes)} / ${formatBytes(knownTotalBytes)}，${percent}%`
      : `正在取回 ${formatBytes(loadedBytes)}`
    : `取回失败 ${failed} 张，已缓存 ${progress.completed} 张`;

  return {
    active,
    failed,
    message,
    percent,
  };
}

export const CompletedJobCard = memo(function CompletedJobCard({ job, onClear, onRetry, onRetryDownload }: CompletedJobCardProps) {
  const [imgCopied, setImgCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewImages, setPreviewImages] = useState<string[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [assetMenuOpen, setAssetMenuOpen] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [retryingDownload, setRetryingDownload] = useState(false);

  const sourceImages = useMemo(() => job.images || (job.imageData ? [job.imageData] : []), [job.imageData, job.images]);
  const searchGrounding = useMemo(() => job.searchGrounding || [], [job.searchGrounding]);
  const searchSources = useMemo(() => {
    const unique = new Map<string, { uri: string; title?: string; type?: 'web' | 'image' }>();
    for (const metadata of searchGrounding) {
      for (const source of metadata.sources || []) {
        if (!unique.has(source.uri)) unique.set(source.uri, source);
      }
    }
    return Array.from(unique.values()).slice(0, 8);
  }, [searchGrounding]);
  const searchEntryPointHtml = searchGrounding.find(item => item.searchEntryPointHtml)?.searchEntryPointHtml;
  const searchQueries = useMemo(() => Array.from(new Set(searchGrounding.flatMap(item => [
    ...(item.webSearchQueries || []),
    ...(item.imageSearchQueries || []),
  ]))).slice(0, 8), [searchGrounding]);
  const [images, setImages] = useState(sourceImages);
  const resolvedBlobUrlsRef = useRef<string[]>([]);
  const actionPayloads = useMemo<ImageActionPayload[]>(() => sourceImages.map((imageRef, index) => ({
    id: `${job.id}-${index}`,
    name: `jacky-image-${job.id.slice(0, 8)}${sourceImages.length > 1 ? `-${index + 1}` : ''}`,
    storedRef: { jobId: job.id, imageRef, imageIndex: index },
    sourceKind: job.mode === 'image-to-image' ? 'image-to-image' : 'text-to-image',
    sourceLabel: job.mode === 'image-to-image' ? '图生图历史结果' : '文生图历史结果',
    sourceRef: `${job.id}:${index}`,
    prompt: job.prompt,
  })), [job.id, job.mode, job.prompt, sourceImages]);

  /** 是否存在仍以远程 URL 形式呈现的图片（即首次本地缓存失败、需要"重新下载"补齐）。 */
  const needsRedownload = useMemo(
    () => sourceImages.some(img => img.startsWith('URL:') || img.startsWith('MULTI_URL:')),
    [sourceImages]
  );
  const downloadProgressSummary = useMemo(
    () => getDownloadProgressSummary(job.imageDownloadProgress),
    [job.imageDownloadProgress]
  );
  const isDownloadingImages = !!downloadProgressSummary?.active;

  const handleRetryDownload = useCallback(async () => {
    if (!onRetryDownload || retryingDownload || isDownloadingImages) return;
    setRetryingDownload(true);
    try {
      await onRetryDownload(job);
    } finally {
      setRetryingDownload(false);
    }
  }, [isDownloadingImages, job, onRetryDownload, retryingDownload]);

  const revokeResolvedBlobUrls = useCallback(() => {
    if (resolvedBlobUrlsRef.current.length > 0) {
      revokeBlobUrls(resolvedBlobUrlsRef.current);
      resolvedBlobUrlsRef.current = [];
    }
  }, []);

  useEffect(() => {
    setImages(sourceImages);
    return revokeResolvedBlobUrls;
  }, [revokeResolvedBlobUrls, sourceImages]);

  useEffect(() => {
    const urls = job.blobUrls;
    return () => {
      if (urls) {
        revokeBlobUrls(urls);
      }
    };
  }, [job.blobUrls]);

  const resolveImageAt = useCallback(async (index: number): Promise<string | undefined> => {
    const image = images[index] || sourceImages[index];
    if (!image) return undefined;
    if (image.startsWith('blob:') && image !== sourceImages[index]) return image;
    if (!image.startsWith('IDB:') && !image.startsWith('FILE:') && !image.startsWith('blob:')) return image;

    const resolved = await resolveStoredImageRef(job.id, image, index);
    if (resolved.blobUrl) {
      resolvedBlobUrlsRef.current.push(resolved.blobUrl);
      setImages(prev => prev.map((item, itemIndex) => (itemIndex === index ? resolved.image : item)));
    }

    return resolved.image;
  }, [images, job.id, sourceImages]);

  const resolveImagesAt = useCallback(async (indexes: number[]): Promise<string[]> => {
    const resolved = await Promise.all(indexes.map(index => resolveImageAt(index)));
    return resolved.filter((image): image is string => !!image);
  }, [resolveImageAt]);

  const visiblePreviewImages = images.slice(0, 3);
  const isMultiple = sourceImages.length > 1;
  const supportsTemperature = !job.model.startsWith('gpt-image-2');
  const outputSizeLabel = job.custom_size || getOutputSizeLabel(job.output_size);
  const lazyLoad = useImageLazyLoad<HTMLDivElement>({
    rootMargin: '300px',
    enabled: true,
  });
  // 单独跟踪每个可见缩略图的加载状态，避免单图失败导致全部不显示
  const [loadedImageIndices, setLoadedImageIndices] = useState<Set<number>>(new Set());
  const handleImageLoad = useCallback((index: number) => {
    setLoadedImageIndices(prev => new Set(prev).add(index));
    // 第一张图加载完成时同步更新lazyLoad状态
    if (index === 0) {
      lazyLoad.handleImageLoad();
    }
  }, [lazyLoad]);

  const downloadImage = (index: number = 0) => {
    const payload = actionPayloads[index];
    if (!payload) return;
    void runImageAction('download', payload);
  };

  const addImageToAssets = (index: number = 0) => {
    const payload = actionPayloads[index];
    if (!payload) return;
    void runImageAction('add-to-assets', payload);
  };

  const addAllToAssets = () => {
    actionPayloads.forEach((_, index) => {
      setTimeout(() => addImageToAssets(index), index * 100);
    });
    setAssetMenuOpen(false);
  };

  const downloadAll = () => {
    actionPayloads.forEach((_, index) => {
      setTimeout(() => downloadImage(index), index * 100);
    });
    setDownloadMenuOpen(false);
  };

  const copyImage = async (index: number = 0) => {
    const payload = actionPayloads[index];
    if (!payload) return;
    try {
      await copyImagePayload(payload);
      setImgCopied(true);
      setTimeout(() => setImgCopied(false), 2000);
      setCopyMenuOpen(false);
      dispatchImageActionToast('图片已复制', 'success');
    } catch (error) {
      setCopyMenuOpen(false);
      const message = error instanceof Error ? error.message : '图片复制失败';
      dispatchImageActionToast(message.includes('Failed to fetch') ? '该图片源不允许本地保存或复制，请直接右键/长摁复制' : message, 'error');
    }
  };

  const copyPrompt = () => {
    navigator.clipboard.writeText(job.prompt);
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 2000);
  };

  const openPreview = async () => {
    const resolved = await resolveImagesAt(sourceImages.map((_, index) => index));
    setPreviewImages(resolved.map(getImageSrc).filter(Boolean));
    setPreviewOpen(true);
  };

  useEffect(() => {
    if (!lazyLoad.isVisible) return;
    const previewIndexes = Array.from(
      { length: Math.min(sourceImages.length, 3) },
      (_, index) => index
    );
    void resolveImagesAt(previewIndexes);
  }, [lazyLoad.isVisible, resolveImagesAt, sourceImages.length]);

  if (sourceImages.length === 0) {
    return null;
  }

  return (
    <>
      <article className="group/card flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_8px_24px_-20px_hsl(var(--foreground)/0.35)] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-[0_16px_36px_-24px_hsl(var(--foreground)/0.45)]">
        <div
          ref={lazyLoad.elementRef}
          className="relative aspect-[4/3] w-full overflow-hidden bg-muted"
        >
          <button
            type="button"
            onClick={() => void openPreview()}
            className="absolute inset-0 h-full w-full border-0 p-0 text-left"
            title="看大图"
          >
            {isMultiple ? (
              <div className={cn(
                'grid h-full w-full gap-px bg-border',
                visiblePreviewImages.length >= 3 ? 'grid-cols-2 grid-rows-2' : 'grid-cols-2'
              )}>
                {visiblePreviewImages.map((image, index) => (
                  <img
                    key={`${job.id}-${index}`}
                    src={lazyLoad.isVisible ? (getImageSrc(image) || undefined) : undefined}
                    alt={`生成的图像 ${index + 1}`}
                    className={cn(
                      'h-full w-full object-cover transition-[opacity,transform] duration-300 group-hover/card:scale-[1.015]',
                      loadedImageIndices.has(index) ? 'opacity-100' : 'opacity-0',
                      visiblePreviewImages.length >= 3 && index === 0 && 'row-span-2'
                    )}
                    onLoad={() => handleImageLoad(index)}
                  />
                ))}
              </div>
            ) : (
              <img
                src={lazyLoad.isVisible ? (getImageSrc(images[0]) || undefined) : undefined}
                alt="生成的图像"
                className={cn(
                  'h-full w-full object-cover transition-[opacity,transform] duration-300 group-hover/card:scale-[1.015]',
                  lazyLoad.isLoaded ? 'opacity-100' : 'opacity-0'
                )}
                onLoad={lazyLoad.handleImageLoad}
              />
            )}
            {!lazyLoad.isLoaded && (
              <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-muted via-muted/50 to-muted" />
            )}
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors duration-200 group-hover/card:bg-black/25">
              <span className="flex h-9 w-9 scale-90 items-center justify-center rounded-full bg-black/55 text-white opacity-0 shadow-sm backdrop-blur-sm transition-[opacity,transform] duration-200 group-hover/card:scale-100 group-hover/card:opacity-100">
                <Maximize className="h-4 w-4" />
              </span>
            </div>
          </button>
          {isMultiple && (
            <span className="pointer-events-none absolute right-2.5 top-2.5 rounded-lg bg-black/60 px-2 py-1 text-[11px] font-medium text-white shadow-sm backdrop-blur-sm">
              {sourceImages.length} 张
            </span>
          )}
        </div>

        <div className="flex min-h-28 flex-1 flex-col p-3.5">
          <div className="flex items-start gap-2">
            <p className="line-clamp-2 min-w-0 flex-1 text-sm font-medium leading-5 text-foreground">
              &quot;{job.prompt}&quot;
            </p>
            <button
              onClick={copyPrompt}
              className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="复制提示词"
            >
              {promptCopied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>

          {job.warning && (
            <p className="mt-2 flex items-start gap-1.5 text-xs leading-4 text-warning">
              <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
              <span className="line-clamp-2">{job.warning}</span>
            </p>
          )}

          {searchGrounding.length > 0 && (
            <details className="mt-2 rounded-lg border border-border/80 bg-muted/30 px-2.5 py-2 text-xs">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-foreground">
                <Search className="h-3.5 w-3.5 text-primary" />
                搜索来源
                {searchSources.length > 0 && <span className="text-muted-foreground">({searchSources.length})</span>}
              </summary>
              <div className="mt-2 space-y-2">
                {searchEntryPointHtml && (
                  <iframe
                    title="Google 搜索建议"
                    sandbox="allow-popups allow-popups-to-escape-sandbox"
                    srcDoc={searchEntryPointHtml}
                    className="h-12 w-full overflow-hidden rounded border-0 bg-background"
                  />
                )}
                {searchQueries.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {searchQueries.map(query => (
                      <span key={query} className="rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">{query}</span>
                    ))}
                  </div>
                )}
                {searchSources.length > 0 && (
                  <div className="space-y-1">
                    {searchSources.map(source => (
                      <a
                        key={source.uri}
                        href={source.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 truncate text-primary hover:underline"
                      >
                        <ExternalLink className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{source.title || source.uri}</span>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </details>
          )}

          {downloadProgressSummary && (
            <div
              className="mt-2 flex items-center gap-2"
              title={downloadProgressSummary.message}
              aria-label={downloadProgressSummary.message}
            >
              <div className="h-1.5 min-w-20 flex-1 overflow-hidden rounded-full bg-secondary">
                <div
                  className={`h-full transition-all duration-300 ease-out ${downloadProgressSummary.failed > 0 && !downloadProgressSummary.active ? 'bg-warning' : 'bg-primary'}`}
                  style={{ width: `${Math.max(4, downloadProgressSummary.percent)}%` }}
                />
              </div>
              <span className="w-10 flex-shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {downloadProgressSummary.percent}%
              </span>
            </div>
          )}

          <p className="mt-auto flex flex-wrap items-center gap-x-1 gap-y-0.5 pt-2 text-[11px] leading-4 text-muted-foreground">
            <span className="max-w-full truncate">{getModelDisplayName(job.model)}</span>
            <span>·</span>
            <span>{outputSizeLabel}</span>
            {job.aspect_ratio !== '1:1' && job.aspect_ratio !== 'auto' && <><span>·</span><span>{job.aspect_ratio}</span></>}
            {supportsTemperature && <><span>·</span><Thermometer className="h-3 w-3" /><span>{job.temperature?.toFixed(2) ?? 1}</span></>}
            {job.webSearchEnabled && <><span>·</span><Globe2 className="h-3 w-3" /><span>联网</span></>}
            {job.imageSearchEnabled && <><span>·</span><Images className="h-3 w-3" /><span>图片搜索</span></>}
            {isMultiple && <><span>·</span><span className="font-medium text-primary">x{sourceImages.length}{job.parallelCount && job.parallelCount > sourceImages.length ? `/${job.parallelCount}` : ''}</span></>}
          </p>
        </div>

        <div className="flex min-h-11 flex-shrink-0 items-center justify-end gap-0.5 border-t border-border/80 bg-muted/20 px-2 py-1.5">
            {needsRedownload && onRetryDownload && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void handleRetryDownload()}
                disabled={retryingDownload || isDownloadingImages}
                title={isDownloadingImages ? '正在取回图片' : '重新下载到本地缓存'}
                className="text-warning hover:text-warning/80"
              >
                <RefreshCw className={`w-4 h-4 ${retryingDownload || isDownloadingImages ? 'animate-spin' : ''}`} />
              </Button>
            )}

            {isMultiple ? (
              <DropdownMenu open={assetMenuOpen} onOpenChange={setAssetMenuOpen}>
                <DropdownMenuTrigger className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} title="添加到素材库">
                  <ImagePlus className="w-4 h-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {sourceImages.map((_, index) => (
                    <DropdownMenuItem key={index} onClick={() => {
                      addImageToAssets(index);
                      setAssetMenuOpen(false);
                    }}>
                      保存图片 {index + 1}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onClick={addAllToAssets} className="font-medium text-primary">
                    <ImagePlus className="mr-1.5 w-3.5 h-3.5" />
                    保存全部
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => addImageToAssets(0)}
                title="添加到素材库"
              >
                <ImagePlus className="w-4 h-4" />
              </Button>
            )}

            {isMultiple ? (
              <DropdownMenu open={downloadMenuOpen} onOpenChange={setDownloadMenuOpen}>
                <DropdownMenuTrigger className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} title="下载">
                  <Download className="w-4 h-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {sourceImages.map((_, index) => (
                    <DropdownMenuItem key={index} onClick={() => {
                      downloadImage(index);
                      setDownloadMenuOpen(false);
                    }}>
                      下载图片 {index + 1}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onClick={downloadAll} className="font-medium text-primary">
                    <Download className="mr-1.5 w-3.5 h-3.5" />
                    下载全部
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button variant="ghost" size="icon-sm" onClick={() => downloadImage(0)} title="下载">
                <Download className="w-4 h-4" />
              </Button>
            )}

            {isMultiple ? (
              <DropdownMenu open={copyMenuOpen} onOpenChange={setCopyMenuOpen}>
                <DropdownMenuTrigger className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} title="复制图片">
                  {imgCopied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {sourceImages.map((_, index) => (
                    <DropdownMenuItem key={index} onClick={() => copyImage(index)}>
                      复制图片 {index + 1}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button variant="ghost" size="icon-sm" onClick={() => copyImage(0)} title="复制图片">
                {imgCopied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
              </Button>
            )}

            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onRetry(job)}
              title="重试"
              className="text-muted-foreground hover:text-primary"
            >
              <RotateCcw className="w-4 h-4" />
            </Button>

            <Button variant="ghost" size="icon-sm" onClick={() => setDeleteDialogOpen(true)} title="移除">
              <X className="w-4 h-4" />
            </Button>
        </div>
      </article>

      {previewOpen && createPortal(
        <HistoryImagePreview
          images={previewImages}
          alt={job.prompt}
          onClose={() => setPreviewOpen(false)}
          actionPayloads={actionPayloads}
        />,
        document.body
      )}

      {deleteDialogOpen && createPortal(
        <ConfirmDialog
          title="删除记录"
          message={
            <>
              确定要删除这条记录吗？此操作无法撤销。
              {isMultiple && <span className="mt-1 block text-warning">这将删除 {sourceImages.length} 张图片。</span>}
            </>
          }
          confirmText="删除"
          onConfirm={onClear}
          onCancel={() => setDeleteDialogOpen(false)}
        />,
        document.body
      )}
    </>
  );
});

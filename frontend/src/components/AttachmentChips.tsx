'use client';

import { useState } from 'react';
import { X, ImageIcon, BadgeCheck } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { HistoryImagePreview } from '@/components/workspace/results/HistoryImagePreview';
import { ImageHoverActions } from '@/components/workspace/results/ImageHoverActions';
import type { AssetSourceKind } from '@/lib/asset-store';
import type { ImageActionPayload } from '@/lib/image-actions';

interface AttachmentChip {
  id: string;
  name: string;
  preview?: string;
  dataUrl?: string;
  mimeType?: string;
  badge?: string;
}

interface AttachmentChipsProps {
  files: AttachmentChip[];
  onRemove: (id: string) => void;
  sourceKind?: AssetSourceKind;
  sourceLabel?: string;
  prompt?: string;
  showDownload?: boolean;
  showCopy?: boolean;
  showAddToAssets?: boolean;
  showUseAsReference?: boolean;
}

export function AttachmentChips({
  files,
  onRemove,
  sourceKind = 'upload',
  sourceLabel = '用户上传',
  prompt,
  showDownload = true,
  showCopy = false,
  showAddToAssets = true,
  showUseAsReference = true,
}: AttachmentChipsProps) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  if (files.length === 0) return null;

  const previewImages = files
    .map(file => file.preview)
    .filter((preview): preview is string => Boolean(preview));
  const previewPayloads = files
    .filter(file => Boolean(file.preview))
    .map<ImageActionPayload>(file => ({
      id: file.id,
      name: file.name,
      dataUrl: file.dataUrl || file.preview,
      src: file.preview,
      mimeType: file.mimeType,
      sourceKind,
      sourceLabel,
      sourceRef: file.id,
      prompt,
    }));

  const currentPreview = previewIndex === null ? null : files[previewIndex]?.preview;
  const currentPreviewImageIndex = currentPreview ? previewImages.indexOf(currentPreview) : -1;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {files.map((file, index) => (
          <div key={file.id} className="relative group">
            <button
              type="button"
              onClick={() => {
                if (file.preview) {
                  setPreviewIndex(index);
                }
              }}
              className="w-16 h-16 rounded-lg overflow-hidden bg-muted flex items-center justify-center disabled:cursor-default"
              disabled={!file.preview}
              title={file.preview ? `预览 ${file.name}` : file.name}
            >
              {file.preview ? (
                <img src={file.preview} alt={file.name} className="w-full h-full object-cover" />
              ) : (
                <ImageIcon className="w-6 h-6 text-muted-foreground" />
              )}
            </button>
            {file.badge && (
              <div className="absolute left-0.5 bottom-0.5 max-w-[62px] rounded-md bg-black/70 px-1 py-0.5 text-[10px] leading-none text-white shadow-sm backdrop-blur-sm">
                <span className="inline-flex items-center gap-0.5 truncate">
                  <BadgeCheck className="w-2.5 h-2.5" />
                  {file.badge}
                </span>
              </div>
            )}
            {file.preview && (
              <ImageHoverActions
                payload={{
                  id: file.id,
                  name: file.name,
                  dataUrl: file.dataUrl || file.preview,
                  src: file.preview,
                  mimeType: file.mimeType,
                  sourceKind,
                  sourceLabel,
                  sourceRef: file.id,
                  prompt,
                }}
                onPreview={() => setPreviewIndex(index)}
                compact
                showDownload={showDownload}
                showCopy={showCopy}
                showAddToAssets={showAddToAssets}
                showUseAsReference={showUseAsReference}
                className="rounded-lg"
              />
            )}
            <Button
              variant="secondary"
              size="icon-xs"
              onClick={(event) => {
                event.stopPropagation();
                onRemove(file.id);
              }}
              className="absolute -right-1 -top-1 z-30 rounded-full"
            >
              <X className="w-3 h-3" />
            </Button>
          </div>
        ))}
      </div>

      {previewIndex !== null && currentPreviewImageIndex >= 0 && createPortal(
        <HistoryImagePreview
          images={previewImages}
          alt={files[previewIndex]?.name || '参考图像'}
          initialIndex={currentPreviewImageIndex}
          onClose={() => setPreviewIndex(null)}
          actionPayloads={previewPayloads}
          showDownload={showDownload}
          showAddToAssets={showAddToAssets}
          showUseAsReference={showUseAsReference}
        />,
        document.body
      )}
    </>
  );
}

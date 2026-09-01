'use client';

import { Copy, Download, Eye, ImagePlus, Wand2 } from 'lucide-react';
import type React from 'react';
import { runImageAction, type ImageActionPayload } from '@/lib/image-actions';
import { cn } from '@/lib/utils';

interface ImageHoverActionsProps {
  payload: ImageActionPayload;
  onPreview?: () => void;
  compact?: boolean;
  showPreview?: boolean;
  showDownload?: boolean;
  showCopy?: boolean;
  showAddToAssets?: boolean;
  showUseAsReference?: boolean;
  extraActions?: React.ReactNode;
  className?: string;
}

function stop(event: React.MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function ActionButton({
  title,
  onClick,
  compact,
  children,
}: {
  title: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'pointer-events-auto flex items-center justify-center rounded-full bg-white/20 text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-white/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80',
        compact ? 'h-5 w-5' : 'h-7 w-7',
      )}
      title={title}
    >
      {children}
    </button>
  );
}

export function ImageHoverActions({
  payload,
  onPreview,
  compact = false,
  showPreview = true,
  showDownload = true,
  showCopy = false,
  showAddToAssets = true,
  showUseAsReference = true,
  extraActions,
  className,
}: ImageHoverActionsProps) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-20 hidden items-center justify-center bg-black/0 opacity-0 transition-all group-hover:flex group-hover:bg-black/40 group-hover:opacity-100 md:flex md:opacity-0',
        compact ? 'flex-wrap gap-1 p-1' : 'gap-1.5',
        className,
      )}
    >
      {showPreview && onPreview && (
        <ActionButton
          title="看大图"
          compact={compact}
          onClick={event => {
            stop(event);
            onPreview();
          }}
        >
          <Eye className="h-3.5 w-3.5" />
        </ActionButton>
      )}
      {showAddToAssets && (
        <ActionButton
          title="添加到素材库"
          compact={compact}
          onClick={event => {
            stop(event);
            void runImageAction('add-to-assets', payload);
          }}
        >
          <ImagePlus className="h-3.5 w-3.5" />
        </ActionButton>
      )}
      {showDownload && (
        <ActionButton
          title="下载"
          compact={compact}
          onClick={event => {
            stop(event);
            void runImageAction('download', payload);
          }}
        >
          <Download className="h-3.5 w-3.5" />
        </ActionButton>
      )}
      {showCopy && (
        <ActionButton
          title="复制图片"
          compact={compact}
          onClick={event => {
            stop(event);
            void runImageAction('copy', payload);
          }}
        >
          <Copy className="h-3.5 w-3.5" />
        </ActionButton>
      )}
      {showUseAsReference && (
        <ActionButton
          title="作为图生图参考"
          compact={compact}
          onClick={event => {
            stop(event);
            void runImageAction('use-as-reference', payload);
          }}
        >
          <Wand2 className="h-3.5 w-3.5" />
        </ActionButton>
      )}
      {extraActions && <div className="pointer-events-auto">{extraActions}</div>}
    </div>
  );
}

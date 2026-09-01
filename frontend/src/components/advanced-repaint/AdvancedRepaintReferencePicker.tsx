'use client';

import { useRef, useState, type DragEvent } from 'react';
import { ImagePlus, Images, Loader2, X } from 'lucide-react';
import { AgentAssetPickerDialog } from '@/components/agent/AgentAssetPickerDialog';
import { getAssetBlob, type ImageAsset } from '@/lib/asset-store';
import { generateUUID } from '@/lib/uuid';
import { cn } from '@/lib/utils';
import { getClipboardImageFiles } from '@/lib/clipboard-image';
import type { RepaintReferenceImage, RepaintReferenceRole } from './types';

const MAX_REFERENCE_IMAGES = 6;

const REFERENCE_ROLE_LABELS: Record<RepaintReferenceRole, string> = {
  general: '综合参考',
  structure: '结构参考',
  appearance: '材质 / 外观参考',
};

interface AdvancedRepaintReferencePickerProps {
  references: RepaintReferenceImage[];
  referenceRole: RepaintReferenceRole;
  onReferenceRoleChange: (role: RepaintReferenceRole) => void;
  onAddReferences: (references: RepaintReferenceImage[]) => void;
  onRemoveReference: (referenceId: string) => void;
  onPreview: (index: number) => void;
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}

export function AdvancedRepaintReferencePicker({
  references,
  referenceRole,
  onReferenceRoleChange,
  onAddReferences,
  onRemoveReference,
  onPreview,
  showToast,
}: AdvancedRepaintReferencePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const remainingSlots = Math.max(0, MAX_REFERENCE_IMAGES - references.length);

  const addFiles = async (files: File[]) => {
    if (remainingSlots <= 0 || files.length === 0) return;
    setImporting(true);
    try {
      const incoming: RepaintReferenceImage[] = [];
      for (const file of files.filter(item => item.type.startsWith('image/')).slice(0, remainingSlots)) {
        incoming.push({
          id: generateUUID(),
          name: file.name,
          dataUrl: await readBlobAsDataUrl(file),
          mimeType: file.type || 'image/png',
        });
      }
      if (incoming.length > 0) onAddReferences(incoming);
      if (files.length > remainingSlots) showToast?.(`最多添加 ${MAX_REFERENCE_IMAGES} 张参考图，已添加可容纳的图片`, 'info');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '参考图读取失败', 'error');
    } finally {
      setImporting(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const importAssets = async (assets: ImageAsset[]) => {
    if (remainingSlots <= 0 || assets.length === 0) return;
    setImporting(true);
    try {
      const incoming: RepaintReferenceImage[] = [];
      for (const asset of assets.slice(0, remainingSlots)) {
        const blob = await getAssetBlob(asset.id);
        if (!blob) continue;
        incoming.push({
          id: generateUUID(),
          name: asset.name,
          dataUrl: await readBlobAsDataUrl(blob),
          mimeType: asset.mimeType || blob.type || 'image/png',
        });
      }
      if (incoming.length > 0) onAddReferences(incoming);
      else showToast?.('没有读取到可用的素材图片', 'error');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '素材导入失败', 'error');
    } finally {
      setImporting(false);
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (importing) return;
    const files = getClipboardImageFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void addFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    if (!importing) void addFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <div className="space-y-2" onPaste={handlePaste} tabIndex={0}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">参考图</span>
        <select
          value={referenceRole}
          onChange={event => onReferenceRoleChange(event.target.value as RepaintReferenceRole)}
          className="h-8 rounded-lg border border-input bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
        >
          {Object.entries(REFERENCE_ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {references.map((reference, index) => (
          <div key={reference.id} className="group relative aspect-square overflow-hidden rounded-lg border bg-muted">
            <button
              type="button"
              onClick={() => onPreview(index)}
              className="h-full w-full cursor-zoom-in"
              title={`查看大图：${reference.name}`}
            >
              <img src={reference.dataUrl} alt={reference.name} className="h-full w-full object-cover" />
            </button>
            <button
              type="button"
              onClick={() => onRemoveReference(reference.id)}
              className="absolute right-1 top-1 hidden rounded-full bg-black/65 p-1 text-white group-hover:block focus:block"
              aria-label="删除参考图"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}

        {remainingSlots > 0 && (
          <>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragEnter={event => {
                event.preventDefault();
                if (!importing) setIsDragOver(true);
              }}
              onDragOver={event => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                if (!importing) setIsDragOver(true);
              }}
              onDragLeave={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragOver(false);
              }}
              onDrop={handleDrop}
              disabled={importing}
              className={cn(
                'flex aspect-square flex-col items-center justify-center rounded-lg border border-dashed px-1 text-center text-[10px] transition disabled:cursor-wait disabled:opacity-60',
                isDragOver
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:border-primary hover:bg-primary/5 hover:text-primary',
              )}
              title="点击、拖拽或 Ctrl+V 上传参考图"
            >
              {importing ? <Loader2 className="mb-1 h-4 w-4 animate-spin" /> : <Images className="mb-1 h-4 w-4" />}
              {isDragOver ? '松开添加' : '添加 / 拖拽 / 粘贴'}
            </button>
            <button
              type="button"
              onClick={() => setAssetPickerOpen(true)}
              disabled={importing}
              className="flex aspect-square flex-col items-center justify-center rounded-lg border border-dashed px-1 text-center text-[10px] text-muted-foreground transition hover:border-primary hover:bg-primary/5 hover:text-primary disabled:cursor-wait disabled:opacity-60"
              title="从素材库选择参考图"
            >
              <ImagePlus className="mb-1 h-4 w-4" />素材库
            </button>
          </>
        )}
      </div>

      <p className="text-[10px] leading-4 text-muted-foreground">可点击、拖拽或 Ctrl+V 上传，也可从素材库导入；最多 {MAX_REFERENCE_IMAGES} 张。</p>
      <p className="text-[10px] leading-4 text-muted-foreground">
        {referenceRole === 'structure' && '只迁移相关形状、几何、比例和构造，不复制参考图中的其他主体与背景。'}
        {referenceRole === 'appearance' && '只迁移相关颜色、材质、纹理、表面效果或视觉气质，默认保持原有结构。'}
        {referenceRole === 'general' && '按修改需求综合使用参考图，只吸收与当前区域有关的信息。'}
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={event => void addFiles(Array.from(event.target.files || []))}
      />
      <AgentAssetPickerDialog
        open={assetPickerOpen}
        maxSelected={Math.max(1, remainingSlots)}
        onOpenChange={setAssetPickerOpen}
        onConfirm={assets => void importAssets(assets)}
      />
    </div>
  );
}

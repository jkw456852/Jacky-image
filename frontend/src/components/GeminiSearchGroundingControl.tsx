'use client';

import { useState } from 'react';
import { Globe2, Images, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { buttonVariants } from '@/components/ui/button';
import {
  supportsImageSearchGrounding,
  supportsWebSearchGrounding,
} from '@/lib/model-capabilities';
import { cn } from '@/lib/utils';

interface GeminiSearchGroundingControlProps {
  model: string;
  webSearchEnabled: boolean;
  imageSearchEnabled: boolean;
  onChange: (patch: { webSearchEnabled?: boolean; imageSearchEnabled?: boolean }) => void;
  size?: 'xs' | 'sm';
}

export function GeminiSearchGroundingControl({
  model,
  webSearchEnabled,
  imageSearchEnabled,
  onChange,
  size = 'xs',
}: GeminiSearchGroundingControlProps) {
  const [open, setOpen] = useState(false);
  const webSupported = supportsWebSearchGrounding(model);
  const imageSupported = supportsImageSearchGrounding(model);
  if (!webSupported && !imageSupported) return null;

  const activeWebSearch = webSupported && webSearchEnabled;
  const activeImageSearch = imageSupported && imageSearchEnabled;
  const active = activeWebSearch || activeImageSearch;
  const label = activeWebSearch && activeImageSearch
    ? '网页+图片'
    : activeWebSearch
      ? '联网'
      : activeImageSearch
        ? '图片搜索'
        : '搜索';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          buttonVariants({ variant: 'outline', size }),
          'gap-1',
          active && 'border-primary bg-primary/5 text-primary',
        )}
        title="搜索接地设置"
      >
        <Search className="h-3 w-3" />
        <span className="text-[11px]">{label}</span>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">搜索接地</p>
            <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
              生成前搜索实时网页或图片资料，结果会附带搜索来源。
            </p>
          </div>

          {webSupported && (
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border/80 p-2.5">
              <span className="flex min-w-0 items-start gap-2">
                <Globe2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
                <span>
                  <span className="block text-sm font-medium">联网搜索</span>
                  <span className="block text-xs text-muted-foreground">搜索最新网页信息</span>
                </span>
              </span>
              <Switch
                checked={webSearchEnabled}
                onCheckedChange={checked => onChange({ webSearchEnabled: checked })}
              />
            </label>
          )}

          {imageSupported && (
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border/80 p-2.5">
              <span className="flex min-w-0 items-start gap-2">
                <Images className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
                <span>
                  <span className="block text-sm font-medium">图片搜索</span>
                  <span className="block text-xs text-muted-foreground">搜索网络图片作为视觉参考</span>
                </span>
              </span>
              <Switch
                checked={imageSearchEnabled}
                onCheckedChange={checked => onChange({ imageSearchEnabled: checked })}
              />
            </label>
          )}

          <p className="text-[11px] leading-4 text-muted-foreground">
            搜索会增加生成耗时；图片搜索仅 Banana 2 支持。
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

'use client';

import { Check, SlidersHorizontal } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  DEFAULT_GPT_IMAGE_ADVANCED_PARAMS,
  GPT_IMAGE_BACKGROUND_OPTIONS,
  GPT_IMAGE_QUALITY_OPTIONS,
  GPT_IMAGE_STYLE_OPTIONS,
  type GptImageAdvancedParams,
  type GptImageBackground,
  type GptImageQuality,
  type GptImageStyle,
} from '@/lib/model-capabilities';

interface GptImageAdvancedParamsControlProps {
  value: GptImageAdvancedParams;
  onChange: (value: GptImageAdvancedParams) => void;
  disabled?: boolean;
  variant?: 'ghost' | 'outline';
  size?: 'xs' | 'sm';
}

function isDefaultValue(value: GptImageAdvancedParams): boolean {
  return (
    value.quality === DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.quality &&
    value.style === DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.style &&
    value.background === DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.background
  );
}

function formatLabel(value: GptImageAdvancedParams): string {
  if (isDefaultValue(value)) return '图像参数';
  const quality = GPT_IMAGE_QUALITY_OPTIONS.find(option => option.value === value.quality)?.label || value.quality;
  const style = GPT_IMAGE_STYLE_OPTIONS.find(option => option.value === value.style)?.label || value.style;
  const background = GPT_IMAGE_BACKGROUND_OPTIONS.find(option => option.value === value.background)?.label || value.background;
  return `${quality}/${style}/${background}`;
}

export function GptImageAdvancedParamsControl({
  value,
  onChange,
  disabled = false,
  variant = 'ghost',
  size = 'xs',
}: GptImageAdvancedParamsControlProps) {
  const triggerClass = cn(
    buttonVariants({ variant, size }),
    'gap-1',
  );

  const updateQuality = (quality: GptImageQuality) => onChange({ ...value, quality });
  const updateStyle = (style: GptImageStyle) => onChange({ ...value, style });
  const updateBackground = (background: GptImageBackground) => onChange({ ...value, background });

  return (
    <Popover>
      <PopoverTrigger className={triggerClass} disabled={disabled} title="图像参数">
        <SlidersHorizontal className="h-3 w-3" />
        <span className="shrink-0 truncate text-[11px]">{formatLabel(value)}</span>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="space-y-3">
          <ParamGroup
            label="质量"
            options={GPT_IMAGE_QUALITY_OPTIONS}
            value={value.quality}
            onSelect={updateQuality}
          />
          <ParamGroup
            label="风格"
            options={GPT_IMAGE_STYLE_OPTIONS}
            value={value.style}
            onSelect={updateStyle}
          />
          <ParamGroup
            label="背景"
            options={GPT_IMAGE_BACKGROUND_OPTIONS}
            value={value.background}
            onSelect={updateBackground}
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="w-full"
            onClick={() => onChange(DEFAULT_GPT_IMAGE_ADVANCED_PARAMS)}
          >
            重置为自动
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface ParamGroupProps<T extends string> {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onSelect: (value: T) => void;
}

function ParamGroup<T extends string>({ label, options, value, onSelect }: ParamGroupProps<T>) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="grid grid-cols-2 gap-1">
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            onClick={() => onSelect(option.value)}
            className={cn(
              'flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted',
              option.value === value && 'bg-muted font-medium',
            )}
          >
            <span>{option.label}</span>
            {option.value === value && <Check className="h-3.5 w-3.5" />}
          </button>
        ))}
      </div>
    </div>
  );
}

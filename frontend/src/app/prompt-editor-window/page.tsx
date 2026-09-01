'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { buildAnglePrompt } from '@/components/seat-cover-generation/seat-cover-generation-service';
import { PromptTemplateEditor } from '@/components/seat-cover-generation/PromptTemplateEditor';
import { extractSeatCoverAngleRule, loadSeatCoverPromptBundle, saveSeatCoverAnglePrompt } from '@/components/seat-cover-generation/prompt-templates';
import { supportsImageSearchGrounding, supportsWebSearchGrounding } from '@/lib/model-capabilities';
import type { SeatCoverAnglePreset } from '@/components/seat-cover-generation/types';

type PromptEditorPayload = {
  preset: SeatCoverAnglePreset;
  context: {
    model: string;
    vehicleModel: string;
    vehicleYear: string;
    vehicleTrim: string;
    extraPrompt: string;
    referenceCount: number;
    webSearchEnabled: boolean;
    imageSearchEnabled: boolean;
  };
};

export default function PromptEditorWindowPage() {
  const [sessionId] = useState<string | null>(() => typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('sessionId'));
  const [payload, setPayload] = useState<PromptEditorPayload | null>(null);
  const [value, setValue] = useState('');
  const [defaultValue, setDefaultValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('正在加载提示词编辑器…');

  useEffect(() => {
    document.getElementById('app-boot-loader')?.remove();
    if (!sessionId || !window.jackyDesktop?.promptEditorWindow) {
      window.setTimeout(() => {
        setLoading(false);
        setStatus('独立提示词窗口连接失败，请关闭窗口后从主应用重新打开。');
      }, 0);
      return;
    }
    void window.jackyDesktop.promptEditorWindow.getPayload(sessionId).then(async result => {
      if (!result.ok || !result.payload) {
        setStatus(result.error || '提示词编辑数据读取失败');
        setLoading(false);
        return;
      }
      const nextPayload = result.payload as PromptEditorPayload;
      const bundle = await loadSeatCoverPromptBundle();
      const currentRule = bundle.prompts[nextPayload.preset.name] || '';
      const defaultRule = bundle.defaults[nextPayload.preset.name] || nextPayload.preset.promptHint || '';
      const currentTemplate = currentRule || defaultRule;
      setPayload(nextPayload);
      setValue(extractSeatCoverAngleRule(currentTemplate));
      setDefaultValue(extractSeatCoverAngleRule(defaultRule));
      setLoading(false);
      setStatus('');
    }).catch(error => {
      setLoading(false);
      setStatus(error instanceof Error ? error.message : '提示词编辑数据读取失败');
    });
  }, [sessionId]);

  const close = () => {
    if (sessionId && window.jackyDesktop?.promptEditorWindow) void window.jackyDesktop.promptEditorWindow.close(sessionId);
  };

  const preview = useMemo(() => {
    if (!payload) return '';
    const { context, preset } = payload;
    return buildAnglePrompt(
      context.vehicleModel,
      context.vehicleYear,
      context.vehicleTrim,
      context.extraPrompt,
      preset,
      context.referenceCount,
      supportsWebSearchGrounding(context.model) && context.webSearchEnabled,
      supportsImageSearchGrounding(context.model) && context.imageSearchEnabled,
      value,
    );
  }, [payload, value]);

  if (loading || !payload) return <main className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground"><Loader2 className="mr-2 size-5 animate-spin" />{status}</main>;

  return <PromptTemplateEditor
    key={sessionId || payload.preset.id}
    standalone
    open
    angleName={payload.preset.name}
    value={value}
    defaultValue={defaultValue}
    preview={preview}
    onOpenChange={open => { if (!open) close(); }}
    onDraftChange={setValue}
    onReset={() => setValue(defaultValue)}
    onSave={async content => {
      const result = await saveSeatCoverAnglePrompt(payload.preset.name, content);
      if (!result.ok) throw new Error(result.error || '提示词保存失败');
      setValue(content);
    }}
    showToast={message => setStatus(message)}
  />;
}

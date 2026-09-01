'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { AdvancedRepaintWorkspace } from '@/components/advanced-repaint/AdvancedRepaintWorkspace';
import type { RepaintReferenceImage } from '@/components/advanced-repaint/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

type RepaintWindowPayload = {
  sourceDataUrl: string;
  fileName?: string;
  hasApiKey?: boolean;
  references?: RepaintReferenceImage[];
};

export default function RepaintWindowPage() {
  const [sessionId] = useState<string | null>(() => typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('sessionId'));
  const [payload, setPayload] = useState<RepaintWindowPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('正在准备局部重绘…');

  useEffect(() => {
    document.getElementById('app-boot-loader')?.remove();
    const id = sessionId;
    if (!id || !window.jackyDesktop?.repaintWindow) {
      window.setTimeout(() => {
        setLoading(false);
        setStatus('局部重绘窗口连接失败，请关闭窗口后从主应用重新打开。');
      }, 0);
      return;
    }
    void window.jackyDesktop.repaintWindow.getPayload(id).then(result => {
      if (result.ok && result.payload) {
        setPayload(result.payload);
        setStatus('');
      } else {
        setStatus(result.error || '局部重绘数据读取失败');
      }
      setLoading(false);
    }).catch(error => {
      setLoading(false);
      setStatus(error instanceof Error ? error.message : '局部重绘数据读取失败');
    });
  }, [sessionId]);

  const close = () => {
    if (sessionId && window.jackyDesktop?.repaintWindow) {
      void window.jackyDesktop.repaintWindow.cancel(sessionId);
    }
  };

  const applyResult = (dataUrl: string) => {
    if (!sessionId || !window.jackyDesktop?.repaintWindow) return;
    setStatus('正在把局部重绘结果覆盖回候选图…');
    void window.jackyDesktop.repaintWindow.complete(sessionId, dataUrl).catch(error => {
      setStatus(error instanceof Error ? error.message : '结果回写失败');
    });
  };

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b bg-card px-4 py-3 shadow-sm">
        <div className="flex min-w-0 items-center gap-2"><Check className="size-5 text-primary" /><h1 className="truncate font-semibold">座套候选 · 局部重绘</h1><Badge variant="secondary">独立窗口</Badge></div>
        <Button variant="outline" onClick={close}><X className="size-4" />关闭</Button>
      </header>
      {!payload ? <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">{loading && <Loader2 className="mr-2 size-5 animate-spin" />}{status}</div> : <div className="min-h-0 flex-1 overflow-auto p-3"><AdvancedRepaintWorkspace
        wideMode
        hasApiKey={payload.hasApiKey !== false}
        onConfigureApiKey={() => setStatus('请先回到主窗口配置 API Key，再重新打开局部重绘。')}
        showToast={(message, type) => setStatus(`${type === 'error' ? '错误：' : ''}${message}`)}
        initialSourceDataUrl={payload.sourceDataUrl}
        initialSourceFileName={payload.fileName}
        initialReferences={payload.references || []}
        onApplyResult={applyResult}
      /></div>}
    </main>
  );
}

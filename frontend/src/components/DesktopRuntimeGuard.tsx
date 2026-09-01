'use client';

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { MonitorCog } from 'lucide-react';

type RuntimeState = 'checking' | 'ready' | 'blocked';

export function DesktopRuntimeGuard({ children }: { children: ReactNode }) {
  const runtimeState = useSyncExternalStore<RuntimeState>(
    () => () => undefined,
    () => window.jackyDesktop?.isElectron === true ? 'ready' : 'blocked',
    () => 'checking',
  );

  useEffect(() => {
    document.getElementById('app-boot-loader')?.remove();
  }, []);

  if (runtimeState === 'checking') return null;

  if (runtimeState === 'blocked') {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6 pt-[var(--jacky-desktop-titlebar-height)]">
        <div className="max-w-md space-y-4 text-center">
          <MonitorCog className="mx-auto h-10 w-10 text-muted-foreground" />
          <div className="space-y-2">
            <h1 className="text-xl font-semibold">请使用 Jacky Image 桌面版</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              当前构建仅支持 Electron 桌面运行环境，浏览器入口不再提供模型配置、历史记录或图片缓存功能。
            </p>
          </div>
        </div>
      </main>
    );
  }

  return children;
}

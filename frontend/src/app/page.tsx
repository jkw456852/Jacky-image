'use client';

import { WorkspaceShell } from '@/components/workspace/WorkspaceShell';
import { DesktopRuntimeGuard } from '@/components/DesktopRuntimeGuard';

export default function Home() {
  return (
    <DesktopRuntimeGuard>
      <WorkspaceShell />
    </DesktopRuntimeGuard>
  );
}

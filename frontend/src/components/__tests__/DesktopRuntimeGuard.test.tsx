import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DesktopRuntimeGuard } from '@/components/DesktopRuntimeGuard';

afterEach(() => {
  delete window.jackyDesktop;
});

describe('DesktopRuntimeGuard', () => {
  it('blocks standalone browser access', async () => {
    render(<DesktopRuntimeGuard><div>workspace</div></DesktopRuntimeGuard>);

    expect(await screen.findByText('请使用 Jacky Image 桌面版')).toBeInTheDocument();
    expect(screen.queryByText('workspace')).not.toBeInTheDocument();
  });

  it('renders the workspace when the Electron bridge is present', async () => {
    Object.defineProperty(window, 'jackyDesktop', {
      configurable: true,
      value: { isElectron: true },
    });

    render(<DesktopRuntimeGuard><div>workspace</div></DesktopRuntimeGuard>);

    expect(await screen.findByText('workspace')).toBeInTheDocument();
  });
});

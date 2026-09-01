import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SeatMaskEditor } from '../SeatMaskEditor';

vi.mock('@/components/advanced-repaint/AdvancedRepaintCanvas', () => ({
  AdvancedRepaintCanvas: () => <div data-testid="mask-canvas" />,
}));

describe('SeatMaskEditor smart supplement controls', () => {
  it('offers click-based smart supplementation after automatic detection', async () => {
    render(<SeatMaskEditor sourceUrl="data:image/png;base64,AA==" scope="front" onCancel={() => undefined} onSave={() => undefined} />);
    expect(screen.getByRole('button', { name: '自动识别座椅' })).toBeInTheDocument();
    const smartButton = screen.getByRole('button', { name: '智能补选' });
    expect(smartButton).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(smartButton);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/Ctrl\/⌘ \+ 左键补充识别点/)).toBeInTheDocument();
    expect(screen.getByText(/Alt \+ 左键或右键点击排除区域/)).toBeInTheDocument();
  });
});

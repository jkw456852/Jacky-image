import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MaskUploadControl } from '../MaskUploadControl';

const strategy = {
  representation: 'black-white' as const,
  label: '黑白语义蒙版（自动）',
  description: '自动转换为纯黑白蒙版',
  precise: false,
  consumesImageSlot: true,
};

describe('MaskUploadControl', () => {
  it('accepts a mask image dropped anywhere on the mask control', () => {
    const onFile = vi.fn();
    render(
      <MaskUploadControl
        draft={null}
        processed={null}
        strategy={strategy}
        loading={false}
        targetReady={false}
        onFile={onFile}
        onRemove={vi.fn()}
        onSourceModeChange={vi.fn()}
        onThresholdChange={vi.fn()}
        onSoftEdgesChange={vi.fn()}
        onInvert={vi.fn()}
      />,
    );

    const zone = screen.getByLabelText('遮罩蒙版上传区域');
    const file = new File(['mask'], 'mask.png', { type: 'image/png' });
    const dataTransfer = { files: [file], dropEffect: 'none' };

    fireEvent.dragEnter(zone, { dataTransfer });
    expect(screen.getByText('松开以上传蒙版')).toBeInTheDocument();

    fireEvent.drop(zone, { dataTransfer });
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it('accepts a mask image pasted anywhere on the mask control', () => {
    const onFile = vi.fn();
    render(
      <MaskUploadControl
        draft={null}
        processed={null}
        strategy={strategy}
        loading={false}
        targetReady={false}
        onFile={onFile}
        onRemove={vi.fn()}
        onSourceModeChange={vi.fn()}
        onThresholdChange={vi.fn()}
        onSoftEdgesChange={vi.fn()}
        onInvert={vi.fn()}
      />,
    );

    const zone = screen.getByLabelText('遮罩蒙版上传区域');
    const file = new File(['mask'], 'pasted-mask.png', { type: 'image/png' });
    fireEvent.paste(zone, {
      clipboardData: {
        items: [{ type: file.type, getAsFile: () => file }],
        files: [file],
      },
    });

    expect(onFile).toHaveBeenCalledWith(file);
  });
});

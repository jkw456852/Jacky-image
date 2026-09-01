import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getAssetBlob, type ImageAsset } from '@/lib/asset-store';
import { AdvancedRepaintReferencePicker } from '../AdvancedRepaintReferencePicker';

const libraryAsset: ImageAsset = {
  id: 'asset-1',
  blobKey: 'asset-1.png',
  hash: 'hash',
  name: 'library.png',
  mimeType: 'image/png',
  sizeBytes: 7,
  tags: [],
  note: '',
  sourceKind: 'manual',
  sourceLabel: '素材库',
  createdAt: 1,
  updatedAt: 1,
};

vi.mock('@/lib/asset-store', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/asset-store')>();
  return { ...actual, getAssetBlob: vi.fn() };
});

vi.mock('@/components/agent/AgentAssetPickerDialog', () => ({
  AgentAssetPickerDialog: ({ open, onConfirm }: { open: boolean; onConfirm: (assets: ImageAsset[]) => void }) => open
    ? <button type="button" onClick={() => onConfirm([libraryAsset])}>确认导入素材</button>
    : null,
}));

function renderPicker(onAddReferences = vi.fn()) {
  render(
    <AdvancedRepaintReferencePicker
      references={[]}
      referenceRole="general"
      onReferenceRoleChange={vi.fn()}
      onAddReferences={onAddReferences}
      onRemoveReference={vi.fn()}
      onPreview={vi.fn()}
    />,
  );
  return onAddReferences;
}

describe('AdvancedRepaintReferencePicker', () => {
  it('accepts reference images dropped onto the upload tile', async () => {
    const onAddReferences = renderPicker();
    const uploadTile = screen.getByTitle('点击、拖拽或 Ctrl+V 上传参考图');
    const file = new File(['image'], 'dropped.png', { type: 'image/png' });
    const dataTransfer = { files: [file], dropEffect: 'none' };

    fireEvent.dragEnter(uploadTile, { dataTransfer });
    expect(screen.getByText('松开添加')).toBeInTheDocument();
    fireEvent.drop(uploadTile, { dataTransfer });

    await waitFor(() => expect(onAddReferences).toHaveBeenCalledTimes(1));
    expect(onAddReferences.mock.calls[0][0][0]).toMatchObject({
      name: 'dropped.png',
      mimeType: 'image/png',
    });
    expect(onAddReferences.mock.calls[0][0][0].dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('accepts reference images pasted from the clipboard', async () => {
    const onAddReferences = renderPicker();
    const uploadArea = screen.getByText('参考图').closest('[tabindex="0"]')!;
    const file = new File(['image'], 'pasted.png', { type: 'image/png' });
    const clipboardData = {
      items: [{ type: file.type, getAsFile: () => file }],
      files: [file],
    };

    fireEvent.paste(uploadArea, { clipboardData });

    await waitFor(() => expect(onAddReferences).toHaveBeenCalledTimes(1));
    expect(onAddReferences.mock.calls[0][0][0]).toMatchObject({
      name: 'pasted.png',
      mimeType: 'image/png',
    });
  });

  it('imports selected images from the asset library', async () => {
    vi.mocked(getAssetBlob).mockResolvedValue(new Blob(['library'], { type: 'image/png' }));
    const onAddReferences = renderPicker();

    fireEvent.click(screen.getByTitle('从素材库选择参考图'));
    fireEvent.click(screen.getByRole('button', { name: '确认导入素材' }));

    await waitFor(() => expect(onAddReferences).toHaveBeenCalledTimes(1));
    expect(getAssetBlob).toHaveBeenCalledWith('asset-1');
    expect(onAddReferences.mock.calls[0][0][0]).toMatchObject({
      name: 'library.png',
      mimeType: 'image/png',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { getClipboardImageFiles } from '@/lib/clipboard-image';

describe('getClipboardImageFiles', () => {
  it('reads image files from clipboard items', () => {
    const image = new File(['image'], 'clipboard.png', { type: 'image/png' });
    const text = new File(['text'], 'note.txt', { type: 'text/plain' });
    const dataTransfer = {
      items: [
        { type: image.type, getAsFile: () => image },
        { type: text.type, getAsFile: () => text },
      ],
      files: [image],
    } as unknown as DataTransfer;

    expect(getClipboardImageFiles(dataTransfer)).toEqual([image]);
  });

  it('falls back to clipboard files when items are unavailable', () => {
    const image = new File(['image'], 'clipboard.webp', { type: 'image/webp' });
    const text = new File(['text'], 'note.txt', { type: 'text/plain' });
    const dataTransfer = { files: [text, image] } as unknown as DataTransfer;

    expect(getClipboardImageFiles(dataTransfer)).toEqual([image]);
  });
});

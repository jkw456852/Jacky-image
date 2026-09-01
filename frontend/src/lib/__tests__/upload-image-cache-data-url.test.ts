import { describe, expect, it } from 'vitest';
import { dataUrlToBlob } from '@/lib/upload-image-cache';

describe('upload cache data URL conversion', () => {
  it('decodes base64 image data without issuing a fetch request', async () => {
    const blob = dataUrlToBlob('data:image/png;base64,AAECAw==');

    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(4);
  });

  it('decodes percent-encoded data URLs', async () => {
    const blob = dataUrlToBlob('data:text/plain;charset=utf-8,hello%20jacky');

    expect(blob.type).toBe('text/plain');
    expect(blob.size).toBe(11);
  });

  it('rejects malformed data URLs with a readable error', () => {
    expect(() => dataUrlToBlob('not-a-data-url')).toThrow('图片数据格式无效');
  });
});

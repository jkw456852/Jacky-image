import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSeatCoverImageBlob } from '../image-source';

describe('seat-cover fitting image source', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('decodes an uploaded data URL without using fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const blob = await resolveSeatCoverImageBlob('data:image/png;base64,aGVsbG8=');

    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(5);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads a temporary backend URL when the local cache is not available', async () => {
    const bytes = new TextEncoder().encode('image');
    const fetchSpy = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const blob = await resolveSeatCoverImageBlob('URL:/api/jacky/images/task-1/0');

    expect(fetchSpy).toHaveBeenCalledWith('/api/jacky/images/task-1/0');
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(5);
  });
});

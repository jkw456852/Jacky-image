import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadAndStoreImages,
  deleteStoredBlobs,
  fetchImageAsBlob,
  getStoredBlob,
  storeImageBlob,
  type ImageDownloadProgressItem,
} from '@/lib/image-downloader';

function makeStream(chunks: number[][], failAtIndex?: number): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAtIndex !== undefined && index === failAtIndex) {
        controller.error(new Error('stream failed'));
        return;
      }
      const chunk = chunks[index];
      if (!chunk) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(new Uint8Array(chunk));
    },
  });
}

function mockImageFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  delete window.jackyDesktop;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchImageAsBlob', () => {
  it('按 Content-Length 上报流式下载进度', async () => {
    const progress: Array<{ loadedBytes: number; totalBytes?: number; percent?: number }> = [];
    mockImageFetch(new Response(makeStream([[1, 2], [3, 4]]), {
      headers: {
        'content-length': '4',
        'content-type': 'image/png',
      },
    }));

    const blob = await fetchImageAsBlob('/image.png', 1, item => progress.push(item));

    expect(blob.size).toBe(4);
    expect(progress).toEqual([
      { loadedBytes: 0, totalBytes: 4, percent: 0 },
      { loadedBytes: 2, totalBytes: 4, percent: 50 },
      { loadedBytes: 4, totalBytes: 4, percent: 100 },
    ]);
  });

  it('未知总大小时仍上报已下载字节', async () => {
    const progress: Array<{ loadedBytes: number; totalBytes?: number; percent?: number }> = [];
    mockImageFetch(new Response(makeStream([[1], [2, 3]]), {
      headers: { 'content-type': 'image/png' },
    }));

    const blob = await fetchImageAsBlob('/image.png', 1, item => progress.push(item));

    expect(blob.size).toBe(3);
    expect(progress.at(-1)).toMatchObject({ loadedBytes: 3 });
    expect(progress.at(-1)?.totalBytes).toBeUndefined();
    expect(progress.at(-1)?.percent).toBeUndefined();
  });

  it('HTTP 非 2xx 时抛出状态码错误', async () => {
    mockImageFetch(new Response('bad gateway', { status: 502 }));

    await expect(fetchImageAsBlob('/image.png', 1)).rejects.toThrow('HTTP 502');
  });

  it('body 读取中断时抛出流错误', async () => {
    const progress: Array<{ loadedBytes: number }> = [];
    mockImageFetch(new Response(makeStream([[1]], 1), {
      headers: { 'content-length': '2' },
    }));

    await expect(fetchImageAsBlob('/image.png', 1, item => progress.push(item))).rejects.toThrow('stream failed');
    expect(progress.some(item => item.loadedBytes === 1)).toBe(true);
  });
});

describe('downloadAndStoreImages', () => {
  it('没有 Electron 文件桥接时拒绝写入浏览器缓存', async () => {
    const progress: ImageDownloadProgressItem[] = [];
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:cached-0'),
      revokeObjectURL: vi.fn(),
    });
    mockImageFetch(new Response(makeStream([[1, 2]]), {
      headers: {
        'content-length': '2',
        'content-type': 'image/png',
      },
    }));

    const result = await downloadAndStoreImages('job-fallback', ['URL:/image.png'], {
      maxRetries: 1,
      onProgress: item => progress.push(item),
    });

    expect(result.successCount).toBe(0);
    expect(result.failCount).toBe(1);
    expect(result.blobUrls).toEqual(['']);
    expect(result.items[0]).toMatchObject({ index: 0, status: 'failed', error: 'Jacky Image 仅支持桌面版图片缓存' });
    expect(progress.some(item => item.status === 'downloading' && item.percent === 100)).toBe(true);
    await expect(getStoredBlob('job-fallback', 0)).resolves.toBeNull();
  });

  it('Electron 环境通过本地文件桥接读写图片缓存', async () => {
    const write = vi.fn().mockResolvedValue({ ok: true });
    const read = vi.fn().mockResolvedValue({
      ok: true,
      mimeType: 'image/png',
      bytes: new Uint8Array([7, 8, 9]),
    });
    const deleteJob = vi.fn().mockResolvedValue({ ok: true, deleted: 1 });
    Object.defineProperty(window, 'jackyDesktop', {
      configurable: true,
      value: { imageCache: { write, read, deleteJob } },
    });

    await storeImageBlob('desktop-job', 0, new Blob([new Uint8Array([1, 2])], { type: 'image/png' }));
    const restored = await getStoredBlob('desktop-job', 0);
    await deleteStoredBlobs('desktop-job', 1);

    expect(write).toHaveBeenCalled();
    expect(restored).toMatchObject({ size: 3, type: 'image/png' });
    expect(deleteJob).toHaveBeenCalledWith('desktop-job', 1);
  });
});

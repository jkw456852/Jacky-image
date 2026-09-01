import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadJobs, saveJobs, type StoredJob } from '@/lib/job-store';

const job: StoredJob = {
  id: 'job-1',
  status: 'completed',
  mode: 'text-to-image',
  prompt: 'test',
  output_size: '1K',
  temperature: 1,
  aspect_ratio: '1:1',
  model: 'gpt-image-2',
  created_at: '2026-07-28T00:00:00.000Z',
  images: ['blob:runtime-image'],
  blobUrls: ['blob:runtime-image'],
};

function installRecordsBridge(loadValue: unknown[] | null = null) {
  const saveJobsBridge = vi.fn<(jobs: unknown[]) => { ok: boolean }>(() => ({ ok: true }));
  Object.defineProperty(window, 'jackyDesktop', {
    configurable: true,
    value: {
      records: {
        loadJobs: () => loadValue,
        saveJobs: saveJobsBridge,
      },
      imageCache: {},
    },
  });
  return saveJobsBridge;
}

describe('desktop usage records', () => {
  beforeEach(() => localStorage.clear());

  afterEach(() => {
    delete window.jackyDesktop;
    vi.restoreAllMocks();
  });

  it('loads usage history from the desktop file bridge', () => {
    installRecordsBridge([{ ...job, images: ['FILE:job-1-0'], imageData: 'FILE:job-1-0' }]);

    expect(loadJobs()[0]?.images).toEqual(['FILE:job-1-0']);
  });

  it('writes persistent file references instead of blob URLs', () => {
    const save = installRecordsBridge([]);

    saveJobs([job]);

    expect(save).toHaveBeenCalledWith([
      expect.objectContaining({
        images: ['FILE:job-1-0'],
        imageData: 'FILE:job-1-0',
      }),
    ]);
    const savedJobs = save.mock.calls[0]?.[0] as StoredJob[];
    expect(savedJobs[0]?.blobUrls).toBeUndefined();
    expect(localStorage.getItem('jacky-jobs')).toBeNull();
  });
});

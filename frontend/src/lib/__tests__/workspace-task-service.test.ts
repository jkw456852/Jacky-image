import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ackJackyTask, createJackyTask, resolveImageTaskProvider, type JackyTaskResponse } from '@/lib/ccode-task-client';
import { downloadAndStoreImages } from '@/lib/image-downloader';
import type { StoredJob } from '@/lib/job-store';
import {
  finalizeCompletedServerTask,
  submitImageToImage,
  submitTextToImage,
  type SubmitActions,
} from '@/lib/workspace-task-service';
vi.mock('@/lib/ccode-task-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/ccode-task-client')>();
  return {
    ...actual,
    ackJackyTask: vi.fn(),
    createJackyTask: vi.fn(),
    resolveImageTaskProvider: vi.fn(),
  };
});

vi.mock('@/lib/image-downloader', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/image-downloader')>();
  return {
    ...actual,
    downloadAndStoreImages: vi.fn(),
  };
});

const mockedAckJackyTask = vi.mocked(ackJackyTask);
const mockedCreateJackyTask = vi.mocked(createJackyTask);
const mockedDownloadAndStoreImages = vi.mocked(downloadAndStoreImages);
const mockedResolveImageTaskProvider = vi.mocked(resolveImageTaskProvider);

function makeJob(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    id: 'job-1',
    status: 'processing',
    mode: 'text-to-image',
    prompt: 'prompt',
    output_size: '1K',
    temperature: 1,
    aspect_ratio: '1:1',
    model: 'gemini-3-pro-image-preview',
    created_at: '2026-06-07T00:00:00.000Z',
    serverTaskId: 'task-1',
    ...overrides,
  };
}

function makeCompletedTask(images: string[]): JackyTaskResponse {
  return {
    id: 'task-1',
    status: 'completed',
    result: { images },
  };
}

function createActions(initialJob: StoredJob): { actions: SubmitActions; getJob: () => StoredJob } {
  let currentJob = initialJob;
  const actions: SubmitActions = {
    addJob: vi.fn(),
    replaceJob: vi.fn((_jobId, updater) => {
      currentJob = updater(currentJob);
    }),
    completeJob: vi.fn(async (_jobId, job) => {
      currentJob = job;
    }),
    failJob: vi.fn(async (_jobId, error) => {
      currentJob = { ...currentJob, status: 'failed', error };
    }),
  };

  return {
    actions,
    getJob: () => currentJob,
  };
}

beforeEach(() => {
  mockedAckJackyTask.mockReset();
  mockedAckJackyTask.mockResolvedValue(undefined);
  mockedCreateJackyTask.mockReset();
  mockedCreateJackyTask.mockResolvedValue('task-advanced-1');
  mockedDownloadAndStoreImages.mockReset();
  mockedResolveImageTaskProvider.mockReset();
  mockedResolveImageTaskProvider.mockReturnValue({
    modelConfigId: 'image-config-1',
    protocol: 'openai',
    modelId: 'gpt-image-2',
  });
});

describe('submitImageToImage mask forwarding', () => {
  it('passes the normalized mask separately from reference images', async () => {
    const job = makeJob({ mode: 'image-to-image' });
    const { actions } = createActions(job);

    await submitImageToImage({
      prompt: 'replace the sky',
      files: [{
        id: 'image-1',
        name: 'source.png',
        dataUrl: 'data:image/png;base64,U09VUkNF',
        mimeType: 'image/png',
      }],
      mask: {
        dataUrl: 'data:image/png;base64,TUFTSw==',
        mimeType: 'image/png',
        representation: 'alpha',
        width: 1024,
        height: 1024,
        sourceMode: 'alpha',
        inverted: false,
      },
      outputSize: '1K',
      aspectRatio: '1:1',
      temperature: 1,
      webSearchEnabled: false,
      imageSearchEnabled: false,
      model: 'gpt-image-2',
      gptImageQuality: 'high',
      gptImageStyle: 'vivid',
      gptImageBackground: 'transparent',
      parallelCount: 1,
    }, actions, vi.fn());

    expect(mockedCreateJackyTask).toHaveBeenCalledWith(expect.objectContaining({
      images: [{ data: 'U09VUkNF', mimeType: 'image/png' }],
      mask: expect.objectContaining({
        data: 'TUFTSw==',
        mimeType: 'image/png',
        representation: 'alpha',
        width: 1024,
        height: 1024,
      }),
    }));
    expect(actions.addJob).toHaveBeenCalledWith(expect.objectContaining({
      maskImage: expect.objectContaining({ representation: 'alpha' }),
    }));
  });
});

describe('submitTextToImage', () => {
  it('passes GPT Image advanced params into createJackyTask payload', async () => {
    const job = makeJob();
    const { actions, getJob } = createActions(job);

    await submitTextToImage({
      prompts: ['cut out subject'],
      outputSize: '1K',
      aspectRatio: '1:1',
      temperature: 1,
      webSearchEnabled: false,
      imageSearchEnabled: false,
      model: 'gpt-image-2',
      gptImageQuality: 'high',
      gptImageStyle: 'vivid',
      gptImageBackground: 'transparent',
      parallelCount: 1,
    }, actions, vi.fn());

    expect(mockedCreateJackyTask).toHaveBeenCalledWith(expect.objectContaining({
      modelConfigId: 'image-config-1',
      mode: 'text-to-image',
      model: 'gpt-image-2',
      gptImageQuality: 'high',
      gptImageStyle: 'vivid',
      gptImageBackground: 'transparent',
    }));
    expect(actions.addJob).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-image-2',
      prompt: 'cut out subject',
    }));
    expect(getJob().serverTaskId).toBe('task-advanced-1');
  });

  it('forwards Gemini web and image search switches', async () => {
    mockedResolveImageTaskProvider.mockReturnValue({
      modelConfigId: 'banana-2-config',
      protocol: 'google',
      modelId: 'gemini-3.1-flash-image-preview',
    });
    const { actions } = createActions(makeJob());

    await submitTextToImage({
      prompts: ['latest electric vehicle concept'],
      outputSize: '1K',
      aspectRatio: '16:9',
      temperature: 1,
      webSearchEnabled: true,
      imageSearchEnabled: true,
      model: 'banana-2-config',
      gptImageQuality: 'auto',
      gptImageStyle: 'auto',
      gptImageBackground: 'auto',
      parallelCount: 1,
    }, actions, vi.fn());

    expect(mockedCreateJackyTask).toHaveBeenCalledWith(expect.objectContaining({
      modelConfigId: 'banana-2-config',
      model: 'gemini-3.1-flash-image-preview',
      webSearchEnabled: true,
      imageSearchEnabled: true,
    }));
  });

  it('preserves search grounding metadata on completed jobs', async () => {
    const job = makeJob({ webSearchEnabled: true, imageSearchEnabled: true });
    const { actions, getJob } = createActions(job);
    const task: JackyTaskResponse = {
      id: 'task-1',
      status: 'completed',
      result: {
        images: ['base64-image'],
        searchGrounding: [{
          webSearchQueries: ['latest product'],
          imageSearchQueries: ['product reference'],
          sources: [{ uri: 'https://example.com', title: 'Example', type: 'web' }],
        }],
      },
    };

    await finalizeCompletedServerTask(job, task, actions);

    expect(getJob().searchGrounding).toEqual(task.result?.searchGrounding);
  });
});

describe('finalizeCompletedServerTask', () => {
  it('全部 URL 图片缓存成功后替换为 blob URL 并 ack 服务端任务', async () => {
    mockedDownloadAndStoreImages.mockImplementation(async (_jobId, _imageRefs, options) => {
      options?.onProgress?.({ index: 0, status: 'downloading', loadedBytes: 5, totalBytes: 10, percent: 50 });
      options?.onProgress?.({ index: 0, status: 'cached', loadedBytes: 10, totalBytes: 10, percent: 100 });
      return {
        successCount: 1,
        failCount: 0,
        blobUrls: ['blob:cached-0'],
        items: [{ index: 0, status: 'cached', loadedBytes: 10, totalBytes: 10, percent: 100 }],
      };
    });
    const job = makeJob();
    const { actions, getJob } = createActions(job);

    await finalizeCompletedServerTask(job, makeCompletedTask(['URL:/api/jacky/images/task-1/0']), actions);

    expect(actions.completeJob).toHaveBeenCalledTimes(2);
    expect(getJob().images).toEqual(['blob:cached-0']);
    expect(getJob().serverTaskAcked).toBe(true);
    expect(getJob().imageDownloadProgress).toBeUndefined();
    expect(mockedAckJackyTask).toHaveBeenCalledWith('task-1');
  });

  it('部分 URL 图片缓存失败时保留 URL 引用和失败进度且不 ack', async () => {
    mockedDownloadAndStoreImages.mockImplementation(async (_jobId, _imageRefs, options) => {
      options?.onProgress?.({ index: 0, status: 'cached', loadedBytes: 10, totalBytes: 10, percent: 100 });
      options?.onProgress?.({ index: 1, status: 'failed', loadedBytes: 2, totalBytes: 10, percent: 20, error: 'stream failed' });
      return {
        successCount: 1,
        failCount: 1,
        blobUrls: ['blob:cached-0', ''],
        items: [
          { index: 0, status: 'cached', loadedBytes: 10, totalBytes: 10, percent: 100 },
          { index: 1, status: 'failed', loadedBytes: 2, totalBytes: 10, percent: 20, error: 'stream failed' },
        ],
      };
    });
    const job = makeJob();
    const { actions, getJob } = createActions(job);

    await finalizeCompletedServerTask(job, makeCompletedTask([
      'URL:/api/jacky/images/task-1/0',
      'URL:/api/jacky/images/task-1/1',
    ]), actions);

    expect(getJob().images).toEqual([
      'blob:cached-0',
      'URL:/api/jacky/images/task-1/1',
    ]);
    expect(getJob().serverTaskAcked).toBe(false);
    expect(getJob().warning).toContain('1 张图片本地缓存失败');
    expect(getJob().imageDownloadProgress?.failed).toBe(1);
    expect(mockedAckJackyTask).not.toHaveBeenCalled();
  });
});

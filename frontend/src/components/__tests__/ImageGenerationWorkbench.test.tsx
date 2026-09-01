import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImageGenerationWorkbench } from '../ImageGenerationWorkbench';

const uploadMocks = vi.hoisted(() => ({
  prepareUploadImage: vi.fn(),
}));

const maskMocks = vi.hoisted(() => ({
  createMaskDraft: vi.fn(),
  processMaskForTarget: vi.fn(),
}));

vi.mock('@/lib/upload-image-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/upload-image-cache')>();
  return { ...actual, prepareUploadImage: uploadMocks.prepareUploadImage };
});

vi.mock('@/lib/mask-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mask-utils')>();
  return {
    ...actual,
    createMaskDraft: maskMocks.createMaskDraft,
    processMaskForTarget: maskMocks.processMaskForTarget,
  };
});

function installModelRegistry() {
  Object.defineProperty(window, 'jackyDesktop', {
    configurable: true,
    value: {
      modelRegistry: {
        load: () => ({
          imageModels: [
            {
              id: 'grok-imagine-image',
              protocol: 'grok',
              name: 'Grok Imagine',
              modelId: 'grok-imagine-image',
              apiKey: 'test-key',
              apiKeyConfigured: true,
              baseUrl: 'https://api.x.ai',
              builtinPreset: 'grok-imagine-image',
              maxRefImages: 0,
              maxOutputSize: '1K',
              supportsAdvancedParams: false,
            },
            {
              id: 'gemini-3-pro-image-preview',
              protocol: 'google',
              name: 'Banana Pro',
              modelId: 'gemini-3-pro-image-preview',
              apiKey: 'test-key',
              apiKeyConfigured: true,
              baseUrl: 'https://generativelanguage.googleapis.com',
              builtinPreset: 'gemini-3-pro-image-preview',
              maxRefImages: 14,
              maxOutputSize: '4K',
              supportsAdvancedParams: false,
            },
            {
              id: 'gpt-image-2',
              protocol: 'openai',
              name: 'GPT Image 2',
              modelId: 'gpt-image-2',
              apiKey: 'test-key',
              apiKeyConfigured: true,
              baseUrl: 'https://api.openai.com',
              builtinPreset: 'gpt-image-2',
              maxRefImages: 16,
              maxOutputSize: '4K',
              supportsAdvancedParams: true,
            },
          ],
          textModels: [],
          defaults: {
            textToImage: 'grok-imagine-image',
            imageToImage: 'gemini-3-pro-image-preview',
            reversePrompt: '',
            agent: '',
            promptOptimize: '',
            imageDescribe: '',
          },
        }),
        save: () => ({ ok: true }),
      },
    },
  });
}

describe('ImageGenerationWorkbench reference uploads', () => {
  beforeEach(() => {
    installModelRegistry();
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    uploadMocks.prepareUploadImage.mockReset();
    maskMocks.createMaskDraft.mockReset();
    maskMocks.processMaskForTarget.mockReset();
    uploadMocks.prepareUploadImage.mockResolvedValue({
      id: 'reference-hash',
      name: 'reference.png',
      preview: 'data:image/png;base64,AA==',
      dataUrl: 'data:image/png;base64,AA==',
      mimeType: 'image/png',
      originalSize: 4,
      processedSize: 4,
      width: 1,
      height: 1,
      cacheHit: false,
    });
  });

  afterEach(() => {
    delete window.jackyDesktop;
    vi.unstubAllGlobals();
  });

  it('accepts an extension-only image and switches away from a model without reference support', async () => {
    const { container } = render(
      <ImageGenerationWorkbench
        initialData={{ model: 'grok-imagine-image' }}
        onSubmitText={vi.fn()}
        onSubmitImage={vi.fn()}
      />,
    );

    expect(await screen.findByText('参考图（上传后自动切换模型）')).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input).not.toBeDisabled();

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'reference.png');
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => expect(uploadMocks.prepareUploadImage).toHaveBeenCalled());
    expect(uploadMocks.prepareUploadImage.mock.calls[0][0].type).toBe('image/png');
    expect(await screen.findByAltText('reference.png')).toBeInTheDocument();
    expect(await screen.findByText('参考图（可选）')).toBeInTheDocument();
  });

  it('converts an uploaded mask after the reference image becomes available', async () => {
    maskMocks.createMaskDraft.mockResolvedValue({
      id: 'mask-id',
      name: 'mask.png',
      originalDataUrl: 'data:image/png;base64,AQ==',
      mimeType: 'image/png',
      analysis: {
        width: 1,
        height: 1,
        hasTransparency: false,
        isGrayscale: true,
        detectedSource: 'luminance',
      },
      sourceMode: 'auto',
      threshold: 128,
      softEdges: false,
      inverted: false,
    });
    maskMocks.processMaskForTarget.mockResolvedValue({
      dataUrl: 'data:image/png;base64,Ag==',
      mimeType: 'image/png',
      representation: 'black-white',
      width: 1,
      height: 1,
      sourceMode: 'luminance',
      inverted: false,
    });

    const { container } = render(
      <ImageGenerationWorkbench
        initialData={{ model: 'gemini-3-pro-image-preview' }}
        onSubmitText={vi.fn()}
        onSubmitImage={vi.fn()}
      />,
    );

    await screen.findByText('参考图（可选）');
    const referenceInput = container.querySelectorAll<HTMLInputElement>('input[type="file"]')[0];
    fireEvent.change(referenceInput, {
      target: { files: [new File([new Uint8Array([1])], 'reference.png', { type: 'image/png' })] },
    });
    await screen.findByAltText('reference.png');

    const maskInput = container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    fireEvent.change(maskInput, {
      target: { files: [new File([new Uint8Array([2])], 'mask.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(maskMocks.processMaskForTarget).toHaveBeenCalledTimes(1));
    expect(maskMocks.processMaskForTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'mask-id' }),
      'data:image/png;base64,AA==',
      expect.objectContaining({ representation: 'black-white' }),
    );
    expect(await screen.findByAltText('转换后的蒙版')).toHaveAttribute('src', 'data:image/png;base64,Ag==');
  });

  it('previews the protocol mask immediately before a reference image is uploaded', async () => {
    maskMocks.createMaskDraft.mockResolvedValue({
      id: 'mask-only-id', name: 'mask.png', originalDataUrl: 'data:image/png;base64,TUFTR09SSUc=', mimeType: 'image/png',
      analysis: { width: 2, height: 2, hasTransparency: false, isGrayscale: false, detectedSource: 'color' },
      sourceMode: 'auto', threshold: 32, softEdges: false, inverted: false,
    });
    maskMocks.processMaskForTarget.mockResolvedValue({
      dataUrl: 'data:image/png;base64,QUxQSEE=', mimeType: 'image/png', representation: 'alpha',
      width: 2, height: 2, sourceMode: 'color', inverted: false,
    });

    const { container } = render(
      <ImageGenerationWorkbench initialData={{ model: 'gpt-image-2' }} onSubmitText={vi.fn()} onSubmitImage={vi.fn()} />,
    );

    await screen.findByText('参考图（可选）');
    const maskInput = container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    fireEvent.change(maskInput, { target: { files: [new File([new Uint8Array([2])], 'mask.png', { type: 'image/png' })] } });

    await waitFor(() => expect(maskMocks.processMaskForTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'mask-only-id' }),
      'data:image/png;base64,TUFTR09SSUc=',
      expect.objectContaining({ representation: 'alpha' }),
    ));
    expect(await screen.findByAltText('转换后的蒙版')).toHaveAttribute('src', 'data:image/png;base64,QUxQSEE=');
    expect(screen.getByText('等待第 1 张参考图')).toBeInTheDocument();
  });
});

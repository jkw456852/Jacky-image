import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerationParamsBar, type GenerationParamsValue } from '../GenerationParamsBar';

const banana = {
  id: 'banana-pro', protocol: 'google', name: 'Banana Pro', modelId: 'gemini-3-pro-image-preview',
  apiKey: 'key', apiKeyConfigured: true, baseUrl: 'https://generativelanguage.googleapis.com',
  builtinPreset: 'gemini-3-pro-image-preview', maxRefImages: 14, maxOutputSize: '4K', supportsAdvancedParams: false,
};
const gpt = {
  id: 'gpt-image', protocol: 'openai', name: 'GPT Image', modelId: 'gpt-image-2',
  apiKey: 'key', apiKeyConfigured: true, baseUrl: 'https://api.openai.com',
  builtinPreset: 'gpt-image-2', maxRefImages: 16, maxOutputSize: '4K', supportsAdvancedParams: true,
};

describe('GenerationParamsBar model catalog', () => {
  let imageModels = [banana];

  beforeEach(() => {
    imageModels = [banana];
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(window, 'jackyDesktop', {
      configurable: true,
      value: {
        modelRegistry: {
          load: () => ({
            imageModels,
            textModels: [],
            defaults: { textToImage: 'banana-pro', imageToImage: 'banana-pro', reversePrompt: '', agent: '', promptOptimize: '', imageDescribe: '' },
          }),
          save: () => ({ ok: true }),
        },
      },
    });
  });

  afterEach(() => {
    delete window.jackyDesktop;
    vi.unstubAllGlobals();
  });

  it('refreshes the refactored generation model menu when GPT Image is configured', async () => {
    const value: GenerationParamsValue = {
      model: 'banana-pro', outputSize: '1K', aspectRatio: '1:1', temperature: 1,
      webSearchEnabled: false, imageSearchEnabled: false, parallelCount: 1,
      gptImageAdvancedParams: { quality: 'auto', style: 'auto', background: 'auto' },
    };
    render(<GenerationParamsBar value={value} onChange={vi.fn()} />);

    imageModels = [banana, gpt];
    fireEvent(window, new Event('jacky-model-registry-updated'));
    fireEvent.click(screen.getByTitle('模型选择'));

    await waitFor(() => expect(screen.getByRole('button', { name: 'GPT Image' })).toBeInTheDocument());
  });
});

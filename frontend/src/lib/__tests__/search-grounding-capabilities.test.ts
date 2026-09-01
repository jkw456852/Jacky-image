import { afterEach, describe, expect, it } from 'vitest';
import {
  supportsImageSearchGrounding,
  supportsWebSearchGrounding,
} from '@/lib/model-capabilities';

describe('Gemini image search grounding capabilities', () => {
  afterEach(() => {
    delete window.jackyDesktop;
  });

  it('supports web and image search on Banana 2', () => {
    expect(supportsWebSearchGrounding('gemini-3.1-flash-image-preview')).toBe(true);
    expect(supportsWebSearchGrounding('gemini-3.1-flash-image')).toBe(true);
    expect(supportsImageSearchGrounding('gemini-3.1-flash-image-preview')).toBe(true);
    expect(supportsImageSearchGrounding('gemini-3.1-flash-image')).toBe(true);
  });

  it('supports only web search on Banana Pro', () => {
    expect(supportsWebSearchGrounding('gemini-3-pro-image-preview')).toBe(true);
    expect(supportsWebSearchGrounding('gemini-3-pro-image')).toBe(true);
    expect(supportsImageSearchGrounding('gemini-3-pro-image-preview')).toBe(false);
  });

  it('does not expose search switches for unsupported models', () => {
    expect(supportsWebSearchGrounding('gemini-3.1-flash-lite-image')).toBe(false);
    expect(supportsImageSearchGrounding('gpt-image-2')).toBe(false);
  });

  it('recognizes configured model aliases by upstream model id', () => {
    Object.defineProperty(window, 'jackyDesktop', {
      configurable: true,
      value: {
        modelRegistry: {
          load: () => ({
            imageModels: [{
              id: 'custom-banana-2',
              protocol: 'google',
              name: 'Banana 2 Custom',
              modelId: 'gemini-3.1-flash-image',
              builtinPreset: 'gemini-3.1-flash-image-preview',
              apiKey: 'configured',
              apiKeyConfigured: true,
              baseUrl: 'https://example.com',
              maxRefImages: 14,
              maxOutputSize: '4K',
              supportsAdvancedParams: false,
            }],
            textModels: [],
            defaults: {
              textToImage: 'custom-banana-2',
              imageToImage: 'custom-banana-2',
              reversePrompt: '',
              agent: '',
              promptOptimize: '',
              imageDescribe: '',
            },
          }),
        },
      },
    });

    expect(supportsWebSearchGrounding('custom-banana-2')).toBe(true);
    expect(supportsImageSearchGrounding('custom-banana-2')).toBe(true);
  });
});

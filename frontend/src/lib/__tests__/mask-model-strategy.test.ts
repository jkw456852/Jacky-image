import { afterEach, describe, expect, it } from 'vitest';
import { getMaskStrategyForModel } from '@/lib/mask-utils';

describe('configured model mask strategy', () => {
  afterEach(() => {
    delete window.jackyDesktop;
  });

  it('uses a black-white mask for a custom Google model id and its upstream model id', () => {
    Object.defineProperty(window, 'jackyDesktop', {
      configurable: true,
      value: {
        isElectron: true,
        modelRegistry: {
          load: () => ({
            imageModels: [{
              id: 'custom-banana',
              protocol: 'google',
              name: 'Banana Pro',
              modelId: 'gemini-3-pro-image-preview',
              apiKey: 'configured',
              apiKeyConfigured: true,
              baseUrl: 'https://example.com',
              builtinPreset: 'gemini-3-pro-image-preview',
              maxRefImages: 14,
              maxOutputSize: '4K',
              supportsAdvancedParams: false,
            }],
            textModels: [],
            defaults: {
              textToImage: 'custom-banana',
              imageToImage: 'custom-banana',
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

    expect(getMaskStrategyForModel('custom-banana')).toMatchObject({
      representation: 'black-white',
      consumesImageSlot: true,
    });
    expect(getMaskStrategyForModel('gemini-3-pro-image-preview')).toMatchObject({
      representation: 'black-white',
    });
  });
});

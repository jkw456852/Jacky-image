import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelId } from '@/lib/gemini-config';
import { resolveSeatCoverAspectRatio } from '../seat-cover-generation-service';

function registry() {
  return {
    imageModels: [{
      id: 'banana-flash', protocol: 'google', name: 'Banana Flash', modelId: 'gemini-3.1-flash-image-preview',
      apiKey: 'key', apiKeyConfigured: true, baseUrl: 'https://example.com', builtinPreset: 'gemini-3.1-flash-image-preview',
      maxRefImages: 14, maxOutputSize: '4K', supportsAdvancedParams: false,
    }],
    textModels: [],
    defaults: { textToImage: 'banana-flash', imageToImage: 'banana-flash', reversePrompt: '', agent: '', promptOptimize: '', imageDescribe: '' },
  };
}

describe('seat-cover aspect ratio normalization', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'jackyDesktop', {
      configurable: true,
      value: { modelRegistry: { load: registry, save: () => ({ ok: true }) } },
    });
  });

  afterEach(() => { delete window.jackyDesktop; });

  it('never forwards auto to Gemini when a concrete image ratio is required', () => {
    expect(resolveSeatCoverAspectRatio('banana-flash' as ModelId, '2K', 'auto', 1200, 896)).toBe('4:3');
    expect(resolveSeatCoverAspectRatio('banana-flash' as ModelId, '2K', 'auto')).toBe('4:3');
  });

  it('keeps portrait base images in the closest supported portrait ratio', () => {
    expect(resolveSeatCoverAspectRatio('banana-flash' as ModelId, '2K', 'auto', 800, 1600)).toBe('9:16');
    expect(resolveSeatCoverAspectRatio('banana-flash' as ModelId, '2K', 'auto', 900, 1200)).toBe('3:4');
  });

  it('preserves supported explicit ratios', () => {
    expect(resolveSeatCoverAspectRatio('banana-flash' as ModelId, '2K', '16:9', 1200, 896)).toBe('16:9');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GPT_IMAGE_ADVANCED_PARAMS } from '@/lib/model-capabilities';
import { getRepaintModelOptions, normalizeRepaintParamsForModel, type RepaintParams } from '../AdvancedRepaintWorkspace';
import { buildUniversalRepaintPrompt } from '../advanced-repaint-service';

function registry() {
  return {
    imageModels: [
      {
        id: 'banana-pro', protocol: 'google', name: 'Banana Pro', modelId: 'gemini-3-pro-image-preview',
        apiKey: 'key', apiKeyConfigured: true, baseUrl: 'https://generativelanguage.googleapis.com',
        builtinPreset: 'gemini-3-pro-image-preview', maxRefImages: 14, maxOutputSize: '4K', supportsAdvancedParams: false,
      },
      {
        id: 'gpt-image', protocol: 'openai', name: 'GPT Image', modelId: 'gpt-image-2',
        apiKey: 'key', apiKeyConfigured: true, baseUrl: 'https://api.openai.com',
        builtinPreset: 'gpt-image-2', maxRefImages: 16, maxOutputSize: '4K', supportsAdvancedParams: true,
      },
      {
        id: 'grok-create', protocol: 'grok', name: 'Grok Create', modelId: 'grok-imagine-image',
        apiKey: 'key', apiKeyConfigured: true, baseUrl: 'https://api.x.ai',
        builtinPreset: 'grok-imagine-image', maxRefImages: 0, maxOutputSize: '1K', supportsAdvancedParams: false,
      },
    ],
    textModels: [],
    defaults: {
      textToImage: 'banana-pro', imageToImage: 'banana-pro', reversePrompt: '', agent: '', promptOptimize: '', imageDescribe: '',
    },
  };
}

describe('advanced repaint model parameters', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'jackyDesktop', {
      configurable: true,
      value: { modelRegistry: { load: registry, save: () => ({ ok: true }) } },
    });
  });

  afterEach(() => {
    delete window.jackyDesktop;
  });

  it('offers both Banana and GPT Image edit-capable models', () => {
    expect(getRepaintModelOptions()).toEqual([
      { value: 'banana-pro', label: 'Banana Pro' },
      { value: 'gpt-image', label: 'GPT Image' },
    ]);
  });

  it('clears Banana-only search flags when switching to GPT Image and preserves GPT image parameters', () => {
    const current: RepaintParams = {
      model: 'banana-pro',
      temperature: 0.8,
      webSearchEnabled: true,
      imageSearchEnabled: false,
      parallelCount: 2,
      gptImageAdvancedParams: { quality: 'high', style: 'natural', background: 'opaque' },
    };

    expect(normalizeRepaintParamsForModel(current, 'gpt-image')).toEqual({
      ...current,
      model: 'gpt-image',
      webSearchEnabled: false,
      imageSearchEnabled: false,
      gptImageAdvancedParams: { quality: 'high', style: 'natural', background: 'opaque' },
    });
    expect(normalizeRepaintParamsForModel(current, 'banana-pro').gptImageAdvancedParams)
      .toEqual(DEFAULT_GPT_IMAGE_ADVANCED_PARAMS);
  });
});


describe('advanced repaint reference prompt', () => {
  it('marks uploaded references as mandatory evidence and avoids colored guide cues', () => {
    const prompt = buildUniversalRepaintPrompt('replace the seat', 'structure', 1);

    expect(prompt).toContain('mandatory visual evidence');
    expect(prompt).toContain('must visibly inherit');
    expect(prompt).toContain('protocol-native mask');
    expect(prompt).toContain('black-white semantic mask');
  });
});

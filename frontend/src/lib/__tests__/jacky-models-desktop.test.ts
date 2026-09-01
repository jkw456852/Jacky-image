import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadRegistry, saveRegistry, type JackyModelRegistry } from '@/lib/jacky-models';

const registry: JackyModelRegistry = {
  imageModels: [{
    id: 'image-1',
    protocol: 'openai',
    name: 'Image',
    modelId: 'gpt-image-2',
    apiKeyConfigured: true,
    baseUrl: 'https://api.openai.com',
    builtinPreset: 'gpt-image-2',
    maxRefImages: 16,
    maxOutputSize: '4K',
    supportsAdvancedParams: true,
  }],
  textModels: [{
    id: 'text-1',
    protocol: 'openai-responses',
    name: 'Text',
    modelId: 'gpt-5.4-mini',
    apiKeyConfigured: true,
    baseUrl: 'https://api.openai.com',
    note: 'OpenAI Responses；支持原生联网搜索',
  }],
  defaults: {
    textToImage: 'image-1',
    imageToImage: 'image-1',
    reversePrompt: 'text-1',
    agent: 'text-1',
    promptOptimize: 'text-1',
    imageDescribe: 'text-1',
  },
};

function installDesktopBridge(loadValue: unknown, save = vi.fn(() => ({ ok: true }))) {
  Object.defineProperty(window, 'jackyDesktop', {
    configurable: true,
    value: {
      isElectron: true,
      platform: 'win32',
      electronVersion: '40.6.1',
      modelRegistry: {
        load: () => loadValue,
        save,
      },
    },
  });
  return save;
}

describe('desktop model registry bridge', () => {
  beforeEach(() => localStorage.clear());

  afterEach(() => {
    delete window.jackyDesktop;
    vi.restoreAllMocks();
  });

  it('reads the Electron startup snapshot instead of localStorage', () => {
    localStorage.setItem('jacky-model-registry', JSON.stringify({ imageModels: [], textModels: [], defaults: {} }));
    installDesktopBridge(registry);

    expect(loadRegistry()).toEqual(registry);
  });

  it('writes only through the Electron bridge', () => {
    const save = installDesktopBridge(registry);

    saveRegistry(registry);

    expect(save).toHaveBeenCalledWith(registry);
    expect(localStorage.getItem('jacky-model-registry')).toBeNull();
  });

  it('surfaces configuration-file save errors', () => {
    installDesktopBridge(registry, vi.fn(() => ({ ok: false, error: 'configuration file unavailable' })));

    expect(() => saveRegistry(registry)).toThrow('configuration file unavailable');
  });
});

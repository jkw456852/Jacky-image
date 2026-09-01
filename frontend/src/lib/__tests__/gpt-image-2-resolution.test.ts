import { describe, expect, it } from 'vitest';

import {
  CUSTOM_IMAGE_SIZE_LIMITS,
  getAspectRatioOptions,
  getGptImageResolution,
} from '@/lib/model-capabilities';

function parseResolution(resolution: string) {
  const [width, height] = resolution.split('x').map(Number);
  return { width, height };
}

describe('GPT Image 2 flexible 4K resolutions', () => {
  it('keeps every supported aspect ratio by scaling oversized combinations down', () => {
    const options = getAspectRatioOptions('gpt-image-2', '4K');

    expect(options.map(option => option.value)).toEqual([
      '1:1',
      '3:2',
      '2:3',
      '16:9',
      '9:16',
      '4:3',
      '3:4',
      '21:9',
    ]);
    expect(Object.fromEntries(options.map(option => [option.value, option.resolution]))).toEqual({
      '1:1': '2880x2880',
      '3:2': '3504x2336',
      '2:3': '2336x3504',
      '16:9': '3840x2160',
      '9:16': '2160x3840',
      '4:3': '3264x2448',
      '3:4': '2448x3264',
      '21:9': '3840x1648',
    });
  });

  it('keeps generated 4K sizes inside GPT Image 2 edge and pixel limits', () => {
    const options = getAspectRatioOptions('gpt-image-2', '4K');

    for (const option of options) {
      const { width, height } = parseResolution(option.resolution);
      expect(Math.max(width, height)).toBeLessThanOrEqual(3840);
      expect(width * height).toBeLessThanOrEqual(CUSTOM_IMAGE_SIZE_LIMITS.maxPixels);
      expect(width % CUSTOM_IMAGE_SIZE_LIMITS.multiple).toBe(0);
      expect(height % CUSTOM_IMAGE_SIZE_LIMITS.multiple).toBe(0);
      expect(getGptImageResolution('4K', option.value)).toBe(option.resolution);
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  getMaskStrategy,
  resolveMaskSourceMode,
  transformMaskPixels,
} from '@/lib/mask-utils';

describe('mask protocol strategy', () => {
  it('uses a dedicated alpha PNG for OpenAI', () => {
    expect(getMaskStrategy('openai')).toMatchObject({
      representation: 'alpha',
      precise: true,
      consumesImageSlot: false,
    });
  });

  it('uses semantic black-white masks for Google and Grok', () => {
    expect(getMaskStrategy('google')).toMatchObject({
      representation: 'black-white',
      precise: false,
      consumesImageSlot: true,
    });
    expect(getMaskStrategy('grok')).toMatchObject({
      representation: 'black-white',
      precise: false,
      consumesImageSlot: true,
    });
  });
});

describe('mask pixel conversion', () => {
  it('preserves OpenAI alpha semantics where transparent pixels are edited', () => {
    const source = new Uint8ClampedArray([
      20, 30, 40, 0,
      20, 30, 40, 255,
    ]);
    const output = transformMaskPixels(source, {
      sourceMode: 'alpha',
      threshold: 128,
      softEdges: true,
      inverted: false,
      representation: 'alpha',
    });

    expect(Array.from(output)).toEqual([
      255, 255, 255, 0,
      255, 255, 255, 255,
    ]);
  });

  it('converts colored pixels into a hard black-white luminance mask', () => {
    const source = new Uint8ClampedArray([
      255, 255, 255, 255,
      10, 10, 10, 255,
      255, 0, 0, 255,
    ]);
    const output = transformMaskPixels(source, {
      sourceMode: 'luminance',
      threshold: 128,
      softEdges: false,
      inverted: false,
      representation: 'black-white',
    });

    expect(Array.from(output)).toEqual([
      255, 255, 255, 255,
      0, 0, 0, 255,
      0, 0, 0, 255,
    ]);
  });

  it('extracts a colored foreground by comparing it with the border background', () => {
    const source = new Uint8ClampedArray([
      0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
      0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255,
      0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
    ]);
    const output = transformMaskPixels(source, {
      sourceMode: 'color',
      threshold: 32,
      softEdges: false,
      inverted: false,
      representation: 'black-white',
      width: 3,
      height: 3,
    });

    expect(Array.from(output.slice(4 * 4, 5 * 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(output.slice(0, 4))).toEqual([0, 0, 0, 255]);
  });

  it('supports colored marks on a light background', () => {
    const source = new Uint8ClampedArray([
      255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 0, 80, 255, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    ]);
    const output = transformMaskPixels(source, {
      sourceMode: 'color',
      threshold: 32,
      softEdges: false,
      inverted: false,
      representation: 'black-white',
      width: 3,
      height: 3,
    });

    expect(Array.from(output.slice(4 * 4, 5 * 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(output.slice(0, 4))).toEqual([0, 0, 0, 255]);
  });

  it('supports mask inversion', () => {
    const source = new Uint8ClampedArray([255, 255, 255, 255]);
    const output = transformMaskPixels(source, {
      sourceMode: 'luminance',
      threshold: 128,
      softEdges: false,
      inverted: true,
      representation: 'black-white',
    });
    expect(Array.from(output)).toEqual([0, 0, 0, 255]);
  });

  it('auto-detects the source channel from analysis', () => {
    expect(resolveMaskSourceMode('auto', { detectedSource: 'alpha' })).toBe('alpha');
    expect(resolveMaskSourceMode('auto', { detectedSource: 'luminance' })).toBe('luminance');
    expect(resolveMaskSourceMode('auto', { detectedSource: 'color' })).toBe('color');
    expect(resolveMaskSourceMode('alpha', { detectedSource: 'luminance' })).toBe('alpha');
  });
});

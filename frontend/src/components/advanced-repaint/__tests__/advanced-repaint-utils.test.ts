import { describe, expect, it, vi } from 'vitest';
import { calculateContextCropBounds, closestAspectRatio, detectMaskComponents, drawImageCover, getCommittableRepaintRegions, getRepaintCompositionKey, hasDiscardableRepaintWork } from '../advanced-repaint-utils';
import type { RepaintRegion } from '../types';

function createMask(width: number, height: number, points: Array<[number, number]>) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [x, y] of points) data[(y * width + x) * 4 + 3] = 255;
  return data;
}

describe('advanced repaint connected regions', () => {
  it('splits disconnected brush islands and sorts them top-to-bottom then left-to-right', () => {
    const data = createMask(12, 12, [
      [8, 1], [9, 1], [8, 2], [9, 2],
      [1, 1], [2, 1], [1, 2], [2, 2],
      [5, 8], [6, 8], [5, 9], [6, 9],
    ]);
    const regions = detectMaskComponents(data, 12, 12, { minPixels: 1, mergeGap: 0 });
    expect(regions).toHaveLength(3);
    expect(regions.map(region => region.bounds)).toEqual([
      { x: 1, y: 1, width: 2, height: 2 },
      { x: 8, y: 1, width: 2, height: 2 },
      { x: 5, y: 8, width: 2, height: 2 },
    ]);
  });

  it('uses eight-neighbor connectivity for diagonal strokes', () => {
    const data = createMask(4, 4, [[1, 1], [2, 2]]);
    const regions = detectMaskComponents(data, 4, 4, { minPixels: 1, mergeGap: 0 });
    expect(regions).toHaveLength(1);
    expect(regions[0].pixelCount).toBe(2);
  });

  it('merges close components using the configured connection tolerance', () => {
    const data = createMask(10, 4, [[1, 1], [2, 1], [5, 1], [6, 1]]);
    expect(detectMaskComponents(data, 10, 4, { minPixels: 1, mergeGap: 1 })).toHaveLength(2);
    expect(detectMaskComponents(data, 10, 4, { minPixels: 1, mergeGap: 2 })).toHaveLength(1);
  });

  it('merges high-resolution components without spreading pixel indexes onto the call stack', () => {
    const width = 1001;
    const height = 240;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (x === 500) continue;
        data[(y * width + x) * 4 + 3] = 255;
      }
    }

    const regions = detectMaskComponents(data, width, height, { minPixels: 1, mergeGap: 1 });
    expect(regions).toHaveLength(1);
    expect(regions[0].pixelCount).toBe((width - 1) * height);
    expect(regions[0].pixelIndices).toBeInstanceOf(Int32Array);
  });
});

describe('advanced repaint crop math', () => {
  it('adds context without crossing source image boundaries', () => {
    expect(calculateContextCropBounds({ x: 2, y: 3, width: 10, height: 8 }, 100, 80, 0.2, 6)).toEqual({
      x: 0,
      y: 0,
      width: 18,
      height: 17,
    });
  });

  it('chooses the nearest supported generation ratio', () => {
    expect(closestAspectRatio(1600, 900, ['1:1', '4:3', '16:9'])).toBe('16:9');
    expect(closestAspectRatio(800, 1200, ['1:1', '2:3', '3:2'])).toBe('2:3');
  });
});


describe('advanced repaint composition invalidation', () => {
  const createRegion = (): RepaintRegion => ({
    id: 'region-1',
    name: '区域 1',
    order: 0,
    pixelCount: 20,
    tightBounds: { x: 2, y: 2, width: 4, height: 4 },
    cropBounds: { x: 0, y: 0, width: 8, height: 8 },
    sourceCropDataUrl: 'data:image/png;base64,source',
    maskDataUrl: 'data:image/png;base64,mask',
    prompt: 'replace the object',
    referenceRole: 'general',
    references: [],
    candidates: [{ id: 'candidate-1', imageUrl: 'data:image/png;base64,result-1' }],
    selectedCandidateId: 'candidate-1',
    status: 'completed',
    enabled: true,
  });

  it('ignores text, reference and progress-only changes', () => {
    const original = createRegion();
    const changed = {
      ...original,
      name: '新名字',
      prompt: 'a new prompt typed by the user',
      status: 'generating' as const,
      statusText: '正在生成',
      references: [{ id: 'ref-1', name: 'ref.png', dataUrl: 'data:image/png;base64,ref', mimeType: 'image/png' }],
    };

    expect(getRepaintCompositionKey([changed])).toBe(getRepaintCompositionKey([original]));
  });


  it('changes when post-generation mask or patch placement changes', () => {
    const original = createRegion();
    const moved = { ...original, patchOffsetX: 12, patchOffsetY: -8 };
    const remasked = { ...original, compositeMaskDataUrl: 'data:image/png;base64,edited-mask' };

    expect(getRepaintCompositionKey([moved])).not.toBe(getRepaintCompositionKey([original]));
    expect(getRepaintCompositionKey([remasked])).not.toBe(getRepaintCompositionKey([original]));
  });

  it('changes when the selected generated pixels change', () => {
    const original = createRegion();
    const changed = {
      ...original,
      candidates: [{ id: 'candidate-2', imageUrl: 'data:image/png;base64,result-2' }],
      selectedCandidateId: 'candidate-2',
    };

    expect(getRepaintCompositionKey([changed])).not.toBe(getRepaintCompositionKey([original]));
  });


  it('commits only enabled regions with a selected candidate', () => {
    const enabled = createRegion();
    const disabled = { ...createRegion(), id: 'region-2', enabled: false };
    const missingSelection = { ...createRegion(), id: 'region-3', selectedCandidateId: undefined };

    expect(getCommittableRepaintRegions([enabled, disabled, missingSelection]).map(region => region.id)).toEqual(['region-1']);
  });

  it('warns before discarding prompts, references, or generated candidates', () => {
    const empty = { ...createRegion(), prompt: '', references: [], candidates: [], selectedCandidateId: undefined };
    expect(hasDiscardableRepaintWork([empty])).toBe(false);
    expect(hasDiscardableRepaintWork([{ ...empty, prompt: '保留这个修改要求' }])).toBe(true);
    expect(hasDiscardableRepaintWork([{ ...empty, references: [{ id: 'ref', name: 'ref.png', dataUrl: 'data:image/png;base64,ref', mimeType: 'image/png' }] }])).toBe(true);
    expect(hasDiscardableRepaintWork([createRegion()])).toBe(true);
  });

});


describe('advanced repaint patch placement', () => {
  it('applies source-pixel translation after cover fitting', () => {
    const drawImage = vi.fn();
    const context = { drawImage } as unknown as CanvasRenderingContext2D;
    const image = { naturalWidth: 100, naturalHeight: 100 } as HTMLImageElement;

    drawImageCover(context, image, 200, 100, 12, -8);

    expect(drawImage).toHaveBeenCalledWith(image, 12, -58, 200, 200);
  });
});

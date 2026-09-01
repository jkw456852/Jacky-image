import { describe, expect, it } from 'vitest';
import { getReferenceTargetDimensions } from '@/lib/upload-image-cache';

describe('reference image resolution', () => {
  it('keeps a 3555x2666 reference image at its original resolution', () => {
    expect(getReferenceTargetDimensions(3555, 2666)).toEqual({
      width: 3555,
      height: 2666,
    });
  });

  it('retains a safety limit for unusually large source images', () => {
    const result = getReferenceTargetDimensions(12000, 9000);
    expect(result.width).toBeLessThan(12000);
    expect(result.height).toBeLessThan(9000);
  });
});

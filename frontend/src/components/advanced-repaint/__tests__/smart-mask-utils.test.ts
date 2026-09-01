import { describe, expect, it } from 'vitest';
import { cleanSmartBinaryMask, type SmartMaskPoint } from '../smart-mask-utils';

function maskFromRows(rows: string[]) {
  const height = rows.length;
  const width = rows[0]?.length || 0;
  const data = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    [...row].forEach((value, x) => {
      if (value === '#') data[y * width + x] = 1;
    });
  });
  return { data, width, height };
}

function point(x: number, y: number, width: number, height: number, label: 0 | 1 = 1): SmartMaskPoint {
  return { x: (x + 0.5) / width, y: (y + 0.5) / height, label };
}

describe('smart mask cleanup', () => {
  it('keeps the component containing the positive click and removes detached islands', () => {
    const source = maskFromRows([
      '..........',
      '.###......',
      '.###..##..',
      '.###..##..',
      '..........',
    ]);
    const result = cleanSmartBinaryMask(source.data, source.width, source.height, [
      point(2, 2, source.width, source.height),
    ], { maxHolePixels: 0 });

    expect(result.pixelCount).toBe(9);
    expect(result.removedPixels).toBe(4);
    expect(result.data[2 * source.width + 2]).toBe(1);
    expect(result.data[2 * source.width + 7]).toBe(0);
  });

  it('keeps multiple disconnected parts when each has a positive correction point', () => {
    const source = maskFromRows([
      '..........',
      '.##...##..',
      '.##...##..',
      '..........',
    ]);
    const result = cleanSmartBinaryMask(source.data, source.width, source.height, [
      point(1, 1, source.width, source.height),
      point(6, 1, source.width, source.height),
    ], { maxHolePixels: 0 });

    expect(result.keptComponentCount).toBe(2);
    expect(result.pixelCount).toBe(8);
  });

  it('anchors to the nearest foreground when the click lands just outside an interpolated edge', () => {
    const source = maskFromRows([
      '........',
      '...##...',
      '...##...',
      '........',
    ]);
    const result = cleanSmartBinaryMask(source.data, source.width, source.height, [
      point(2, 1, source.width, source.height),
    ], { anchorSearchRadius: 2, maxHolePixels: 0 });

    expect(result.pixelCount).toBe(4);
  });

  it('fills small enclosed holes but preserves a hole protected by a negative point', () => {
    const source = maskFromRows([
      '............',
      '.##########.',
      '.##########.',
      '.##.####.##.',
      '.##########.',
      '.##########.',
      '............',
    ]);
    const result = cleanSmartBinaryMask(source.data, source.width, source.height, [
      point(1, 1, source.width, source.height),
      point(8, 3, source.width, source.height, 0),
    ], { maxHolePixels: 4 });

    expect(result.data[3 * source.width + 3]).toBe(1);
    expect(result.data[3 * source.width + 8]).toBe(0);
    expect(result.filledHolePixels).toBe(1);
  });

  it('does not fill large structural openings', () => {
    const source = maskFromRows([
      '..........',
      '.########.',
      '.##....##.',
      '.##....##.',
      '.##....##.',
      '.########.',
      '..........',
    ]);
    const result = cleanSmartBinaryMask(source.data, source.width, source.height, [
      point(1, 1, source.width, source.height),
    ], { maxHolePixels: 4 });

    expect(result.filledHolePixels).toBe(0);
    expect(result.data[3 * source.width + 4]).toBe(0);
  });

  it('handles a large mask iteratively without overflowing the call stack', () => {
    const width = 1400;
    const height = 900;
    const data = new Uint8Array(width * height);
    for (let y = 100; y < 800; y += 1) {
      for (let x = 100; x < 1300; x += 1) data[y * width + x] = 1;
    }
    for (let y = 400; y < 405; y += 1) {
      for (let x = 600; x < 605; x += 1) data[y * width + x] = 0;
    }
    data[10 * width + 10] = 1;

    const result = cleanSmartBinaryMask(data, width, height, [
      point(200, 200, width, height),
    ]);

    expect(result.data[402 * width + 602]).toBe(1);
    expect(result.data[10 * width + 10]).toBe(0);
    expect(result.removedPixels).toBe(1);
  });
});

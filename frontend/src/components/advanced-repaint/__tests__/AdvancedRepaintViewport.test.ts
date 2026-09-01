import { describe, expect, it } from 'vitest';
import { calculateRepaintDisplayWidth, getRepaintWheelZoom } from '../AdvancedRepaintViewport';

describe('advanced repaint viewport fitting', () => {
  it('fits a portrait source by viewport height instead of stretching it to the full window width', () => {
    const width = calculateRepaintDisplayWidth(1600, 640, 1024, 1536, 100);

    expect(width).toBeCloseTo((640 - 32) * (1024 / 1536));
    expect(width).toBeLessThan(500);
  });

  it('applies zoom relative to the fitted size', () => {
    const fitted = calculateRepaintDisplayWidth(1200, 640, 1600, 900, 100);
    const zoomed = calculateRepaintDisplayWidth(1200, 640, 1600, 900, 200);

    expect(zoomed).toBeCloseTo(fitted * 2);
  });
});


describe('advanced repaint wheel zoom', () => {
  it('zooms in and out in stable ten-percent steps', () => {
    expect(getRepaintWheelZoom(100, -100)).toBe(110);
    expect(getRepaintWheelZoom(100, 100)).toBe(90);
  });

  it('keeps wheel zoom inside the supported range', () => {
    expect(getRepaintWheelZoom(240, -100)).toBe(240);
    expect(getRepaintWheelZoom(40, 100)).toBe(40);
  });
});

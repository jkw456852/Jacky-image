import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepaintRegion } from '../types';
import { AdvancedRepaintCompositeEditor } from '../AdvancedRepaintCompositeEditor';
import { loadRepaintImage } from '../advanced-repaint-utils';

vi.mock('../advanced-repaint-utils', () => ({
  loadRepaintImage: vi.fn(async () => ({ naturalWidth: 100, naturalHeight: 100, width: 100, height: 100 })),
  drawImageCover: vi.fn(),
}));

function createContext(canvas: HTMLCanvasElement) {
  return {
    canvas,
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(canvas.width * canvas.height * 4),
      width: canvas.width,
      height: canvas.height,
    })),
    putImageData: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    globalCompositeOperation: 'source-over',
    strokeStyle: '#fff',
    fillStyle: '#fff',
    lineWidth: 1,
    lineCap: 'round',
    lineJoin: 'round',
    filter: 'none',
  } as unknown as CanvasRenderingContext2D;
}

function createRegion(): RepaintRegion {
  return {
    id: 'region-1',
    name: '区域 1',
    order: 0,
    pixelCount: 100,
    tightBounds: { x: 20, y: 20, width: 60, height: 60 },
    cropBounds: { x: 10, y: 10, width: 100, height: 100 },
    sourceCropDataUrl: 'data:image/png;base64,source-crop',
    maskDataUrl: 'data:image/png;base64,mask',
    prompt: 'replace',
    referenceRole: 'general',
    references: [],
    candidates: [{ id: 'candidate-1', imageUrl: 'data:image/png;base64,candidate' }],
    selectedCandidateId: 'candidate-1',
    status: 'completed',
    enabled: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return createContext(this);
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,edited-mask');
  Object.defineProperty(HTMLCanvasElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLCanvasElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLCanvasElement.prototype, 'hasPointerCapture', { configurable: true, value: vi.fn(() => true) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 200,
    bottom: 200,
    width: 200,
    height: 200,
    toJSON: () => ({}),
  });
});

describe('AdvancedRepaintCompositeEditor', () => {
  it('commits generated patch translation in original-image pixels', async () => {
    const onUpdateRegion = vi.fn();
    const { getByLabelText } = render(
      <AdvancedRepaintCompositeEditor
        sourceDataUrl="data:image/png;base64,source"
        sourceWidth={200}
        sourceHeight={200}
        regions={[createRegion()]}
        selectedRegionId="region-1"
        blendRadius={0}
        editTool="move"
        brushSize={20}
        onUpdateRegion={onUpdateRegion}
      />,
    );
    await waitFor(() => expect(loadRepaintImage).toHaveBeenCalled());
    const canvas = getByLabelText('高级重绘合成调整画布');

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 70, clientY: 80 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 70, clientY: 80 });

    expect(onUpdateRegion).toHaveBeenCalledWith('region-1', {
      patchOffsetX: 20,
      patchOffsetY: 30,
    });
  });

  it('commits an edited compositing mask after painting', async () => {
    const onUpdateRegion = vi.fn();
    const { getByLabelText } = render(
      <AdvancedRepaintCompositeEditor
        sourceDataUrl="data:image/png;base64,source"
        sourceWidth={200}
        sourceHeight={200}
        regions={[createRegion()]}
        selectedRegionId="region-1"
        blendRadius={3}
        editTool="mask-erase"
        brushSize={24}
        onUpdateRegion={onUpdateRegion}
      />,
    );
    await waitFor(() => expect(loadRepaintImage).toHaveBeenCalled());
    const canvas = getByLabelText('高级重绘合成调整画布');

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 65, clientY: 65 });
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 65, clientY: 65 });

    expect(onUpdateRegion).toHaveBeenCalledWith('region-1', {
      compositeMaskDataUrl: 'data:image/png;base64,edited-mask',
    });
  });
});


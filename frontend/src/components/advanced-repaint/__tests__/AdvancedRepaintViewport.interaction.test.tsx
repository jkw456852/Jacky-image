import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdvancedRepaintViewport } from '../AdvancedRepaintViewport';

describe('AdvancedRepaintViewport interactions', () => {
  it('zooms with the mouse wheel without moving the scroll viewport', () => {
    const onZoomChange = vi.fn();
    render(
      <AdvancedRepaintViewport sourceWidth={1200} sourceHeight={800} zoom={100} onZoomChange={onZoomChange}>
        <img src="data:image/png;base64,AA==" alt="source" />
      </AdvancedRepaintViewport>,
    );

    const viewport = screen.getByTitle('鼠标滚轮缩放；按住空格并用鼠标左键拖动画布');
    Object.assign(viewport, { scrollLeft: 120, scrollTop: 80 });
    const wheelEvent = new WheelEvent('wheel', { deltaY: -100, clientX: 100, clientY: 100, bubbles: true, cancelable: true });
    screen.getByAltText('source').dispatchEvent(wheelEvent);

    expect(wheelEvent.defaultPrevented).toBe(true);
    expect(onZoomChange).toHaveBeenCalledWith(110);
    expect(viewport.scrollLeft).toBe(120);
    expect(viewport.scrollTop).toBe(80);
  });

  it('pans the scroll viewport with Space plus the left mouse button', () => {
    render(
      <AdvancedRepaintViewport sourceWidth={1200} sourceHeight={800} zoom={200} onZoomChange={vi.fn()}>
        <img src="data:image/png;base64,AA==" alt="source" />
      </AdvancedRepaintViewport>,
    );

    const viewport = screen.getByTitle('鼠标滚轮缩放；按住空格并用鼠标左键拖动画布');
    Object.assign(viewport, {
      scrollLeft: 100,
      scrollTop: 80,
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    });

    fireEvent.mouseEnter(viewport);
    fireEvent.keyDown(window, { code: 'Space' });
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 70, clientY: 60 });

    expect(viewport.scrollLeft).toBe(130);
    expect(viewport.scrollTop).toBe(120);

    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 70, clientY: 60 });
    fireEvent.keyUp(window, { code: 'Space' });
  });
});

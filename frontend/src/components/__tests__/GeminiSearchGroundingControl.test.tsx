import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GeminiSearchGroundingControl } from '../GeminiSearchGroundingControl';

describe('GeminiSearchGroundingControl', () => {
  it('shows web and image switches for Banana 2', () => {
    const onChange = vi.fn();
    render(
      <GeminiSearchGroundingControl
        model="gemini-3.1-flash-image-preview"
        webSearchEnabled={false}
        imageSearchEnabled={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByTitle('搜索接地设置'));
    expect(screen.getByText('联网搜索')).toBeInTheDocument();
    expect(screen.getByText('图片搜索')).toBeInTheDocument();
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]);
    fireEvent.click(switches[1]);
    expect(onChange).toHaveBeenCalledWith({ webSearchEnabled: true });
    expect(onChange).toHaveBeenCalledWith({ imageSearchEnabled: true });
  });

  it('hides image search for Banana Pro', () => {
    render(
      <GeminiSearchGroundingControl
        model="gemini-3-pro-image-preview"
        webSearchEnabled={false}
        imageSearchEnabled={false}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle('搜索接地设置'));
    expect(screen.getByText('联网搜索')).toBeInTheDocument();
    expect(screen.queryByText('图片搜索')).not.toBeInTheDocument();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SeatCoverGenerationWorkspace, SeatCoverImageLightbox } from '../SeatCoverGenerationWorkspace';
import { SEAT_COVER_ANGLE_PRESETS } from '../presets';

vi.mock('@/lib/upload-image-cache', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/upload-image-cache')>();
  return {
    ...actual,
    prepareUploadImage: vi.fn(async (file: File) => ({
      id: `upload-${file.name}`,
      name: file.name,
      dataUrl: `data:${file.type};base64,bW9jaw==`,
      preview: `data:${file.type};base64,bW9jaw==`,
      mimeType: file.type,
      width: 100,
      height: 80,
      originalSize: file.size,
      processedSize: file.size,
    })),
  };
});

function registry() {
  return {
    imageModels: [{
      id: 'banana-pro', protocol: 'google', name: 'Banana Pro', modelId: 'gemini-3-pro-image-preview',
      apiKey: 'key', apiKeyConfigured: true, baseUrl: 'https://example.com', builtinPreset: 'gemini-3-pro-image-preview',
      maxRefImages: 14, maxOutputSize: '4K', supportsAdvancedParams: false,
    }, {
      id: 'gpt-image', protocol: 'openai', name: 'GPT Image 2', modelId: 'gpt-image-2',
      apiKey: 'key', apiKeyConfigured: true, baseUrl: 'https://example.com', builtinPreset: 'gpt-image-2',
      maxRefImages: 16, maxOutputSize: '4K', supportsAdvancedParams: true,
    }],
    textModels: [],
    defaults: { textToImage: 'banana-pro', imageToImage: 'banana-pro', reversePrompt: '', agent: '', promptOptimize: '', imageDescribe: '' },
  };
}

describe('SeatCoverGenerationWorkspace enhancements', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'jackyDesktop', {
      configurable: true,
      value: {
        modelRegistry: { load: registry, save: () => ({ ok: true }) },
        seatCoverPrompts: { openDirectory: vi.fn(async () => ({ ok: true })) },
        promptEditorWindow: { open: vi.fn(async () => ({ ok: true, sessionId: 'prompt-session' })) },
      },
    });
  });

  afterEach(() => { delete window.jackyDesktop; });

  it('zooms with the wheel and pans with space plus left-drag in the lightbox', () => {
    render(<SeatCoverImageLightbox src="data:image/png;base64,AA==" onClose={() => undefined} />);
    const viewport = screen.getByTestId('seat-cover-lightbox-viewport');
    const image = screen.getByAltText('大图预览');

    fireEvent.wheel(viewport, { deltaY: -100 });
    expect(image).toHaveStyle({ transform: 'translate3d(0px, 0px, 0) scale(1.15)' });

    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    fireEvent.mouseDown(viewport, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(viewport, { clientX: 120, clientY: 135 });
    fireEvent.mouseUp(viewport);
    expect(image).toHaveStyle({ transform: 'translate3d(20px, 35px, 0) scale(1.15)' });
    fireEvent.keyUp(window, { code: 'Space', key: ' ' });
  });

  it('shows project controls and updates task estimates when an angle is selected', async () => {
    render(<SeatCoverGenerationWorkspace hasApiKey onConfigureApiKey={() => undefined} />);
    const createButton = screen.getByRole('button', { name: '新建' });
    expect(createButton).toBeInTheDocument();
    await waitFor(() => expect(createButton).toBeEnabled());
    expect(screen.getByText(/已选择\/建立 0 个角度/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '编辑提示词' })).toHaveLength(15);
    const promptFolderButton = screen.getByRole('button', { name: '打开提示词文件夹' });
    fireEvent.click(promptFolderButton);
    expect(window.jackyDesktop?.seatCoverPrompts?.openDirectory).toHaveBeenCalledTimes(1);

    const presetImage = screen.getByAltText(SEAT_COVER_ANGLE_PRESETS[0].name);
    fireEvent.click(presetImage.closest('button')!);
    expect(screen.getByText(/已选择\/建立 1 个角度/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    expect(screen.getByRole('heading', { name: '新建座套项目' })).toBeInTheDocument();
    const nameInput = screen.getByLabelText('项目名称');
    fireEvent.change(nameInput, { target: { value: '测试车型-2026' } });
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    await waitFor(() => expect(screen.getByTitle('切换项目').querySelectorAll('option')).toHaveLength(2));
    expect(screen.getByRole('option', { name: '测试车型-2026' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重命名' }));
    expect(screen.getByRole('heading', { name: '重命名座套项目' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '最终项目名' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
    expect(screen.getByRole('option', { name: '最终项目名' })).toBeInTheDocument();
  });

  it('opens the current angle prompt editor in an independent desktop window', async () => {
    render(<SeatCoverGenerationWorkspace hasApiKey onConfigureApiKey={() => undefined} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '新建' })).toBeEnabled());
    fireEvent.click(screen.getAllByRole('button', { name: '编辑提示词' })[0]);
    await waitFor(() => expect(window.jackyDesktop?.promptEditorWindow.open).toHaveBeenCalledTimes(1));
  });

  it('clears search grounding and switches to GPT Image 2 controls when the model changes', async () => {
    render(<SeatCoverGenerationWorkspace hasApiKey onConfigureApiKey={() => undefined} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '新建' })).toBeEnabled());
    const modelSelect = screen.getByLabelText('生图模型');
    const webSearch = screen.getByLabelText('联网搜索');
    fireEvent.click(webSearch);
    expect(webSearch).toBeChecked();

    fireEvent.change(modelSelect, { target: { value: 'gpt-image' } });
    expect(screen.queryByLabelText('联网搜索')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('温度')).not.toBeInTheDocument();
    expect(screen.getByText('GPT Image 2 专属配置')).toBeInTheDocument();

    fireEvent.change(modelSelect, { target: { value: 'banana-pro' } });
    expect(screen.getByLabelText('联网搜索')).not.toBeChecked();
  });

  it('shows a delete button for an established original-angle task', async () => {
    render(<SeatCoverGenerationWorkspace hasApiKey onConfigureApiKey={() => undefined} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '新建' })).toBeEnabled());
    const presetImage = screen.getByAltText(SEAT_COVER_ANGLE_PRESETS[0].name);
    fireEvent.click(presetImage.closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: '建立角度任务' }));
    expect(await screen.findByRole('button', { name: '删除原车角度任务' })).toBeInTheDocument();
  });

  it('accepts dragged and pasted images in the reusable material upload boxes', async () => {
    render(<SeatCoverGenerationWorkspace hasApiKey onConfigureApiKey={() => undefined} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '新建' })).toBeEnabled());
    const uploadArea = await screen.findByLabelText('原车内饰资料图片上传区域');
    const dropped = new File(['drop'], 'vehicle-drop.png', { type: 'image/png' });
    const pasted = new File(['paste'], 'vehicle-paste.webp', { type: 'image/webp' });

    fireEvent.drop(uploadArea, { dataTransfer: { files: [dropped], dropEffect: 'none' } });
    fireEvent.paste(uploadArea, {
      clipboardData: {
        items: [{ type: pasted.type, getAsFile: () => pasted }],
        files: [pasted],
      },
    });

    expect(await screen.findByAltText('vehicle-drop.png')).toBeInTheDocument();
    expect(await screen.findByAltText('vehicle-paste.webp')).toBeInTheDocument();
  });

  it('accepts pasted images in the custom fitting base upload area', async () => {
    render(<SeatCoverGenerationWorkspace hasApiKey onConfigureApiKey={() => undefined} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '新建' })).toBeEnabled());
    fireEvent.click(await screen.findByRole('button', { name: '座套上椅' }));
    const uploadArea = await screen.findByLabelText('座套底图上传区域');
    const pasted = new File(['paste'], 'custom-seat-base.png', { type: 'image/png' });

    fireEvent.paste(uploadArea, {
      clipboardData: {
        items: [{ type: pasted.type, getAsFile: () => pasted }],
        files: [pasted],
      },
    });

    expect(await screen.findByRole('heading', { name: 'custom-seat-base.png' })).toBeInTheDocument();
  });

});

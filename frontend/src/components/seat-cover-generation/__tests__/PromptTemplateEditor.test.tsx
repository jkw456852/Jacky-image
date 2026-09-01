import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromptTemplateEditor } from '../PromptTemplateEditor';

describe('PromptTemplateEditor', () => {
  it('keeps the CodeMirror editor mounted when switching to preview and back', () => {
    const { container } = render(<PromptTemplateEditor
      standalone
      open
      angleName="主驾"
      value="车型：{{vehicle.model}}"
      defaultValue="默认提示词"
      preview="车型：TOYOTA RAV 4"
      onOpenChange={() => undefined}
      onSave={vi.fn(async () => undefined)}
      onReset={() => undefined}
    />);
    expect(container.querySelector('.cm-editor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '最终预览' }));
    expect(screen.getByText('车型：TOYOTA RAV 4')).toBeInTheDocument();
    expect(container.querySelector('.cm-editor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑模板' }));
    expect(container.querySelector('.cm-editor')).toBeVisible();
  });


  it('shows a wrapping custom tooltip with the complete variable explanation', async () => {
    render(<PromptTemplateEditor
      standalone
      open
      angleName="主驾"
      value="{{provider.role_delivery}}"
      defaultValue="默认提示词"
      preview="图片按照编号顺序上传。"
      onOpenChange={() => undefined}
      onSave={vi.fn(async () => undefined)}
      onReset={() => undefined}
    />);
    const variableCard = screen.getByText('图片角色总说明').closest('button');
    expect(variableCard).not.toBeNull();
    fireEvent.focus(variableCard!);
    await waitFor(() => expect(screen.getByText(/它不是图片编号，不能替代角度引导图编号/)).toBeInTheDocument());
  });

  it('blocks saving a full template with a duplicated role-delivery sentence and an orphan angle marker', () => {
    render(<PromptTemplateEditor
      standalone
      open
      angleName="后排右侧面"
      value={'【输出目标】\n【输入图片】\n{{provider.role_delivery}}\n{{provider.role_delivery}}\n{{! JACKY_ANGLE_RULE_END }}'}
      defaultValue="默认提示词"
      preview=""
      onOpenChange={() => undefined}
      onSave={vi.fn(async () => undefined)}
      onReset={() => undefined}
    />);
    expect(screen.getByText(/图片角色总说明.*只能出现 1 次/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存模板' })).toBeDisabled();
  });

  it('synchronizes a freshly loaded saved template into an already mounted editor', async () => {
    const onSave = vi.fn(async () => undefined);
    const props = {
      standalone: true,
      open: true,
      angleName: '主驾',
      defaultValue: '默认提示词',
      preview: '',
      onOpenChange: () => undefined,
      onSave,
      onReset: () => undefined,
    };
    const { container, rerender } = render(<PromptTemplateEditor {...props} value="默认提示词" />);
    expect(container.querySelector('.cm-content')).toHaveTextContent('默认提示词');

    rerender(<PromptTemplateEditor {...props} value="已经保存的自定义提示词" />);
    await waitFor(() => expect(container.querySelector('.cm-content')).toHaveTextContent('已经保存的自定义提示词'));
    fireEvent.click(screen.getByRole('button', { name: '保存模板' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('已经保存的自定义提示词'));
  });
});

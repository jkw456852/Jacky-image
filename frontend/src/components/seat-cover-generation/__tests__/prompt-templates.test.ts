import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractSeatCoverAngleRule, loadSeatCoverAnglePrompt, renderSeatCoverPromptTemplate, saveSeatCoverAnglePrompt } from '../prompt-templates';

describe('seat-cover editable prompt loader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the matching prompt without browser caching', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      prompts: { '单品45度': '  纯白背景角度提示词  ' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadSeatCoverAnglePrompt('单品45度')).resolves.toBe('纯白背景角度提示词');
    expect(fetchMock).toHaveBeenCalledWith('/api/jacky/seat-cover-prompts', { cache: 'no-store' });
  });



  it('removes template comments and replaces dynamic variables before generation', () => {
    const rendered = renderSeatCoverPromptTemplate(
      '{{! 仅供编辑者看的说明 }}车型：{{vehicle.model}} {{vehicle.year}} {{vehicle.trim}}\n角度：{{angle.name}}\n{{references.vehicle_range}}\n{{user.extra_prompt}}',
      {
        vehicle: { model: 'TOYOTA RAV 4', year: '2026', trim: 'Woodland', identity: 'TOYOTA RAV 4 2026 Woodland' },
        angle: { name: '主驾', prompt: '主驾角度规则', seatScope: 'both' },
        references: { count: 3, guideLabel: 'Image 1', vehicleRange: 'Images 2–4', list: 'Images 2–4' },
        search: { instructions: '' },
        provider: { roleDelivery: '图片按编号使用。' },
        user: { extraPrompt: '保持橙色缝线' },
      },
    );
    expect(rendered).toContain('车型：TOYOTA RAV 4 2026 Woodland');
    expect(rendered).toContain('角度：主驾');
    expect(rendered).toContain('Images 2–4');
    expect(rendered).not.toContain('仅供编辑者看的说明');
  });

  it('falls back to an empty override when the file or request is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ prompts: {} }), { status: 200 })));
    await expect(loadSeatCoverAnglePrompt('不存在的角度')).resolves.toBe('');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(loadSeatCoverAnglePrompt('单品45度')).resolves.toBe('');
  });

  it('extracts only the editable angle rule from a previously expanded template', () => {
    const fullTemplate = `【输出目标】
生成目标车辆。
{{! JACKY_ANGLE_RULE_START }}
【摄影机位与构图】
默认主驾角度规则
{{! JACKY_ANGLE_RULE_END }}
    【禁止】
不要镜像。`;
    expect(extractSeatCoverAngleRule(fullTemplate)).toBe('默认主驾角度规则');
  });

  it('verifies the saved prompt by reading it back before reporting success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompts: { 主驾: '自定义模板' }, defaults: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(saveSeatCoverAnglePrompt('主驾', '  自定义模板  ')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/jacky/seat-cover-prompts', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: '主驾', content: '自定义模板' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/jacky/seat-cover-prompts', { cache: 'no-store' });
  });

  it('rejects a save when the prompt read-back differs', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompts: { 主驾: '默认模板' }, defaults: {} }), { status: 200 })));

    await expect(saveSeatCoverAnglePrompt('主驾', '自定义模板')).resolves.toEqual({
      ok: false,
      error: '提示词保存校验失败：重新读取的内容与刚保存的内容不一致',
    });
  });
});

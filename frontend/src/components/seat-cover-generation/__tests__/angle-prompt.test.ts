import { describe, expect, it } from 'vitest';
import { buildAnglePrompt, buildEditableAnglePromptTemplate, isSingleProductAnglePreset } from '../seat-cover-generation-service';
import type { SeatCoverAnglePreset } from '../types';

const preset: SeatCoverAnglePreset = {
  id: 'rear-left',
  name: '后排左侧面',
  imagePath: '/preset.webp',
  seatScope: 'rear',
  promptHint: '保持正常后排左侧面构图。',
  sortOrder: 1,
};

describe('seat-cover angle prompt structure', () => {
  it('uses a compact visual brief while preserving exact grounded vehicle identity', () => {
    const prompt = buildAnglePrompt('TOYOTA RAV 4', '2026', 'Woodland', '保留原厂橙色缝线', preset, 3, true, true);
    expect(prompt).toContain('【输出目标】');
    expect(prompt).toContain('生成一张“TOYOTA RAV 4 2026 Woodland”的照片级真实汽车内饰摄影图');
    expect(prompt).toContain('Image 1：固定角度参考图');
    expect(prompt).toContain('Images 2–4：同一目标车辆的真实原车资料');
    expect(prompt).toContain('保持正常后排左侧面构图。');
    expect(prompt).toContain('车型：TOYOTA RAV 4');
    expect(prompt).toContain('年份：2026');
    expect(prompt).toContain('配置：Woodland');
    expect(prompt).toContain('联网检索只能使用完整车型身份“TOYOTA RAV 4 2026 Woodland”');
    expect(prompt).toContain('联网资料与用户上传的原车图片冲突时，以用户图片为准');
    expect(prompt).toContain('【额外要求】\n保留原厂橙色缝线');
    expect(prompt).not.toContain('你是一名专业汽车内饰摄影与车型还原专家');
    expect(prompt).not.toContain('生成前必须逐项核对');
  });

  it('uses a dedicated white-background product photography brief for single-product angles', () => {
    const singlePreset: SeatCoverAnglePreset = {
      ...preset,
      id: 'single-45',
      name: '单品45度',
      promptHint: '保持单座椅 45 度构图。',
    };
    expect(isSingleProductAnglePreset(singlePreset)).toBe(true);
    const prompt = buildAnglePrompt('TOYOTA RAV 4', '2026', 'Woodland', '', singlePreset, 3, false, false);
    expect(prompt).toContain('原厂 OEM 座椅的照片级真实产品摄影图');
    expect(prompt).toContain('Image 1：纯白底低细节结构引导图');
    expect(prompt).toContain('保持单座椅 45 度构图。');
    expect(prompt).toContain('纯白无缝摄影棚背景，背景颜色为 #FFFFFF');
    expect(prompt).toContain('不要生成灰底、渐变、墙面、地面线');
    expect(prompt).toContain('不要继承 Image 1 中的迷彩、网孔、印花、座套拼接');
    expect(prompt).toContain('不是 3D 渲染、概念图、拼贴图或座套商品渲染');
  });



  it('supports editing the complete rendered prompt with dynamic placeholders', () => {
    const fullTemplate = '【输出目标】\n生成 {{vehicle.identity}} 的 {{angle.name}} 图片。\n参考范围：{{references.vehicle_range}}\n{{user.extra_prompt}}';
    const rendered = buildAnglePrompt('RAV4', '2026', 'Woodland', '保留原厂缝线', preset, 3, false, false, fullTemplate);
    expect(rendered).toContain('生成 RAV4 2026 Woodland 的 后排左侧面 图片');
    expect(rendered).toContain('参考范围：Images 2–4');
    expect(rendered).toContain('保留原厂缝线');
    expect(rendered).not.toContain('{{vehicle.identity}}');

    const editable = buildEditableAnglePromptTemplate({
      model: 'RAV4', year: '2026', trim: 'Woodland', extraPrompt: '保留原厂缝线', preset,
      referenceCount: 3, webSearchEnabled: false, imageSearchEnabled: false, anglePrompt: '保持左侧面构图。',
    });
    expect(editable).toBe('保持左侧面构图。');
  });

  it('sends a saved compact angle prompt without adding any common template text', () => {
    const compactTemplate = '锁定{{references.guide_label}}的摄影角度不变，以{{references.vehicle_range}}生成{{vehicle.identity}}白底实拍图';
    const prompt = buildAnglePrompt('RAV4', '2026', 'Woodland', '不会自动追加', preset, 3, true, true, compactTemplate);
    expect(prompt).toBe('锁定Image 1的摄影角度不变，以Images 2–4生成RAV4 2026 Woodland白底实拍图');
    expect(prompt).not.toContain('【输出目标】');
    expect(prompt).not.toContain('【车型还原】');
    expect(prompt).not.toContain('【禁止】');
    expect(prompt).not.toContain('不会自动追加');
  });

  it('adapts the image-role reminder to providers that receive per-image labels', () => {
    const geminiPrompt = buildAnglePrompt('RAV4', '2026', 'Woodland', '', preset, 2, false, false, '', 'google');
    const openAiPrompt = buildAnglePrompt('RAV4', '2026', 'Woodland', '', preset, 2, false, false, '', 'openai');
    expect(geminiPrompt).toContain('系统还会在每张图片前逐张标注其角色');
    expect(openAiPrompt).toContain('图片按照以下编号顺序上传');
    expect(openAiPrompt).not.toContain('系统还会在每张图片前逐张标注其角色');
  });

  it('keeps the provider instruction separate from the guide-image label', () => {
    const fullTemplate = `【输出目标】
生成 {{vehicle.identity}}。
【输入图片】
{{provider.role_delivery}}
{{references.guide_label}}：低细节角度结构引导图。
{{references.vehicle_range}}：原车资料；不得改变 {{references.guide_label}} 规定的机位。
{{! JACKY_ANGLE_RULE_START }}
【摄影机位与构图】
保持 {{references.guide_label}} 的右侧后排视角。
{{! JACKY_ANGLE_RULE_END }}`;
    const prompt = buildAnglePrompt('雪佛兰索罗德', '2026', '', '', preset, 3, false, false, fullTemplate, 'google');
    expect(prompt).toContain('输入图片 1 是固定角度参考图，也是摄影机位与构图的最高优先级蓝图');
    expect(prompt).toContain('后续原车资料图不得改变它的视角。\nImage 1：低细节角度结构引导图。');
    expect(prompt).toContain('Images 2–4：原车资料；不得改变 Image 1 规定的机位。');
    expect(prompt).not.toContain('不得改变系统还会在每张图片前逐张标注其角色');
    expect(prompt).not.toContain('JACKY_ANGLE_RULE');
  });
});

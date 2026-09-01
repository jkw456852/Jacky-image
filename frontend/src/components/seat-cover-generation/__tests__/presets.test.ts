import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { SEAT_COVER_ANGLE_PRESETS } from '../presets';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const promptDirectory = path.resolve(
  testDir,
  '../../../../../backend/seat-cover-prompts/angles',
);

function promptFor(name: string): string {
  const fileName = fs.readdirSync(promptDirectory)
    .find(file => file.toLowerCase().endsWith(`-${name}.txt`.toLowerCase()));
  if (!fileName) return '';
  return fs.readFileSync(path.join(promptDirectory, fileName), 'utf8').replace(/^\uFEFF/, '').trim();
}

describe('seat-cover angle presets', () => {
  it('contains the 15 supplied angle references in a stable order', () => {
    expect(SEAT_COVER_ANGLE_PRESETS).toHaveLength(15);
    expect(SEAT_COVER_ANGLE_PRESETS.map(item => item.name)).toEqual([
      '主驾', '侧面前半', '侧面后半', '前排背面', '副驾', '副驾2',
      '单品45度', '单品五座', '单品侧面', '单品正面', '后排左侧面', '后排正面',
      '躺倒正面', '后排右侧面', '后排左侧面座椅抬起',
    ]);
  });

  it('provides one complete editable prompt template for every preset', () => {
    expect(fs.existsSync(promptDirectory)).toBe(true);
    expect(SEAT_COVER_ANGLE_PRESETS.every(item => Boolean(promptFor(item.name)))).toBe(true);
    expect(SEAT_COVER_ANGLE_PRESETS.every(item => promptFor(item.name).includes('【输出目标】'))).toBe(true);
    expect(SEAT_COVER_ANGLE_PRESETS.every(item => promptFor(item.name).includes('【输入图片】'))).toBe(true);
    expect(SEAT_COVER_ANGLE_PRESETS.every(item => promptFor(item.name).includes('【摄影机位与构图】'))).toBe(true);
    expect(SEAT_COVER_ANGLE_PRESETS.every(item => promptFor(item.name).includes('{{! JACKY_ANGLE_RULE_START }}'))).toBe(true);
    expect(SEAT_COVER_ANGLE_PRESETS.every(item => promptFor(item.name).includes('{{! JACKY_ANGLE_RULE_END }}'))).toBe(true);
    expect(SEAT_COVER_ANGLE_PRESETS.every(item => promptFor(item.name).includes('{{references.guide_label}}'))).toBe(true);
    expect(SEAT_COVER_ANGLE_PRESETS.every(item => promptFor(item.name).split('{{provider.role_delivery}}').length - 1 === 1)).toBe(true);
    expect(SEAT_COVER_ANGLE_PRESETS.every(item => !promptFor(item.name).includes('{{angle.prompt}}'))).toBe(true);

    const raisedSeat = promptFor('后排左侧面座椅抬起');
    expect(raisedSeat).toContain('只抬起参考图中画面右侧/远侧的那一块后排座椅坐垫');
    expect(raisedSeat).toContain('不是靠背');
    expect(raisedSeat).toContain('轻微翻起约 22 度');
    expect(raisedSeat).toContain('不得生成普通后排平放状态');
    expect(raisedSeat).toContain('不得左右镜像');
    expect(promptFor('后排左侧面')).toContain('所有后排座椅靠背必须完整、竖直');
  });

  it('locks high-risk cabin angles against appearance and pose contamination', () => {
    expect(promptFor('主驾')).toContain('透过打开的主驾门洞向车厢内看');
    expect(promptFor('主驾')).toContain('前后排同框关系');
    expect(promptFor('侧面前半')).toContain('不得复制预设图的拆门、敞篷或剖切车身');
    expect(promptFor('侧面后半')).toContain('所有后排靠背保持竖直锁止');
    expect(promptFor('前排背面')).toContain('绝对不能看到前排座椅正面');
    expect(promptFor('副驾')).toContain('不得镜像成主驾近景');
    expect(promptFor('单品五座')).toContain('不得生成灰底、渐变、车厢、门板、中控、车身、地面线或车外环境');
    expect(promptFor('后排正面')).toContain('镜头位于前排中央或前排座椅之间');
    expect(promptFor('躺倒正面')).toContain('躺倒对象是前排靠背，不是后排靠背');
    expect(promptFor('后排右侧面')).toContain('相机位于车辆前排右侧/副驾驶区域');
    expect(promptFor('后排右侧面')).toContain('绝不是站在右后门向车头拍摄');
    expect(promptFor('后排右侧面')).toContain('前排中央扶手/中控台只允许在左下角出现很小的近景切片');
  });

  it('forces all single-product presets onto a pure white studio background', () => {
    for (const name of ['单品45度', '单品五座', '单品侧面', '单品正面']) {
      const prompt = promptFor(name);
      expect(prompt).toContain('纯白无缝摄影棚背景（#FFFFFF）');
      expect(prompt).toContain('不得生成灰底');
    }
  });

  it('keeps front, rear and combined seat scopes from the filenames', () => {
    expect(SEAT_COVER_ANGLE_PRESETS.find(item => item.name === '副驾')?.seatScope).toBe('front');
    expect(SEAT_COVER_ANGLE_PRESETS.find(item => item.name === '后排正面')?.seatScope).toBe('rear');
    expect(SEAT_COVER_ANGLE_PRESETS.find(item => item.name === '后排右侧面')?.seatScope).toBe('rear');
    expect(SEAT_COVER_ANGLE_PRESETS.find(item => item.name === '后排左侧面座椅抬起')?.seatScope).toBe('rear');
    expect(SEAT_COVER_ANGLE_PRESETS.find(item => item.name === '主驾')?.seatScope).toBe('both');
    expect(SEAT_COVER_ANGLE_PRESETS.every(item => item.imagePath.includes('.webp?v='))).toBe(true);
  });
});


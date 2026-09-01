import type { SeatCoverAnglePreset, SeatCoverScope } from './types';

const presetFiles: Array<[string, SeatCoverScope]> = [
  ['主驾', 'both'],
  ['侧面前半', 'front'],
  ['侧面后半', 'rear'],
  ['前排背面', 'both'],
  ['副驾', 'front'],
  ['副驾2', 'both'],
  ['单品45度', 'front'],
  ['单品五座', 'both'],
  ['单品侧面', 'front'],
  ['单品正面', 'front'],
  ['后排左侧面', 'rear'],
  ['后排正面', 'rear'],
  ['躺倒正面', 'both'],
  ['后排右侧面', 'rear'],
  ['后排左侧面座椅抬起', 'rear'],
];

const PRESET_ASSET_VERSION = '20260804-3';



export const SEAT_COVER_ANGLE_PRESETS: SeatCoverAnglePreset[] = presetFiles.map(([name, seatScope], index) => ({
  id: `seat-angle-${index + 1}`,
  name,
  imagePath: `/seat-cover-presets/${encodeURIComponent(`${name}-${seatScope === 'front' ? '前排' : seatScope === 'rear' ? '后排' : '前排+后排'}.webp`)}?v=${PRESET_ASSET_VERSION}`,
  seatScope,
  sortOrder: index,
}));

export const SEAT_COVER_STAGE_LABELS: Record<SeatCoverScope, string> = {
  front: '前排',
  rear: '后排',
  both: '前排 + 后排',
};

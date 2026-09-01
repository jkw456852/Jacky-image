import { getModelMaxRefImages } from '@/lib/model-capabilities';
import type { ModelId } from '@/lib/gemini-config';
import type { SeatCoverAnglePreset, SeatCoverImageAsset, SeatCoverScope } from './types';

export interface ScoredSeatCoverReference {
  image: SeatCoverImageAsset;
  score: number;
  reasons: string[];
  categories: string[];
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  overall: ['整体', '全景', '全车', '内饰', '驾驶舱', '座舱', 'cabin', 'interior', 'wide', 'overview'],
  dashboard: ['中控', '仪表', '方向盘', '档把', 'console', 'dashboard', 'cockpit', 'steering'],
  front: ['前排', '主驾', '副驾', '驾驶位', '乘客位', 'front', 'driver', 'passenger'],
  rear: ['后排', '二排', '三排', 'rear', 'back seat', 'second row', 'third row'],
  detail: ['细节', '局部', '特写', '纹理', '缝线', '接口', 'detail', 'close', 'macro'],
  left: ['左侧', '左边', 'left'],
  right: ['右侧', '右边', 'right'],
  folded: ['放倒', '躺倒', '折叠', '平放', '货运', '装载', 'folded', 'fold down', 'flat load', 'cargo'],
  raised: ['抬起', '翻起', '竖起', '立起', 'raised', 'lifted', 'flip up'],
};

function normalizedName(image: SeatCoverImageAsset): string {
  return image.name.toLowerCase().replace(/[\s_\-]+/g, ' ');
}

function hasKeyword(name: string, keywords: string[]): boolean {
  return keywords.some(keyword => name.includes(keyword));
}

function inferCategories(image: SeatCoverImageAsset): string[] {
  const name = normalizedName(image);
  return Object.entries(CATEGORY_KEYWORDS)
    .filter(([, keywords]) => hasKeyword(name, keywords))
    .map(([category]) => category);
}

function scopeCategories(scope: SeatCoverScope): string[] {
  return scope === 'front' ? ['front'] : scope === 'rear' ? ['rear'] : ['front', 'rear'];
}

const MAX_ANGLE_VEHICLE_REFERENCES = 7;
const MAX_SINGLE_PRODUCT_REFERENCES = 3;
const MAX_SINGLE_FIVE_SEAT_REFERENCES = 4;

function isSingleProductPreset(preset?: Pick<SeatCoverAnglePreset, 'name'>): boolean {
  return Boolean(preset?.name.startsWith('单品'));
}

export function getVehicleReferenceLimit(model: ModelId, preset?: Pick<SeatCoverAnglePreset, 'name'>): number {
  const providerLimit = Math.max(0, getModelMaxRefImages(model) - 1);
  if (preset?.name === '单品五座') return Math.min(MAX_SINGLE_FIVE_SEAT_REFERENCES, providerLimit);
  if (isSingleProductPreset(preset)) return Math.min(MAX_SINGLE_PRODUCT_REFERENCES, providerLimit);
  return Math.min(MAX_ANGLE_VEHICLE_REFERENCES, providerLimit);
}

export function scoreVehicleReferences(
  images: SeatCoverImageAsset[],
  preset: SeatCoverAnglePreset,
): ScoredSeatCoverReference[] {
  const presetName = preset.name.toLowerCase();
  const desiredScopes = scopeCategories(preset.seatScope);
  const wantsLeft = presetName.includes('左');
  const wantsRight = presetName.includes('右');
  const wantsFolded = presetName.includes('躺倒') || presetName.includes('放倒');
  const wantsRaised = presetName.includes('抬起') || presetName.includes('翻起');
  const singleProduct = isSingleProductPreset(preset);

  return images.map((image, index) => {
    const categories = inferCategories(image);
    const reasons: string[] = [];
    let score = Math.max(0, 8 - index * 0.08);

    if (categories.includes('overall')) {
      score += singleProduct ? -34 : 24;
      reasons.push(singleProduct ? '单品任务降权整体场景' : '原车整体图');
    }
    if (categories.includes('dashboard')) {
      score += singleProduct ? -42 : 19;
      reasons.push(singleProduct ? '单品任务排除中控场景' : '中控/驾驶舱');
    }
    if (desiredScopes.some(scope => categories.includes(scope))) {
      score += singleProduct ? 48 : 31;
      reasons.push(preset.seatScope === 'rear' ? '对应后排座椅' : preset.seatScope === 'front' ? '对应前排座椅' : '对应座椅区域');
    }
    if (categories.includes('detail')) {
      score += singleProduct ? 28 : 13;
      reasons.push('关键细节');
    }
    if (wantsFolded && categories.includes('folded')) {
      score += 28;
      reasons.push('放倒状态匹配');
    }
    if (wantsRaised && categories.includes('raised')) {
      score += 28;
      reasons.push('抬起状态匹配');
    }
    if (!wantsFolded && !wantsRaised && (categories.includes('folded') || categories.includes('raised'))) {
      score -= 45;
      reasons.push('特殊座椅状态降权');
    }
    if (wantsFolded && categories.includes('raised')) score -= 35;
    if (wantsRaised && categories.includes('folded')) score -= 35;
    if (wantsLeft && categories.includes('left')) {
      score += 10;
      reasons.push('方向匹配');
    }
    if (wantsRight && categories.includes('right')) {
      score += 10;
      reasons.push('方向匹配');
    }
    if (image.width && image.height) {
      const ratio = image.width / image.height;
      if (ratio >= 1.2) {
        score += 4;
        reasons.push('横向构图');
      }
      if (image.width >= 1600 || image.height >= 1600) score += 2;
    }
    if (!reasons.length) reasons.push('补充资料');
    return { image, score, reasons, categories };
  }).sort((a, b) => b.score - a.score);
}

export function selectVehicleReferences(
  model: ModelId,
  images: SeatCoverImageAsset[],
  preset: SeatCoverAnglePreset,
  manualIds?: string[],
): SeatCoverImageAsset[] {
  const limit = getVehicleReferenceLimit(model, preset);
  if (limit <= 0) return [];
  if (manualIds?.length) {
    const byId = new Map(images.map(image => [image.id, image]));
    return Array.from(new Set(manualIds))
      .map(id => byId.get(id))
      .filter((image): image is SeatCoverImageAsset => Boolean(image))
      .slice(0, limit);
  }

  const scored = scoreVehicleReferences(images, preset);
  const chosen: ScoredSeatCoverReference[] = [];
  const used = new Set<string>();
  const wantsFolded = preset.name.includes('躺倒') || preset.name.includes('放倒');
  const wantsRaised = preset.name.includes('抬起') || preset.name.includes('翻起');
  const isPoseCompatible = (item: ScoredSeatCoverReference) => (
    (wantsFolded ? item.categories.includes('folded') && !item.categories.includes('raised') : true)
    && (wantsRaised ? item.categories.includes('raised') && !item.categories.includes('folded') : true)
    && (wantsFolded || wantsRaised ? true : !item.categories.includes('folded') && !item.categories.includes('raised'))
  );
  const takeFirst = (predicate: (item: ScoredSeatCoverReference) => boolean) => {
    const found = scored.find(item => !used.has(item.image.id) && isPoseCompatible(item) && predicate(item));
    if (!found || chosen.length >= limit) return;
    chosen.push(found);
    used.add(found.image.id);
  };

  // Single-product outputs must not inherit the cabin scene. Prefer only
  // seat-specific and close-up evidence, and deliberately avoid dashboard or
  // wide-cabin references unless no seat evidence exists at all.
  if (isSingleProductPreset(preset)) {
    for (const scope of scopeCategories(preset.seatScope)) takeFirst(item => item.categories.includes(scope) && !item.categories.includes('dashboard'));
    takeFirst(item => item.categories.includes('detail') && !item.categories.includes('dashboard'));
    if (preset.name === '单品五座') {
      takeFirst(item => item.categories.includes('front'));
      takeFirst(item => item.categories.includes('rear'));
    }
    for (const item of scored) {
      if (chosen.length >= limit) break;
      if (used.has(item.image.id) || !isPoseCompatible(item)) continue;
      const seatEvidence = scopeCategories(preset.seatScope).some(scope => item.categories.includes(scope))
        || item.categories.includes('detail');
      if (!seatEvidence || item.categories.includes('dashboard')) continue;
      chosen.push(item);
      used.add(item.image.id);
    }
    if (chosen.length === 0) {
      const fallback = scored.find(item => isPoseCompatible(item) && !item.categories.includes('dashboard'));
      if (fallback) chosen.push(fallback);
    }
    return chosen.map(item => item.image);
  }

  // Put the corresponding seat evidence immediately after the angle guide.
  // Wide cabin/dashboard photos often carry a competing camera angle, so rear
  // tasks must not present those before the actual rear-seat identity evidence.
  if (preset.seatScope === 'rear') {
    takeFirst(item => item.categories.includes('rear'));
    takeFirst(item => item.categories.includes('detail') && !item.categories.includes('dashboard'));
    takeFirst(item => item.categories.includes('overall'));
    takeFirst(item => item.categories.includes('dashboard'));
  } else if (preset.seatScope === 'front') {
    takeFirst(item => item.categories.includes('front'));
    takeFirst(item => item.categories.includes('dashboard'));
    takeFirst(item => item.categories.includes('detail'));
    takeFirst(item => item.categories.includes('overall'));
  } else {
    takeFirst(item => item.categories.includes('overall'));
    takeFirst(item => item.categories.includes('dashboard'));
    takeFirst(item => item.categories.includes('front'));
    takeFirst(item => item.categories.includes('rear'));
    takeFirst(item => item.categories.includes('detail'));
  }

  for (const item of scored) {
    if (chosen.length >= limit) break;
    if (used.has(item.image.id) || !isPoseCompatible(item)) continue;
    chosen.push(item);
    used.add(item.image.id);
  }
  return chosen.map(item => item.image);
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelId } from '@/lib/gemini-config';
import type { SeatCoverAnglePreset, SeatCoverImageAsset } from '../types';
import { getVehicleReferenceLimit, selectVehicleReferences } from '../reference-selection';

const preset: SeatCoverAnglePreset = {
  id: 'rear-right',
  name: '后排右侧面',
  imagePath: '/preset.png',
  seatScope: 'rear',
  sortOrder: 1,
};

function image(id: string, name: string): SeatCoverImageAsset {
  return { id, name, dataUrl: 'data:image/png;base64,AA==', preview: '', mimeType: 'image/png', width: 1600, height: 1000 };
}

describe('seat-cover reference selection', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'jackyDesktop', {
      configurable: true,
      value: { modelRegistry: { load: () => ({ imageModels: [{ id: 'banana-pro', protocol: 'google', name: 'Banana Pro', modelId: 'gemini-3-pro-image-preview', apiKey: 'key', apiKeyConfigured: true, baseUrl: 'https://example.com', builtinPreset: 'gemini-3-pro-image-preview', maxRefImages: 14, maxOutputSize: '4K', supportsAdvancedParams: false }], textModels: [], defaults: { textToImage: 'banana-pro', imageToImage: 'banana-pro', reversePrompt: '', agent: '', promptOptimize: '', imageDescribe: '' } }), save: () => ({ ok: true }) } },
    });
  });

  afterEach(() => { delete window.jackyDesktop; });
  it('prioritizes diverse angle-relevant images and reserves one preset slot', () => {
    const model = 'banana-pro' as ModelId;
    const images = [
      image('generic', 'IMG_0001.png'),
      image('overall', '原车内饰整体全景.png'),
      image('dashboard', '中控方向盘细节.png'),
      image('rear', '后排右侧座椅.png'),
      image('detail', '座椅缝线关键细节.png'),
    ];
    const selected = selectVehicleReferences(model, images, preset);
    expect(selected.length).toBeLessThanOrEqual(getVehicleReferenceLimit(model));
    expect(selected[0].id).toBe('rear');
    expect(selected[1].id).toBe('detail');
    expect(selected.map(item => item.id)).toContain('rear');
    expect(selected.map(item => item.id)).toContain('overall');
  });

  it('excludes folded or lifted seat-state photos from normal rear angles', () => {
    const model = 'banana-pro' as ModelId;
    const normalPreset: SeatCoverAnglePreset = { ...preset, name: '后排左侧面' };
    const images = [
      image('folded', '后排座椅放倒.png'),
      image('raised', '后排座椅抬起.png'),
      image('normal', '后排座椅正常状态.png'),
      image('overall', '原车内饰整体图.png'),
    ];
    const selected = selectVehicleReferences(model, images, normalPreset);
    expect(selected.map(item => item.id)).toContain('normal');
    expect(selected.map(item => item.id)).not.toContain('folded');
    expect(selected.map(item => item.id)).not.toContain('raised');
  });



  it('keeps cabin and dashboard references out of automatic single-product selection', () => {
    const model = 'banana-pro' as ModelId;
    const singlePreset: SeatCoverAnglePreset = { ...preset, name: '单品45度', seatScope: 'front' };
    const images = [
      image('overall', '原车内饰整体全景.png'),
      image('dashboard', '中控方向盘细节.png'),
      image('front', '主驾座椅侧面.png'),
      image('detail', '前排座椅缝线细节.png'),
    ];
    const selected = selectVehicleReferences(model, images, singlePreset);
    expect(selected.length).toBeLessThanOrEqual(3);
    expect(selected.map(item => item.id)).toContain('front');
    expect(selected.map(item => item.id)).toContain('detail');
    expect(selected.map(item => item.id)).not.toContain('dashboard');
    expect(selected.map(item => item.id)).not.toContain('overall');
  });

  it('honors manual order and caps it to the model limit', () => {
    const model = 'banana-pro' as ModelId;
    const images = Array.from({ length: 20 }, (_, index) => image(String(index), `图-${index}.png`));
    const manual = images.map(item => item.id).reverse();
    const selected = selectVehicleReferences(model, images, preset, manual);
    expect(selected[0].id).toBe('19');
    expect(selected).toHaveLength(getVehicleReferenceLimit(model));
  });

  it('drops stale manual IDs so the displayed count matches the images that can actually be sent', () => {
    const model = 'banana-pro' as ModelId;
    const images = [image('one', '前排.png'), image('two', '后排.png')];
    const selected = selectVehicleReferences(model, images, preset, ['removed-image', 'two', 'two', 'one']);
    expect(selected.map(item => item.id)).toEqual(['two', 'one']);
  });
});

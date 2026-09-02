import {
  ackJackyTask,
  createJackyTask,
  getJackyTask,
  resolveImageTaskProvider,
  type ImageReference,
} from '@/lib/ccode-task-client';
import { downloadAndStoreImages, makeStoredBlobRef } from '@/lib/image-downloader';
import {
  detectClosestAspectRatio,
  getAspectRatioOptions,
  getModelMaxRefImages,
  supportsImageSearchGrounding,
  supportsWebSearchGrounding,
  type ParallelCount,
} from '@/lib/model-capabilities';
import type { ModelId } from '@/lib/gemini-config';
import type { AspectRatio, OutputSize } from '@/lib/job-store';
import type { ProviderProtocol } from '@/lib/jacky-models';
import { analyzeMaskDataUrl, getImageDimensions, getMaskStrategyForModel, processMaskForTarget, type MaskDraft } from '@/lib/mask-utils';
import { generateUUID } from '@/lib/uuid';
import type { SeatCoverAnglePreset, SeatCoverGenerationConfig, SeatCoverImageAsset, SeatCoverScope } from './types';
import { loadSeatCoverAnglePrompt, renderSeatCoverPromptTemplate, type SeatCoverPromptContext } from './prompt-templates';

const POLL_INTERVAL = 1500;
const POLL_TIMEOUT = 32 * 60 * 1000;
const REQUEST_REFERENCE_MAX_SIDE = 1600;
const REQUEST_REFERENCE_MIN_BYTES = 384 * 1024;
const REQUEST_REFERENCE_WEBP_QUALITY = 0.9;

export interface SeatCoverGenerationResult {
  taskId: string;
  imageRefs: string[];
  blobUrls: string[];
  serverTaskAcked: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function estimateDataUrlBytes(dataUrl: string): number {
  return Math.floor(base64FromDataUrl(dataUrl).length * 3 / 4);
}

function loadRequestImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('参考图解码失败'));
    image.src = dataUrl;
  });
}

async function optimizeReferenceForRequest(
  asset: SeatCoverImageAsset,
  role?: ImageReference['role'],
): Promise<SeatCoverImageAsset> {
  const canOptimize = role === 'vehicle-reference'
    || role === 'seat-product-reference'
    || role === 'cover-reference';
  if (!canOptimize || typeof document === 'undefined' || typeof Image === 'undefined') return asset;

  const knownMaxSide = Math.max(asset.width || 0, asset.height || 0);
  if (estimateDataUrlBytes(asset.dataUrl) < REQUEST_REFERENCE_MIN_BYTES
    && (!knownMaxSide || knownMaxSide <= REQUEST_REFERENCE_MAX_SIDE)) return asset;

  try {
    const image = await loadRequestImage(asset.dataUrl);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, REQUEST_REFERENCE_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return asset;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/webp', REQUEST_REFERENCE_WEBP_QUALITY);
    if (!dataUrl.startsWith('data:image/webp;base64,') || dataUrl.length >= asset.dataUrl.length * 0.92) return asset;
    return { ...asset, dataUrl, mimeType: 'image/webp', width, height };
  } catch {
    return asset;
  }
}

export function isSingleProductAnglePreset(preset: Pick<SeatCoverAnglePreset, 'name'>): boolean {
  return preset.name.startsWith('单品');
}

async function createSingleProductStructureGuide(blob: Blob): Promise<string> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') {
    throw new Error('当前环境不支持结构引导图转换');
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const maxSide = 240;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(2, Math.round(bitmap.width * scale));
    const height = Math.max(2, Math.round(bitmap.height * scale));
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = width;
    sourceCanvas.height = height;
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
    if (!sourceContext) throw new Error('无法创建结构引导图画布');
    sourceContext.drawImage(bitmap, 0, 0, width, height);
    const source = sourceContext.getImageData(0, 0, width, height);
    const gray = new Float32Array(width * height);
    for (let index = 0; index < gray.length; index += 1) {
      const offset = index * 4;
      gray[index] = source.data[offset] * 0.299 + source.data[offset + 1] * 0.587 + source.data[offset + 2] * 0.114;
    }
    const blurred = new Float32Array(gray.length);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) sum += gray[(y + dy) * width + x + dx];
        }
        blurred[y * width + x] = sum / 9;
      }
    }
    const smoothed = new Float32Array(blurred.length);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) sum += blurred[(y + dy) * width + x + dx];
        }
        smoothed[y * width + x] = sum / 9;
      }
    }
    const output = sourceContext.createImageData(width, height);
    for (let offset = 0; offset < output.data.length; offset += 4) {
      output.data[offset] = 255;
      output.data[offset + 1] = 255;
      output.data[offset + 2] = 255;
      output.data[offset + 3] = 255;
    }
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const tl = smoothed[(y - 1) * width + x - 1];
        const tc = smoothed[(y - 1) * width + x];
        const tr = smoothed[(y - 1) * width + x + 1];
        const ml = smoothed[y * width + x - 1];
        const mr = smoothed[y * width + x + 1];
        const bl = smoothed[(y + 1) * width + x - 1];
        const bc = smoothed[(y + 1) * width + x];
        const br = smoothed[(y + 1) * width + x + 1];
        const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
        const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
        const magnitude = Math.min(255, Math.hypot(gx, gy));
        const value = magnitude > 52 ? Math.max(45, 255 - magnitude * 1.15) : 255;
        const offset = (y * width + x) * 4;
        output.data[offset] = value;
        output.data[offset + 1] = value;
        output.data[offset + 2] = value;
        output.data[offset + 3] = 255;
      }
    }
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = Math.max(2, Math.round(bitmap.width * Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))));
    outputCanvas.height = Math.max(2, Math.round(bitmap.height * Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))));
    const outputContext = outputCanvas.getContext('2d');
    if (!outputContext) throw new Error('无法输出结构引导图');
    sourceContext.putImageData(output, 0, 0);
    outputContext.fillStyle = '#ffffff';
    outputContext.fillRect(0, 0, outputCanvas.width, outputCanvas.height);
    outputContext.imageSmoothingEnabled = true;
    outputContext.drawImage(sourceCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
    return outputCanvas.toDataURL('image/png');
  } finally {
    bitmap.close();
  }
}

async function loadPresetAsset(preset: SeatCoverAnglePreset): Promise<SeatCoverImageAsset> {
  const response = await fetch(preset.imagePath);
  if (!response.ok) throw new Error(`角度参考图加载失败：${preset.name}`);
  const blob = await response.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('角度参考图读取失败'));
    reader.readAsDataURL(blob);
  });
  let modelInputDataUrl = dataUrl;
  let mimeType = blob.type || 'image/webp';
  if (isSingleProductAnglePreset(preset)) {
    try {
      modelInputDataUrl = await createSingleProductStructureGuide(blob);
      mimeType = 'image/png';
    } catch {
      // Keep the original preset as a fallback; the prompt still forbids appearance transfer.
    }
  }
  return {
    id: preset.id,
    name: preset.name,
    dataUrl: modelInputDataUrl,
    preview: preset.imagePath,
    mimeType,
  };
}

function toImageReference(asset: SeatCoverImageAsset, role?: ImageReference['role']): ImageReference {
  return {
    data: base64FromDataUrl(asset.dataUrl),
    mimeType: asset.mimeType || 'image/webp',
    ...(role ? { role } : {}),
  };
}

export function resolveSeatCoverAspectRatio(
  model: ModelId,
  outputSize: Extract<OutputSize, '1K' | '2K' | '4K'>,
  requested: AspectRatio | undefined,
  width?: number,
  height?: number,
): AspectRatio {
  const ratioOptions = getAspectRatioOptions(model, outputSize).filter(option => option.value !== 'auto');
  const allowedRatios = ratioOptions.map(option => option.value);
  if (requested && requested !== 'auto' && allowedRatios.includes(requested)) return requested;
  if (width && height) return detectClosestAspectRatio(width, height, ratioOptions);
  if (allowedRatios.includes('4:3')) return '4:3';
  if (allowedRatios.includes('1:1')) return '1:1';
  return allowedRatios[0] || '1:1';
}

function capReferences(model: ModelId, images: SeatCoverImageAsset[], reserved: number): SeatCoverImageAsset[] {
  const max = getModelMaxRefImages(model) - reserved;
  if (max < 1) throw new Error('当前模型至少需要支持 2 张参考图才能使用座套生成');
  return images.slice(0, max);
}

function selectCoverReferences(
  model: ModelId,
  scope: SeatCoverScope,
  frontImages: SeatCoverImageAsset[],
  rearImages: SeatCoverImageAsset[],
  reservedSlots = 1,
): { images: SeatCoverImageAsset[]; frontCount: number; rearCount: number } {
  const slots = getModelMaxRefImages(model) - reservedSlots;
  if (slots < 1) throw new Error('当前模型至少需要支持 2 张参考图才能使用座套生成');
  if (scope === 'front') {
    const images = frontImages.slice(0, slots);
    return { images, frontCount: images.length, rearCount: 0 };
  }
  if (scope === 'rear') {
    const images = rearImages.slice(0, slots);
    return { images, frontCount: 0, rearCount: images.length };
  }

  const frontTarget = Math.min(frontImages.length, Math.ceil(slots / 2));
  const rearTarget = Math.min(rearImages.length, slots - frontTarget);
  const frontExtra = Math.min(frontImages.length - frontTarget, slots - frontTarget - rearTarget);
  const rearExtra = Math.min(rearImages.length - rearTarget, slots - frontTarget - rearTarget - frontExtra);
  const front = frontImages.slice(0, frontTarget + frontExtra);
  const rear = rearImages.slice(0, rearTarget + rearExtra);
  return { images: [...front, ...rear], frontCount: front.length, rearCount: rear.length };
}

function isFullAnglePromptTemplate(value: string): boolean {
  return value.includes('【输出目标】') && value.includes('【输入图片】');
}

export function buildEditableAnglePromptTemplate(input: {
  model: string;
  year: string;
  trim: string;
  extraPrompt: string;
  preset: SeatCoverAnglePreset;
  referenceCount: number;
  webSearchEnabled: boolean;
  imageSearchEnabled: boolean;
  anglePrompt: string;
  providerProtocol?: ProviderProtocol;
}): string {
  const rendered = buildAnglePrompt(
    input.model,
    input.year,
    input.trim,
    input.extraPrompt,
    input.preset,
    input.referenceCount,
    input.webSearchEnabled,
    input.imageSearchEnabled,
    input.anglePrompt,
    input.providerProtocol,
  );
  if (isFullAnglePromptTemplate(input.anglePrompt.trim())) return input.anglePrompt.trim();
  const identity = [input.model, input.year, input.trim].map(value => value.trim()).filter(Boolean).join(' ');
  const vehicleRange = input.referenceCount <= 0 ? '未提供原车资料图' : input.referenceCount === 1 ? 'Image 2' : `Images 2–${input.referenceCount + 1}`;
  const searchText = input.webSearchEnabled || input.imageSearchEnabled
    ? `联网检索只能使用完整车型身份“${identity || '用户未填写完整车型身份'}”，不得用普通版、基础版、其他配置或其他年份代替“${input.trim || '用户指定配置'}”。联网资料与用户上传的原车图片冲突时，以用户图片为准。`
    : '';
  const replacements: Array<[string, string]> = [
    [identity, '{{vehicle.identity}}'],
    [input.model, '{{vehicle.model}}'],
    [input.year, '{{vehicle.year}}'],
    [input.trim, '{{vehicle.trim}}'],
    [input.preset.name, '{{angle.name}}'],
    [vehicleRange, '{{references.vehicle_range}}'],
    [searchText, '{{search.instructions}}'],
    ['系统还会在每张图片前逐张标注其角色，以下图片分工必须严格执行；输入图片 1 是固定角度参考图，也是摄影机位与构图的最高优先级蓝图，后续原车资料图不得改变它的视角。', '{{provider.role_delivery}}'],
    ['图片按照以下编号顺序上传，必须严格按照编号分工使用；Image 1 是固定角度参考图，也是摄影机位与构图的最高优先级蓝图，后续原车资料图只负责车型身份，不得改变 Image 1 的视角。', '{{provider.role_delivery}}'],
    ['系统还会在每张图片前逐张标注其角色，以下图片分工必须严格执行；输入图片 1 是摄影机位与构图的最高优先级蓝图，后续原车资料图不得改变它的视角。', '{{provider.role_delivery}}'],
    ['图片按照以下编号顺序上传，必须严格按照编号分工使用；Image 1 是摄影机位与构图的最高优先级蓝图，后续原车资料图只负责车型身份，不得改变 Image 1 的视角。', '{{provider.role_delivery}}'],
    ['系统还会在每张图片前逐张标注其角色，以下图片分工必须严格执行。', '{{provider.role_delivery}}'],
    ['图片按照以下编号顺序上传，必须严格按照编号分工使用。', '{{provider.role_delivery}}'],
    ['Image 1', '{{references.guide_label}}'],
    [input.extraPrompt.trim(), '{{user.extra_prompt}}'],
  ];
  return replacements.reduce((result, [from, to]) => from ? result.split(from).join(to) : result, rendered).trim();
}

export function buildAnglePrompt(
  model: string,
  year: string,
  trim: string,
  extraPrompt: string,
  preset: SeatCoverAnglePreset,
  referenceCount: number,
  webSearchEnabled: boolean,
  imageSearchEnabled: boolean,
  anglePromptOverride = '',
  providerProtocol: ProviderProtocol = 'google',
): string {
  const vehicleIdentity = [model, year, trim].map(value => value.trim()).filter(Boolean).join(' ');
  const identity = vehicleIdentity || '用户未填写完整车型身份';
  const vehicleRange = referenceCount <= 0
    ? '未提供原车资料图'
    : referenceCount === 1
      ? 'Image 2'
      : `Images 2–${referenceCount + 1}`;
  const providerRoleDelivery = providerProtocol === 'google'
    ? '系统还会在每张图片前逐张标注其角色，以下图片分工必须严格执行；输入图片 1 是固定角度参考图，也是摄影机位与构图的最高优先级蓝图，后续原车资料图不得改变它的视角。'
    : '图片按照以下编号顺序上传，必须严格按照编号分工使用；Image 1 是固定角度参考图，也是摄影机位与构图的最高优先级蓝图，后续原车资料图只负责车型身份，不得改变 Image 1 的视角。';
  const searchInstructions = webSearchEnabled || imageSearchEnabled
    ? `联网检索只能使用完整车型身份“${identity}”，不得用普通版、基础版、其他配置或其他年份代替“${trim || '用户指定配置'}”。联网资料与用户上传的原车图片冲突时，以用户图片为准。`
    : '';
  const promptContext: SeatCoverPromptContext = {
    vehicle: { model, year, trim, identity },
    angle: { name: preset.name, prompt: '', seatScope: preset.seatScope },
    references: { count: referenceCount, guideLabel: 'Image 1', vehicleRange, list: vehicleRange },
    search: { instructions: searchInstructions },
    provider: { roleDelivery: providerRoleDelivery },
    user: { extraPrompt },
  };
  const rawPromptOverride = anglePromptOverride.trim();
  if (rawPromptOverride) return renderSeatCoverPromptTemplate(rawPromptOverride, promptContext);
  const anglePrompt = renderSeatCoverPromptTemplate(anglePromptOverride.trim(), promptContext).trim()
    || preset.promptHint?.trim()
    || '严格匹配 Image 1 的摄影机位、透视、裁切和主体布局。';
  const roleDelivery = providerRoleDelivery;
  const searchBlock = webSearchEnabled || imageSearchEnabled
    ? `
【精确配置】
联网检索只能使用完整车型身份“${identity}”，不得用普通版、基础版、其他配置或其他年份代替“${trim || '用户指定配置'}”。联网资料与用户上传的原车图片冲突时，以用户图片为准。`
    : '';
  const extraBlock = extraPrompt.trim() ? `
【额外要求】
${extraPrompt.trim()}` : '';

  if (isSingleProductAnglePreset(preset)) {
    const productScope = preset.name === '单品五座'
      ? '生成该车型前后排原厂座椅的五座产品展示组合；座位数量和排列方式跟随 Image 1。'
      : '只生成一张完整的目标车型原厂前排座椅，不展示第二张座椅。';
    return `【输出目标】
生成“${identity}”原厂 OEM 座椅的照片级真实产品摄影图。不是 3D 渲染、概念图、拼贴图或座套商品渲染。
目标角度：${preset.name}
${productScope}

【输入图片】
${roleDelivery}
Image 1：纯白底低细节结构引导图。只采用它的座椅数量、摆放关系、旋转方向、摄影机位、透视、主体位置、画面占比和留白；完全忽略它的车型、产品设计、座套轮廓、颜色、材质、迷彩、网孔、印花、拼接、缝线、包边和背景。
${vehicleRange}：目标车辆的真实原车资料。只采用这些图片中的原厂座椅结构、头枕、靠背、侧翼、坐垫、底座、调节部件、面料和配色；不得改变 Image 1 规定的拍摄几何。

【产品构图】
${anglePrompt}
严格保持 Image 1 的旋转方向、透视、主体占比、裁切和留白，但产品结构与外观必须完全来自目标车型资料。

【背景】
纯白无缝摄影棚背景，背景颜色为 #FFFFFF。图片四角和座椅周围必须保持纯白，只允许座椅底部出现非常轻微的自然接触阴影。

【车型还原】
车型：${model || '用户未填写'}
年份：${year || '用户未填写'}
配置：${trim || '未指定'}
必须还原该精确车型的原厂座椅，不得把 Image 1 中的座套设计、材质或产品造型安装到目标座椅上。${searchBlock}

【禁止】
不要生成灰底、渐变、墙面、地面线、摄影棚道具、车厢、车门、门板、中控、车身或室外环境。
不要继承 Image 1 中的迷彩、网孔、印花、座套拼接、缝线、包边、材质或颜色。
不要生成额外座椅、错误座位数量、文字、水印、错误品牌标志或其他车型部件。${extraBlock}`;
  }

  const poseRule = preset.name.includes('座椅抬起')
    ? '只允许抬起角度说明指定的分体坐垫；抬起对象不是靠背，并且必须保留真实旋转轴、接触面、阴影和重力方向。'
    : preset.name.includes('躺倒')
      ? '只允许躺倒角度说明指定的前排靠背；其他座椅保持正常状态。'
      : '所有座椅靠背保持完整竖直锁止，所有坐垫保持正常水平状态。';

  return `【输出目标】
生成一张“${identity}”的照片级真实汽车内饰摄影图。不是 3D 渲染、概念车、设计草图或拼贴图。
目标角度：${preset.name}

【输入图片】
${roleDelivery}
Image 1：固定角度参考图。只采用它的摄影机位置、镜头方向、左右关系、透视、景别、裁切范围、门框/车窗/B柱形成的画面边界、座椅布局和主体占比；不要复制它的车型、品牌、颜色、材质、纹理、座套设计和背景。
${vehicleRange}：同一目标车辆的真实原车资料。采用这些图片中的车型身份、方向盘位置、仪表台、中控、门板、座椅结构、原厂材质、颜色和配置；不得改变 Image 1 规定的摄影机位。

【摄影机位与构图】
${anglePrompt}
严格保持 Image 1 的拍摄侧、镜头高度、俯仰角、透视、裁切、主体位置、前后遮挡关系和留白，不得左右镜像或改成其他视角。

【车型还原】
车型：${model || '用户未填写'}
年份：${year || '用户未填写'}
配置：${trim || '未指定'}
必须精确还原该车型的方向盘位置、仪表台、中控、门板、座椅数量、座椅结构、原厂材质和配色。${searchBlock}

【座椅状态】
${poseRule}

【禁止】
不要复制 Image 1 中的车型、车身结构、拆门、敞篷、越野框架、颜色、迷彩图案、座套、材质或背景。
不要生成错误驾驶侧、镜像构图、额外座椅、错误配置、文字、水印或不属于目标车型的部件。${extraBlock}`;
}

function buildFittingPrompt(
  vehicleModel: string,
  vehicleYear: string,
  scope: SeatCoverScope,
  frontCount: number,
  rearCount: number,
  extraPrompt: string,
): string {
  const scopeText = scope === 'front' ? '前排座椅' : scope === 'rear' ? '后排座椅' : '前排和后排座椅';
  const frontRange = frontCount > 0
    ? `Images 2–${frontCount + 1}：前排座套产品资料。`
    : '';
  const rearStart = frontCount + 2;
  const rearRange = rearCount <= 0
    ? ''
    : rearCount === 1
      ? `Image ${rearStart}：后排座套产品资料。`
      : `Images ${rearStart}–${rearStart + rearCount - 1}：后排座套产品资料。`;
  const extraBlock = extraPrompt.trim() ? `
【额外要求】
${extraPrompt.trim()}` : '';

  return `【输出目标】
在 Image 1 的原车内饰照片中，只为${scopeText}生成照片级真实的座套安装效果。输出方向和宽高比必须跟随 Image 1。
车型：${vehicleModel || '用户未填写'}
年份：${vehicleYear || '用户未填写'}

【输入图片】
Image 1：干净的原车内饰底图，是构图、透视、光线、颜色和未编辑区域的唯一基准。
${[frontRange, rearRange].filter(Boolean).join('\n')}
座套资料只用于还原材质、颜色、纹理、拼接、缝线、包边和标志，不用于改变底图中的座椅数量、位置、形状或摄影机位。

【编辑范围】
只修改${scopeText}的座套覆盖区域。前排座套只能安装到前排，后排座套只能安装到后排；座套必须贴合原车座椅，并符合真实安装、开孔、包边和受力关系。
若附带蒙版，白色或透明可编辑区域是唯一允许修改的范围；蒙版颜色不得进入结果。

【必须保持】
保持 Image 1 的中控台、方向盘、门板、扶手箱、地板、车窗、车外环境、非目标座椅、构图、透视和光线不变。
不要增加或删除座椅，不要改变原车座椅的位置、形状和比例。${extraBlock}`;
}

async function pollTask(taskId: string, onProgress?: (message: string) => void): Promise<string[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT) {
    const task = await getJackyTask(taskId);
    if (task.status === 'completed') {
      const refs = task.result?.images || [];
      if (!refs.length) throw new Error('模型已完成任务，但没有返回图片');
      return refs;
    }
    if (task.status === 'failed' || task.status === 'expired') {
      throw new Error(task.error || `生成任务${task.status === 'expired' ? '已过期' : '失败'}`);
    }
    const elapsedMs = Date.now() - startedAt;
    onProgress?.(task.status === 'queued' || task.status === '排队中'
      ? '排队中…'
      : elapsedMs >= 8 * 60 * 1000
        ? '上游仍在处理这一笔请求，请勿重复点击…'
        : '生成中…');
    await sleep(POLL_INTERVAL);
  }
  throw new Error('座套生成任务等待超时，请稍后重试');
}

async function resolveResult(taskId: string, refs: string[]): Promise<SeatCoverGenerationResult> {
  const download = await downloadAndStoreImages(`seat-cover-${taskId}`, refs);
  const imageRefs = refs.map((ref, index) => {
    if (!ref.startsWith('URL:')) return ref;
    return download.blobUrls[index] ? makeStoredBlobRef(`seat-cover-${taskId}`, index) : ref;
  });
  const blobUrls = refs.map((ref, index) => {
    if (download.blobUrls[index]) return download.blobUrls[index];
    if (ref.startsWith('URL:')) return ref.substring(4);
    return ref;
  });
  const hasUncachedServerUrl = imageRefs.some(ref => ref.startsWith('URL:'));
  return { taskId, imageRefs, blobUrls, serverTaskAcked: !hasUncachedServerUrl };
}

async function finishSeatCoverTask(taskId: string, onProgress?: (message: string) => void): Promise<SeatCoverGenerationResult> {
  const result = await resolveResult(taskId, await pollTask(taskId, onProgress));
  if (result.serverTaskAcked) await ackJackyTask(taskId);
  return result;
}

async function generateTask(
  input: {
    model: ModelId;
    outputSize: Extract<OutputSize, '1K' | '2K' | '4K'>;
    parallelCount: ParallelCount;
    temperature: number;
    webSearchEnabled: boolean;
    imageSearchEnabled: boolean;
    gptImageAdvancedParams: SeatCoverGenerationConfig['gptImageAdvancedParams'];
    images: SeatCoverImageAsset[];
    prompt: string;
    aspectRatio?: AspectRatio;
    maskDataUrl?: string;
    maskTargetDataUrl?: string;
    imageRoles?: Array<ImageReference['role']>;
    onProgress?: (message: string) => void;
    onTaskCreated?: (serverTaskId: string) => void;
  },
): Promise<SeatCoverGenerationResult> {
  if (input.images.length === 0) throw new Error('至少需要一张参考图片');
  const provider = resolveImageTaskProvider(input.model);
  let primaryImage = input.images[0];
  if (!primaryImage.width || !primaryImage.height) {
    try {
      const dimensions = await getImageDimensions(primaryImage.dataUrl);
      primaryImage = { ...primaryImage, ...dimensions };
    } catch {
      // Old cached/generated images may not carry dimensions. Fall back only
      // when the image itself cannot be decoded.
    }
  }
  const requestImages = await Promise.all(
    [primaryImage, ...input.images.slice(1)].map((image, index) => (
      optimizeReferenceForRequest(image, input.imageRoles?.[index])
    )),
  );
  const safeAspectRatio = resolveSeatCoverAspectRatio(
    input.model,
    input.outputSize,
    input.aspectRatio,
    primaryImage.width,
    primaryImage.height,
  );
  let mask: Parameters<typeof createJackyTask>[0]['mask'];
  if (input.maskDataUrl && input.maskTargetDataUrl) {
    const analysis = await analyzeMaskDataUrl(input.maskDataUrl);
    const draft: MaskDraft = {
      id: generateUUID(),
      name: 'seat-area-mask.png',
      originalDataUrl: input.maskDataUrl,
      mimeType: 'image/png',
      analysis,
      sourceMode: 'luminance',
      threshold: 128,
      softEdges: false,
      inverted: false,
    };
    const processed = await processMaskForTarget(
      draft,
      input.maskTargetDataUrl,
      getMaskStrategyForModel(input.model),
    );
    mask = {
      data: base64FromDataUrl(processed.dataUrl),
      mimeType: processed.mimeType,
      representation: processed.representation,
      width: processed.width,
      height: processed.height,
      inverted: processed.inverted,
    };
  }
  const taskId = await createJackyTask({
    modelConfigId: provider.modelConfigId,
    mode: 'image-to-image',
    prompt: input.prompt,
    outputSize: input.outputSize,
    aspectRatio: safeAspectRatio as never,
    temperature: input.temperature,
    webSearchEnabled: supportsWebSearchGrounding(input.model) && input.webSearchEnabled,
    imageSearchEnabled: supportsImageSearchGrounding(input.model) && input.imageSearchEnabled,
    model: provider.modelId,
    gptImageQuality: input.gptImageAdvancedParams.quality,
    gptImageStyle: input.gptImageAdvancedParams.style,
    gptImageBackground: input.gptImageAdvancedParams.background,
    parallelCount: input.parallelCount,
    images: requestImages.map((image, index) => toImageReference(image, input.imageRoles?.[index])),
    mask,
  });
  input.onTaskCreated?.(taskId);
  input.onProgress?.('任务已创建，正在排队…');
  return finishSeatCoverTask(taskId, input.onProgress);
}

export function resumeSeatCoverGenerationTask(taskId: string, onProgress?: (message: string) => void): Promise<SeatCoverGenerationResult> {
  return finishSeatCoverTask(taskId, onProgress);
}

export async function generateSeatCoverAngle(input: {
  vehicleModel: string;
  vehicleYear: string;
  vehicleTrim: string;
  extraPrompt: string;
  preset: SeatCoverAnglePreset;
  vehicleImages: SeatCoverImageAsset[];
  config: SeatCoverGenerationConfig;
  onProgress?: (message: string) => void;
  onTaskCreated?: (serverTaskId: string) => void;
}): Promise<SeatCoverGenerationResult> {
  const vehicleImages = capReferences(input.config.model, input.vehicleImages, 1);
  const provider = resolveImageTaskProvider(input.config.model);
  const [presetAsset, anglePromptOverride] = await Promise.all([
    loadPresetAsset(input.preset),
    loadSeatCoverAnglePrompt(input.preset.name),
  ]);
  // The preset is the first/primary image so providers use it as the composition base.
  const images = [presetAsset, ...vehicleImages];
  return generateTask({
    ...input.config,
    images,
    prompt: buildAnglePrompt(
      input.vehicleModel,
      input.vehicleYear,
      input.vehicleTrim,
      input.extraPrompt,
      input.preset,
      vehicleImages.length,
      supportsWebSearchGrounding(input.config.model) && input.config.webSearchEnabled,
      supportsImageSearchGrounding(input.config.model) && input.config.imageSearchEnabled,
      anglePromptOverride,
      provider.protocol,
    ),
    aspectRatio: '4:3',
    imageRoles: [
      isSingleProductAnglePreset(input.preset) ? 'angle-structure-reference' : 'angle-reference',
      ...vehicleImages.map(() => isSingleProductAnglePreset(input.preset)
        ? 'seat-product-reference' as const
        : 'vehicle-reference' as const),
    ],
    onProgress: input.onProgress,
    onTaskCreated: input.onTaskCreated,
  });
}

export async function generateSeatCoverFitting(input: {
  vehicleModel: string;
  vehicleYear: string;
  extraPrompt: string;
  scope: SeatCoverScope;
  baseImage: SeatCoverImageAsset;
  frontCoverImages: SeatCoverImageAsset[];
  rearCoverImages: SeatCoverImageAsset[];
  config: SeatCoverGenerationConfig;
  maskDataUrl?: string;
  onProgress?: (message: string) => void;
  onTaskCreated?: (serverTaskId: string) => void;
}): Promise<SeatCoverGenerationResult> {
  const maskStrategy = input.maskDataUrl ? getMaskStrategyForModel(input.config.model) : null;
  const selected = selectCoverReferences(
    input.config.model,
    input.scope,
    input.frontCoverImages,
    input.rearCoverImages,
    maskStrategy?.consumesImageSlot ? 2 : 1,
  );
  const images = [input.baseImage, ...selected.images];
  return generateTask({
    ...input.config,
    images,
    prompt: buildFittingPrompt(input.vehicleModel, input.vehicleYear, input.scope, selected.frontCount, selected.rearCount, input.extraPrompt),
    aspectRatio: 'auto',
    imageRoles: ['base-image', ...selected.images.map(() => 'cover-reference' as const)],
    maskDataUrl: input.maskDataUrl,
    maskTargetDataUrl: input.baseImage.dataUrl,
    onProgress: input.onProgress,
    onTaskCreated: input.onTaskCreated,
  });
}

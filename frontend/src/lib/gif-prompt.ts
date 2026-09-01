const STRUCTURE_PREFIX = `Create a strict animation sprite sheet, not a labeled contact sheet.

Canvas: exactly 3264x2448 pixels.
Grid: exactly 4 columns and 3 rows, 12 panels total.
Each panel: exactly 816x816 pixels, square, edge-to-edge.
Panel order: left to right, top to bottom: row 1 = frames 1-4, row 2 = frames 5-8, row 3 = frames 9-12.

The grid must fill the entire canvas. No outer margin, no gutters, no spacing between panels, no rounded panels, no borders, no separators, no labels, no frame numbers, no text, no watermark, no annotations.
Each panel contains exactly one frame of the same animation sequence.
Keep the subject fully inside each 816x816 panel and centered on a stable anchor point.`;

const TEMPLATE_LOGIC =
  'The first uploaded image is a layout template only: use it strictly to determine the 4x3 panel boundaries and panel sizes. Do not copy any visible guide lines, grid strokes, labels, numbers, colors, borders, frames, watermarks, or any other template artifacts into the final image.';

const REF_LOGIC =
  'Use the remaining uploaded images only as visual references for character identity, outfit, color palette, object design, and rendering style. If a reference image is not square, treat it as if center-cropped to a 1:1 square. Do not reuse the reference background composition unless explicitly requested.';

const STYLE_LOGIC = `Maintain strict identity consistency across all 12 frames: same character, same outfit, same colors, same proportions, same object design, same camera angle, same lighting, same background, and same rendering style.

Only the intended animation motion may change between frames. Motion between adjacent frames must be small, gradual, and evenly spaced. Avoid sudden jumps, scale changes, camera movement, perspective changes, pose resets, duplicated unrelated characters, changing accessories, or changes in background layout. The subject anchor point and overall scale must stay stable across the whole sheet.`;

const NON_LOOP_LOGIC = `This is a linear 12-frame animation storyboard.
Frame 1 is the clear starting pose, frame 12 is the natural ending pose.
The transition between every adjacent frame must be smooth and gradual, with the same small motion step size.`;

const CLOSED_LOOP_LOGIC = `This is a seamless closed-loop animation.
Frames 1-12 represent evenly spaced phases of one continuous cycle.
Frame 12 must transition smoothly back to frame 1 with the same small motion step as all other adjacent frames.
Do not make frame 12 a static duplicate of frame 1; frame 12 should be the natural frame immediately before frame 1 in the loop.
The subject anchor point, scale, identity, lighting, and background must remain stable across the loop seam.`;

function buildChineseRefIntro(refImageCount: number): string {
  const templatePart =
    '图一是gif平面图布局模板，仅用于确定4列3行的网格切片边界，禁止把模板中的引导线、网格线、编号、边框、底色等元素画进最终图像';
  if (refImageCount <= 0) {
    return `${templatePart}。以下是用户的gif设计提示词：`;
  }
  const tokens = ['图二'];
  const labels = ['二', '三', '四', '五', '六', '七'];
  for (let index = 1; index < refImageCount; index++) {
    tokens.push(`图${labels[index] || index + 1}`);
  }
  const refSuffix = refImageCount === 1 ? '图二' : tokens.join('，');
  return `${templatePart}；gif视觉参考使用${refSuffix}（仅参考角色、配色、风格，不要复制其背景构图）。以下是用户的gif设计提示词：`;
}

export interface BuildGifPromptInput {
  userPrompt: string;
  refImageCount: number;
  loop: boolean;
  closedLoop: boolean;
}

export function buildGifPrompt(input: BuildGifPromptInput): string {
  const cleanedUser = input.userPrompt.trim();
  const hasRefs = input.refImageCount > 0;

  const chineseIntro = buildChineseRefIntro(input.refImageCount);
  const refSegment = hasRefs ? `\n\n${REF_LOGIC}` : '';
  const loopSegment = input.closedLoop ? CLOSED_LOOP_LOGIC : NON_LOOP_LOGIC;

  const englishBody = `${STRUCTURE_PREFIX}\n\n${TEMPLATE_LOGIC}${refSegment}\n\n${STYLE_LOGIC}\n\nUser intent: ${cleanedUser}\n\n${loopSegment}`;

  return `${chineseIntro}\n\n${englishBody}`;
}
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/server.js'),
  'utf8',
);

describe('backend GPT Image advanced params forwarding', () => {
  it('does not contain legacy GPT Image SKU gating or token suffix logic', () => {
    expect(serverSource).not.toContain('gpt-image-2-fast');
    expect(serverSource).not.toContain('gpt-image-2-plus');
    expect(serverSource).not.toContain('gpt-image-2-pro');
    expect(serverSource).not.toContain('TOKEN_SUFFIX');
    expect(serverSource).not.toContain('supportsGptImageAdvancedParams(');
  });

  it('forwards quality/background/output_format and conditional style in multipart edits', () => {
    expect(serverSource).toContain("formData.append('quality', advancedParams.quality)");
    expect(serverSource).toContain("formData.append('background', advancedParams.background)");
    expect(serverSource).toContain("formData.append('output_format', 'png')");
    expect(serverSource).toContain("formData.append('style', advancedParams.style)");
  });

  it('forwards quality/background/output_format and conditional style in JSON generations', () => {
    expect(serverSource).toContain('quality: advancedParams.quality');
    expect(serverSource).toContain('background: advancedParams.background');
    expect(serverSource).toContain("output_format: 'png'");
    expect(serverSource).toContain("advancedParams.style === 'vivid' || advancedParams.style === 'natural' ? { style: advancedParams.style } : {}");
  });

  it('routes OpenAI image endpoint by mode rather than legacy model names', () => {
    expect(serverSource).toContain("request.mode === 'image-to-image'");
    expect(serverSource).toContain('/v1/images/edits');
    expect(serverSource).toContain('/v1/images/generations');
  });

  it('resolves and forwards size for OpenAI image requests', () => {
    expect(serverSource).toContain('function resolveGptImageRequestSize(request)');
    expect(serverSource).toContain('const customSize = normalizeCustomImageSize(request.customSize, 4096)');
    expect(serverSource).toContain("if (request.outputSize === 'auto') return 'auto'");
    expect(serverSource).toContain('return getSupportedGptImageSize(request.model, request.outputSize, request.aspectRatio)');
    expect(serverSource).toContain('return requestGptImage(apiKey, request, resolveGptImageRequestSize(request), { baseUrl, signal: request.signal });');
  });

  it('explicitly forwards size=auto in both generation and edit requests', () => {
    expect(serverSource).toContain("formData.append('size', resolvedSize)");
    expect(serverSource).toContain('...(resolvedSize ? { size: resolvedSize } : {})');
  });

  it('scales oversized GPT Image 2 aspect ratios into the supported 4K pixel budget', () => {
    expect(serverSource).toContain('function fitGptImageResolutionToLimits(width, height, ratioWidth, ratioHeight)');
    expect(serverSource).toContain('Math.sqrt(CUSTOM_IMAGE_SIZE_LIMITS.maxPixels / (ratioWidth * ratioHeight))');
    expect(serverSource).toContain('return fitGptImageResolutionToLimits(width, height, ratioWidth, ratioHeight)');
  });

  it('forwards a normalized mask to OpenAI edits', () => {
    expect(serverSource).toContain("formData.append('mask', maskBlob, 'mask.png')");
    expect(serverSource).toContain('if (request.mask)');
  });

  it('uses semantic image roles and masks for Gemini and Grok', () => {
    expect(serverSource).toContain('function getSemanticMaskPrompt(prompt)');
    expect(serverSource).toContain('最后一张是黑白语义蒙版');
    expect(serverSource).toContain('function getGeminiMaskedEditParts(request, options = {})');
    expect(serverSource).toContain("role === 'angle-structure-reference'");
    expect(serverSource).toContain("role === 'angle-reference'");
    expect(serverSource).toContain('摄影机位与构图的最高优先级蓝图');
    expect(serverSource).toContain("console.log('[seat-cover-angle-request]'");
    expect(serverSource).toContain("createHash('sha256').update(img.data).digest('hex').slice(0, 16)");
    expect(serverSource).toContain("role === 'seat-product-reference'");
    expect(serverSource).toContain('输出必须仍是纯白底独立座椅产品图');
    expect(serverSource).toContain("role === 'vehicle-reference'");
    expect(serverSource).toContain('if (maskDataUrl) dataUrls.push(maskDataUrl)');
  });

  it('uses Gemini image response format and routes Gemini 3 image models through interactions', () => {
    expect(serverSource).toContain('function getGeminiImageConfig(request)');
    expect(serverSource).toContain('function getGeminiImageResponseFormat(request)');
    expect(serverSource).toContain('function getGeminiInteractionResponseFormat(request)');
    expect(serverSource).toContain('function getGeminiUpstreamModel(request)');
    expect(serverSource).toContain('return request.model');
    expect(serverSource).toContain('The configured model ID is authoritative');
    expect(serverSource).toContain('function requestApilioGeminiImage(apiKey, request, options = {})');
    expect(serverSource).toContain('function isApilioGeminiImageProxy(model, baseUrl)');
    expect(serverSource).toContain("host === 'api.apilio.ai'");
    expect(serverSource).toContain('/v1beta/models/${encodeURIComponent(request.model)}:generateContent');
    expect(serverSource).toContain("const parts = [...imageParts, ...(text ? [{ text }] : [])]");
    expect(serverSource).toContain('getGeminiMaskedEditParts(request, { includeImageRoleInstructions: false })');
    expect(serverSource).toContain("partOrder: text ? ['images', 'text'] : ['images']");
    expect(serverSource).toContain("console.log('[image-upstream-request]', requestDebug)");
    expect(serverSource).toContain('Some Gemini-compatible proxies return generated images as Markdown links');
    expect(serverSource).toContain('const markdownImageUrl = text.match');
    expect(serverSource).toContain("console.log('[image-upstream-response]'");
    expect(serverSource).toContain('function readJsonResponseWithoutWaitingForSocketClose(response, options = {})');
    expect(serverSource).toContain("console.log('[image-upstream-body]'");
    expect(serverSource).toContain("'Accept-Encoding': 'identity'");
    expect(serverSource).toContain("'Connection': 'close'");
    expect(serverSource).toContain('function requestGeminiInteractionImage(apiKey, request, options = {})');
    expect(serverSource).toContain("`${baseUrl}/v1beta/interactions`");
    expect(serverSource).toContain('response_format: getGeminiInteractionResponseFormat(request)');
    expect(serverSource).not.toContain("return 'gemini-3.1-flash-image'");
    expect(serverSource).not.toContain("return 'gemini-3-pro-image'");
    expect(serverSource).toContain("request.outputSize !== 'auto'");
    expect(serverSource).toContain("request.aspectRatio !== 'auto'");
    expect(serverSource).toContain('GEMINI_IMAGE_ASPECT_RATIOS.has(request.aspectRatio)');
    expect(serverSource).toContain("responseModalities: ['TEXT', 'IMAGE']");
    expect(serverSource).toContain("responseModalities: ['IMAGE']");
    expect(serverSource).toContain('...(imageConfig ? { imageConfig } : {})');
    expect(serverSource).toContain('responseFormat');
  });

  it('serves and saves editable seat-cover angle prompts', () => {
    expect(serverSource).toContain('JACKY_SEAT_COVER_PROMPT_DIR');
    expect(serverSource).toContain('function ensureSeatCoverPromptDirectory()');
    expect(serverSource).toContain('function loadSeatCoverAnglePrompts(directory = SEAT_COVER_PROMPT_DIR)');
    expect(serverSource).toContain('function saveSeatCoverAnglePrompt(name, content)');
    expect(serverSource).toContain('function extractSeatCoverAngleRule(template)');
    expect(serverSource).toContain('.full-template.bak');
    expect(serverSource).toContain("console.log('[seat-cover-prompt-compact]'");
    expect(serverSource).toContain("apiPathname === '/api/jacky/seat-cover-prompts'");
    expect(serverSource).toContain("req.method === 'POST'");
  });

  it('adds Google web and image search tools to Gemini generateContent requests', () => {
    expect(serverSource).toContain('function getGeminiSearchTools(request)');
    expect(serverSource).toContain('searchTypes.webSearch = {}');
    expect(serverSource).toContain('searchTypes.imageSearch = {}');
    expect(serverSource).toContain('return [{ googleSearch: { searchTypes } }]');
    expect(serverSource).toContain('...(tools ? { tools } : {})');
  });
});

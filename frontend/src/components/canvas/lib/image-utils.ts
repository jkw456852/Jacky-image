import type { ReferenceImage } from "../types-media";

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function getDataUrlByteSize(dataUrl: string) {
  const base64 = dataUrl.split(",", 2)[1];
  if (!base64) {
    return 0;
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

export function readImageMeta(dataUrl: string) {
  return new Promise<{ width: number; height: number; mimeType: string }>((resolve) => {
    const image = new Image();
    const done = () => resolve({ width: image.naturalWidth || 1024, height: image.naturalHeight || 1024, mimeType: dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" });
    image.onload = done;
    image.onerror = done;
    setTimeout(done, 3000);
    image.src = dataUrl;
  });
}

export function dataUrlToFile(image: ReferenceImage) {
  const [header, content] = image.dataUrl.split(",", 2);
  const mimeType = header.match(/data:(.*?);base64/)?.[1] || image.type || "image/png";
  const binary = atob(content || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], image.name || "reference.png", { type: mimeType });
}

// 参考图压缩参数：与图生图 upload-image-cache 保持一致，避免画布未压缩 PNG 把
// 请求体顶过后端 10MB 上限导致连接重置。
const REFERENCE_MAX_SIDE = 2560;
const REFERENCE_MAX_PIXELS = 5_000_000;
const REFERENCE_JPEG_QUALITY = 0.86;
const REFERENCE_WEBP_QUALITY = 0.9;
const REFERENCE_COMPRESS_THRESHOLD_BYTES = 1.5 * 1024 * 1024;

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解码失败"));
    image.src = src;
  });
}

/**
 * 提交生成任务前压缩参考图 dataURL：超过尺寸/像素上限则等比缩放，并重编码为 webp/jpeg。
 * 小图（≤1.5MB）、非 data: URL、压缩后更大或失败时原样返回。
 */
export async function compressReferenceDataUrl(dataUrl: string): Promise<{ dataUrl: string; mimeType: string }> {
  const originalMime = dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png";
  if (typeof document === "undefined" || !dataUrl.startsWith("data:")) {
    return { dataUrl, mimeType: originalMime };
  }
  if (getDataUrlByteSize(dataUrl) <= REFERENCE_COMPRESS_THRESHOLD_BYTES) {
    return { dataUrl, mimeType: originalMime };
  }
  try {
    const image = await loadImageElement(dataUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return { dataUrl, mimeType: originalMime };

    const sideScale = Math.min(1, REFERENCE_MAX_SIDE / Math.max(width, height));
    const pixelScale = Math.min(1, Math.sqrt(REFERENCE_MAX_PIXELS / (width * height)));
    const scale = Math.min(sideScale, pixelScale);
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    if (!context) return { dataUrl, mimeType: originalMime };
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const normalizedMime = originalMime.toLowerCase();
    const outputMime = normalizedMime === "image/png" || normalizedMime === "image/webp" ? "image/webp" : "image/jpeg";
    const quality = outputMime === "image/webp" ? REFERENCE_WEBP_QUALITY : REFERENCE_JPEG_QUALITY;
    const compressed = canvas.toDataURL(outputMime, quality);

    if (compressed.startsWith("data:") && getDataUrlByteSize(compressed) < getDataUrlByteSize(dataUrl)) {
      return { dataUrl: compressed, mimeType: compressed.match(/^data:([^;]+)/)?.[1] || outputMime };
    }
    return { dataUrl, mimeType: originalMime };
  } catch {
    return { dataUrl, mimeType: originalMime };
  }
}

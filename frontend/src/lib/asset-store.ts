'use client';

import {
  deleteDesktopBlob,
  readDesktopBlob,
  readDesktopDocument,
  writeDesktopBlob,
  writeDesktopDocument,
} from '@/lib/desktop-app-files';
import { getLegacyStorageName } from '@/lib/legacy-storage-names';

export type AssetSourceKind =
  | 'text-to-image'
  | 'image-to-image'
  | 'agent'
  | 'reverse-prompt'
  | 'gif'
  | 'upload'
  | 'random'
  | 'prompt-gallery'
  | 'manual';

export type AssetKind = 'image' | 'text';

export interface ImageAsset {
  id: string;
  kind?: 'image';
  blobKey: string;
  hash: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  tags: string[];
  note: string;
  sourceKind: AssetSourceKind;
  sourceLabel: string;
  sourceRef?: string;
  prompt?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface TextAsset {
  id: string;
  kind: 'text';
  hash: string;
  content: string;
  sizeBytes: number;
  sourceKind: AssetSourceKind;
  sourceLabel: string;
  sourceRef?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export type AssetItem = ImageAsset | TextAsset;

export interface AssetBlobRecord {
  key: string;
  hash: string;
  blob: Blob;
  thumbnailBlob?: Blob;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  createdAt: number;
}

export interface AddImageAssetInput {
  blob: Blob;
  name?: string;
  tags?: string[];
  note?: string;
  sourceKind: AssetSourceKind;
  sourceLabel?: string;
  sourceRef?: string;
  prompt?: string;
}

export interface UpdateImageAssetInput {
  name?: string;
  tags?: string[];
  note?: string;
}

export interface AddTextAssetInput {
  content: string;
  sourceKind: AssetSourceKind;
  sourceLabel?: string;
  sourceRef?: string;
}

interface AssetsDocument {
  assets: AssetItem[];
}

const DOCUMENT_NAME = 'assets';
const ORIGINAL_SCOPE = 'asset-originals';
const THUMBNAIL_SCOPE = 'asset-thumbnails';
const THUMB_MAX_SIDE = 512;
let writeQueue = Promise.resolve();

function now(): number {
  return Date.now();
}

function makeId(prefix = 'asset'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hashBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    return bufferToHex(await crypto.subtle.digest('SHA-256', buffer.slice(0)));
  }
  let hash = 0x811c9dc5;
  for (const byte of new Uint8Array(buffer)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv32-${blob.size}-${hash.toString(16).padStart(8, '0')}`;
}

async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.trim());
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    return `text-${bufferToHex(await crypto.subtle.digest('SHA-256', bytes.slice(0)))}`;
  }
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `text-fnv32-${bytes.length}-${hash.toString(16).padStart(8, '0')}`;
}

function isTextAsset(asset: AssetItem | null | undefined): asset is TextAsset {
  return asset?.kind === 'text';
}

function isImageAsset(asset: AssetItem | null | undefined): asset is ImageAsset {
  return Boolean(asset) && asset?.kind !== 'text';
}

export function getAssetFileExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('jpeg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('avif')) return 'avif';
  return 'png';
}

function sanitizeTags(tags?: string[]): string[] {
  return Array.from(new Set((tags || []).map(tag => tag.trim()).filter(Boolean)));
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function getImageDimensionsAndThumbnail(blob: Blob): Promise<{
  width?: number;
  height?: number;
  thumbnailBlob?: Blob;
}> {
  if (typeof document === 'undefined') return {};
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const next = new Image();
      next.onload = () => resolve(next);
      next.onerror = () => reject(new Error('图片读取失败'));
      next.src = url;
    });
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return {};
    const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return { width, height };
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      width,
      height,
      thumbnailBlob: await canvasToBlob(canvas, 'image/webp', 0.82) || undefined,
    };
  } catch {
    return {};
  } finally {
    URL.revokeObjectURL(url);
  }
}

function openLegacyDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const request = indexedDB.open(getLegacyStorageName('assets-db'), 1);
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
}

function getAllLegacy<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  if (!db.objectStoreNames.contains(storeName)) return Promise.resolve([]);
  return new Promise(resolve => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onsuccess = () => resolve((request.result as T[]) || []);
    request.onerror = () => resolve([]);
  });
}

async function migrateLegacyAssets(): Promise<AssetsDocument | null> {
  const db = await openLegacyDatabase();
  if (!db) return null;
  const [assets, blobs] = await Promise.all([
    getAllLegacy<AssetItem>(db, 'assets'),
    getAllLegacy<AssetBlobRecord>(db, 'asset-blobs'),
  ]);
  db.close();
  if (assets.length === 0 && blobs.length === 0) return null;
  for (const record of blobs) {
    if (record?.blob instanceof Blob) await writeDesktopBlob(ORIGINAL_SCOPE, record.key, record.blob);
    if (record?.thumbnailBlob instanceof Blob) {
      await writeDesktopBlob(THUMBNAIL_SCOPE, record.key, record.thumbnailBlob);
    }
  }
  const document = { assets };
  await writeDesktopDocument(DOCUMENT_NAME, document);
  return document;
}

async function loadDocument(): Promise<AssetsDocument> {
  const stored = await readDesktopDocument<AssetsDocument>(DOCUMENT_NAME);
  if (stored && Array.isArray(stored.assets)) return stored;
  return await migrateLegacyAssets() || { assets: [] };
}

function updateDocument(updater: (document: AssetsDocument) => AssetsDocument): Promise<void> {
  const operation = writeQueue.then(async () => {
    const document = await loadDocument();
    await writeDesktopDocument(DOCUMENT_NAME, updater(document));
  });
  writeQueue = operation.catch(() => undefined);
  return operation;
}

async function putAssetAndBlob(asset: AssetItem, blobRecord: AssetBlobRecord | null): Promise<void> {
  if (blobRecord) {
    await writeDesktopBlob(ORIGINAL_SCOPE, blobRecord.key, blobRecord.blob);
    if (blobRecord.thumbnailBlob) {
      await writeDesktopBlob(THUMBNAIL_SCOPE, blobRecord.key, blobRecord.thumbnailBlob);
    }
  }
  await updateDocument(document => ({
    assets: [...document.assets.filter(item => item.id !== asset.id), asset],
  }));
}

export async function addImageAsset(input: AddImageAssetInput): Promise<ImageAsset> {
  const sourceBlob = input.blob;
  const mimeType = sourceBlob.type || 'image/png';
  const hash = await hashBlob(sourceBlob);
  const createdAt = now();
  const document = await loadDocument();
  const sameSourceAsset = document.assets.filter(isImageAsset).find(asset =>
    asset.hash === hash
    && asset.sourceKind === input.sourceKind
    && Boolean(asset.sourceRef)
    && asset.sourceRef === input.sourceRef
  );
  if (sameSourceAsset) {
    const updated = {
      ...sameSourceAsset,
      lastUsedAt: createdAt,
      updatedAt: createdAt,
      tags: sanitizeTags([...sameSourceAsset.tags, ...(input.tags || [])]),
      note: input.note || sameSourceAsset.note,
    };
    await putAssetAndBlob(updated, null);
    return updated;
  }

  const existingBlob = await readDesktopBlob(ORIGINAL_SCOPE, hash);
  const dimensions = existingBlob ? {} : await getImageDimensionsAndThumbnail(sourceBlob);
  const asset: ImageAsset = {
    id: makeId(),
    kind: 'image',
    blobKey: hash,
    hash,
    name: input.name?.trim() || `素材-${new Date(createdAt).toLocaleString()}`,
    mimeType,
    sizeBytes: sourceBlob.size,
    width: dimensions.width,
    height: dimensions.height,
    tags: sanitizeTags(input.tags),
    note: input.note?.trim() || '',
    sourceKind: input.sourceKind,
    sourceLabel: input.sourceLabel || getSourceKindLabel(input.sourceKind),
    sourceRef: input.sourceRef,
    prompt: input.prompt,
    createdAt,
    updatedAt: createdAt,
    lastUsedAt: createdAt,
  };
  await putAssetAndBlob(asset, existingBlob ? null : {
    key: hash,
    hash,
    blob: sourceBlob,
    thumbnailBlob: dimensions.thumbnailBlob,
    mimeType,
    sizeBytes: sourceBlob.size,
    width: dimensions.width,
    height: dimensions.height,
    createdAt,
  });
  return asset;
}

export async function addTextAsset(input: AddTextAssetInput): Promise<TextAsset> {
  const content = input.content.trim();
  if (!content) throw new Error('提示词内容不能为空');
  const hash = await hashText(content);
  const createdAt = now();
  const existing = (await loadDocument()).assets.find(asset => isTextAsset(asset) && asset.hash === hash);
  if (existing && isTextAsset(existing)) {
    const updated = { ...existing, lastUsedAt: createdAt, updatedAt: createdAt };
    await putAssetAndBlob(updated, null);
    return updated;
  }
  const asset: TextAsset = {
    id: makeId('text-asset'),
    kind: 'text',
    hash,
    content,
    sizeBytes: new TextEncoder().encode(content).byteLength,
    sourceKind: input.sourceKind,
    sourceLabel: input.sourceLabel || getSourceKindLabel(input.sourceKind),
    sourceRef: input.sourceRef,
    createdAt,
    updatedAt: createdAt,
    lastUsedAt: createdAt,
  };
  await putAssetAndBlob(asset, null);
  return asset;
}

export async function findImageAssetByBlob(blob: Blob): Promise<ImageAsset | null> {
  const hash = await hashBlob(blob);
  return (await loadDocument()).assets.filter(isImageAsset).find(asset => asset.hash === hash) || null;
}

export async function listAssets(kind?: AssetKind): Promise<AssetItem[]> {
  return (await loadDocument()).assets
    .filter(asset => !kind || (kind === 'image' ? isImageAsset(asset) : isTextAsset(asset)))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function listImageAssets(): Promise<ImageAsset[]> {
  return (await listAssets('image')).filter(isImageAsset);
}

export async function listTextAssets(): Promise<TextAsset[]> {
  return (await listAssets('text')).filter(isTextAsset);
}

export async function getImageAsset(assetId: string): Promise<ImageAsset | null> {
  const asset = (await loadDocument()).assets.find(item => item.id === assetId);
  return isImageAsset(asset) ? asset : null;
}

export async function getTextAsset(assetId: string): Promise<TextAsset | null> {
  const asset = (await loadDocument()).assets.find(item => item.id === assetId);
  return isTextAsset(asset) ? asset : null;
}

export async function getAssetBlob(assetId: string): Promise<Blob | null> {
  const asset = await getImageAsset(assetId);
  return asset ? readDesktopBlob(ORIGINAL_SCOPE, asset.blobKey) : null;
}

export async function getAssetThumbnailBlob(asset: ImageAsset): Promise<Blob | null> {
  return await readDesktopBlob(THUMBNAIL_SCOPE, asset.blobKey)
    || readDesktopBlob(ORIGINAL_SCOPE, asset.blobKey);
}

export async function updateImageAsset(assetId: string, input: UpdateImageAssetInput): Promise<void> {
  const current = await getImageAsset(assetId);
  if (!current) throw new Error('素材不存在');
  await putAssetAndBlob({
    ...current,
    name: input.name?.trim() || current.name,
    tags: input.tags ? sanitizeTags(input.tags) : current.tags,
    note: typeof input.note === 'string' ? input.note : current.note,
    updatedAt: now(),
  }, null);
}

export async function touchImageAsset(assetId: string): Promise<void> {
  await touchAsset(assetId);
}

export async function touchAsset(assetId: string): Promise<void> {
  const asset = (await loadDocument()).assets.find(item => item.id === assetId);
  if (asset) await putAssetAndBlob({ ...asset, lastUsedAt: now(), updatedAt: now() }, null);
}

export async function deleteAsset(assetId: string): Promise<void> {
  const document = await loadDocument();
  const asset = document.assets.find(item => item.id === assetId);
  if (!asset) throw new Error('素材不存在');
  const shouldDeleteBlob = isImageAsset(asset)
    && !document.assets.some(item => item.id !== assetId && isImageAsset(item) && item.blobKey === asset.blobKey);
  await updateDocument(current => ({
    assets: current.assets.filter(item => item.id !== assetId),
  }));
  if (isImageAsset(asset) && shouldDeleteBlob) {
    await Promise.all([
      deleteDesktopBlob(ORIGINAL_SCOPE, asset.blobKey),
      deleteDesktopBlob(THUMBNAIL_SCOPE, asset.blobKey),
    ]);
  }
}

export async function deleteImageAsset(assetId: string): Promise<void> {
  await deleteAsset(assetId);
}

export function getSourceKindLabel(kind: AssetSourceKind): string {
  const labels: Record<AssetSourceKind, string> = {
    'text-to-image': '文生图',
    'image-to-image': '图生图',
    agent: 'Agent',
    'reverse-prompt': '反推提示词',
    gif: 'GIF 工作流',
    upload: '用户上传',
    random: '随机图片',
    'prompt-gallery': '提示词广场',
    manual: '手动导入',
  };
  return labels[kind] || '图片素材';
}

export function formatAssetSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return '未知大小';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`;
}

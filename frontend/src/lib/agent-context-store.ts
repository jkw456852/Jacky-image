'use client';

import { deleteStoredBlobs, getStoredBlob, storeImageBlob } from '@/lib/image-downloader';
import type { AgentImageRecord, AgentMessage, AgentProposal } from '@/lib/agent-chat-config';
import type { GptImageBackground, GptImageQuality, GptImageStyle } from '@/lib/model-capabilities';
import { readDesktopDocument, writeDesktopDocument } from '@/lib/desktop-app-files';
import { getCachedUploadBlob } from '@/lib/upload-image-cache';
import { getLegacyStorageName } from '@/lib/legacy-storage-names';

export interface AgentSessionSnapshot {
  messages: AgentMessage[];
  images: AgentImageRecord[];
  imageModel: string | null;
}

export interface PendingProposalData {
  proposal: AgentProposal;
  pendingAnalysis: string;
  pendingReasoning: string;
  isReedit: boolean;
}

export interface PendingGenerationData {
  taskId: string;
  proposal: AgentProposal;
  pendingAnalysis: string;
  pendingReasoning: string;
  selectedImageIds: string[];
  model: string;
  outputSize: string;
  customSize?: string;
  aspectRatio: string;
  temperature: number;
  gptImageQuality?: GptImageQuality;
  gptImageStyle?: GptImageStyle;
  gptImageBackground?: GptImageBackground;
  parallelCount: number;
  startedAt: number;
}

interface AgentDocument {
  messages: AgentMessage[];
  images: AgentImageRecord[];
  imageModel: string | null;
  pendingProposal: PendingProposalData | null;
  pendingGeneration: PendingGenerationData | null;
}

const DOCUMENT_NAME = 'agent-session';
const EMPTY_DOCUMENT: AgentDocument = {
  messages: [],
  images: [],
  imageModel: null,
  pendingProposal: null,
  pendingGeneration: null,
};

let writeQueue = Promise.resolve();

function openLegacyDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const request = indexedDB.open(getLegacyStorageName('agent-db'), 1);
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
}

function getAllLegacy<T>(db: IDBDatabase, store: string): Promise<T[]> {
  if (!db.objectStoreNames.contains(store)) return Promise.resolve([]);
  return new Promise(resolve => {
    const request = db.transaction(store, 'readonly').objectStore(store).getAll();
    request.onsuccess = () => resolve((request.result as T[]) || []);
    request.onerror = () => resolve([]);
  });
}

async function readLegacyDocument(): Promise<AgentDocument | null> {
  const db = await openLegacyDatabase();
  if (!db) return null;
  const [messages, images, meta] = await Promise.all([
    getAllLegacy<AgentMessage>(db, 'messages'),
    getAllLegacy<AgentImageRecord>(db, 'images'),
    getAllLegacy<{ key: string; value: string }>(db, 'meta'),
  ]);
  db.close();
  if (messages.length === 0 && images.length === 0 && meta.length === 0) return null;
  const readMetaJson = <T,>(key: string): T | null => {
    const raw = meta.find(item => item.key === key)?.value;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };
  return {
    messages,
    images,
    imageModel: meta.find(item => item.key === 'imageModel')?.value || null,
    pendingProposal: readMetaJson<PendingProposalData>('pendingProposal'),
    pendingGeneration: readMetaJson<PendingGenerationData>('pendingGeneration'),
  };
}

async function loadDocument(): Promise<AgentDocument> {
  const stored = await readDesktopDocument<AgentDocument>(DOCUMENT_NAME);
  if (stored) {
    return {
      ...EMPTY_DOCUMENT,
      ...stored,
      messages: Array.isArray(stored.messages) ? stored.messages : [],
      images: Array.isArray(stored.images) ? stored.images : [],
    };
  }
  const legacy = await readLegacyDocument();
  if (legacy) {
    await writeDesktopDocument(DOCUMENT_NAME, legacy);
    return legacy;
  }
  return { ...EMPTY_DOCUMENT };
}

function updateDocument(updater: (document: AgentDocument) => AgentDocument): Promise<void> {
  const operation = writeQueue.then(async () => {
    const document = await loadDocument();
    await writeDesktopDocument(DOCUMENT_NAME, updater(document));
  });
  writeQueue = operation.catch(() => undefined);
  return operation;
}

export async function loadAgentSession(): Promise<AgentSessionSnapshot> {
  const document = await loadDocument();
  return {
    messages: [...document.messages].sort((a, b) => a.createdAt - b.createdAt),
    images: [...document.images].sort((a, b) => a.createdAt - b.createdAt),
    imageModel: document.imageModel,
  };
}

export async function putMessage(message: AgentMessage): Promise<void> {
  await updateDocument(document => ({
    ...document,
    messages: [...document.messages.filter(item => item.id !== message.id), message],
  }));
}

export async function putImageRecord(record: AgentImageRecord): Promise<void> {
  await updateDocument(document => ({
    ...document,
    images: [...document.images.filter(item => item.imgId !== record.imgId), record],
  }));
}

export async function saveImageModel(model: string): Promise<void> {
  await updateDocument(document => ({ ...document, imageModel: model }));
}

export async function deleteMessages(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const selected = new Set(ids);
  await updateDocument(document => ({
    ...document,
    messages: document.messages.filter(item => !selected.has(item.id)),
  }));
}

export async function deleteImageRecords(imgIds: string[]): Promise<void> {
  if (imgIds.length === 0) return;
  const selected = new Set(imgIds);
  await updateDocument(document => ({
    ...document,
    images: document.images.filter(item => !selected.has(item.imgId)),
  }));
}

export async function deleteAgentImageBytes(imgId: string): Promise<void> {
  await deleteStoredBlobs(imgId, 1);
}

export async function clearAgentSession(): Promise<void> {
  await writeQueue;
  await writeDesktopDocument(DOCUMENT_NAME, { ...EMPTY_DOCUMENT });
}

export async function savePendingProposal(data: PendingProposalData): Promise<void> {
  await updateDocument(document => ({ ...document, pendingProposal: data }));
}

export async function loadPendingProposal(): Promise<PendingProposalData | null> {
  return (await loadDocument()).pendingProposal;
}

export async function clearPendingProposal(): Promise<void> {
  await updateDocument(document => ({ ...document, pendingProposal: null }));
}

export async function savePendingGeneration(data: PendingGenerationData): Promise<void> {
  await updateDocument(document => ({ ...document, pendingGeneration: data }));
}

export async function loadPendingGeneration(): Promise<PendingGenerationData | null> {
  return (await loadDocument()).pendingGeneration;
}

export async function clearPendingGeneration(): Promise<void> {
  await updateDocument(document => ({ ...document, pendingGeneration: null }));
}

export async function storeAgentImageBytes(imgId: string, blob: Blob): Promise<void> {
  await storeImageBlob(imgId, 0, blob);
}

export async function getAgentImageRecord(imgId: string): Promise<AgentImageRecord | null> {
  return (await loadDocument()).images.find(item => item.imgId === imgId) || null;
}

export async function getAgentImageBytes(imgId: string): Promise<Blob | null> {
  const record = await getAgentImageRecord(imgId);
  if (record?.contentHash) {
    const cached = await getCachedUploadBlob(record.contentHash);
    if (cached) return cached;
  }
  return getStoredBlob(imgId, 0);
}

export async function getAgentImageBase64(imgId: string): Promise<{ data: string; mimeType: string } | null> {
  const blob = await getAgentImageBytes(imgId);
  if (!blob) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  return { data: base64, mimeType: blob.type || 'image/png' };
}

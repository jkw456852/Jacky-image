'use client';

import {
  readDesktopDocument,
  writeDesktopDocument,
} from '@/lib/desktop-app-files';
import { getLegacyStorageName } from '@/lib/legacy-storage-names';

export interface StoredReverseResult {
  slot: 'current' | 'previous';
  text: string;
  model: string;
  mode: string;
  aborted?: boolean;
  timestamp: number;
}

export interface StoredReverseDraft {
  slot: 'draft';
  file: {
    id: string;
    name: string;
    preview: string;
    dataUrl: string;
    mimeType: string;
    badge?: string;
  } | null;
  timestamp: number;
}

interface ReversePromptDocument {
  current: StoredReverseResult | null;
  previous: StoredReverseResult | null;
  draft: StoredReverseDraft | null;
}

const DOCUMENT_NAME = 'reverse-prompt';
const EMPTY_DOCUMENT: ReversePromptDocument = {
  current: null,
  previous: null,
  draft: null,
};

let writeQueue = Promise.resolve();

function openLegacyDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const request = indexedDB.open(getLegacyStorageName('reverse-db'), 1);
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
}

async function readLegacyDocument(): Promise<ReversePromptDocument | null> {
  const db = await openLegacyDatabase();
  if (!db || !db.objectStoreNames.contains('reverse-results')) {
    db?.close();
    return null;
  }
  return new Promise(resolve => {
    const tx = db.transaction('reverse-results', 'readonly');
    const request = tx.objectStore('reverse-results').getAll();
    request.onsuccess = () => {
      const records = Array.isArray(request.result) ? request.result : [];
      const current = records.find(item => item?.slot === 'current') as StoredReverseResult | undefined;
      const previous = records.find(item => item?.slot === 'previous') as StoredReverseResult | undefined;
      const draft = records.find(item => item?.slot === 'draft') as StoredReverseDraft | undefined;
      resolve({
        current: current || null,
        previous: previous || null,
        draft: draft || null,
      });
    };
    request.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
  });
}

async function loadDocument(): Promise<ReversePromptDocument> {
  const stored = await readDesktopDocument<ReversePromptDocument>(DOCUMENT_NAME);
  if (stored) return { ...EMPTY_DOCUMENT, ...stored };

  const legacy = await readLegacyDocument();
  if (legacy) {
    await writeDesktopDocument(DOCUMENT_NAME, legacy);
    return legacy;
  }
  return { ...EMPTY_DOCUMENT };
}

function updateDocument(
  updater: (document: ReversePromptDocument) => ReversePromptDocument,
): Promise<void> {
  const operation = writeQueue.then(async () => {
    const document = await loadDocument();
    await writeDesktopDocument(DOCUMENT_NAME, updater(document));
  });
  writeQueue = operation.catch(() => undefined);
  return operation;
}

export async function loadReverseResults(): Promise<ReversePromptDocument> {
  return loadDocument();
}

export async function saveReverseResult(result: StoredReverseResult): Promise<void> {
  await updateDocument(document => ({ ...document, [result.slot]: result }));
}

export async function clearReverseResult(slot: 'current' | 'previous'): Promise<void> {
  await updateDocument(document => ({ ...document, [slot]: null }));
}

export async function saveReverseDraft(file: StoredReverseDraft['file']): Promise<void> {
  await updateDocument(document => ({
    ...document,
    draft: { slot: 'draft', file, timestamp: Date.now() },
  }));
}

export async function clearReverseDraft(): Promise<void> {
  await updateDocument(document => ({ ...document, draft: null }));
}

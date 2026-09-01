'use client';

const memoryDocuments = new Map<string, unknown>();
const memoryBlobs = new Map<string, Blob>();

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value)) as T;
}

function blobMapKey(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}

export async function readDesktopDocument<T>(namespace: string): Promise<T | null> {
  const bridge = typeof window !== 'undefined' ? window.jackyDesktop?.appData : null;
  if (!bridge) return clone((memoryDocuments.get(namespace) as T | undefined) ?? null);
  const result = await bridge.read(namespace);
  if (!result?.ok) throw new Error(result?.error || 'Could not read desktop data file');
  return clone((result.value as T | null | undefined) ?? null);
}

export async function writeDesktopDocument<T>(namespace: string, value: T): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.jackyDesktop?.appData : null;
  if (!bridge) {
    memoryDocuments.set(namespace, clone(value));
    return;
  }
  const result = await bridge.write(namespace, value);
  if (!result?.ok) throw new Error(result?.error || 'Could not write desktop data file');
}

export async function deleteDesktopDocument(namespace: string): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.jackyDesktop?.appData : null;
  if (!bridge) {
    memoryDocuments.delete(namespace);
    return;
  }
  const result = await bridge.delete(namespace);
  if (!result?.ok) throw new Error(result?.error || 'Could not delete desktop data file');
}

export async function writeDesktopBlob(scope: string, key: string, blob: Blob): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.jackyDesktop?.appCache : null;
  if (!bridge) {
    memoryBlobs.set(blobMapKey(scope, key), blob);
    return;
  }
  const result = await bridge.write(scope, key, blob.type || 'application/octet-stream', await blob.arrayBuffer());
  if (!result?.ok) throw new Error(result?.error || 'Could not write desktop cache file');
}

export async function readDesktopBlob(scope: string, key: string): Promise<Blob | null> {
  const bridge = typeof window !== 'undefined' ? window.jackyDesktop?.appCache : null;
  if (!bridge) return memoryBlobs.get(blobMapKey(scope, key)) || null;
  const result = await bridge.read(scope, key);
  if (!result?.ok) throw new Error(result?.error || 'Could not read desktop cache file');
  if (result.missing || !result.bytes) return null;
  return new Blob([new Uint8Array(result.bytes)], {
    type: result.mimeType || 'application/octet-stream',
  });
}

export async function deleteDesktopBlob(scope: string, key: string): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.jackyDesktop?.appCache : null;
  if (!bridge) {
    memoryBlobs.delete(blobMapKey(scope, key));
    return;
  }
  const result = await bridge.delete(scope, key);
  if (!result?.ok) throw new Error(result?.error || 'Could not delete desktop cache file');
}

export async function listDesktopBlobKeys(scope: string): Promise<string[]> {
  const bridge = typeof window !== 'undefined' ? window.jackyDesktop?.appCache : null;
  if (!bridge) {
    const prefix = `${scope}\u0000`;
    return Array.from(memoryBlobs.keys())
      .filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length));
  }
  const result = await bridge.list(scope);
  if (!result?.ok) throw new Error(result?.error || 'Could not list desktop cache files');
  return Array.isArray(result.keys) ? result.keys : [];
}

'use client';

export interface LocalDownloadResult {
  filePath?: string;
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Response(blob).arrayBuffer();
}

export async function saveBlobToDownloads(blob: Blob, fileName: string): Promise<LocalDownloadResult> {
  const desktopDownloads = typeof window !== 'undefined' ? window.jackyDesktop?.downloads : undefined;
  if (!desktopDownloads) {
    throw new Error('Jacky Image 仅支持桌面版文件下载');
  }
  const result = await desktopDownloads.save(fileName, await blobToArrayBuffer(blob));
  if (!result?.ok) throw new Error(result?.error || '文件写入下载目录失败');
  return { filePath: result.filePath };
}

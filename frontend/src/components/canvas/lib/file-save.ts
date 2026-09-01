/** 替代 file-saver 的 saveAs：浏览器端触发下载，纯前端。 */
import { saveBlobToDownloads } from '@/lib/local-download';

export async function saveAs(blob: Blob, filename: string): Promise<void> {
  if (typeof window === 'undefined') return;
  await saveBlobToDownloads(blob, filename);
}

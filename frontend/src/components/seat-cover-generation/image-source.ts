import { getStoredBlob, parseStoredBlobRef } from '@/lib/image-downloader';
import { dataUrlToBlob } from '@/lib/upload-image-cache';

export async function resolveSeatCoverImageBlob(imageRef: string, imageUrl?: string): Promise<Blob> {
  const inlineSource = imageRef.startsWith('data:')
    ? imageRef
    : imageUrl?.startsWith('data:')
      ? imageUrl
      : null;
  if (inlineSource) return dataUrlToBlob(inlineSource);

  const storedRef = parseStoredBlobRef(imageRef);
  if (storedRef) {
    const blob = await getStoredBlob(storedRef.jobId, storedRef.imageIndex);
    if (blob) return blob;
  }

  const remoteSource = imageRef.startsWith('URL:')
    ? imageRef.substring(4)
    : imageUrl;
  if (remoteSource && /^(?:blob:|https?:|\/)/i.test(remoteSource)) {
    const response = await fetch(remoteSource);
    if (response.ok) return response.blob();
  }
  throw new Error('底图读取失败，请重新选择或上传底图');
}

// 历史图片库沿用原物理库名，确保品牌升级后用户图片无需复制即可继续读取。
// 此前 job-store 与 image-downloader 各自在每次读写时都 indexedDB.open()+close()
// （一个任务 N 张图就开关 N 次），且部分打开点缺少 onupgradeneeded，在全新库上
// 先执行会建出「没有对象存储」的库，导致后续 transaction 抛 "object store not found"。
// 这里统一为单例缓存连接 + 统一升级逻辑，消除两个问题。

import { getLegacyStorageName } from '@/lib/legacy-storage-names';

export const DB_NAME = getLegacyStorageName('image-db');
export const DB_VERSION = 2;
export const IMG_STORE = 'images';
export const BLOBS_STORE = 'blobs';

let dbPromise: Promise<IDBDatabase | null> | null = null;

export function openImageDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => { dbPromise = null; resolve(null); };
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IMG_STORE)) {
        db.createObjectStore(IMG_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        db.createObjectStore(BLOBS_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 另一个 tab 触发升级时主动关闭并失效缓存，下次调用会重新打开。
      db.onversionchange = () => { try { db.close(); } catch { /* ignore */ } dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
  });
  return dbPromise;
}

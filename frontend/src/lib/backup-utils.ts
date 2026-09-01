'use client';

import { zipSync, unzipSync, strToU8 } from 'fflate';
import localforage from 'localforage';
import { saveRegistry, type JackyModelRegistry } from '@/lib/jacky-models';
import { saveBlobToDownloads } from '@/lib/local-download';
import { getStoredBlob, storeImageBlob } from '@/lib/image-downloader';
import type { StoredJob } from '@/lib/job-store';
import {
    getAllDesktopPreferences,
    removeDesktopPreference,
    setDesktopPreference,
} from '@/lib/desktop-preferences';
import {
    deleteDesktopBlob,
    listDesktopBlobKeys,
    readDesktopBlob,
    readDesktopDocument,
    writeDesktopBlob,
    writeDesktopDocument,
} from '@/lib/desktop-app-files';
import { getLegacyStorageName } from '@/lib/legacy-storage-names';

export interface BackupProgress {
    percent: number;
    message: string;
}

export type ProgressCallback = (progress: BackupProgress) => void;

type BackupRecord = Record<string, unknown>;
type DatabaseBackup = Record<string, BackupRecord[]>;
type IndexedDBBackup = Record<string, DatabaseBackup>;
type BlobRef = { _blobRef: string; _blobMimeType: string };

function isBackupRecord(value: unknown): value is BackupRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlobRef(value: unknown): value is BlobRef {
    return isBackupRecord(value)
        && typeof value['_blobRef'] === 'string'
        && typeof value['_blobMimeType'] === 'string';
}

// localStorage keys to backup
const LOCAL_STORAGE_KEYS = [
    'jacky-model-registry',
    'jacky-jobs',
    'jacky-t2i-settings',
    'jacky-i2i-settings',
    'jacky-reverse-prompt-settings',
    'theme',
    'jacky-wide-mode',
    // Agent 模式
    'jacky-agent-params',
    'jacky-agent-web-search',
    'jacky-agent-intent-recognition',
    // 动图生成
    'jacky-gif-settings',
    'jacky-gif-active-job',
    // 我的素材
    'jacky-assets-settings',
    // 无限画布生成配置
    'jacky-image:canvas_config',
];

// IndexedDB databases to backup
const INDEXEDDB_DATABASES = [
    { name: getLegacyStorageName('image-db'), version: 2, stores: ['images', 'blobs'] },
    { name: getLegacyStorageName('reverse-db'), version: 1, stores: ['reverse-results'] },
    { name: getLegacyStorageName('upload-cache'), version: 1, stores: ['images'] },
    // Agent 模式对话、图片登记、元信息
    { name: getLegacyStorageName('agent-db'), version: 1, stores: ['messages', 'images', 'meta'] },
    // 本地图片素材库
    { name: getLegacyStorageName('assets-db'), version: 1, stores: ['assets', 'asset-blobs'] },
];

// localforage keyless 实例（无限画布：项目状态 + 图片 blob）。
// 通用 IndexedDB 逻辑面向 keyPath store，无法 round-trip localforage 的无 keyPath store，故单独处理。
const LOCALFORAGE_STORES: { name: string; storeName: string }[] = [
    { name: getLegacyStorageName('image'), storeName: 'canvas_app_state' },
    { name: getLegacyStorageName('image'), storeName: 'canvas_image_files' },
];

const DESKTOP_DOCUMENTS = [
    'agent-session',
    'reverse-prompt',
    'assets',
    'upload-image-cache',
] as const;

const DESKTOP_CACHE_SCOPES = [
    'upload-images',
    'asset-originals',
    'asset-thumbnails',
    'canvas-images',
] as const;

interface DesktopCacheManifestEntry {
    scope: string;
    key: string;
    path: string;
    mimeType: string;
}

type LocalForageEntry = { key: string; value: unknown } | { key: string; _blobRef: string; _blobMimeType: string };
type LocalForageBackup = Record<string, Record<string, LocalForageEntry[]>>;

/** Blob → Uint8Array（fflate 需要 Uint8Array） */
async function blobToUint8(blob: Blob): Promise<Uint8Array> {
    const ab = await blob.arrayBuffer();
    return new Uint8Array(ab);
}

// 用于生成导出时 Blob 的唯一引用 ID
let _blobRefSeq = 0;
function nextBlobRef(): string {
    return `b${Date.now()}_${++_blobRefSeq}`;
}

/**
 * 将 JSON 数据转为 fflate 可用的 Uint8Array
 */
function jsonToU8(data: unknown): Uint8Array {
    return strToU8(JSON.stringify(data));
}

/**
 * 导出 localforage（keyless）store：保留 key；Blob 值以二进制存入 ZIP blobs/，JSON 内留引用。
 * 数据逐 store 写入 files 对象，释放引用后可被 GC 回收。
 */
async function exportLocalForage(files: Record<string, Uint8Array>): Promise<LocalForageBackup> {
    const result: LocalForageBackup = {};
    for (const cfg of LOCALFORAGE_STORES) {
        try {
            const instance = localforage.createInstance({ name: cfg.name, storeName: cfg.storeName });
            const entries: LocalForageEntry[] = [];
            await instance.iterate((value: unknown, key: string) => {
                if (value instanceof Blob) {
                    const ref = nextBlobRef();
                    blobToUint8(value).then(u8 => { files[`blobs/${ref}`] = u8; });
                    entries.push({ key, _blobRef: ref, _blobMimeType: value.type });
                } else {
                    entries.push({ key, value });
                }
            });
            if (!result[cfg.name]) result[cfg.name] = {};
            result[cfg.name][cfg.storeName] = entries;
        } catch {
            // skip failed localforage export
        }
    }
    return result;
}

/**
 * 导入 localforage（keyless）store：先清空，再按 key 写回；Blob 从 ZIP 还原。
 */
async function importLocalForage(data: LocalForageBackup, unzipped: Record<string, Uint8Array>): Promise<void> {
    for (const cfg of LOCALFORAGE_STORES) {
        const entries = data[cfg.name]?.[cfg.storeName];
        if (!Array.isArray(entries)) continue;
        try {
            const instance = localforage.createInstance({ name: cfg.name, storeName: cfg.storeName });
            await instance.clear();
            for (const entry of entries) {
                let value: unknown;
                if ('_blobRef' in entry && typeof entry._blobRef === 'string') {
                    const blobData = unzipped[`blobs/${entry._blobRef}`];
                    if (!blobData) continue;
                    value = new Blob([blobData as unknown as BlobPart], { type: entry._blobMimeType });
                } else {
                    value = (entry as { value: unknown }).value;
                }
                await instance.setItem(entry.key, value);
            }
        } catch {
            // skip failed localforage import
        }
    }
}

/**
 * 导出 localStorage 数据
 */
function exportLocalStorage(): Record<string, string> {
    const data: Record<string, string> = {};
    const preferences = getAllDesktopPreferences();

    for (const key of LOCAL_STORAGE_KEYS) {
        if (key === 'jacky-model-registry' && window.jackyDesktop?.modelRegistry) {
            continue;
        }
        try {
            const value = preferences[key] ?? null;
            if (value !== null) {
                data[key] = value;
            }
        } catch {
            // skip failed localStorage export
        }
    }

    const desktopJobs = window.jackyDesktop?.records.loadJobs();
    if (Array.isArray(desktopJobs)) {
        data['jacky-jobs'] = JSON.stringify(desktopJobs);
    }

    return data;
}

function imageExtension(mimeType: string): string {
    if (mimeType.includes('jpeg')) return 'jpg';
    if (mimeType.includes('webp')) return 'webp';
    if (mimeType.includes('gif')) return 'gif';
    if (mimeType.includes('avif')) return 'avif';
    return 'png';
}

function imageMimeType(extension: string): string {
    if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
    if (extension === 'webp') return 'image/webp';
    if (extension === 'gif') return 'image/gif';
    if (extension === 'avif') return 'image/avif';
    return 'image/png';
}

async function exportDesktopImageCache(files: Record<string, Uint8Array>, jobs: StoredJob[]): Promise<void> {
    if (!window.jackyDesktop?.imageCache) return;
    for (const job of jobs) {
        const images = job.images || (job.imageData ? [job.imageData] : []);
        for (let index = 0; index < images.length; index += 1) {
            const blob = await getStoredBlob(job.id, index);
            if (!blob) continue;
            const bytes = new Uint8Array(await new Response(blob).arrayBuffer());
            files[`desktop-image-cache/${encodeURIComponent(job.id)}/${index}.${imageExtension(blob.type)}`] = bytes;
        }
    }
}

async function exportDesktopAppFiles(files: Record<string, Uint8Array>): Promise<void> {
    for (const namespace of DESKTOP_DOCUMENTS) {
        const value = await readDesktopDocument(namespace);
        if (value !== null) files[`desktop-app-data/${namespace}.json`] = jsonToU8(value);
    }

    const manifest: DesktopCacheManifestEntry[] = [];
    let sequence = 0;
    for (const scope of DESKTOP_CACHE_SCOPES) {
        for (const key of await listDesktopBlobKeys(scope)) {
            const blob = await readDesktopBlob(scope, key);
            if (!blob) continue;
            const backupPath = `desktop-app-cache/blob-${sequence++}`;
            files[backupPath] = new Uint8Array(await blob.arrayBuffer());
            manifest.push({
                scope,
                key,
                path: backupPath,
                mimeType: blob.type || 'application/octet-stream',
            });
        }
    }
    files['desktop-app-cache/manifest.json'] = jsonToU8(manifest);
}

async function importDesktopAppFiles(unzipped: Record<string, Uint8Array>): Promise<void> {
    for (const namespace of DESKTOP_DOCUMENTS) {
        const data = unzipped[`desktop-app-data/${namespace}.json`];
        if (!data) continue;
        await writeDesktopDocument(namespace, JSON.parse(new TextDecoder().decode(data)));
    }

    const manifestData = unzipped['desktop-app-cache/manifest.json'];
    if (!manifestData) return;
    const manifest = JSON.parse(new TextDecoder().decode(manifestData)) as DesktopCacheManifestEntry[];
    if (!Array.isArray(manifest)) return;
    for (const scope of DESKTOP_CACHE_SCOPES) {
        await Promise.all((await listDesktopBlobKeys(scope)).map(key => deleteDesktopBlob(scope, key)));
    }
    for (const entry of manifest) {
        if (!entry || !DESKTOP_CACHE_SCOPES.includes(entry.scope as typeof DESKTOP_CACHE_SCOPES[number])) continue;
        const bytes = unzipped[entry.path];
        if (!bytes || typeof entry.key !== 'string') continue;
        await writeDesktopBlob(entry.scope, entry.key, new Blob([bytes as unknown as BlobPart], {
            type: entry.mimeType || 'application/octet-stream',
        }));
    }
}

/**
 * 打开 IndexedDB 数据库
 */
function openDatabase(name: string, version: number, createStores: boolean = false): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') {
            resolve(null);
            return;
        }

        const request = indexedDB.open(name, version);

        request.onerror = () => resolve(null);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (e) => {
            const db = (e.target as IDBOpenDBRequest).result;
            const oldVersion = e.oldVersion || 0;
            if (!createStores && oldVersion > 0) return;

            // 根据数据库名称创建相应的 stores
            if (name === 'jacky-image-db') {
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('blobs')) {
                    db.createObjectStore('blobs', { keyPath: 'key' });
                }
            } else if (name === 'jacky-reverse-db') {
                if (!db.objectStoreNames.contains('reverse-results')) {
                    db.createObjectStore('reverse-results', { keyPath: 'slot' });
                }
            } else if (name === 'jacky-upload-cache') {
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'key' });
                }
            } else if (name === 'jacky-agent-db') {
                if (!db.objectStoreNames.contains('messages')) {
                    db.createObjectStore('messages', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'imgId' });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }
            } else if (name === 'jacky-assets-db') {
                if (!db.objectStoreNames.contains('assets')) {
                    const store = db.createObjectStore('assets', { keyPath: 'id' });
                    store.createIndex('hash', 'hash', { unique: false });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }
                if (!db.objectStoreNames.contains('asset-blobs')) {
                    db.createObjectStore('asset-blobs', { keyPath: 'key' });
                }
            }
        };
    });
}

/**
 * 导出单个 IndexedDB store 的所有数据
 * Blob 字段转为 Uint8Array 存入 files，JSON 中只保留引用
 */
async function exportStore(db: IDBDatabase, storeName: string, files: Record<string, Uint8Array>): Promise<BackupRecord[]> {
    return new Promise((resolve, reject) => {
        try {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();

            request.onsuccess = async () => {
                const records = request.result;

                const processedRecords = await Promise.all(
                    records.map(async (record) => {
                        const processed = { ...record };

                        // 遍历所有字段，将 Blob 类型以二进制存入 files
                        for (const key of Object.keys(processed)) {
                            const val = processed[key];
                            if (val instanceof Blob) {
                                const ref = nextBlobRef();
                                files[`blobs/${ref}`] = await blobToUint8(val);
                                processed[key] = { _blobRef: ref, _blobMimeType: val.type };
                            }
                        }

                        return processed;
                    })
                );

                resolve(processedRecords);
            };

            request.onerror = () => reject(request.error);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * 导出所有 IndexedDB 数据
 * 逐数据库、逐 store 顺序处理，处理完立即写入 files，降低内存峰值
 */
async function exportIndexedDB(files: Record<string, Uint8Array>, onProgress?: ProgressCallback): Promise<IndexedDBBackup> {
    const allData: IndexedDBBackup = {};
    let completedStores = 0;
    const totalStores = INDEXEDDB_DATABASES.reduce((sum, db) => sum + db.stores.length, 0);

    for (const dbConfig of INDEXEDDB_DATABASES) {
        const db = await openDatabase(dbConfig.name, dbConfig.version);

        if (!db) {
            continue;
        }

        const dbData: DatabaseBackup = {};

        for (const storeName of dbConfig.stores) {
            try {
                if (!db.objectStoreNames.contains(storeName)) {
                    continue;
                }

                const storeData = await exportStore(db, storeName, files);
                dbData[storeName] = storeData;

                completedStores++;
                if (onProgress) {
                    const percent = 10 + Math.floor((completedStores / totalStores) * 80);
                    onProgress({
                        percent,
                        message: `正在导出 ${dbConfig.name}/${storeName}...`,
                    });
                }
            } catch {
                // store export failed, continue with next
            }
        }

        db.close();
        allData[dbConfig.name] = dbData;
    }

    return allData;
}

/**
 * 导出所有数据为 ZIP 文件
 * 使用 fflate 替代 JSZip，显著降低内存占用和处理时间
 */
export async function exportAllData(onProgress?: ProgressCallback): Promise<Blob> {
    if (onProgress) {
        onProgress({ percent: 0, message: '开始导出数据...' });
    }

    // 导出 localStorage
    if (onProgress) {
        onProgress({ percent: 5, message: '正在导出 localStorage...' });
    }
    const localStorageData = exportLocalStorage();

    // 逐 store 导出 IndexedDB，Blob 数据直接转为 Uint8Array 存入 files
    const files: Record<string, Uint8Array> = {};
    const desktopJobs = window.jackyDesktop?.records.loadJobs();
    if (Array.isArray(desktopJobs)) {
        await exportDesktopImageCache(files, desktopJobs as StoredJob[]);
    }
    await exportDesktopAppFiles(files);
    const indexedDBData = await exportIndexedDB(files, onProgress);

    // 导出 localforage 数据
    const localForageData = await exportLocalForage(files);

    // 打包元数据和 localStorage JSON
    if (onProgress) {
        onProgress({ percent: 90, message: '正在打包数据...' });
    }

    // 添加元数据
    files['metadata.json'] = jsonToU8({
        version: process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0',
        exportDate: new Date().toISOString(),
        appName: 'Jacky Image',
    });

    // 添加 localStorage 数据
    files['localStorage.json'] = jsonToU8(localStorageData);

    // 添加 IndexedDB 数据
    for (const [dbName, dbData] of Object.entries(indexedDBData)) {
        files[`indexedDB/${dbName}.json`] = jsonToU8(dbData);
    }

    // 添加 localforage（无限画布）数据
    for (const [dbName, dbData] of Object.entries(localForageData)) {
        files[`localforage/${dbName}.json`] = jsonToU8(dbData);
    }

    if (onProgress) {
        onProgress({ percent: 95, message: '正在生成 ZIP 文件...' });
    }

    // 使用 fflate 同步压缩（比 JSZip 快 10-20 倍，内存占用更低）
    const zipped = zipSync(files, { level: 6 });
    const blob = new Blob([zipped], { type: 'application/zip' });

    if (onProgress) {
        onProgress({ percent: 100, message: '导出完成！' });
    }

    return blob;
}

/**
 * 从 base64 字符串创建 Blob
 */
function base64ToBlob(base64: string, mimeType: string): Blob {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);

    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }

    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
}

/**
 * 导入 localStorage 数据（带校验）
 */
function importLocalStorage(data: unknown): void {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;

    const allowedKeySet = new Set(LOCAL_STORAGE_KEYS);
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        if (!allowedKeySet.has(key)) continue;
        if (typeof value !== 'string') continue;

        if (key === 'jacky-jobs' && window.jackyDesktop?.records) {
            let jobs: unknown;
            try {
                jobs = JSON.parse(value);
            } catch {
                continue;
            }
            if (!Array.isArray(jobs)) continue;
            const result = window.jackyDesktop.records.saveJobs(jobs);
            if (!result?.ok) throw new Error(result?.error || '使用记录恢复到本地文件失败');
            continue;
        }

        if (key === 'jacky-model-registry') {
            let parsedRegistry: JackyModelRegistry;
            try {
                const parsed = JSON.parse(value);
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    continue;
                }
                const record = parsed as Record<string, unknown>;
                const hasImageModels = Array.isArray(record.imageModels);
                const hasTextModels = Array.isArray(record.textModels);
                const hasDefaults = typeof record.defaults === 'object' && record.defaults !== null;
                if (!hasImageModels || !hasTextModels || !hasDefaults) {
                    continue;
                }
                parsedRegistry = parsed as JackyModelRegistry;
            } catch {
                continue;
            }
            saveRegistry(parsedRegistry);
            continue;
        }

        try {
            setDesktopPreference(key, value);
        } catch {
            // skip failed localStorage import
        }
    }
}

/**
 * 删除 IndexedDB 数据库
 */
async function deleteDatabase(name: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return;

    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
            // 即使被阻塞也继续，因为可能是其他标签页打开了数据库
            resolve();
        };
    });
}

/**
 * 导入单个 store 的数据
 */
async function importStore(db: IDBDatabase, storeName: string, records: BackupRecord[], unzipped: Record<string, Uint8Array>): Promise<void> {
    // 先异步预处理记录：从解压数据提取二进制 / base64 解码
    const processedRecords = await Promise.all(
        records.map(async (record) => {
            const processed: BackupRecord = { ...record };

            for (const key of Object.keys(processed)) {
                const val = processed[key];

                // 新格式：_blobRef 对象 → 从解压数据恢复 Blob
                if (isBlobRef(val)) {
                    const blobData = unzipped[`blobs/${val._blobRef}`];
                    if (blobData) {
                        processed[key] = new Blob([blobData as unknown as BlobPart], { type: val._blobMimeType });
                    }
                    continue;
                }

                // 旧格式兼容：base64 字符串 + _blobMimeType
                if (key === 'blob' && typeof val === 'string' && typeof record._blobMimeType === 'string') {
                    processed.blob = base64ToBlob(val, record._blobMimeType);
                }
            }

            // 清理旧格式遗留的 _blobMimeType（新格式按字段内嵌携带）
            if ('_blobMimeType' in processed && typeof processed._blobMimeType === 'string') {
                delete processed._blobMimeType;
            }

            return processed;
        })
    );

    // 再写回 IndexedDB
    return new Promise((resolve, reject) => {
        try {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);

            for (const processedRecord of processedRecords) {
                store.put(processedRecord);
            }

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * 导入 IndexedDB 数据
 */
async function importIndexedDB(data: IndexedDBBackup, unzipped: Record<string, Uint8Array>, onProgress?: ProgressCallback): Promise<void> {
    let completedStores = 0;
    const totalStores = Object.values(data).reduce((sum, dbData) => sum + Object.keys(dbData).length, 0);

    for (const dbConfig of INDEXEDDB_DATABASES) {
        const dbData = data[dbConfig.name];
        if (!dbData) continue;

        // 先删除整个数据库，确保重新创建
        await deleteDatabase(dbConfig.name);

        // 重新打开数据库并导入数据（createStores=true 以便创建 stores）
        const db = await openDatabase(dbConfig.name, dbConfig.version, true);
        if (!db) {
            continue;
        }

        for (const storeName of dbConfig.stores) {
            try {
                const storeData = dbData[storeName];
                if (!storeData || !Array.isArray(storeData)) continue;

                if (!db.objectStoreNames.contains(storeName)) {
                    continue;
                }

                await importStore(db, storeName, storeData, unzipped);

                completedStores++;
                if (onProgress) {
                    const percent = 20 + Math.floor((completedStores / totalStores) * 70);
                    onProgress({
                        percent,
                        message: `正在导入 ${dbConfig.name}/${storeName}...`,
                    });
                }
            } catch {
                // store import failed, continue with next
            }
        }

        db.close();
    }
}

/**
 * 从 ZIP 文件导入所有数据（覆盖现有数据）
 * 使用 fflate 解压，兼容新版和旧版（JSZip 生成的）备份格式
 */
export async function importAllData(file: File, onProgress?: ProgressCallback): Promise<void> {
    if (onProgress) {
        onProgress({ percent: 0, message: '开始导入数据...' });
    }

    // 解压 ZIP 文件
    if (onProgress) {
        onProgress({ percent: 5, message: '正在解压文件...' });
    }

    const buffer = await file.arrayBuffer();
    const unzipped = unzipSync(new Uint8Array(buffer));

    // 辅助：从解压结果读取文本
    const readText = (path: string): string | null => {
        const data = unzipped[path];
        return data ? new TextDecoder().decode(data) : null;
    };

    const metadataText = readText('metadata.json');
    if (metadataText) {
        const metadata = JSON.parse(metadataText) as Record<string, unknown>;
        if (metadata.incremental === true) {
            throw new Error('不支持导入非完整备份文件，请选择完整备份文件');
        }
    }

    // 先完整预解析备份中的 JSON；任何损坏都在清空本机数据之前失败，
    // 避免“导入到一半才发现文件坏了”导致现有数据被破坏。
    const parsedJsonEntries = new Map<string, unknown>();
    for (const [backupPath, data] of Object.entries(unzipped)) {
        if (!backupPath.endsWith('.json')) continue;
        try {
            parsedJsonEntries.set(backupPath, JSON.parse(new TextDecoder().decode(data)));
        } catch {
            throw new Error(`备份文件损坏，无法解析 ${backupPath}`);
        }
    }

    // 读取 localStorage 数据
    if (onProgress) {
        onProgress({ percent: 10, message: '正在清空 localStorage...' });
    }

    // 清空现有 localStorage
    for (const key of LOCAL_STORAGE_KEYS) {
        try {
            removeDesktopPreference(key);
        } catch {
            // skip failed localStorage removal
        }
    }
    if (window.jackyDesktop?.records) {
        const existingJobs = window.jackyDesktop.records.loadJobs();
        if (Array.isArray(existingJobs) && window.jackyDesktop.imageCache) {
            await Promise.all(existingJobs.map((job) => {
                const record = job as { id?: unknown; images?: unknown[] };
                return typeof record.id === 'string'
                    ? window.jackyDesktop!.imageCache.deleteJob(record.id, record.images?.length)
                    : Promise.resolve({ ok: true });
            }));
        }
        const result = window.jackyDesktop.records.saveJobs([]);
        if (!result?.ok) throw new Error(result?.error || '无法清空本地使用记录');
    }

    if (onProgress) {
        onProgress({ percent: 15, message: '正在导入 localStorage...' });
    }

    const localStorageText = readText('localStorage.json');
    if (localStorageText) {
        const localStorageData = parsedJsonEntries.get('localStorage.json');
        importLocalStorage(localStorageData);
    }

    for (const [backupPath, data] of Object.entries(unzipped)) {
        const match = backupPath.match(/^desktop-image-cache\/([^/]+)\/(\d+)\.([a-z0-9]+)$/i);
        if (!match) continue;
        const jobId = decodeURIComponent(match[1]);
        const imageIndex = Number(match[2]);
        if (!Number.isInteger(imageIndex) || imageIndex < 0) continue;
        await storeImageBlob(jobId, imageIndex, new Blob([data], { type: imageMimeType(match[3].toLowerCase()) }));
    }

    // 读取 IndexedDB 数据
    const indexedDBData: IndexedDBBackup = {};
    for (const [path, data] of Object.entries(unzipped)) {
        if (path.startsWith('indexedDB/') && path.endsWith('.json')) {
            const dbName = path.replace('indexedDB/', '').replace('.json', '');
            indexedDBData[dbName] = parsedJsonEntries.get(path) as IndexedDBBackup[string];
        }
    }

    // 导入 IndexedDB
    await importIndexedDB(indexedDBData, unzipped, onProgress);

    // 读取并导入 localforage（无限画布）数据
    if (onProgress) {
        onProgress({ percent: 92, message: '正在导入无限画布数据...' });
    }
    const localForageData: LocalForageBackup = {};
    for (const [path, data] of Object.entries(unzipped)) {
        if (path.startsWith('localforage/') && path.endsWith('.json')) {
            const dbName = path.replace('localforage/', '').replace('.json', '');
            localForageData[dbName] = parsedJsonEntries.get(path) as LocalForageBackup[string];
        }
    }
    await importLocalForage(localForageData, unzipped);
    await importDesktopAppFiles(unzipped);

    if (onProgress) {
        onProgress({ percent: 100, message: '导入完成！' });
    }
}

/**
 * 下载 Blob 为文件
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
    await saveBlobToDownloads(blob, filename);
}

/**
 * 生成备份文件名
 */
export function generateBackupFilename(): string {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    return `jacky-backup-${dateStr}-${timeStr}.zip`;
}

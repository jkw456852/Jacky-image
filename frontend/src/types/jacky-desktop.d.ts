export {};

declare global {
  interface JackyDesktopStoragePaths {
    recordsDirectory: string;
    cacheDirectory: string;
    downloadsDirectory: string;
  }

  type JackyDesktopStorageKind = 'records' | 'cache' | 'downloads';

  interface Window {
    jackyDesktop?: {
      isElectron: boolean;
      platform: string;
      electronVersion: string;
      modelRegistry: {
        load: () => unknown | null;
        save: (registry: unknown) => { ok: boolean; error?: string };
      };
      modelSecrets: {
        configure: (modelId: string, kind: 'image' | 'text') => Promise<{
          ok: boolean;
          configured?: boolean;
          cancelled?: boolean;
          registry?: unknown;
          error?: string;
        }>;
      };
      storage: {
        get: () => JackyDesktopStoragePaths | null;
        selectDirectory: (kind: JackyDesktopStorageKind) => Promise<string | null>;
        save: (paths: JackyDesktopStoragePaths) => Promise<{
          ok: boolean;
          paths?: JackyDesktopStoragePaths;
          restartRequired?: boolean;
          error?: string;
        }>;
        openDirectory: (kind: JackyDesktopStorageKind) => Promise<{ ok: boolean; error?: string }>;
      };
      preferences: {
        get: (key: string) => string | null;
        getAll: () => Record<string, string>;
        set: (key: string, value: string) => { ok: boolean; error?: string };
        remove: (key: string) => { ok: boolean; error?: string };
      };
      seatCoverPrompts: {
        openDirectory: () => Promise<{ ok: boolean; error?: string }>;
      };
      promptEditorWindow: {
        open: (payload: { preset: unknown; value?: string; defaultValue?: string; context: unknown }) => Promise<{ ok: boolean; sessionId?: string; error?: string }>;
        getPayload: (sessionId: string) => Promise<{ ok: boolean; payload?: unknown; error?: string }>;
        close: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
        onClosed: (callback: (value: { sessionId: string }) => void) => () => void;
      };
      taskStatus: {
        update: (tasks: Array<{
          id: string;
          status: 'queued' | 'processing' | 'completed' | 'failed';
          title: string;
          detail?: string;
          count?: number;
          updatedAt?: string;
        }>) => void;
      };
      repaintWindow: {
        open: (payload: {
          sourceDataUrl: string;
          fileName?: string;
          hasApiKey?: boolean;
          references?: Array<{ id: string; name: string; dataUrl: string; mimeType: string }>;
        }) => Promise<{ ok: boolean; sessionId?: string; error?: string }>;
        getPayload: (sessionId: string) => Promise<{ ok: boolean; payload?: {
          sourceDataUrl: string;
          fileName?: string;
          hasApiKey?: boolean;
          references?: Array<{ id: string; name: string; dataUrl: string; mimeType: string }>;
        }; error?: string }>;
        complete: (sessionId: string, dataUrl: string) => Promise<{ ok: boolean; error?: string }>;
        cancel: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
        onResult: (callback: (value: { sessionId: string; dataUrl: string }) => void) => () => void;
        onClosed: (callback: (value: { sessionId: string }) => void) => () => void;
      };
      records: {
        loadJobs: () => unknown[] | null;
        saveJobs: (jobs: unknown[]) => { ok: boolean; error?: string };
      };
      appData: {
        read: (namespace: string) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
        write: (namespace: string, data: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
        delete: (namespace: string) => Promise<{ ok: boolean; error?: string }>;
      };
      appCache: {
        write: (scope: string, key: string, mimeType: string, bytes: ArrayBuffer) => Promise<{ ok: boolean; error?: string }>;
        read: (scope: string, key: string) => Promise<{
          ok: boolean;
          missing?: boolean;
          mimeType?: string;
          bytes?: Uint8Array;
          error?: string;
        }>;
        delete: (scope: string, key: string) => Promise<{ ok: boolean; deleted?: boolean; error?: string }>;
        list: (scope: string) => Promise<{ ok: boolean; keys?: string[]; error?: string }>;
      };
      imageCache: {
        write: (jobId: string, imageIndex: number, mimeType: string, bytes: ArrayBuffer) => Promise<{ ok: boolean; error?: string }>;
        read: (jobId: string, imageIndex: number) => Promise<{
          ok: boolean;
          missing?: boolean;
          mimeType?: string;
          bytes?: Uint8Array;
          error?: string;
        }>;
        deleteJob: (jobId: string, imageCount?: number) => Promise<{ ok: boolean; deleted?: number; error?: string }>;
      };
      downloads: {
        save: (fileName: string, bytes: ArrayBuffer) => Promise<{ ok: boolean; filePath?: string; error?: string }>;
      };
      updates: {
        getState: () => Promise<{ status: string; currentVersion?: string; availableVersion?: string | null; releaseName?: string | null; releaseNotes?: string | null; releaseDate?: string | null; progress?: { percent?: number } | null; error?: string | null }>;
        check: () => Promise<{ ok: boolean; reason?: string }>;
        download: () => Promise<{ ok: boolean; reason?: string }>;
        install: () => Promise<{ ok: boolean; reason?: string }>;
        onState: (callback: (state: { status: string; currentVersion?: string; availableVersion?: string | null; releaseName?: string | null; releaseNotes?: string | null; releaseDate?: string | null; progress?: { percent?: number } | null; error?: string | null }) => void) => () => void;
      };
    };
  }
}

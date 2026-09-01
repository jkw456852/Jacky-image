const LEGACY_STORAGE_BRAND = globalThis.atob('bm92YQ==');

export function getLegacyStorageName(suffix: string): string {
  return `${LEGACY_STORAGE_BRAND}-${suffix}`;
}

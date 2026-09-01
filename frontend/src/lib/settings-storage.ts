'use client';

import { getCompleteImageModels, getCompleteTextModels, loadRegistry } from '@/lib/jacky-models';
import {
  getJsonDesktopPreference,
  setJsonDesktopPreference,
} from '@/lib/desktop-preferences';

export function getStoredApiKey(): string {
  // Secrets are owned by the Electron main process and are never returned to renderer code.
  return '';
}

export function setStoredApiKey(): boolean {
  return true;
}

export function removeStoredApiKey(): void {
  // 开源版改为模型级别独立存储，不再提供全局 key 写入口。
}

export const getStoredCcodeKey = getStoredApiKey;
export const setStoredCcodeKey = setStoredApiKey;
export const removeStoredCcodeKey = removeStoredApiKey;

export function getApiKeyFromStorage(): string {
  return getStoredApiKey();
}

export function hasAnyApiKey(): boolean {
  const registry = loadRegistry();
  return getCompleteImageModels(registry).length > 0 && getCompleteTextModels(registry).length > 0;
}

export function loadJsonFromStorage<T>(key: string): Partial<T> {
  return getJsonDesktopPreference<T>(key);
}

export function saveJsonToStorage<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  setJsonDesktopPreference(key, value);
}

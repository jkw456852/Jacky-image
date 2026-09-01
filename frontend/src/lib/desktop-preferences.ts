'use client';

const memoryPreferences: Record<string, string> = {};

function getBridge() {
  if (typeof window === 'undefined') return null;
  return window.jackyDesktop?.preferences || null;
}

export function getDesktopPreference(key: string): string | null {
  return getBridge()?.get(key) ?? memoryPreferences[key] ?? null;
}

export function getAllDesktopPreferences(): Record<string, string> {
  return getBridge()?.getAll() || { ...memoryPreferences };
}

export function setDesktopPreference(key: string, value: string): void {
  const bridge = getBridge();
  if (!bridge) {
    memoryPreferences[key] = value;
    return;
  }
  const result = bridge.set(key, value);
  if (!result?.ok) throw new Error(result?.error || 'Could not save desktop preference');
}

export function removeDesktopPreference(key: string): void {
  const bridge = getBridge();
  if (!bridge) {
    delete memoryPreferences[key];
    return;
  }
  const result = bridge.remove(key);
  if (!result?.ok) throw new Error(result?.error || 'Could not remove desktop preference');
}

export function getJsonDesktopPreference<T>(key: string): Partial<T> {
  const raw = getDesktopPreference(key);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<T>;
  } catch {
    try {
      removeDesktopPreference(key);
    } catch {
      // A malformed optional preference should not block the workspace.
    }
    return {};
  }
}

export function setJsonDesktopPreference<T>(key: string, value: T): void {
  setDesktopPreference(key, JSON.stringify(value));
}

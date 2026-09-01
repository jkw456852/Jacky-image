'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getJsonDesktopPreference,
  setJsonDesktopPreference,
} from '@/lib/desktop-preferences';

/**
 * 泛型 localStorage 持久化 Hook
 *
 * 将「从 localStorage 读取设置 → 状态初始化 → 变化时回写」的重复模式封装为通用 Hook。
 *
 * @param key localStorage 存储键
 * @param defaults 默认值（也作为类型推断依据）
 * @returns [values, setPartial] — 当前值 + 局部更新函数
 *
 * @example
 * const [settings, updateSettings] = usePersistedSettings('jacky-t2i-settings', {
 *   model: 'gemini-3-pro-image-preview' as ModelId,
 *   outputSize: '1K' as OutputSize,
 *   temperature: 1,
 * });
 * // 局部更新：
 * updateSettings({ model: 'gpt-image-2' });
 */
export function usePersistedSettings<T extends Record<string, unknown>>(
  key: string,
  defaults: T,
): [T, (update: Partial<T>) => void] {
  const [values, setValues] = useState<T>(defaults);
  const readyRef = useRef(false);

  // 挂载时从 localStorage 恢复
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const saved = getJsonDesktopPreference<T>(key);
        if (Object.keys(saved).length > 0) {
          // 仅覆盖 defaults 中已有的字段，忽略未知字段
          const merged = { ...defaults };
          for (const k of Object.keys(defaults) as Array<keyof T>) {
            if (k in saved && saved[k] !== undefined) {
              (merged as Record<string, unknown>)[k as string] = saved[k];
            }
          }
          setValues(merged);
        }
      } catch {
        // JSON 解析失败则使用默认值
      }
      readyRef.current = true;
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // 变化时回写 localStorage
  useEffect(() => {
    if (!readyRef.current) return;
    try {
      setJsonDesktopPreference(key, values);
    } catch {
      // 忽略存储不可用或配额超限
    }
  }, [key, values]);

  const setPartial = useCallback((update: Partial<T>) => {
    setValues(prev => ({ ...prev, ...update }));
  }, []);

  return [values, setPartial];
}

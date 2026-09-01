import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";
import {
  getDesktopPreference,
  removeDesktopPreference,
  setDesktopPreference,
} from "@/lib/desktop-preferences";
import { getLegacyStorageName } from "@/lib/legacy-storage-names";

const legacyStore = localforage.createInstance({
  name: getLegacyStorageName("image"),
  storeName: "canvas_app_state",
});

export const localForageStorage: StateStorage = {
  getItem: async (name) => {
    if (typeof window === "undefined") return null;
    const stored = getDesktopPreference(name);
    if (stored !== null) return stored;
    try {
      const legacy = await legacyStore.getItem<string>(name);
      if (typeof legacy === "string") {
        setDesktopPreference(name, legacy);
        await legacyStore.removeItem(name);
        return legacy;
      }
    } catch {
      // Legacy IndexedDB migration is best-effort.
    }
    return null;
  },
  setItem: async (name, value) => {
    if (typeof window === "undefined") return;
    setDesktopPreference(name, value);
    void legacyStore.removeItem(name).catch(() => undefined);
  },
  removeItem: async (name) => {
    if (typeof window === "undefined") return;
    removeDesktopPreference(name);
    void legacyStore.removeItem(name).catch(() => undefined);
  },
};

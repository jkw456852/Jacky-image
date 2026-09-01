"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import type { CanvasGenerationConfig } from "../canvas-generation-service";
import {
  getDesktopPreference,
  removeDesktopPreference,
  setDesktopPreference,
} from "@/lib/desktop-preferences";

export const defaultCanvasConfig: CanvasGenerationConfig = {
  model: "gemini-3-pro-image-preview",
  outputSize: "1K",
  aspectRatio: "1:1",
  customSize: undefined,
  temperature: 1,
  webSearchEnabled: false,
  imageSearchEnabled: false,
  count: 1,
  gptImageQuality: "auto",
  gptImageStyle: "auto",
  gptImageBackground: "auto",
};

const desktopPreferenceStorage: Storage = {
  get length() { return 0; },
  clear() {},
  key() { return null; },
  getItem: getDesktopPreference,
  setItem: setDesktopPreference,
  removeItem: removeDesktopPreference,
};

type CanvasConfigStore = {
  config: CanvasGenerationConfig;
  updateConfig: <K extends keyof CanvasGenerationConfig>(key: K, value: CanvasGenerationConfig[K]) => void;
  setConfig: (patch: Partial<CanvasGenerationConfig>) => void;
};

export const useCanvasConfigStore = create<CanvasConfigStore>()(
  persist(
    (set) => ({
      config: defaultCanvasConfig,
      updateConfig: (key, value) => set((state) => ({ config: { ...state.config, [key]: value } })),
      setConfig: (patch) => set((state) => ({ config: { ...state.config, ...patch } })),
    }),
    {
      name: "jacky-image:canvas_config",
      storage: createJSONStorage(() => desktopPreferenceStorage),
      merge: (persisted, current) => {
        const persistedConfig = ((persisted as Partial<CanvasConfigStore>)?.config || {}) as Partial<CanvasGenerationConfig>;
        return { ...current, config: { ...defaultCanvasConfig, ...persistedConfig } };
      },
    },
  ),
);

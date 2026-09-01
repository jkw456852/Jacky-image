/**
 * 画布主题桥接：原 infinite-canvas 用静态 light/dark 调色板 + useThemeStore 切换。
 * 这里改为引用本项目的 CSS 变量（globals.css 定义），随 data-theme 自动切换明暗，
 * 因此只需一套主题对象即可（保留 canvasThemes 形状以兼容原组件读法）。
 */
export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasTheme = {
  canvas: {
    background: "var(--background)",
    dot: "color-mix(in srgb, var(--muted-foreground) 30%, transparent)",
    line: "color-mix(in srgb, var(--muted-foreground) 16%, transparent)",
    selectionStroke: "var(--primary)",
    selectionFill: "color-mix(in srgb, var(--primary) 12%, transparent)",
  },
  node: {
    label: "var(--muted-foreground)",
    fill: "var(--card)",
    panel: "var(--popover)",
    stroke: "var(--border)",
    activeStroke: "var(--primary)",
    placeholder: "var(--placeholder)",
    text: "var(--foreground)",
    muted: "var(--muted-foreground)",
    faint: "var(--muted-foreground)",
  },
  toolbar: {
    panel: "var(--card)",
    border: "var(--border)",
    item: "var(--muted-foreground)",
    itemHover: "var(--muted)",
    activeBg: "var(--muted)",
    activeText: "var(--foreground)",
  },
} as const;

export type CanvasTheme = typeof canvasTheme;

/** 兼容原组件 `canvasThemes[theme]` 的读法：明暗共用同一套（由 CSS 变量切换）。 */
export const canvasThemes = {
  light: canvasTheme,
  dark: canvasTheme,
} as const;

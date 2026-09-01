"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import { Segmented } from "@/components/ui/toggle-group";
import { Input } from "@/components/ui/input";
import {
  cropDataUrl,
  splitDataUrl,
  transformAngleDataUrl,
  upscaleDataUrl,
  type ImageSplitPiece,
  type ImageUpscaleAlgorithm,
} from "../utils/canvas-image-data";
import { readImageMeta } from "../lib/image-utils";
import { Spinner } from "./canvas-ui";

type BaseProps = { open: boolean; source: string; onClose: () => void };

const RATIO_OPTIONS = [
  { value: "free", label: "自由" },
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "3:2", label: "3:2" },
  { value: "2:3", label: "2:3" },
];

/** 全屏裁剪：可拖拽/缩放选择区域 + 比例切换。 */
export function CanvasCropDialog({ open, source, onClose, onApply }: BaseProps & { onApply: (dataUrl: string) => void }) {
  const [ratio, setRatio] = useState("free");
  const [busy, setBusy] = useState(false);
  const [imageSize, setImageSize] = useState({ w: 0, h: 0 });
  // 裁剪区域（归一化 0-1 坐标）
  const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number }>({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ kind: "move" | "resize"; handle?: string; startX: number; startY: number; startCrop: typeof crop } | null>(null);
  const ratioRef = useRef(ratio);
  useEffect(() => { ratioRef.current = ratio; }, [ratio]);

  // 加载图片尺寸
  useEffect(() => {
    if (!open) return;
    void readImageMeta(source).then((meta) => {
      setImageSize({ w: meta.width, h: meta.height });
      // 初始裁剪区域居中 80%
      const ratioVal = parseRatio(ratioRef.current);
      if (ratioVal) {
        const imgRatio = meta.width / meta.height;
        if (imgRatio > ratioVal) {
          const h = 0.8;
          const w = h * ratioVal / imgRatio;
          setCrop({ x: (1 - w) / 2, y: 0.1, w, h });
        } else {
          const w = 0.8;
          const h = w * imgRatio / ratioVal;
          setCrop({ x: 0.1, y: (1 - h) / 2, w, h });
        }
      } else {
        setCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
      }
    });
  }, [open, source]);

  // 比例切换时，调整当前裁剪区域以匹配新比例
  const handleRatioChange = useCallback((newRatio: string) => {
    setRatio(newRatio);
    const ratioVal = parseRatio(newRatio);
    if (!ratioVal || !imageSize.w) return;
    const imgRatio = imageSize.w / imageSize.h;
    setCrop((prev) => {
      const centerX = prev.x + prev.w / 2;
      const centerY = prev.y + prev.h / 2;
      let w = prev.w;
      let h = w * imgRatio / ratioVal;
      if (h > 1) { h = 1; w = h * ratioVal / imgRatio; }
      if (w > 1) { w = 1; h = w * imgRatio / ratioVal; }
      const x = Math.max(0, Math.min(1 - w, centerX - w / 2));
      const y = Math.max(0, Math.min(1 - h, centerY - h / 2));
      return { x, y, w, h };
    });
  }, [imageSize]);

  // 拖拽/缩放逻辑
  const handlePointerDown = useCallback((event: React.PointerEvent, kind: "move" | "resize", handle?: string) => {
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    dragRef.current = { kind, handle, startX: event.clientX, startY: event.clientY, startCrop: { ...crop } };
  }, [crop]);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const dx = (event.clientX - drag.startX) / rect.width;
    const dy = (event.clientY - drag.startY) / rect.height;
    const ratioVal = parseRatio(ratio);
    const imgRatio = imageSize.w / imageSize.h;

    if (drag.kind === "move") {
      const x = clamp(drag.startCrop.x + dx, 0, 1 - drag.startCrop.w);
      const y = clamp(drag.startCrop.y + dy, 0, 1 - drag.startCrop.h);
      setCrop({ ...drag.startCrop, x, y });
    } else if (drag.kind === "resize") {
      const s = drag.startCrop;
      let nx = s.x, ny = s.y, nw = s.w, nh = s.h;
      const handle = drag.handle!;

      if (handle.includes("e")) nw = clamp(s.w + dx, 0.05, 1 - s.x);
      if (handle.includes("w")) { nx = clamp(s.x + dx, 0, s.x + s.w - 0.05); nw = s.w - (nx - s.x); }
      if (handle.includes("s")) nh = clamp(s.h + dy, 0.05, 1 - s.y);
      if (handle.includes("n")) { ny = clamp(s.y + dy, 0, s.y + s.h - 0.05); nh = s.h - (ny - s.y); }

      // 比例锁定：以宽度为主导调整高度
      if (ratioVal) {
        const targetH = nw * imgRatio / ratioVal;
        if (handle.includes("n")) { ny = s.y + s.h - targetH; }
        nh = targetH;
        // 边界修正
        if (ny < 0) { ny = 0; nh = s.y + s.h; }
        if (ny + nh > 1) { nh = 1 - ny; }
        if (nh < 0.05) { nh = 0.05; }
      }

      setCrop({ x: nx, y: ny, w: nw, h: nh });
    }
  }, [ratio, imageSize]);

  const handlePointerUp = useCallback(() => { dragRef.current = null; }, []);

  const apply = async () => {
    setBusy(true);
    try {
      onApply(await cropDataUrl(source, { x: crop.x, y: crop.y, width: crop.w, height: crop.h }));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex select-none flex-col bg-background/95 backdrop-blur-sm"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* 顶部栏 */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-medium">裁剪图片</span>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="size-5" />
        </Button>
      </div>

      {/* 图片 + 裁剪区域 */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-8">
        <div ref={containerRef} className="relative overflow-hidden" style={{ maxWidth: "100%", maxHeight: "100%" }}>
          {imageSize.w > 0 && (
            <CropOverlay
              source={source}
              imageSize={imageSize}
              crop={crop}
              onPointerDown={handlePointerDown}
            />
          )}
        </div>
      </div>

      {/* 底部控制栏 */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-t border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Segmented value={ratio} onChange={handleRatioChange} options={RATIO_OPTIONS} className="flex-wrap" />
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{Math.round(crop.w * imageSize.w)} × {Math.round(crop.h * imageSize.h)}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>取消</Button>
          <Button size="sm" onClick={apply} disabled={busy}>
            {busy && <Spinner className="size-4" />}
            应用裁剪
          </Button>
        </div>
      </div>
    </div>
  );
}

function CropOverlay({ source, imageSize, crop, onPointerDown }: {
  source: string;
  imageSize: { w: number; h: number };
  crop: { x: number; y: number; w: number; h: number };
  onPointerDown: (event: React.PointerEvent, kind: "move" | "resize", handle?: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const maxW = window.innerWidth - 64;
      const maxH = window.innerHeight - 160;
      const imgRatio = imageSize.w / imageSize.h;
      let w = maxW;
      let h = w / imgRatio;
      if (h > maxH) { h = maxH; w = h * imgRatio; }
      setDisplaySize({ w: Math.round(w), h: Math.round(h) });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [imageSize]);

  const toPixel = (n: number, axis: "x" | "y") => n * (axis === "x" ? displaySize.w : displaySize.h);

  const handles = ["nw", "ne", "sw", "se", "n", "s", "e", "w"] as const;

  return (
    <div ref={containerRef} style={{ width: displaySize.w || "auto", height: displaySize.h || "auto" }}>
      {displaySize.w > 0 && (
        <div className="relative" style={{ width: displaySize.w, height: displaySize.h }}>
          {/* 底层图片 */}
          <img src={source} alt="" className="block size-full object-contain" draggable={false} />

          {/* 暗色遮罩（4 块围绕选区） */}
          <div className="pointer-events-none absolute inset-0">
            {/* 上 */}
            <div className="absolute left-0 right-0 top-0 bg-black/60" style={{ height: toPixel(crop.y, "y") }} />
            {/* 下 */}
            <div className="absolute bottom-0 left-0 right-0 bg-black/60" style={{ height: toPixel(1 - crop.y - crop.h, "y") }} />
            {/* 左 */}
            <div className="absolute left-0 bg-black/60" style={{ top: toPixel(crop.y, "y"), width: toPixel(crop.x, "x"), height: toPixel(crop.h, "y") }} />
            {/* 右 */}
            <div className="absolute right-0 bg-black/60" style={{ top: toPixel(crop.y, "y"), width: toPixel(1 - crop.x - crop.w, "x"), height: toPixel(crop.h, "y") }} />
          </div>

          {/* 选区边框 + 拖拽移动 */}
          <div
            className="absolute cursor-move border-2 border-white/80"
            style={{
              left: toPixel(crop.x, "x"),
              top: toPixel(crop.y, "y"),
              width: toPixel(crop.w, "x"),
              height: toPixel(crop.h, "y"),
            }}
            onPointerDown={(e) => onPointerDown(e, "move")}
          >
            {/* 三分线 */}
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute top-1/3 left-0 right-0 h-px bg-white/30" />
              <div className="absolute top-2/3 left-0 right-0 h-px bg-white/30" />
              <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/30" />
              <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/30" />
            </div>
          </div>

          {/* 8 个缩放手柄 */}
          {handles.map((h) => {
            const isCorner = h.length === 2;
            const pos: React.CSSProperties = {};
            let cursor = "default";
            if (h.includes("n")) { pos.top = toPixel(crop.y, "y") - 5; cursor = "n-resize"; }
            if (h.includes("s")) { pos.top = toPixel(crop.y + crop.h, "y") - 5; cursor = "s-resize"; }
            if (h.includes("w")) { pos.left = toPixel(crop.x, "x") - 5; cursor = "w-resize"; }
            if (h.includes("e")) { pos.left = toPixel(crop.x + crop.w, "x") - 5; cursor = "e-resize"; }
            if (h === "n" || h === "s") { pos.left = toPixel(crop.x + crop.w / 2, "x") - 5; }
            if (h === "e" || h === "w") { pos.top = toPixel(crop.y + crop.h / 2, "y") - 5; }
            if (isCorner) {
              cursor = h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize";
            }
            return (
              <div
                key={h}
                className="absolute z-10"
                style={{ ...pos, cursor, width: 10, height: 10 }}
                onPointerDown={(e) => onPointerDown(e, "resize", h)}
              >
                {isCorner && <div className="m-1 size-3 rounded-sm border-2 border-white bg-primary shadow-sm" />}
                {!isCorner && <div className="m-2 size-2 rounded-full border-2 border-white bg-primary shadow-sm" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 放大：目标倍数 + 算法。 */
export function CanvasUpscaleDialog({ open, source, onClose, onApply }: BaseProps & { onApply: (dataUrl: string) => void }) {
  const [multiplier, setMultiplier] = useState("2");
  const [algorithm, setAlgorithm] = useState<ImageUpscaleAlgorithm>("high");
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setBusy(true);
    try {
      const meta = await readImageMeta(source);
      const targetLongEdge = Math.max(meta.width, meta.height) * Number(multiplier);
      onApply(await upscaleDataUrl(source, { targetLongEdge, algorithm }));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <OpDialog open={open} title="放大图片" onClose={onClose} onApply={apply} busy={busy} source={source}>
      <Field label="放大倍数">
        <Segmented value={multiplier} onChange={setMultiplier} options={[{ value: "2", label: "2×" }, { value: "3", label: "3×" }, { value: "4", label: "4×" }]} />
      </Field>
      <Field label="算法">
        <Segmented<ImageUpscaleAlgorithm> value={algorithm} onChange={setAlgorithm} options={[{ value: "high", label: "高质量" }, { value: "bilinear", label: "双线性" }, { value: "nearest", label: "邻近" }]} />
      </Field>
    </OpDialog>
  );
}

const SPLIT_PRESETS: { rows: number; columns: number; label: string }[] = [
  { rows: 1, columns: 2, label: "1×2" },
  { rows: 2, columns: 1, label: "2×1" },
  { rows: 2, columns: 2, label: "2×2" },
  { rows: 2, columns: 3, label: "2×3" },
  { rows: 3, columns: 2, label: "3×2" },
  { rows: 3, columns: 3, label: "3×3" },
  { rows: 4, columns: 4, label: "4×4" },
];

/** 全屏分割：左侧图上网格线 + 右侧预览，内置分割方式。 */
export function CanvasSplitDialog({ open, source, onClose, onApply }: BaseProps & { onApply: (pieces: ImageSplitPiece[]) => void }) {
  const [rows, setRows] = useState(2);
  const [columns, setColumns] = useState(2);
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<{ dataUrl: string; row: number; column: number }[]>([]);
  const [imageSize, setImageSize] = useState({ w: 0, h: 0 });

  // 加载图片尺寸
  useEffect(() => {
    if (!open) return;
    void readImageMeta(source).then((meta) => setImageSize({ w: meta.width, h: meta.height }));
  }, [open, source]);

  // 生成预览
  useEffect(() => {
    if (!open || !imageSize.w) return;
    let cancelled = false;
    // 先清空旧预览（标记正在生成），再异步填充新预览
    queueMicrotask(() => setPreviews([]));
    void splitDataUrl(source, { rows, columns }).then((pieces) => {
      if (cancelled) return;
      setPreviews(pieces.map((p) => ({ dataUrl: p.dataUrl, row: p.row, column: p.column })));
    });
    return () => { cancelled = true; };
  }, [open, source, rows, columns, imageSize]);

  const handlePreset = (preset: { rows: number; columns: number }) => {
    setRows(preset.rows);
    setColumns(preset.columns);
  };

  const apply = async () => {
    setBusy(true);
    try {
      onApply(await splitDataUrl(source, { rows, columns }));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const total = rows * columns;

  return (
    <div className="fixed inset-0 z-[9999] flex select-none flex-col bg-background/95 backdrop-blur-sm">
      {/* 顶部栏 */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-medium">分割图片</span>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{rows} × {columns} = {total} 块</span>
          <span>{imageSize.w}×{imageSize.h} → {Math.floor(imageSize.w / columns)}×{Math.floor(imageSize.h / rows)}</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="size-5" />
        </Button>
      </div>

      {/* 主区域：左图 + 右预览 */}
      <div className="flex min-h-0 flex-1">
        {/* 左侧：图片 + 网格线 */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center p-6">
          <SplitGridOverlay source={source} rows={rows} columns={columns} />
        </div>

        {/* 右侧：预览面板 */}
        <div className="w-72 shrink-0 overflow-y-auto border-l border-border bg-muted/30 p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">预览 ({total})</div>
          {previews.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              <Spinner className="mr-2 size-4" /> 生成预览中…
            </div>
          ) : (
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(columns, 4)}, 1fr)` }}>
              {previews.map((piece, index) => (
                <div key={index} className="overflow-hidden rounded-lg border border-border bg-background">
                  <img src={piece.dataUrl} alt={`R${piece.row + 1}C${piece.column + 1}`} className="block w-full object-contain" />
                  <div className="px-1 py-0.5 text-center text-[10px] text-muted-foreground">{piece.row + 1},{piece.column + 1}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 底部控制栏 */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-t border-border px-4 py-3">
        <div className="flex items-center gap-2">
          {SPLIT_PRESETS.map((preset) => {
            const isActive = rows === preset.rows && columns === preset.columns;
            return (
              <button
                key={preset.label}
                type="button"
                className={cn("rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors", isActive ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted")}
                onClick={() => handlePreset(preset)}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            行
            <Input type="number" min={1} max={8} value={rows} onChange={(e) => setRows(clampInt(e.target.value, 1, 8))} className="h-7 w-14 text-xs" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            列
            <Input type="number" min={1} max={8} value={columns} onChange={(e) => setColumns(clampInt(e.target.value, 1, 8))} className="h-7 w-14 text-xs" />
          </label>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>取消</Button>
          <Button size="sm" onClick={apply} disabled={busy}>
            {busy && <Spinner className="size-4" />}
            应用分割
          </Button>
        </div>
      </div>
    </div>
  );
}

function SplitGridOverlay({ source, rows, columns }: { source: string; rows: number; columns: number }) {
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void readImageMeta(source).then((meta) => {
      const maxW = window.innerWidth - 360 - 48;
      const maxH = window.innerHeight - 160;
      const imgRatio = meta.width / meta.height;
      let w = maxW;
      let h = w / imgRatio;
      if (h > maxH) { h = maxH; w = h * imgRatio; }
      setDisplaySize({ w: Math.round(w), h: Math.round(h) });
    });
  }, [source]);

  return (
    <div ref={containerRef} style={{ width: displaySize.w || "auto", height: displaySize.h || "auto" }}>
      {displaySize.w > 0 && (
        <div className="relative" style={{ width: displaySize.w, height: displaySize.h }}>
          <img src={source} alt="" className="block size-full object-contain" draggable={false} />

          {/* 网格线 */}
          <div className="pointer-events-none absolute inset-0">
            {/* 水平线 */}
            {Array.from({ length: rows - 1 }, (_, i) => (
              <div key={`h${i}`} className="absolute left-0 right-0 h-px bg-white/60" style={{ top: `${((i + 1) / rows) * 100}%` }} />
            ))}
            {/* 垂直线 */}
            {Array.from({ length: columns - 1 }, (_, i) => (
              <div key={`v${i}`} className="absolute top-0 bottom-0 w-px bg-white/60" style={{ left: `${((i + 1) / columns) * 100}%` }} />
            ))}
            {/* 编号标签 */}
            {Array.from({ length: rows }, (_, r) =>
              Array.from({ length: columns }, (_, c) => (
                <div
                  key={`l${r}${c}`}
                  className="absolute flex items-center justify-center rounded bg-black/50 text-[10px] font-medium text-white"
                  style={{
                    left: `${(c / columns) * 100}%`,
                    top: `${(r / rows) * 100}%`,
                    width: `${(1 / columns) * 100}%`,
                    height: `${(1 / rows) * 100}%`,
                  }}
                >
                  {r + 1},{c + 1}
                </div>
              )),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 视角：水平/俯仰/距离 + 广角。 */
export function CanvasAngleDialog({ open, source, onClose, onApply }: BaseProps & { onApply: (dataUrl: string) => void }) {
  const [horizontalAngle, setHorizontalAngle] = useState(0);
  const [pitchAngle, setPitchAngle] = useState(0);
  const [cameraDistance, setCameraDistance] = useState(0);
  const [wideAngle, setWideAngle] = useState("off");
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setBusy(true);
    try {
      onApply(await transformAngleDataUrl(source, { horizontalAngle, pitchAngle, cameraDistance, wideAngle: wideAngle === "on" }));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <OpDialog open={open} title="调整视角" onClose={onClose} onApply={apply} busy={busy} source={source}>
      <Field label={`水平 · ${horizontalAngle}`}>
        <Slider value={[horizontalAngle]} min={-60} max={60} step={1} onValueChange={(value) => setHorizontalAngle(value[0] ?? 0)} />
      </Field>
      <Field label={`俯仰 · ${pitchAngle}`}>
        <Slider value={[pitchAngle]} min={-45} max={45} step={1} onValueChange={(value) => setPitchAngle(value[0] ?? 0)} />
      </Field>
      <Field label={`距离 · ${cameraDistance}`}>
        <Slider value={[cameraDistance]} min={-5} max={5} step={1} onValueChange={(value) => setCameraDistance(value[0] ?? 0)} />
      </Field>
      <Field label="广角">
        <Segmented value={wideAngle} onChange={setWideAngle} options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} />
      </Field>
    </OpDialog>
  );
}

function OpDialog({ open, title, source, busy, onClose, onApply, children }: { open: boolean; title: string; source: string; busy: boolean; onClose: () => void; onApply: () => void; children: React.ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 pt-1">
          <div className="grid place-items-center overflow-hidden rounded-xl border border-border bg-muted/40 p-2">
            <img src={source} alt="" className="max-h-56 w-auto object-contain" />
          </div>
          {children}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={onApply} disabled={busy}>
            {busy && <Spinner className="size-4" />}
            应用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function clampInt(value: string, min: number, max: number) {
  const n = Math.round(Number(value) || min);
  return Math.min(max, Math.max(min, n));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseRatio(ratio: string): number | null {
  if (ratio === "free") return null;
  const [w, h] = ratio.split(":").map(Number);
  return w && h ? w / h : null;
}

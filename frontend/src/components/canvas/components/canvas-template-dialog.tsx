"use client";

import { useMemo, useState } from "react";
import { Check, Film, Grid3x3, LayoutDashboard, LayoutGrid, SkipBack, SkipForward, Sun, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ---- types ----

export type CanvasTemplate = {
  id: string;
  title: string;
  description: string;
  prompt: string;
  category: "网格" | "单图";
  icon: LucideIcon;
};

// ---- template data ----

const CANVAS_TEMPLATES: CanvasTemplate[] = [
  {
    id: "multiCameraGrid",
    title: "多机位角度表",
    description: "3×3 网格展示同一主体的 9 个不同机位角度",
    category: "网格",
    icon: Grid3x3,
    prompt:
      "基于参考图创建一张干净的 3x3 多机位角度联系表。九个画格展示同一主体和同一场景的不同机位：正面、左前三分之三、右前三分之三、左侧全侧面、右侧全侧面、背面、俯拍、仰拍、荷兰倾斜角。所有画格保持身份、服装、发型、动作、背景世界、光线和色彩氛围一致，只改变机位和取景。使用细窄中性分隔线，不要字幕、编号、UI 标签、额外人物、重复主体或画面内摄影设备",
  },
  {
    id: "plotDeduction",
    title: "四拍叙事推演",
    description: "2×2 网格推演铺垫→升级→高潮→后果的四拍叙事",
    category: "网格",
    icon: Film,
    prompt:
      "基于参考图推演一张 2x2 分镜网格，形成合理的四拍叙事。画格顺序从左到右、从上到下：铺垫、行动升级、关键戏剧点、后果。四格保持相同角色、身份、服装、地点、光线逻辑和世界连续性，只改变表情、机位、取景和动作推进。使用电影剧照质感和细窄中性分隔线，不要字幕、对白气泡、文字标签、新主角或环境风格变化",
  },
  {
    id: "continuousStoryboard",
    title: "连续分镜 (25格)",
    description: "5×5 网格展示从参考图开始的连续场景推进",
    category: "网格",
    icon: LayoutGrid,
    prompt:
      "创建一张 5x5、共 25 格的连续分镜网格，从参考图开始展示一个连续场景推进。阅读顺序从左到右、从上到下。每格保持相同角色、身份、服装、地点、光线逻辑和世界连续性，机位、取景、表情和动作在格与格之间自然变化。使用一致的电影调色和细窄中性分隔线，不要字幕、格号、对白气泡、新主角或身份互换",
  },
  {
    id: "characterThreeView",
    title: "角色三视图",
    description: "正面、侧面、背面三个全身视图的角色设定表",
    category: "网格",
    icon: Users,
    prompt:
      "基于参考图创建角色三视图设定表：同一个角色并排展示且只有三个全身视图，正面、完整侧面和背面。三视图保持身份、面部结构、发型、服装、比例、颜色和配饰一致。使用中性站姿、干净纯背景、正交设定表风格、统一比例和高度。不要新增角色、文字、标志或装饰 UI",
  },
  {
    id: "lightingCorrection",
    title: "调色与光线校正",
    description: "对参考图进行专业电影调色和光线校正",
    category: "单图",
    icon: Sun,
    prompt:
      "这是对参考图进行调色和光线校正：严格保持相同人物、相同场景、相同构图和相同姿态，只应用专业电影调色、平衡曝光、受控高光与阴影、自然肤色、三向色彩校正、轻微胶片颗粒、IMAX / HDR 质感。不要重画主体，不要改变身份，不要在颜色和对比之外改变风格",
  },
  {
    id: "predictNext",
    title: "预测下一帧",
    description: "预测并渲染参考图之后的下一个合理瞬间",
    category: "单图",
    icon: SkipForward,
    prompt:
      "预测并渲染参考图之后的下一个合理瞬间：保持相同角色、身份、服装、地点和光线，让动作自然推进几秒，保持世界连续性，机位和取景可以自然变化，电影剧照质感。不要发明新角色，不要改变环境，不要把场景压缩成普通肖像",
  },
  {
    id: "predictPrevious",
    title: "预测上一帧",
    description: "预测并渲染导致参考图发生的上一个合理瞬间",
    category: "单图",
    icon: SkipBack,
    prompt:
      "预测并渲染导致参考图发生的上一个合理瞬间：保持相同角色、身份、服装、地点和光线，将动作自然回退几秒，保持世界连续性和场景逻辑，机位和取景可以自然变化，电影剧照质感。不要发明新角色，不要改变环境",
  },
];

const CATEGORIES = ["全部", "网格", "单图"] as const;

// ---- component ----

type CanvasTemplateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (template: CanvasTemplate) => void;
};

export function CanvasTemplateDialog({ open, onOpenChange, onConfirm }: CanvasTemplateDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("全部");

  const filtered = useMemo(() => {
    if (category === "全部") return CANVAS_TEMPLATES;
    return CANVAS_TEMPLATES.filter((t) => t.category === category);
  }, [category]);

  const selected = selectedId ? CANVAS_TEMPLATES.find((t) => t.id === selectedId) ?? null : null;

  const handleConfirm = () => {
    if (!selected) return;
    onConfirm(selected);
    setSelectedId(null);
    setCategory("全部");
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setSelectedId(null);
      setCategory("全部");
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[100dvh] max-h-[100dvh] w-screen flex-col sm:h-auto sm:max-h-[85vh] sm:w-full sm:max-w-2xl sm:rounded-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutDashboard className="h-4 w-4" />
            画布流程模板
            <span className="text-xs font-normal text-muted-foreground">选择一个模板导入到画布</span>
          </DialogTitle>
        </DialogHeader>

        {/* category tabs */}
        <div className="flex items-center gap-1.5 border-b pb-2">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              className={cn(
                "inline-flex min-h-7 shrink-0 items-center rounded-full border px-2.5 text-xs leading-tight whitespace-nowrap transition-colors",
                category === cat ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted",
              )}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* template grid */}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 gap-3 pb-3 md:grid-cols-2">
            {filtered.map((template) => {
              const Icon = template.icon;
              const isSelected = selectedId === template.id;
              return (
                <div
                  key={template.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(template.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedId(template.id);
                    }
                  }}
                  className={cn(
                    "group flex flex-col gap-2.5 rounded-md border p-3 text-left transition-colors",
                    isSelected ? "border-primary ring-1 ring-primary/30" : "border-border hover:border-muted-foreground/30",
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md", isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-foreground">{template.title}</p>
                        <Badge variant="outline" className="shrink-0 px-1.5 py-0.5 text-[10px]">
                          {template.category}
                        </Badge>
                        {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{template.description}</p>
                    </div>
                  </div>
                  <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground/70">{template.prompt}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* footer */}
        <div className="-mx-4 -mb-4 flex min-h-14 items-center justify-between gap-3 border-t bg-muted/50 px-4 py-3 text-xs">
          <span className="min-w-0 truncate text-muted-foreground">
            {selected ? `将导入：${selected.title}` : `${filtered.length} 个可用模板`}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
              取消
            </Button>
            <Button size="sm" onClick={handleConfirm} disabled={!selected}>
              导入到画布
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

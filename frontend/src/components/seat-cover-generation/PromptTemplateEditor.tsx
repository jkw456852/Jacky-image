import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, RotateCcw, Save, X } from 'lucide-react';
import { useEffectEvent } from 'react';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, Decoration, ViewPlugin, hoverTooltip, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export type PromptVariableDefinition = {
  key: string;
  label: string;
  description: string;
  example: string;
  group: string;
};

export const SEAT_COVER_PROMPT_VARIABLES: PromptVariableDefinition[] = [
  { key: 'vehicle.model', label: '车辆型号', description: '当前项目填写的车辆型号。', example: 'TOYOTA RAV 4', group: '车辆参数' },
  { key: 'vehicle.year', label: '车辆年份', description: '当前项目填写的车辆年份。', example: '2026', group: '车辆参数' },
  { key: 'vehicle.trim', label: '车辆配置', description: '当前项目填写的车型配置或版本。', example: 'Woodland', group: '车辆参数' },
  { key: 'vehicle.identity', label: '完整车型身份', description: '车型、年份和配置拼接后的完整身份。', example: 'TOYOTA RAV 4 2026 Woodland', group: '车辆参数' },
  { key: 'angle.name', label: '当前角度', description: '当前正在生成的预设角度名称。', example: '主驾', group: '当前角度' },
  { key: 'angle.seat_scope', label: '座椅范围', description: '当前角度对应的前排、后排或前后排范围。', example: '前排', group: '当前角度' },
  { key: 'references.guide_label', label: '角度引导图编号', description: '角度结构引导图在模型输入中的编号。需要指代摄影机位时使用这个变量。', example: 'Image 1', group: '参考图' },
  { key: 'references.count', label: '参考图数量', description: '本次实际发送给模型的原车资料图数量。', example: '3', group: '参考图' },
  { key: 'references.vehicle_range', label: '参考图编号范围', description: '原车资料在模型输入中的图片编号范围。', example: 'Images 2–4', group: '参考图' },
  { key: 'references.list', label: '参考图列表', description: '本次实际使用的参考图编号或列表文本。', example: 'Images 2–4', group: '参考图' },
  { key: 'search.instructions', label: '联网搜索规则', description: '开启联网搜索或搜图时插入；关闭时为空。', example: '联网只能检索精确配置……', group: '生成配置' },
  { key: 'provider.role_delivery', label: '图片角色总说明', description: '插入一整句模型适配说明，只应在【输入图片】开头使用一次；它不是图片编号，不能替代角度引导图编号。', example: '图片按照以下编号顺序上传，必须严格按照编号分工使用。', group: '生成配置' },
  { key: 'user.extra_prompt', label: '用户额外要求', description: '界面中填写的额外提示词。', example: '保留橙色缝线', group: '用户内容' },
];

const variableByKey = new Map(SEAT_COVER_PROMPT_VARIABLES.map(item => [item.key, item]));
const variablePattern = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const commentPattern = /\{\{![\s\S]*?\}\}/g;

const editorTheme = EditorView.theme({
  '&': { height: '100%', border: '1px solid hsl(var(--border))', borderRadius: '0.75rem', overflow: 'hidden', backgroundColor: 'hsl(var(--background))' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: '13px', lineHeight: '1.65' },
  '.cm-content': { padding: '14px 0' },
  '.cm-gutters': { backgroundColor: 'hsl(var(--muted) / 0.45)', color: 'hsl(var(--muted-foreground))', border: 'none' },
  '.cm-jacky-variable': { color: '#0f766e', backgroundColor: '#ccfbf1', borderRadius: '0.3rem', padding: '0 0.15rem', fontWeight: '700' },
  '.cm-jacky-comment': { color: '#94a3b8', fontStyle: 'italic' },
  '.cm-activeLine': { backgroundColor: 'hsl(var(--muted) / 0.35)' },
  '.cm-selectionBackground': { backgroundColor: 'hsl(var(--primary) / 0.22) !important' },
}, { dark: false });

function buildTokenDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of view.visibleRanges) {
    const { from, to } = range;
    const text = view.state.sliceDoc(from, to);
    const pattern = /\{\{![\s\S]*?\}\}|\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const start = from + match.index;
      const end = start + match[0].length;
      builder.add(start, end, match[0].startsWith('{{!') ? Decoration.mark({ class: 'cm-jacky-comment' }) : Decoration.mark({ class: 'cm-jacky-variable' }));
    }
  }
  return builder.finish();
}

class VariableHighlightPlugin {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildTokenDecorations(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet) this.decorations = buildTokenDecorations(update.view);
  }
}

const variableHighlight = ViewPlugin.fromClass(VariableHighlightPlugin, { decorations: value => value.decorations });

const variableHover = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const lineOffset = line.from;
  const pattern = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const start = lineOffset + match.index;
    const end = start + match[0].length;
    if (pos < start || pos > end) continue;
    const definition = variableByKey.get(match[1]);
    if (!definition) return { pos: start, end, above: true, create: () => ({ dom: tooltipDom('未知变量', '这个变量没有对应的动态参数。') }) };
    return { pos: start, end, above: true, create: () => ({ dom: tooltipDom(`${definition.label} · {{${definition.key}}}`, `${definition.description} 示例：${definition.example}`) }) };
  }
  return null;
});

function tooltipDom(title: string, body: string): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl';
  dom.style.maxWidth = '420px';
  dom.style.whiteSpace = 'normal';
  dom.style.overflowWrap = 'anywhere';
  const titleNode = document.createElement('div');
  titleNode.className = 'font-semibold';
  titleNode.textContent = title;
  const bodyNode = document.createElement('div');
  bodyNode.className = 'mt-1 max-w-xs text-muted-foreground';
  bodyNode.textContent = body;
  dom.append(titleNode, bodyNode);
  return dom;
}

function createEditorState(value: string, onChange: (value: string) => void): EditorState {
  return EditorState.create({
    doc: value,
    extensions: [
      history(),
      markdown(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      editorTheme,
      variableHighlight,
      variableHover,
      EditorView.lineWrapping,
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state.doc.toString()); }),
    ],
  });
}

export function PromptTemplateEditor({
  open,
  angleName,
  value,
  defaultValue,
  preview,
  onOpenChange,
  onSave,
  onReset,
  onDraftChange,
  showToast,
  standalone = false,
}: {
  open: boolean;
  angleName: string;
  value: string;
  defaultValue: string;
  preview: string;
  onOpenChange: (open: boolean) => void;
  onSave: (value: string) => Promise<void>;
  onReset: () => void;
  onDraftChange?: (value: string) => void;
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void;
  standalone?: boolean;
}) {
  const editorHost = useRef<HTMLDivElement | null>(null);
  const editorView = useRef<EditorView | null>(null);
  const onDraftChangeRef = useRef(onDraftChange);
  const [draft, setDraft] = useState(value);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [saving, setSaving] = useState(false);
  const getCurrentValue = useEffectEvent(() => value);

  useEffect(() => { onDraftChangeRef.current = onDraftChange; }, [onDraftChange]);

  useEffect(() => {
    if (!open || !editorHost.current) return undefined;
    const view = new EditorView({ state: createEditorState(getCurrentValue(), next => { setDraft(next); onDraftChangeRef.current?.(next); }), parent: editorHost.current });
    editorView.current = view;
    return () => { view.destroy(); editorView.current = null; };
  }, [open, angleName]);

  useEffect(() => {
    const view = editorView.current;
    if (!view) return;
    const currentDocument = view.state.doc.toString();
    if (currentDocument === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [angleName, open, value]);

  const unknownVariables = useMemo(() => {
    const withoutComments = draft.replace(commentPattern, '');
    return Array.from(withoutComments.matchAll(variablePattern)).map(match => match[1]).filter(key => !variableByKey.has(key));
  }, [draft]);

  const structuralIssues = useMemo(() => {
    if (!draft.includes('【输出目标】') || !draft.includes('【输入图片】')) return [];
    const count = (token: string) => draft.split(token).length - 1;
    const issues: string[] = [];
    if (count('{{provider.role_delivery}}') !== 1) issues.push('“图片角色总说明”必须且只能出现 1 次');
    if (count('{{references.guide_label}}') < 1) issues.push('缺少“角度引导图编号”变量');
    const hasRuleStart = draft.includes('{{! JACKY_ANGLE_RULE_START }}');
    const hasRuleEnd = draft.includes('{{! JACKY_ANGLE_RULE_END }}');
    if (hasRuleStart !== hasRuleEnd) issues.push('角度专用规则的开始/结束标记不完整');
    if ((hasRuleStart || hasRuleEnd) && !draft.includes('【摄影机位与构图】')) issues.push('角度专用规则缺少“摄影机位与构图”段落');
    return issues;
  }, [draft]);

  const insertVariable = (key: string) => {
    const view = editorView.current;
    if (!view) return;
    view.focus();
    view.dispatch(view.state.replaceSelection(`{{${key}}}`));
  };

  const reset = () => {
    onReset();
    const view = editorView.current;
    if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: defaultValue } });
  };

  const save = async () => {
    if (structuralIssues.length > 0) {
      showToast?.(`模板结构异常：${structuralIssues.join('；')}`, 'error');
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      showToast?.('提示词已保存，下次生成立即生效', 'success');
      onOpenChange(false);
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : '提示词保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const groupedVariables = Array.from(new Set(SEAT_COVER_PROMPT_VARIABLES.map(item => item.group)));
  const header = standalone ? <div className="flex items-start justify-between gap-4 border-b pb-3"><div><h1 className="text-lg font-semibold">编辑角度提示词 · {angleName}</h1><p className="mt-1 text-sm text-muted-foreground">所见即所发：这里只保存并发送编辑框中的内容，不会自动拼接公共提示词。变量会在发送前替换为本次任务的实际值。</p></div><Button variant="outline" onClick={() => onOpenChange(false)}><X className="size-4" />关闭</Button></div> : <DialogHeader><DialogTitle>编辑角度提示词 · {angleName}</DialogTitle><DialogDescription>所见即所发：这里只保存并发送编辑框中的内容，不会自动拼接公共提示词。变量会在发送前替换为本次任务的实际值。</DialogDescription></DialogHeader>;
  const content = <>
    {header}
    <div className="flex items-center gap-2 border-b pb-2">
      <Button size="sm" variant={tab === 'edit' ? 'default' : 'outline'} onClick={() => setTab('edit')}>编辑模板</Button>
      <Button size="sm" variant={tab === 'preview' ? 'default' : 'outline'} onClick={() => setTab('preview')}>最终预览</Button>
      <span className="ml-auto text-xs text-muted-foreground">{structuralIssues.length ? `发现 ${structuralIssues.length} 个结构问题` : unknownVariables.length ? `发现 ${unknownVariables.length} 个未知变量` : '变量检查通过'}</span>
    </div>
    <div className={cn("grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_300px]", tab !== 'edit' && 'hidden')}>
      <div ref={editorHost} className="h-full min-h-[420px]" />
      <aside className="max-h-[min(68dvh,680px)] overflow-auto rounded-xl border bg-muted/30 p-3">
        <div className="mb-2 text-sm font-semibold">快捷插入变量</div>
        {groupedVariables.map(group => <section key={group} className="mb-3"><div className="mb-1 text-[11px] font-semibold text-muted-foreground">{group}</div><div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">{SEAT_COVER_PROMPT_VARIABLES.filter(item => item.group === group).map(variable => <Tooltip key={variable.key}><TooltipTrigger render={<button type="button" className="w-full rounded-lg border bg-background px-2 py-1.5 text-left hover:border-primary hover:bg-primary/5" onMouseDown={event => event.preventDefault()} onClick={() => insertVariable(variable.key)} />}><div className="text-xs font-medium">{variable.label}</div><code className="text-[10px] text-teal-700">{'{{'}{variable.key}{'}}'}</code></TooltipTrigger><TooltipContent side="left" sideOffset={10} className="block w-[min(420px,calc(100vw-32px))] max-w-none whitespace-normal break-words px-3 py-2"><div className="font-semibold">{variable.label} · {'{{'}{variable.key}{'}}'}</div><div className="mt-1 leading-5 opacity-90">{variable.description}</div><div className="mt-1 leading-5 opacity-75">示例：{variable.example}</div></TooltipContent></Tooltip>)}</div></section>)}
      </aside>
    </div>
    <div className={cn("min-h-0 flex-1 overflow-auto rounded-xl border bg-muted/20 p-4", tab !== 'preview' && 'hidden')}><pre className="whitespace-pre-wrap text-xs leading-6">{preview || '暂无预览内容'}</pre></div>
    {structuralIssues.length > 0 && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">模板结构异常：{structuralIssues.join('；')}。请修复后再保存。</div>}
    {unknownVariables.length > 0 && <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">未知变量：{unknownVariables.join('、')}。渲染时会变为空，请检查拼写。</div>}
    <DialogFooter className={standalone ? 'mx-0 shrink-0 rounded-xl sm:justify-between' : 'flex-wrap sm:justify-between'}>
      <Button variant="ghost" onClick={reset}><RotateCcw className="size-4" />恢复默认</Button>
      <div className="flex gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}><X className="size-4" />取消</Button><Button onClick={() => void save()} disabled={saving || structuralIssues.length > 0}>{saving ? <Check className="size-4" /> : <Save className="size-4" />}{saving ? '保存中…' : '保存模板'}</Button></div>
    </DialogFooter>
  </>;
  if (standalone) return <main className="flex h-screen min-h-0 flex-col bg-background p-4 text-foreground"><section className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-4 rounded-2xl border bg-card p-4 shadow-sm">{content}</section></main>;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:h-[min(94dvh,940px)] sm:w-[min(96vw,1280px)] sm:max-w-none" showCloseButton={false}>{content}</DialogContent>
  </Dialog>;
}

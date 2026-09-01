export type SeatCoverPromptValue = string | number | boolean | null | undefined;

export interface SeatCoverPromptContext {
  vehicle: { model: string; year: string; trim: string; identity: string };
  angle: { name: string; prompt: string; seatScope: string };
  references: { count: number; guideLabel: string; vehicleRange: string; list: string };
  search: { instructions: string };
  provider: { roleDelivery: string };
  user: { extraPrompt: string };
}

export interface SeatCoverPromptBundle {
  prompts: Record<string, string>;
  defaults: Record<string, string>;
}

const ANGLE_RULE_START_MARKER = '{{! JACKY_ANGLE_RULE_START }}';
const ANGLE_RULE_END_MARKER = '{{! JACKY_ANGLE_RULE_END }}';

export function extractSeatCoverAngleRule(template: string): string {
  const normalized = String(template || '').trim();
  const start = normalized.indexOf(ANGLE_RULE_START_MARKER);
  const end = normalized.indexOf(ANGLE_RULE_END_MARKER);
  if (start < 0 || end <= start) return normalized;
  return normalized
    .slice(start + ANGLE_RULE_START_MARKER.length, end)
    .trim()
    .replace(/^【摄影机位与构图】\s*(?:\r?\n)?/, '')
    .trim();
}

export function renderSeatCoverPromptTemplate(template: string, context: SeatCoverPromptContext): string {
  const values: Record<string, SeatCoverPromptValue> = {
    'vehicle.model': context.vehicle.model,
    'vehicle.year': context.vehicle.year,
    'vehicle.trim': context.vehicle.trim,
    'vehicle.identity': context.vehicle.identity,
    'angle.name': context.angle.name,
    'angle.prompt': context.angle.prompt,
    'angle.seat_scope': context.angle.seatScope,
    'references.count': context.references.count,
    'references.guide_label': context.references.guideLabel,
    'references.vehicle_range': context.references.vehicleRange,
    'references.list': context.references.list,
    'search.instructions': context.search.instructions,
    'provider.role_delivery': context.provider.roleDelivery,
    'user.extra_prompt': context.user.extraPrompt,
  };
  return template
    .replace(/\{\{![\s\S]*?\}\}/g, '')
    .replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (full, key: string) => {
      const value = values[key];
      return value === null || value === undefined ? '' : String(value);
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function loadSeatCoverPromptBundle(): Promise<SeatCoverPromptBundle> {
  try {
    const response = await fetch('/api/jacky/seat-cover-prompts', { cache: 'no-store' });
    if (!response.ok) return { prompts: {}, defaults: {} };
    const data = await response.json() as { prompts?: Record<string, unknown>; defaults?: Record<string, unknown> };
    const normalize = (input?: Record<string, unknown>) => Object.fromEntries(Object.entries(input || {})
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, String(value).trim()]));
    return { prompts: normalize(data.prompts), defaults: normalize(data.defaults) };
  } catch {
    return { prompts: {}, defaults: {} };
  }
}

export async function loadSeatCoverAnglePrompt(name: string): Promise<string> {
  const bundle = await loadSeatCoverPromptBundle();
  return bundle.prompts[name] || '';
}

export async function saveSeatCoverAnglePrompt(name: string, content: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const normalizedContent = content.trim();
    const response = await fetch('/api/jacky/seat-cover-prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content: normalizedContent }),
    });
    const data = await response.json() as { ok?: boolean; error?: string };
    if (!response.ok || !data.ok) return { ok: false, error: data.error || '提示词保存失败' };
    const verified = await loadSeatCoverPromptBundle();
    if ((verified.prompts[name] || '').trim() !== normalizedContent) {
      return { ok: false, error: '提示词保存校验失败：重新读取的内容与刚保存的内容不一致' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: '提示词保存失败，请检查本地服务是否运行' };
  }
}

export type DesktopTaskStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface DesktopTaskSummary {
  id: string;
  status: DesktopTaskStatus;
  title: string;
  detail?: string;
  count?: number;
  updatedAt?: string;
}

const taskSources = new Map<string, DesktopTaskSummary[]>();
let lastPayload = '';

function compactText(value: string | undefined, maxLength: number): string | undefined {
  const compacted = value?.replace(/\s+/g, ' ').trim();
  if (!compacted) return undefined;
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, Math.max(0, maxLength - 1))}…`;
}

function publishMergedTasks(): void {
  if (typeof window === 'undefined') return;
  const update = window.jackyDesktop?.taskStatus?.update;
  if (!update) return;

  const merged = Array.from(taskSources.values())
    .flat()
    .map(task => ({
      ...task,
      title: compactText(task.title, 80) || '未命名任务',
      detail: compactText(task.detail, 160),
    }));
  const payload = JSON.stringify(merged);
  if (payload === lastPayload) return;
  lastPayload = payload;
  update(merged);
}

export function publishDesktopTaskSource(source: string, tasks: DesktopTaskSummary[]): void {
  taskSources.set(source, tasks);
  publishMergedTasks();
}

export function clearDesktopTaskSource(source: string): void {
  if (!taskSources.delete(source)) return;
  publishMergedTasks();
}

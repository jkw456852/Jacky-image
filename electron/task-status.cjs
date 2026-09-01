const ALLOWED_STATUSES = new Set(['queued', 'processing', 'completed', 'failed', 'cancelled', 'expired']);
const ACTIVE_STATUSES = new Set(['queued', 'processing']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);

function compactText(value, maxLength) {
  const compacted = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!compacted) return '';
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, Math.max(0, maxLength - 1))}…`;
}

function sanitizeTaskSummaries(value, maxTasks = 500) {
  if (!Array.isArray(value)) return [];

  const tasks = [];
  const seenIds = new Set();
  for (const candidate of value) {
    if (tasks.length >= maxTasks) break;
    if (!candidate || typeof candidate !== 'object') continue;

    const id = compactText(candidate.id, 160);
    const title = compactText(candidate.title, 80);
    const status = candidate.status;
    if (!id || !title || seenIds.has(id) || !ALLOWED_STATUSES.has(status)) continue;

    seenIds.add(id);
    tasks.push({
      id,
      status,
      title,
      ...(compactText(candidate.detail, 160) ? { detail: compactText(candidate.detail, 160) } : {}),
      ...(Number.isFinite(candidate.count) && candidate.count > 1
        ? { count: Math.min(99, Math.floor(candidate.count)) }
        : {}),
      ...(typeof candidate.updatedAt === 'string'
        ? { updatedAt: compactText(candidate.updatedAt, 48) }
        : {}),
    });
  }
  return tasks;
}

function buildTrayTooltip(tasks, appName = 'Jacky Image', maxLength = 127) {
  const activeTasks = tasks.filter(task => ACTIVE_STATUSES.has(task.status));
  if (activeTasks.length === 0) return `${appName} · 当前无进行中任务`;

  const lines = [`${appName} · ${activeTasks.length} 个任务进行中`];
  for (const task of activeTasks.slice(0, 2)) {
    const statusLabel = task.status === 'queued' ? '排队中' : '生成中';
    const countLabel = task.count ? ` ×${task.count}` : '';
    const detail = task.detail ? ` · ${compactText(task.detail, 28)}` : '';
    lines.push(`${statusLabel} · ${task.title}${countLabel}${detail}`);
  }
  if (activeTasks.length > 2) lines.push(`另有 ${activeTasks.length - 2} 个任务`);

  const tooltip = lines.join('\n');
  return tooltip.length <= maxLength ? tooltip : compactText(tooltip, maxLength);
}

function collectTaskTransitions(previousStatuses, tasks, hasPreviousSnapshot) {
  const nextStatuses = new Map(tasks.map(task => [task.id, task.status]));
  if (!hasPreviousSnapshot) return { nextStatuses, terminalTasks: [] };

  const terminalTasks = tasks.filter(task => {
    const previousStatus = previousStatuses.get(task.id);
    return ACTIVE_STATUSES.has(previousStatus) && TERMINAL_STATUSES.has(task.status);
  });
  return { nextStatuses, terminalTasks };
}

function buildTaskNotification(tasks) {
  const failedCount = tasks.filter(task => task.status === 'failed').length;
  const cancelledCount = tasks.filter(task => task.status === 'cancelled' || task.status === 'expired').length;
  const completedCount = tasks.length - failedCount - cancelledCount;
  let title;
  if (failedCount === 0 && cancelledCount === 0) title = tasks.length === 1 ? '任务已完成' : `${tasks.length} 个任务已完成`;
  else if (failedCount === 0 && completedCount === 0) title = tasks.length === 1 ? '任务已取消' : `${tasks.length} 个任务已取消`;
  else if (completedCount === 0) title = tasks.length === 1 ? '任务失败' : `${tasks.length} 个任务失败`;
  else title = '任务状态更新';

  const contentLines = tasks.slice(0, 3).map(task => {
    const resultLabel = task.status === 'failed' ? '失败' : (task.status === 'cancelled' ? '已取消' : (task.status === 'expired' ? '已过期' : '完成'));
    const detail = task.detail ? ` · ${compactText(task.detail, 60)}` : '';
    return `${task.title}（${resultLabel}）${detail}`;
  });
  if (tasks.length > 3) contentLines.push(`另有 ${tasks.length - 3} 个任务`);

  return {
    title,
    content: compactText(contentLines.join('\n'), 240),
    iconType: failedCount > 0 ? 'error' : 'info',
  };
}

module.exports = {
  buildTaskNotification,
  buildTrayTooltip,
  collectTaskTransitions,
  sanitizeTaskSummaries,
};

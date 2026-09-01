const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTrayTooltip,
  collectTaskTransitions,
  sanitizeTaskSummaries,
} = require('./task-status.cjs');

const activeTask = {
  id: 'workspace:1',
  status: 'processing',
  title: '图生图',
  detail: '把座椅替换成白色皮革座椅',
};

test('initial task snapshot does not create completion notifications', () => {
  const initial = collectTaskTransitions(new Map(), [{ ...activeTask, status: 'completed' }], false);
  assert.equal(initial.terminalTasks.length, 0);
  assert.equal(initial.nextStatuses.get(activeTask.id), 'completed');
});

test('active task completion is reported once', () => {
  const previous = new Map([[activeTask.id, 'processing']]);
  const completed = [{ ...activeTask, status: 'completed' }];
  const first = collectTaskTransitions(previous, completed, true);
  const second = collectTaskTransitions(first.nextStatuses, completed, true);
  assert.deepEqual(first.terminalTasks.map(task => task.id), [activeTask.id]);
  assert.equal(second.terminalTasks.length, 0);
});

test('regenerated task can report another completion', () => {
  const completed = [{ ...activeTask, status: 'completed' }];
  const activeAgain = collectTaskTransitions(new Map([[activeTask.id, 'completed']]), [activeTask], true);
  const completedAgain = collectTaskTransitions(activeAgain.nextStatuses, completed, true);
  assert.equal(activeAgain.terminalTasks.length, 0);
  assert.deepEqual(completedAgain.terminalTasks.map(task => task.id), [activeTask.id]);
});

test('tooltip lists active tasks and respects the Windows length limit', () => {
  const tasks = sanitizeTaskSummaries([
    activeTask,
    { ...activeTask, id: 'repaint:1', title: '高级重绘 · 区域 1', detail: '很长'.repeat(100) },
    { ...activeTask, id: 'gif:1', status: 'queued', title: 'GIF 网格图生成' },
  ]);
  const tooltip = buildTrayTooltip(tasks);
  assert.match(tooltip, /3 个任务进行中/);
  assert.match(tooltip, /图生图/);
  assert.ok(tooltip.length <= 127);
});

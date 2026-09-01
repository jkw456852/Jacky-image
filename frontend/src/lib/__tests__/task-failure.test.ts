import { describe, expect, it } from 'vitest';
import { classifyTaskFailure, classifyFailureFromMessage } from '@/lib/task-failure';
import type { JackyTaskResponse } from '@/lib/ccode-task-client';

function makeTask(overrides: Partial<JackyTaskResponse>): JackyTaskResponse {
  return {
    id: 't1',
    status: 'failed',
    ...overrides,
  } as JackyTaskResponse;
}

describe('classifyTaskFailure', () => {
  it('网络错误 → terminal=false（应允许"查看进度"）', () => {
    const task = makeTask({ error: '网络连接失败。请检查网络连接或稍后重试。' });
    const result = classifyTaskFailure(task);
    expect(result.terminal).toBe(false);
    expect(result.reason).toBe('network');
  });

  it('超时错误 → terminal=false', () => {
    const task = makeTask({ error: '请求超时，请稍后重试。' });
    const result = classifyTaskFailure(task);
    expect(result.terminal).toBe(false);
    expect(result.reason).toBe('network');
  });

  it('服务器重启 → terminal=true', () => {
    const task = makeTask({ error: '服务器重启，任务已中断，请重新生成' });
    const result = classifyTaskFailure(task);
    expect(result.terminal).toBe(true);
    expect(result.reason).toBe('restart');
  });

  it('绘图 API 4xx 失败 → terminal=true', () => {
    const task = makeTask({ error: 'API 请求失败: 401 Unauthorized {...}' });
    const result = classifyTaskFailure(task);
    expect(result.terminal).toBe(true);
    expect(result.reason).toBe('api');
  });

  it('绘图 API 5xx 失败 → terminal=true', () => {
    const task = makeTask({ error: 'API 请求失败: 503 Service Unavailable' });
    const result = classifyTaskFailure(task);
    expect(result.terminal).toBe(true);
    expect(result.reason).toBe('api');
  });

  it('所有图片生成失败汇总 → terminal=true', () => {
    const task = makeTask({ error: '所有图片生成失败: API 请求失败: 401 ...' });
    const result = classifyTaskFailure(task);
    expect(result.terminal).toBe(true);
    expect(result.reason).toBe('api');
  });

  it('expired 状态 → terminal=true（任务已删除/过期不可恢复）', () => {
    const task = makeTask({ status: 'expired', error: '该任务已超出取回时间' });
    const result = classifyTaskFailure(task);
    expect(result.terminal).toBe(true);
    expect(result.reason).toBe('expired');
  });

  it('未知失败消息 → terminal=false（保守起见允许查看进度）', () => {
    const task = makeTask({ error: '某种没见过的错误' });
    const result = classifyTaskFailure(task);
    expect(result.terminal).toBe(false);
    expect(result.reason).toBe('unknown');
  });

  it('processing 等非失败状态不被判定为 terminal', () => {
    const task = makeTask({ status: 'processing', error: undefined });
    const result = classifyTaskFailure(task);
    expect(result.terminal).toBe(false);
  });
});

describe('classifyFailureFromMessage', () => {
  it('从纯字符串消息推断网络错误', () => {
    expect(classifyFailureFromMessage('网络连接失败').reason).toBe('network');
    expect(classifyFailureFromMessage('Failed to fetch').reason).toBe('network');
  });

  it('从纯字符串消息识别服务器重启', () => {
    const r = classifyFailureFromMessage('服务器重启，任务已中断，请重新生成');
    expect(r.terminal).toBe(true);
    expect(r.reason).toBe('restart');
  });

  it('从纯字符串消息识别限流', () => {
    const r = classifyFailureFromMessage('请求太频繁，请稍后再试。');
    expect(r.terminal).toBe(true);
    expect(r.reason).toBe('rate_limit');
  });

  it('从纯字符串消息识别队列满或待处理过多', () => {
    const r = classifyFailureFromMessage('当前排队任务较多，请稍后再试。');
    expect(r.terminal).toBe(true);
    expect(r.reason).toBe('queue_full');
  });

  it('空消息 → unknown 非终态', () => {
    const r = classifyFailureFromMessage('');
    expect(r.terminal).toBe(false);
    expect(r.reason).toBe('unknown');
  });
});

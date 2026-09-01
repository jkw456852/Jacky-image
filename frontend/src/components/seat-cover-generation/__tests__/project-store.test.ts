import { describe, expect, it } from 'vitest';
import { normalizeSeatCoverWorkspace } from '../project-store';
import type { SeatCoverGenerationConfig, SeatCoverWorkspaceState } from '../types';

const defaultConfig: SeatCoverGenerationConfig = {
  model: 'gemini-3-pro-image-preview',
  outputSize: '2K',
  parallelCount: 1,
  temperature: 0.35,
  webSearchEnabled: false,
  imageSearchEnabled: false,
  gptImageAdvancedParams: {
    quality: 'auto',
    style: 'auto',
    background: 'auto',
  },
};

function workspaceWithAngleTask(task: SeatCoverWorkspaceState['angleTasks'][number]): SeatCoverWorkspaceState {
  return {
    version: 1,
    stage: 'angles',
    vehicleModel: '',
    vehicleYear: '',
    vehicleTrim: '',
    extraPrompt: '',
    selectedPresetIds: [],
    vehicleImages: [],
    frontCoverImages: [],
    rearCoverImages: [],
    angleTasks: [task],
    fittingTasks: [],
    globalConfig: defaultConfig,
  };
}

describe('seat-cover project store normalization', () => {
  it('turns interrupted generating candidates into failed candidates', () => {
    const workspace = normalizeSeatCoverWorkspace(workspaceWithAngleTask({
      id: 'angle-1',
      presetId: 'preset-1',
      presetName: '主驾',
      seatScope: 'front',
      status: 'generating',
      candidates: [{
        id: 'candidate-1',
        imageRef: '',
        selected: false,
        status: 'generating',
      }],
    }), defaultConfig);

    expect(workspace?.angleTasks[0].status).toBe('failed');
    expect(workspace?.angleTasks[0].error).toContain('软件重启后任务状态已中断');
    expect(workspace?.angleTasks[0].candidates[0].status).toBe('failed');
    expect(workspace?.angleTasks[0].candidates[0].error).toContain('软件重启后任务状态已中断');
  });

  it('repairs previously saved restart failures whose candidates were still generating', () => {
    const workspace = normalizeSeatCoverWorkspace(workspaceWithAngleTask({
      id: 'angle-1',
      presetId: 'preset-1',
      presetName: '主驾',
      seatScope: 'front',
      status: 'failed',
      error: '软件重启后任务状态已中断，请重新生成',
      candidates: [{
        id: 'candidate-1',
        imageRef: '',
        selected: false,
        status: 'generating',
      }],
    }), defaultConfig);

    expect(workspace?.angleTasks[0].status).toBe('failed');
    expect(workspace?.angleTasks[0].candidates[0].status).toBe('failed');
  });
});

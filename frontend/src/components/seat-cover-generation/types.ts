import type { GptImageAdvancedParams, ParallelCount } from '@/lib/model-capabilities';
import type { ModelId } from '@/lib/gemini-config';
import type { OutputSize } from '@/lib/job-store';

export type SeatCoverScope = 'front' | 'rear' | 'both';
export type SeatCoverStage = 'angles' | 'fitting';
export type SeatCoverTaskStatus = 'draft' | 'queued' | 'generating' | 'completed' | 'failed';
export type SeatCoverCandidateStatus = 'pending' | 'generating' | 'completed' | 'failed';
export type SeatCoverReferenceSelectionMode = 'auto' | 'manual';

export interface SeatCoverImageAsset {
  id: string;
  name: string;
  dataUrl: string;
  mimeType: string;
  preview: string;
  width?: number;
  height?: number;
  originalSize?: number;
  processedSize?: number;
}

export interface SeatCoverAnglePreset {
  id: string;
  name: string;
  imagePath: string;
  seatScope: SeatCoverScope;
  promptHint?: string;
  sortOrder: number;
}

export interface SeatCoverCandidate {
  id: string;
  imageRef: string;
  imageUrl?: string;
  width?: number;
  height?: number;
  selected: boolean;
  status?: SeatCoverCandidateStatus;
  error?: string;
}

export interface SeatCoverGenerationConfig {
  model: ModelId;
  outputSize: Extract<OutputSize, '1K' | '2K' | '4K'>;
  parallelCount: ParallelCount;
  temperature: number;
  webSearchEnabled: boolean;
  imageSearchEnabled: boolean;
  gptImageAdvancedParams: GptImageAdvancedParams;
}

export interface SeatCoverAngleTask {
  id: string;
  presetId: string;
  presetName: string;
  seatScope: SeatCoverScope;
  status: SeatCoverTaskStatus;
  candidates: SeatCoverCandidate[];
  referenceSelectionMode?: SeatCoverReferenceSelectionMode;
  referenceImageIds?: string[];
  lastUsedReferenceImageIds?: string[];
  error?: string;
  prompt?: string;
}

export interface SeatCoverFittingTask {
  id: string;
  angleTaskId: string;
  candidateId: string;
  angleName: string;
  seatScope: SeatCoverScope;
  baseImageRef: string;
  baseImageUrl?: string;
  baseImageWidth?: number;
  baseImageHeight?: number;
  status: SeatCoverTaskStatus;
  candidates: SeatCoverCandidate[];
  customConfig?: Partial<SeatCoverGenerationConfig>;
  maskEnabled?: boolean;
  maskDataUrl?: string;
  error?: string;
}

export interface SeatCoverWorkspaceState {
  version: 1;
  stage: SeatCoverStage;
  vehicleModel: string;
  vehicleYear: string;
  vehicleTrim: string;
  extraPrompt: string;
  selectedPresetIds: string[];
  vehicleImages: SeatCoverImageAsset[];
  frontCoverImages: SeatCoverImageAsset[];
  rearCoverImages: SeatCoverImageAsset[];
  angleTasks: SeatCoverAngleTask[];
  fittingTasks: SeatCoverFittingTask[];
  globalConfig: SeatCoverGenerationConfig;
}

export interface SeatCoverProject {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  workspace: SeatCoverWorkspaceState;
}

export interface SeatCoverProjectStore {
  version: 2;
  activeProjectId: string;
  projects: SeatCoverProject[];
}

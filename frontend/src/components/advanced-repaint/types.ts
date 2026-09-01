export type RepaintTool = 'brush' | 'rectangle' | 'smart' | 'eraser';

export type RepaintSelectionMode = 'replace' | 'add' | 'subtract';

export type RepaintReferenceRole = 'general' | 'structure' | 'appearance';

export type RepaintRegionStatus = 'ready' | 'queued' | 'generating' | 'completed' | 'failed';

export interface RepaintBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RepaintReferenceImage {
  id: string;
  name: string;
  dataUrl: string;
  mimeType: string;
}

export interface RepaintCandidate {
  id: string;
  imageUrl: string;
}

export interface RepaintRegion {
  id: string;
  name: string;
  order: number;
  pixelCount: number;
  tightBounds: RepaintBounds;
  cropBounds: RepaintBounds;
  sourceCropDataUrl: string;
  maskDataUrl: string;
  /** Optional non-destructive mask used only when compositing generated patches back. */
  compositeMaskDataUrl?: string;
  /** Generated patch translation in original-image pixels; the mask stays anchored. */
  patchOffsetX?: number;
  patchOffsetY?: number;
  prompt: string;
  referenceRole: RepaintReferenceRole;
  references: RepaintReferenceImage[];
  candidates: RepaintCandidate[];
  selectedCandidateId?: string;
  status: RepaintRegionStatus;
  statusText?: string;
  error?: string;
  enabled: boolean;
}

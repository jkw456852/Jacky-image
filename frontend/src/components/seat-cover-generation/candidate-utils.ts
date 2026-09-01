import { generateUUID } from '@/lib/uuid';
import type { SeatCoverCandidate } from './types';

export function candidateStatus(candidate: SeatCoverCandidate): NonNullable<SeatCoverCandidate['status']> {
  if (candidate.status) return candidate.status;
  return candidate.imageRef ? 'completed' : 'pending';
}

export function createCandidateSlots(count: number, prefix: string): SeatCoverCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-slot-${index + 1}-${generateUUID()}`,
    imageRef: '',
    selected: false,
    status: 'pending',
  }));
}

export function normalizeCandidateSlots(
  candidates: SeatCoverCandidate[],
  desiredCount: number,
  prefix: string,
): SeatCoverCandidate[] {
  const normalized: SeatCoverCandidate[] = candidates.slice(0, desiredCount).map(candidate => ({
    ...candidate,
    status: candidateStatus(candidate),
  }));
  if (normalized.length < desiredCount) {
    normalized.push(...createCandidateSlots(desiredCount - normalized.length, prefix));
  }
  return normalized;
}

export function normalizeExistingCandidates(
  candidates: SeatCoverCandidate[],
): SeatCoverCandidate[] {
  return candidates.map(candidate => ({
    ...candidate,
    status: candidateStatus(candidate),
  }));
}

export function appendCandidateSlots(
  candidates: SeatCoverCandidate[],
  count: number,
  prefix: string,
): SeatCoverCandidate[] {
  return [
    ...candidates.map(candidate => ({ ...candidate, status: candidateStatus(candidate) })),
    ...createCandidateSlots(count, prefix),
  ];
}

export function hasRetryableCandidates(candidates: SeatCoverCandidate[]): boolean {
  return candidates.some(candidate => candidateStatus(candidate) === 'failed' || candidateStatus(candidate) === 'pending');
}

export function completedCandidateCount(candidates: SeatCoverCandidate[]): number {
  return candidates.filter(candidate => candidateStatus(candidate) === 'completed').length;
}

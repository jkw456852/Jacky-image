import { describe, expect, it } from 'vitest';
import { appendCandidateSlots, candidateStatus, createCandidateSlots, hasRetryableCandidates, normalizeCandidateSlots, normalizeExistingCandidates } from '../candidate-utils';

describe('seat-cover candidate slots', () => {
  it('keeps successful candidates and adds missing retryable slots', () => {
    const slots = normalizeCandidateSlots([{ id: 'ok', imageRef: 'ID:test', selected: false }], 3, 'task');
    expect(slots).toHaveLength(3);
    expect(candidateStatus(slots[0])).toBe('completed');
    expect(hasRetryableCandidates(slots)).toBe(true);
  });

  it('creates stable pending slots for a new request', () => {
    const slots = createCandidateSlots(2, 'task');
    expect(slots).toHaveLength(2);
    expect(slots.every(slot => candidateStatus(slot) === 'pending')).toBe(true);
  });

  it('appends a fresh generation group without replacing completed candidates', () => {
    const previous = [{
      id: 'old-result',
      imageRef: 'ID:old-result',
      imageUrl: 'blob:old-result',
      selected: true,
      status: 'completed' as const,
    }];

    const slots = appendCandidateSlots(previous, 2, 'task');

    expect(slots).toHaveLength(3);
    expect(slots[0]).toMatchObject(previous[0]);
    expect(slots.slice(1).every(slot => candidateStatus(slot) === 'pending')).toBe(true);
    expect(new Set(slots.map(slot => slot.id)).size).toBe(3);
  });

  it('keeps all existing candidates when retrying a specific candidate', () => {
    const previous = [
      { id: 'ok-1', imageRef: 'FILE:old-0', selected: false, status: 'completed' as const },
      { id: 'ok-2', imageRef: 'FILE:old-1', selected: false, status: 'completed' as const },
      { id: 'failed-late', imageRef: '', selected: false, status: 'failed' as const },
    ];

    const slots = normalizeExistingCandidates(previous);

    expect(slots.map(slot => slot.id)).toEqual(['ok-1', 'ok-2', 'failed-late']);
    expect(candidateStatus(slots[2])).toBe('failed');
  });

});

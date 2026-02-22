import type { SessionStatus } from '../types/domain.js';

const NEXT_STATES: Record<SessionStatus, SessionStatus[]> = {
  created: ['accepted'],
  accepted: ['prepared'],
  prepared: ['active'],
  active: ['agreed', 'no_agreement', 'failed'],
  agreed: [],
  no_agreement: [],
  failed: [],
  settled: [],
  refunded: [],
  cancelled: []
};

export function canTransitionSession(current: SessionStatus, next: SessionStatus): boolean {
  return NEXT_STATES[current]?.includes(next) ?? false;
}

export function allowedNextStates(current: SessionStatus): SessionStatus[] {
  return [...(NEXT_STATES[current] ?? [])];
}

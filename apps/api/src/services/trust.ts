import type { SessionRecord } from '../types/domain.js';
import type { Store } from './store.js';
import { isFinalSessionStatus, verifySessionAttestationRecord } from './attestation.js';

export type TrustedSessionResult = {
  sessionId: string;
  trusted: boolean;
  status: SessionRecord['status'];
  participants: string[];
  reasons: string[];
};

export type TrustedLeaderboardEntry = {
  agentId: string;
  trustedSessions: number;
  agreements: number;
  noAgreements: number;
  failures: number;
  trustScore: number;
};

export type TrustedLeaderboardResult = {
  trustedSessions: TrustedSessionResult[];
  excludedSessions: TrustedSessionResult[];
  leaderboard: TrustedLeaderboardEntry[];
};

function evaluateSessionTrust(session: SessionRecord, store: Store): TrustedSessionResult {
  const participants = [session.proposerAgentId, session.counterpartyAgentId].filter((id): id is string => Boolean(id));

  if (!isFinalSessionStatus(session.status)) {
    return {
      sessionId: session.id,
      trusted: false,
      status: session.status,
      participants,
      reasons: ['session_not_final']
    };
  }

  const attestation = store.getAttestation(session.id);
  if (!attestation) {
    return {
      sessionId: session.id,
      trusted: false,
      status: session.status,
      participants,
      reasons: ['attestation_missing']
    };
  }

  const turns = store.listSessionTurns(session.id);
  const verification = verifySessionAttestationRecord(attestation, session, turns);

  return {
    sessionId: session.id,
    trusted: verification.valid,
    status: session.status,
    participants,
    reasons: verification.reasons
  };
}

export function buildTrustedLeaderboard(store: Store): TrustedLeaderboardResult {
  const sessions = store.listSessions();
  const results = sessions.map((session) => evaluateSessionTrust(session, store));

  const trustedSessions = results.filter((item) => item.trusted);
  const excludedSessions = results.filter((item) => !item.trusted);

  const aggregate = new Map<string, TrustedLeaderboardEntry>();

  for (const trusted of trustedSessions) {
    const sourceSession = sessions.find((session) => session.id === trusted.sessionId);
    if (!sourceSession) continue;

    for (const agentId of trusted.participants) {
      const row = aggregate.get(agentId) ?? {
        agentId,
        trustedSessions: 0,
        agreements: 0,
        noAgreements: 0,
        failures: 0,
        trustScore: 0
      };

      row.trustedSessions += 1;

      if (sourceSession.status === 'agreed') row.agreements += 1;
      if (sourceSession.status === 'no_agreement') row.noAgreements += 1;
      if (sourceSession.status === 'failed') row.failures += 1;

      row.trustScore = row.agreements * 3 + row.noAgreements - row.failures * 2;
      aggregate.set(agentId, row);
    }
  }

  const leaderboard = [...aggregate.values()].sort((a, b) => {
    if (b.trustScore !== a.trustScore) return b.trustScore - a.trustScore;
    if (b.agreements !== a.agreements) return b.agreements - a.agreements;
    return a.agentId.localeCompare(b.agentId);
  });

  return {
    trustedSessions,
    excludedSessions,
    leaderboard
  };
}

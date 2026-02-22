import { z } from 'zod';
import type { EscrowRecord, SessionRecord } from '../types/domain.js';
import type { Store } from './store.js';
import { nowIso } from '../utils/time.js';

const sessionEscrowSchema = z.object({
  enabled: z.boolean().optional(),
  contractAddress: z.string().min(1),
  tokenAddress: z.string().min(1).optional(),
  amountPerPlayer: z.string().regex(/^\d+$/),
  playerAAgentId: z.string().min(1).optional(),
  playerBAgentId: z.string().min(1).optional()
});

export type SessionEscrowConfig = z.infer<typeof sessionEscrowSchema>;

export type EscrowSettlementResult = {
  action: 'none' | 'settled' | 'refunded' | 'pending';
  escrow?: EscrowRecord;
  reason?: string;
};

function toBigIntSafe(value: string): bigint | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

export function parseSessionEscrowConfig(session: SessionRecord): SessionEscrowConfig | undefined {
  const terms = (session.terms ?? {}) as Record<string, unknown>;
  const raw = terms.escrow;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const parsed = sessionEscrowSchema.safeParse(raw);
  if (!parsed.success) return undefined;

  if (parsed.data.enabled === false) return undefined;
  return parsed.data;
}

export function escrowFundingReady(record: EscrowRecord): boolean {
  return record.playerADeposited && record.playerBDeposited;
}

export function prepareSessionEscrow(store: Store, session: SessionRecord): EscrowRecord | undefined {
  const config = parseSessionEscrowConfig(session);
  if (!config) return undefined;

  const existing = store.getEscrow(session.id);
  if (existing) return existing;

  return store.upsertEscrow({
    sessionId: session.id,
    contractAddress: config.contractAddress,
    tokenAddress: config.tokenAddress,
    stakeAmount: config.amountPerPlayer,
    status: 'prepared',
    txHash: undefined,
    playerAAgentId: config.playerAAgentId ?? session.proposerAgentId,
    playerBAgentId: config.playerBAgentId ?? session.counterpartyAgentId,
    playerADeposited: false,
    playerBDeposited: false,
    settlementAttempts: 0,
    lastSettlementError: undefined,
    lastSettlementAt: undefined,
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
}

export function applyEscrowDeposit(input: {
  store: Store;
  session: SessionRecord;
  actorAgentId: string;
  amount: string;
  txHash?: string;
}): EscrowRecord | undefined {
  const { store, session, actorAgentId, amount, txHash } = input;
  const escrow = store.getEscrow(session.id);
  if (!escrow) return undefined;

  const depositAmount = toBigIntSafe(amount);
  const requiredAmount = toBigIntSafe(escrow.stakeAmount);
  if (!depositAmount || !requiredAmount) return escrow;

  const accepted = depositAmount >= requiredAmount;

  let playerADeposited = escrow.playerADeposited;
  let playerBDeposited = escrow.playerBDeposited;

  if (escrow.playerAAgentId && actorAgentId === escrow.playerAAgentId) {
    playerADeposited = playerADeposited || accepted;
  }

  if (escrow.playerBAgentId && actorAgentId === escrow.playerBAgentId) {
    playerBDeposited = playerBDeposited || accepted;
  }

  const nextStatus = playerADeposited && playerBDeposited
    ? 'funded'
    : (playerADeposited || playerBDeposited ? 'funding_pending' : 'prepared');

  return store.patchEscrow(session.id, {
    status: nextStatus,
    txHash: txHash ?? escrow.txHash,
    playerADeposited,
    playerBDeposited,
    lastSettlementError: undefined
  });
}

export function settleEscrowForSession(store: Store, sessionId: string): EscrowSettlementResult {
  const session = store.getSession(sessionId);
  if (!session) {
    return { action: 'none', reason: 'session_not_found' };
  }

  const escrow = store.getEscrow(session.id);
  if (!escrow) {
    return { action: 'none', reason: 'escrow_not_prepared' };
  }

  if (escrow.status === 'settled' || escrow.status === 'refunded') {
    return { action: 'none', escrow, reason: 'already_finalized' };
  }

  if (session.status === 'agreed') {
    if (!escrowFundingReady(escrow)) {
      const patched = store.patchEscrow(session.id, {
        status: 'settlement_pending',
        settlementAttempts: escrow.settlementAttempts + 1,
        lastSettlementError: 'funding_pending',
        lastSettlementAt: nowIso()
      });

      return {
        action: 'pending',
        escrow: patched,
        reason: 'funding_pending'
      };
    }

    const patched = store.patchEscrow(session.id, {
      status: 'settled',
      settlementAttempts: escrow.settlementAttempts + 1,
      lastSettlementError: undefined,
      lastSettlementAt: nowIso(),
      txHash: escrow.txHash ?? `settle_${Date.now()}`
    });

    return {
      action: 'settled',
      escrow: patched
    };
  }

  if (session.status === 'no_agreement' || session.status === 'failed') {
    const patched = store.patchEscrow(session.id, {
      status: 'refunded',
      settlementAttempts: escrow.settlementAttempts + 1,
      lastSettlementError: undefined,
      lastSettlementAt: nowIso(),
      txHash: escrow.txHash ?? `refund_${Date.now()}`
    });

    return {
      action: 'refunded',
      escrow: patched
    };
  }

  return {
    action: 'none',
    escrow,
    reason: 'session_not_final'
  };
}

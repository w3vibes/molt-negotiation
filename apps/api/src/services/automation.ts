import type { Store } from './store.js';
import { settleEscrowForSession } from './escrow.js';

export type AutomationTickSummary = {
  scanned: number;
  settled: number;
  refunded: number;
  pending: number;
  unchanged: number;
  results: Array<{
    sessionId: string;
    action: 'none' | 'settled' | 'refunded' | 'pending';
    reason?: string;
  }>;
};

export function escrowAutomationEnabledByDefault(): boolean {
  return process.env.NEG_AUTOMATION_ESCROW_ENABLED !== 'false';
}

export function escrowAutomationIntervalMs(): number {
  const parsed = Number(process.env.NEG_AUTOMATION_ESCROW_INTERVAL_MS || '15000');
  if (!Number.isFinite(parsed) || parsed <= 0) return 15000;
  return parsed;
}

export function runEscrowAutomationTick(store: Store): AutomationTickSummary {
  const targets = store.listEscrows().filter((escrow) => {
    return [
      'funded',
      'settlement_pending',
      'refund_pending',
      'prepared',
      'funding_pending'
    ].includes(escrow.status);
  });

  const summary: AutomationTickSummary = {
    scanned: targets.length,
    settled: 0,
    refunded: 0,
    pending: 0,
    unchanged: 0,
    results: []
  };

  for (const escrow of targets) {
    const result = settleEscrowForSession(store, escrow.sessionId);
    summary.results.push({
      sessionId: escrow.sessionId,
      action: result.action,
      reason: result.reason
    });

    if (result.action === 'settled') summary.settled += 1;
    else if (result.action === 'refunded') summary.refunded += 1;
    else if (result.action === 'pending') summary.pending += 1;
    else summary.unchanged += 1;
  }

  return summary;
}

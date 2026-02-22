import type { FastifyInstance } from 'fastify';
import { requireRole } from '../services/access.js';
import {
  escrowAutomationEnabledByDefault,
  escrowAutomationIntervalMs,
  runEscrowAutomationTick
} from '../services/automation.js';
import type { Store } from '../services/store.js';

export function registerAutomationRoutes(app: FastifyInstance, store: Store) {
  app.get('/automation/status', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly', store)) return;

    const escrows = store.listEscrows();
    const pending = escrows.filter((escrow) => ['prepared', 'funding_pending', 'funded', 'settlement_pending', 'refund_pending'].includes(escrow.status));

    return {
      ok: true,
      config: {
        enabled: escrowAutomationEnabledByDefault(),
        intervalMs: escrowAutomationIntervalMs()
      },
      totals: {
        escrows: escrows.length,
        pending: pending.length
      },
      pending: pending.map((item) => ({
        sessionId: item.sessionId,
        status: item.status,
        settlementAttempts: item.settlementAttempts,
        lastSettlementError: item.lastSettlementError
      }))
    };
  });

  app.post('/automation/tick', async (req, reply) => {
    if (!requireRole(req, reply, 'operator', store)) return;

    const summary = runEscrowAutomationTick(store);
    return {
      ok: true,
      summary
    };
  });
}

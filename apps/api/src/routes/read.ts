import type { FastifyInstance } from 'fastify';
import type { SessionStatus } from '../types/domain.js';
import { requireRole } from '../services/access.js';
import type { Store } from '../services/store.js';

const SESSION_STATUSES: SessionStatus[] = [
  'created',
  'accepted',
  'prepared',
  'active',
  'agreed',
  'no_agreement',
  'failed',
  'settled',
  'refunded',
  'cancelled'
];

export function registerReadRoutes(app: FastifyInstance, store: Store) {
  app.get('/agents', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly', store)) return;
    const includeDisabled = String((req.query as { includeDisabled?: string }).includeDisabled || '').toLowerCase() === 'true';
    return store.listAgents(includeDisabled);
  });

  app.get('/sessions', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly', store)) return;

    const statusRaw = (req.query as { status?: string }).status;
    const status = statusRaw && SESSION_STATUSES.includes(statusRaw as SessionStatus)
      ? (statusRaw as SessionStatus)
      : undefined;

    return {
      ok: true,
      sessions: store.listSessions(status)
    };
  });
}

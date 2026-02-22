import type { FastifyInstance } from 'fastify';
import { requireRole } from '../services/access.js';
import { buildTrustedLeaderboard } from '../services/trust.js';
import type { Store } from '../services/store.js';

export function registerLeaderboardRoutes(app: FastifyInstance, store: Store) {
  app.get('/leaderboard/trusted', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly', store)) return;

    const result = buildTrustedLeaderboard(store);

    return {
      ok: true,
      summary: {
        trustedSessions: result.trustedSessions.length,
        excludedSessions: result.excludedSessions.length,
        leaderboardAgents: result.leaderboard.length
      },
      leaderboard: result.leaderboard,
      trustedSessions: result.trustedSessions,
      excludedSessions: result.excludedSessions
    };
  });
}

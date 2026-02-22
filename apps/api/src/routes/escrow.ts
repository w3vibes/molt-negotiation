import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isPrivilegedRole, requireRole, resolveAccessContext } from '../services/access.js';
import {
  applyEscrowDeposit,
  escrowFundingReady,
  parseSessionEscrowConfig,
  prepareSessionEscrow,
  settleEscrowForSession
} from '../services/escrow.js';
import { sendError } from '../services/errors.js';
import type { Store } from '../services/store.js';

const sessionIdParamSchema = z.object({
  id: z.string().min(1)
});

const depositSchema = z.object({
  agentId: z.string().min(1).optional(),
  amount: z.string().regex(/^\d+$/),
  txHash: z.string().min(1).optional()
});

function parseParams(input: unknown) {
  return sessionIdParamSchema.safeParse(input);
}

function isParticipant(agentId: string, session: { proposerAgentId: string; counterpartyAgentId?: string }): boolean {
  return session.proposerAgentId === agentId || session.counterpartyAgentId === agentId;
}

export function registerEscrowRoutes(app: FastifyInstance, store: Store) {
  app.post('/sessions/:id/escrow/prepare', async (req, reply) => {
    if (!requireRole(req, reply, 'agent', store)) return;

    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const session = store.getSession(params.data.id);
    if (!session) {
      return sendError(reply, 404, 'not_found', 'Session not found', { sessionId: params.data.id });
    }

    const config = parseSessionEscrowConfig(session);
    if (!config) {
      return sendError(reply, 400, 'invalid_request', 'Session does not have escrow configuration');
    }

    const access = resolveAccessContext(req, store);
    if (!isPrivilegedRole(access.role) && !isParticipant(access.actorAgentId ?? '', session)) {
      return sendError(reply, 403, 'actor_scope_violation', 'Only participants can prepare escrow', {
        actorAgentId: access.actorAgentId ?? null
      });
    }

    const existing = store.getEscrow(session.id);
    const escrow = prepareSessionEscrow(store, session);

    if (!escrow) {
      return sendError(reply, 500, 'internal_error', 'Failed to prepare escrow');
    }

    return {
      ok: true,
      idempotent: Boolean(existing),
      escrow,
      readiness: {
        funded: escrowFundingReady(escrow),
        playerADeposited: escrow.playerADeposited,
        playerBDeposited: escrow.playerBDeposited
      }
    };
  });

  app.get('/sessions/:id/escrow/status', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly', store)) return;

    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const session = store.getSession(params.data.id);
    if (!session) {
      return sendError(reply, 404, 'not_found', 'Session not found', { sessionId: params.data.id });
    }

    const escrow = store.getEscrow(session.id);
    if (!escrow) {
      return sendError(reply, 404, 'not_found', 'Escrow not prepared', {
        sessionId: session.id
      });
    }

    return {
      ok: true,
      escrow,
      readiness: {
        funded: escrowFundingReady(escrow),
        playerADeposited: escrow.playerADeposited,
        playerBDeposited: escrow.playerBDeposited
      }
    };
  });

  app.post('/sessions/:id/escrow/deposit', async (req, reply) => {
    if (!requireRole(req, reply, 'agent', store)) return;

    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const parsedBody = depositSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid deposit payload', {
        issues: parsedBody.error.issues
      });
    }

    const session = store.getSession(params.data.id);
    if (!session) {
      return sendError(reply, 404, 'not_found', 'Session not found', { sessionId: params.data.id });
    }

    const access = resolveAccessContext(req, store);
    const actorAgentId = parsedBody.data.agentId ?? access.actorAgentId;
    if (!actorAgentId) {
      return sendError(reply, 400, 'invalid_request', 'agentId is required when no agent key is used');
    }

    if (!isPrivilegedRole(access.role) && access.actorAgentId !== actorAgentId) {
      return sendError(reply, 403, 'actor_scope_violation', 'Agent can only report own deposits', {
        actorAgentId: access.actorAgentId ?? null,
        requestedAgentId: actorAgentId
      });
    }

    if (!isParticipant(actorAgentId, session)) {
      return sendError(reply, 400, 'invalid_request', 'agentId must be a session participant');
    }

    const updated = applyEscrowDeposit({
      store,
      session,
      actorAgentId,
      amount: parsedBody.data.amount,
      txHash: parsedBody.data.txHash
    });

    if (!updated) {
      return sendError(reply, 409, 'prepare_required_before_start', 'Escrow must be prepared before deposits are reported', {
        sessionId: session.id
      });
    }

    return {
      ok: true,
      escrow: updated,
      readiness: {
        funded: escrowFundingReady(updated),
        playerADeposited: updated.playerADeposited,
        playerBDeposited: updated.playerBDeposited
      }
    };
  });

  app.post('/sessions/:id/escrow/settle', async (req, reply) => {
    if (!requireRole(req, reply, 'agent', store)) return;

    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const session = store.getSession(params.data.id);
    if (!session) {
      return sendError(reply, 404, 'not_found', 'Session not found', { sessionId: params.data.id });
    }

    const access = resolveAccessContext(req, store);
    if (!isPrivilegedRole(access.role) && !isParticipant(access.actorAgentId ?? '', session)) {
      return sendError(reply, 403, 'actor_scope_violation', 'Only participants can settle session escrow', {
        actorAgentId: access.actorAgentId ?? null
      });
    }

    const result = settleEscrowForSession(store, session.id);

    if (result.action === 'pending') {
      return sendError(reply, 409, 'funding_pending', 'Escrow funding is incomplete', {
        sessionId: session.id,
        escrow: result.escrow,
        reason: result.reason
      });
    }

    if (result.action === 'none' && result.reason === 'session_not_final') {
      return sendError(reply, 409, 'invalid_state_transition', 'Session must be finalized before escrow settlement', {
        sessionId: session.id,
        currentStatus: session.status
      });
    }

    if (result.action === 'none' && result.reason === 'escrow_not_prepared') {
      return sendError(reply, 409, 'prepare_required_before_start', 'Escrow is not prepared for this session', {
        sessionId: session.id
      });
    }

    return {
      ok: true,
      action: result.action,
      escrow: result.escrow,
      reason: result.reason
    };
  });
}

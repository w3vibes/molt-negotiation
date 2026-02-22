import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  isPrivilegedRole,
  requireRole,
  resolveAccessContext
} from '../services/access.js';
import {
  createSessionAttestationRecord,
  isFinalSessionStatus,
  verifySessionAttestationRecord
} from '../services/attestation.js';
import { sendError } from '../services/errors.js';
import {
  privateNegotiationContextSchema,
  runNegotiationEngine
} from '../services/negotiationEngine.js';
import { runEndpointNegotiation } from '../services/endpointNegotiation.js';
import { evaluateStrictSessionPolicy } from '../services/strictSessionPolicy.js';
import {
  allowEngineFallbackByDefault,
  attestationRequiredByDefault,
  endpointNegotiationRequiredByDefault,
  privacyRedactionRequiredByDefault
} from '../services/policy.js';
import {
  parseSessionEscrowConfig,
  settleEscrowForSession
} from '../services/escrow.js';
import {
  assertPrivacySafePublicPayload,
  redactForLog,
  redactSensitiveData
} from '../services/privacy.js';
import { allowedNextStates, canTransitionSession } from '../services/sessionState.js';
import { unsealPrivatePayload, sealPrivatePayload } from '../services/sealedInputs.js';
import type { Store } from '../services/store.js';
import { generateApiKey, generateSessionId } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';

const sessionEscrowConfigSchema = z.object({
  enabled: z.boolean().optional(),
  contractAddress: z.string().min(1),
  tokenAddress: z.string().min(1).optional(),
  amountPerPlayer: z.string().regex(/^\d+$/),
  playerAAgentId: z.string().min(1).optional(),
  playerBAgentId: z.string().min(1).optional()
});

const sessionCreateSchema = z.object({
  id: z.string().min(1).optional(),
  topic: z.string().min(1),
  proposerAgentId: z.string().min(1),
  counterpartyAgentId: z.string().min(1).optional(),
  terms: z.record(z.string(), z.unknown()).optional(),
  escrow: sessionEscrowConfigSchema.optional()
});

const sessionAcceptSchema = z.object({
  counterpartyAgentId: z.string().min(1).optional()
});

const sessionIdParamSchema = z.object({
  id: z.string().min(1)
});

const privateInputSchema = z.object({
  agentId: z.string().min(1).optional(),
  privateContext: privateNegotiationContextSchema,
  publicContext: z.record(z.string(), z.unknown()).optional()
});

const negotiateSchema = z.object({
  maxTurns: z.number().int().min(1).max(50).optional()
});

const adjudicateSchema = z.object({
  status: z.enum(['agreed', 'no_agreement', 'failed']).default('failed'),
  agreement: z.record(z.string(), z.unknown()).optional(),
  note: z.string().max(500).optional()
});

const negotiateDirectSchema = z.object({
  sessionId: z.string().min(1),
  maxTurns: z.number().int().min(1).max(50).optional()
});

function parseParams(input: unknown) {
  return sessionIdParamSchema.safeParse(input);
}

function parseCreateBody(input: unknown) {
  return sessionCreateSchema.safeParse(input);
}

function parseAcceptBody(input: unknown) {
  return sessionAcceptSchema.safeParse(input);
}

function actorCanManageSession(actorAgentId: string | undefined, proposerId: string, counterpartyId: string | undefined): boolean {
  if (!actorAgentId) return false;
  return actorAgentId === proposerId || actorAgentId === counterpartyId;
}

function agentIsParticipant(agentId: string, session: { proposerAgentId: string; counterpartyAgentId?: string }): boolean {
  return session.proposerAgentId === agentId || session.counterpartyAgentId === agentId;
}

function ensureSessionActorScope(
  req: FastifyRequest,
  reply: FastifyReply,
  store: Store,
  session: { proposerAgentId: string; counterpartyAgentId?: string }
): { actorAgentId?: string; privileged: boolean } | null {
  const access = resolveAccessContext(req, store);
  const privileged = isPrivilegedRole(access.role);

  if (!privileged && !actorCanManageSession(access.actorAgentId, session.proposerAgentId, session.counterpartyAgentId)) {
    sendError(reply, 403, 'actor_scope_violation', 'Only session participants can perform this action', {
      actorAgentId: access.actorAgentId ?? null,
      proposerAgentId: session.proposerAgentId,
      counterpartyAgentId: session.counterpartyAgentId ?? null
    });
    return null;
  }

  return {
    actorAgentId: access.actorAgentId,
    privileged
  };
}

function privacyAssertionEnabled(): boolean {
  return privacyRedactionRequiredByDefault();
}

function attestationEnabled(): boolean {
  return attestationRequiredByDefault();
}

function spreadBand(spread: unknown): string {
  const value = typeof spread === 'number' && Number.isFinite(spread) ? Math.max(0, spread) : NaN;
  if (!Number.isFinite(value)) return 'unknown';
  if (value === 0) return 'crossed';
  if (value <= 1) return 'tight';
  if (value <= 5) return 'narrow';
  if (value <= 20) return 'moderate';
  return 'wide';
}

function priceBand(price: unknown): string | undefined {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return undefined;
  if (price < 50) return '<50';
  if (price < 100) return '50-99';
  if (price < 250) return '100-249';
  if (price < 500) return '250-499';
  if (price < 1000) return '500-999';
  return '1000+';
}

function sanitizeTurnSummary(summary: Record<string, unknown>): Record<string, unknown> {
  const buyerOffer = typeof summary.buyerOffer === 'number' ? summary.buyerOffer : undefined;
  const sellerAsk = typeof summary.sellerAsk === 'number' ? summary.sellerAsk : undefined;
  const spread = typeof summary.spread === 'number' ? summary.spread : undefined;
  const agreedPrice = typeof summary.agreedPrice === 'number' ? summary.agreedPrice : undefined;

  const reduced = {
    ...summary,
    ...(buyerOffer != null ? { buyerOfferBand: priceBand(buyerOffer) } : {}),
    ...(sellerAsk != null ? { sellerAskBand: priceBand(sellerAsk) } : {}),
    spreadBand: spreadBand(spread),
    ...(agreedPrice != null ? { agreedPriceBand: priceBand(agreedPrice) } : {}),
    buyerOffer: undefined,
    sellerAsk: undefined,
    spread: undefined,
    agreedPrice: undefined
  };

  return Object.fromEntries(Object.entries(reduced).filter(([, value]) => value !== undefined));
}

function createAndPersistSessionAttestation(store: Store, sessionId: string) {
  const session = store.getSession(sessionId);
  if (!session) {
    return {
      ok: false as const,
      reason: 'session_not_found'
    };
  }

  if (!isFinalSessionStatus(session.status)) {
    return {
      ok: false as const,
      reason: 'session_not_final'
    };
  }

  const turns = store.listSessionTurns(session.id);

  try {
    const record = createSessionAttestationRecord(session, turns, store);
    const saved = store.saveAttestation(record);
    const verification = verifySessionAttestationRecord(saved, session, turns);

    return {
      ok: true as const,
      session,
      attestation: saved,
      verification
    };
  } catch (error) {
    return {
      ok: false as const,
      reason: error instanceof Error ? error.message : 'attestation_create_failed'
    };
  }
}

async function executeNegotiation(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  store: Store,
  sessionId: string,
  maxTurns?: number
) {
  if (!requireRole(req, reply, 'agent', store)) return;

  const session = store.getSession(sessionId);
  if (!session) {
    return sendError(reply, 404, 'not_found', 'Session not found', { sessionId });
  }

  const scope = ensureSessionActorScope(req, reply, store, session);
  if (!scope) return;

  if (session.status !== 'active') {
    return sendError(reply, 409, 'negotiation_not_active', 'Session must be active before negotiation', {
      sessionId,
      currentStatus: session.status
    });
  }

  if (!session.counterpartyAgentId) {
    return sendError(reply, 400, 'invalid_request', 'Session counterpartyAgentId is required before negotiation');
  }

  const proposerAgent = store.getAgent(session.proposerAgentId);
  const counterpartyAgent = store.getAgent(session.counterpartyAgentId);

  const strictPolicy = evaluateStrictSessionPolicy({
    proposer: proposerAgent,
    counterparty: counterpartyAgent
  });

  if (!strictPolicy.ok) {
    return sendError(reply, 400, 'strict_policy_failed', 'Session participants failed strict policy checks', {
      sessionId,
      reasons: strictPolicy.reasons,
      policy: strictPolicy.details
    });
  }

  const proposerSealed = store.getSealedInputForAgent(session.id, session.proposerAgentId);
  const counterpartySealed = store.getSealedInputForAgent(session.id, session.counterpartyAgentId);

  const missingAgentIds = [
    ...(proposerSealed ? [] : [session.proposerAgentId]),
    ...(counterpartySealed ? [] : [session.counterpartyAgentId])
  ];

  if (missingAgentIds.length > 0 || !proposerSealed || !counterpartySealed) {
    return sendError(reply, 409, 'private_context_required', 'Both participants must upload sealed private context before negotiation', {
      sessionId,
      missingAgentIds
    });
  }

  try {
    const proposerPayloadRaw = unsealPrivatePayload(proposerSealed);
    const counterpartyPayloadRaw = unsealPrivatePayload(counterpartySealed);

    const proposerPayloadParsed = privateNegotiationContextSchema.safeParse(proposerPayloadRaw);
    const counterpartyPayloadParsed = privateNegotiationContextSchema.safeParse(counterpartyPayloadRaw);

    if (!proposerPayloadParsed.success || !counterpartyPayloadParsed.success) {
      return sendError(reply, 400, 'invalid_request', 'Stored private context payload is invalid', {
        proposerContextValid: proposerPayloadParsed.success,
        counterpartyContextValid: counterpartyPayloadParsed.success
      });
    }

    if (!proposerAgent || !counterpartyAgent) {
      return sendError(reply, 400, 'strict_policy_failed', 'Session participants are missing', {
        proposerAgentPresent: Boolean(proposerAgent),
        counterpartyAgentPresent: Boolean(counterpartyAgent)
      });
    }

    const localEngineResult = () => runNegotiationEngine({
      proposer: {
        agentId: session.proposerAgentId,
        context: proposerPayloadParsed.data
      },
      counterparty: {
        agentId: session.counterpartyAgentId!,
        context: counterpartyPayloadParsed.data
      },
      maxTurns
    });

    const endpointNegotiationRequired = endpointNegotiationRequiredByDefault();
    const allowEngineFallback = allowEngineFallbackByDefault();

    let result = localEngineResult();
    let executionMode: 'endpoint' | 'engine' | 'engine_fallback' = 'engine';
    let endpointFailureReason: string | undefined;
    let endpointProofSummary: Record<string, unknown> | undefined;

    if (endpointNegotiationRequired) {
      try {
        const endpointResult = await runEndpointNegotiation({
          sessionId: session.id,
          topic: session.topic,
          proposer: {
            agent: proposerAgent,
            context: proposerPayloadParsed.data
          },
          counterparty: {
            agent: counterpartyAgent,
            context: counterpartyPayloadParsed.data
          },
          maxTurns
        });

        if (endpointResult.finalStatus === 'failed' && allowEngineFallback) {
          endpointFailureReason = endpointResult.reason;
          endpointProofSummary = endpointResult.proofSummary;
          result = localEngineResult();
          executionMode = 'engine_fallback';
        } else {
          result = endpointResult;
          executionMode = 'endpoint';
          endpointProofSummary = endpointResult.proofSummary;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'endpoint_negotiation_failed';
        if (!allowEngineFallback) {
          throw error;
        }

        endpointFailureReason = message;
        result = localEngineResult();
        executionMode = 'engine_fallback';
      }
    }

    if (privacyAssertionEnabled()) {
      if (result.agreement) {
        assertPrivacySafePublicPayload(result.agreement, 'negotiation_agreement');
      }
    }

    store.clearSessionTurns(session.id);

    for (const turn of result.transcript) {
      store.upsertSessionTurn({
        sessionId: session.id,
        turn: turn.turn,
        status: turn.status,
        summary: sanitizeTurnSummary({
          ...turn,
          executionMode
        })
      });
    }

    const transcript = store.listSessionTurns(session.id).map((turn) => {
      const summary = redactSensitiveData(sanitizeTurnSummary(turn.summary));
      return {
        turn: turn.turn,
        status: turn.status,
        ...summary
      };
    });

    if (privacyAssertionEnabled()) {
      assertPrivacySafePublicPayload(transcript, 'public_transcript_response');
    }

    const finalStatus = result.finalStatus;
    if (!canTransitionSession(session.status, finalStatus)) {
      app.log.error(
        {
          sessionId: session.id,
          currentStatus: session.status,
          attemptedStatus: finalStatus,
          result: redactForLog(result)
        },
        'negotiation_invalid_state_transition'
      );

      return sendError(reply, 409, 'invalid_state_transition', 'Negotiation produced invalid session transition', {
        currentStatus: session.status,
        attemptedStatus: finalStatus,
        allowedNextStatuses: allowedNextStates(session.status)
      });
    }

    const negotiationSummary = {
      status: finalStatus,
      turns: result.turns,
      agreement: result.agreement ?? null,
      reason: result.reason,
      execution: {
        mode: executionMode,
        endpointNegotiationRequired,
        allowEngineFallback,
        fallbackReason: endpointFailureReason
      },
      proofSummary: endpointProofSummary ?? null,
      completedAt: nowIso()
    };

    if (privacyAssertionEnabled()) {
      assertPrivacySafePublicPayload(negotiationSummary, 'session_negotiation_summary');
    }

    const updatedSession = store.patchSession(session.id, {
      status: finalStatus,
      terms: {
        ...(session.terms ?? {}),
        negotiation: negotiationSummary
      }
    });

    if (!updatedSession) {
      return sendError(reply, 500, 'internal_error', 'Failed to persist negotiated session state');
    }

    const attestationResult = createAndPersistSessionAttestation(store, updatedSession.id);
    if (!attestationResult.ok) {
      if (attestationEnabled()) {
        return sendError(reply, 500, 'attestation_verification_failed', 'Failed to generate session attestation', {
          reason: attestationResult.reason,
          sessionId: updatedSession.id
        });
      }

      const escrowSettlement = settleEscrowForSession(store, updatedSession.id);

      return reply.send({
        ok: true,
        session: updatedSession,
        result: {
          finalStatus: result.finalStatus,
          turns: result.turns,
          agreement: result.agreement,
          reason: result.reason,
          execution: {
            mode: executionMode,
            endpointNegotiationRequired,
            allowEngineFallback,
            fallbackReason: endpointFailureReason
          },
          proofSummary: endpointProofSummary ?? null,
          transcript
        },
        attestation: null,
        escrow: {
          action: escrowSettlement.action,
          escrow: escrowSettlement.escrow,
          reason: escrowSettlement.reason
        }
      });
    }

    if (attestationEnabled() && !attestationResult.verification.valid) {
      return sendError(reply, 500, 'attestation_verification_failed', 'Session attestation verification failed', {
        sessionId: updatedSession.id,
        reasons: attestationResult.verification.reasons,
        checks: attestationResult.verification.checks
      });
    }

    const escrowSettlement = settleEscrowForSession(store, updatedSession.id);

    return reply.send({
      ok: true,
      session: updatedSession,
      result: {
        finalStatus: result.finalStatus,
        turns: result.turns,
        agreement: result.agreement,
        reason: result.reason,
        execution: {
          mode: executionMode,
          endpointNegotiationRequired,
          allowEngineFallback,
          fallbackReason: endpointFailureReason
        },
        proofSummary: endpointProofSummary ?? null,
        transcript
      },
      attestation: {
        record: attestationResult.attestation,
        verification: attestationResult.verification
      },
      escrow: {
        action: escrowSettlement.action,
        escrow: escrowSettlement.escrow,
        reason: escrowSettlement.reason
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'negotiation_failed';

    app.log.error(
      {
        err: redactForLog({ message }),
        sessionId: session.id
      },
      'negotiation_execution_failed'
    );

    if (message.includes('sensitive_content_detected')) {
      return sendError(reply, 500, 'privacy_redaction_violation', 'Privacy assertion failed during negotiation output checks');
    }

    return sendError(reply, 500, 'internal_error', 'Negotiation execution failed');
  }
}

export function registerSessionRoutes(app: FastifyInstance, store: Store) {
  app.get('/sessions/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly', store)) return;

    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const session = store.getSession(params.data.id);
    if (!session) {
      return sendError(reply, 404, 'not_found', 'Session not found', {
        sessionId: params.data.id
      });
    }

    return {
      ok: true,
      session
    };
  });

  app.get('/sessions/:id/transcript', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly', store)) return;

    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const session = store.getSession(params.data.id);
    if (!session) {
      return sendError(reply, 404, 'not_found', 'Session not found', {
        sessionId: params.data.id
      });
    }

    const transcript = store.listSessionTurns(session.id).map((turn) => ({
      turn: turn.turn,
      status: turn.status,
      ...redactSensitiveData(sanitizeTurnSummary(turn.summary))
    }));

    if (privacyAssertionEnabled()) {
      try {
        assertPrivacySafePublicPayload(transcript, 'session_transcript_read');
      } catch {
        return sendError(reply, 500, 'privacy_redaction_violation', 'Transcript contains sensitive content');
      }
    }

    return {
      ok: true,
      sessionId: session.id,
      status: session.status,
      transcript
    };
  });

  app.get('/sessions/:id/attestation', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly', store)) return;

    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const session = store.getSession(params.data.id);
    if (!session) {
      return sendError(reply, 404, 'not_found', 'Session not found', {
        sessionId: params.data.id
      });
    }

    const record = store.getAttestation(session.id);
    if (!record) {
      return sendError(reply, 404, 'not_found', 'Attestation not found for session', {
        sessionId: session.id
      });
    }

    const turns = store.listSessionTurns(session.id);
    const verification = verifySessionAttestationRecord(record, session, turns);

    return {
      ok: true,
      attestation: record,
      verification
    };
  });

  app.post('/sessions/:id/attestation', async (req, reply) => {
    if (!requireRole(req, reply, 'agent', store)) return;

    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const session = store.getSession(params.data.id);
    if (!session) {
      return sendError(reply, 404, 'not_found', 'Session not found', {
        sessionId: params.data.id
      });
    }

    const scope = ensureSessionActorScope(req, reply, store, session);
    if (!scope) return;

    if (!isFinalSessionStatus(session.status)) {
      return sendError(reply, 409, 'invalid_state_transition', 'Attestation requires finalized session status', {
        sessionId: session.id,
        currentStatus: session.status,
        allowedStatuses: ['agreed', 'no_agreement', 'failed']
      });
    }

    const result = createAndPersistSessionAttestation(store, session.id);
    if (!result.ok) {
      return sendError(reply, 500, 'attestation_verification_failed', 'Failed to create attestation', {
        sessionId: session.id,
        reason: result.reason
      });
    }

    if (attestationEnabled() && !result.verification.valid) {
      return sendError(reply, 500, 'attestation_verification_failed', 'Attestation verification failed', {
        sessionId: session.id,
        reasons: result.verification.reasons,
        checks: result.verification.checks
      });
    }

    return reply.send({
      ok: true,
      attestation: result.attestation,
      verification: result.verification
    });
  });

  app.post('/sessions', async (req, reply) => {
    if (!requireRole(req, reply, 'agent', store)) return;

    const parsed = parseCreateBody(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid session create payload', {
        issues: parsed.error.issues
      });
    }

    const body = parsed.data;
    const access = resolveAccessContext(req, store);

    if (!isPrivilegedRole(access.role) && access.actorAgentId !== body.proposerAgentId) {
      return sendError(reply, 403, 'actor_scope_violation', 'Agent can only create sessions as itself', {
        actorAgentId: access.actorAgentId ?? null,
        proposerAgentId: body.proposerAgentId
      });
    }

    if (!store.getAgent(body.proposerAgentId)) {
      return sendError(reply, 400, 'invalid_request', 'Unknown proposerAgentId', {
        proposerAgentId: body.proposerAgentId
      });
    }

    if (body.counterpartyAgentId && !store.getAgent(body.counterpartyAgentId)) {
      return sendError(reply, 400, 'invalid_request', 'Unknown counterpartyAgentId', {
        counterpartyAgentId: body.counterpartyAgentId
      });
    }

    if (body.counterpartyAgentId && body.counterpartyAgentId === body.proposerAgentId) {
      return sendError(reply, 400, 'invalid_request', 'counterpartyAgentId must be different from proposerAgentId');
    }

    const session = store.createSession({
      id: body.id ?? generateSessionId(),
      topic: body.topic,
      proposerAgentId: body.proposerAgentId,
      counterpartyAgentId: body.counterpartyAgentId,
      status: 'created',
      terms: {
        ...(body.terms ?? {}),
        ...(body.escrow ? { escrow: body.escrow } : {})
      }
    });

    return reply.code(201).send({
      ok: true,
      session
    });
  });

  app.post('/sessions/:id/accept', async (req, reply) => {
    if (!requireRole(req, reply, 'agent', store)) return;

    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const parsedBody = parseAcceptBody(req.body ?? {});
    if (!parsedBody.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid accept payload', {
        issues: parsedBody.error.issues
      });
    }

    const session = store.getSession(params.data.id);
    if (!session) {
      return sendError(reply, 404, 'not_found', 'Session not found', {
        sessionId: params.data.id
      });
    }

    if (!canTransitionSession(session.status, 'accepted')) {
      return sendError(reply, 409, 'invalid_state_transition', 'Session cannot be accepted from current state', {
        currentStatus: session.status,
        attemptedStatus: 'accepted',
        allowedNextStatuses: allowedNextStates(session.status)
      });
    }

    const access = resolveAccessContext(req, store);
    const acceptorAgentId = parsedBody.data.counterpartyAgentId ?? access.actorAgentId;
    if (!acceptorAgentId) {
      return sendError(reply, 400, 'invalid_request', 'counterpartyAgentId is required when no agent key is used');
    }

    if (!store.getAgent(acceptorAgentId)) {
      return sendError(reply, 400, 'invalid_request', 'Unknown counterpartyAgentId', {
        counterpartyAgentId: acceptorAgentId
      });
    }

    if (!isPrivilegedRole(access.role) && access.actorAgentId !== acceptorAgentId) {
      return sendError(reply, 403, 'actor_scope_violation', 'Agent can only accept sessions as itself', {
        actorAgentId: access.actorAgentId ?? null,
        acceptorAgentId
      });
    }

    if (session.proposerAgentId === acceptorAgentId) {
      return sendError(reply, 400, 'invalid_request', 'Proposer cannot accept its own session');
    }

    if (session.counterpartyAgentId && session.counterpartyAgentId !== acceptorAgentId) {
      return sendError(reply, 403, 'actor_scope_violation', 'Session is already assigned to a different counterparty', {
        assignedCounterpartyAgentId: session.counterpartyAgentId,
        attemptedCounterpartyAgentId: acceptorAgentId
      });
    }

    const updated = store.patchSession(session.id, {
      counterpartyAgentId: acceptorAgentId,
      status: 'accepted'
    });

    return {
      ok: true,
      session: updated
    };
  });

  app.post('/sessions/:id/prepare', async (req, reply) => {
    if (!requireRole(req, reply, 'agent', store)) return;

    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const session = store.getSession(params.data.id);
    if (!session) {
      return sendError(reply, 404, 'not_found', 'Session not found', {
        sessionId: params.data.id
      });
    }

    if (!canTransitionSession(session.status, 'prepared')) {
      return sendError(reply, 409, 'invalid_state_transition', 'Session cannot be prepared from current state', {
        currentStatus: session.status,
        attemptedStatus: 'prepared',
        allowedNextStatuses: allowedNextStates(session.status)
      });
    }

    const scope = ensureSessionActorScope(req, reply, store, session);
    if (!scope) return;

    const updated = store.patchSession(session.id, {
      status: 'prepared'
    });

    return {
      ok: true,
      session: updated
    };
  });

  app.post('/sessions/:id/start', async (req, reply) => {
    if (!requireRole(req, reply, 'agent', store)) return;

    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const session = store.getSession(params.data.id);
    if (!session) {
      return sendError(reply, 404, 'not_found', 'Session not found', {
        sessionId: params.data.id
      });
    }

    if (!canTransitionSession(session.status, 'active')) {
      if (session.status === 'accepted' || session.status === 'created') {
        return sendError(reply, 409, 'prepare_required_before_start', 'Session must be prepared before start', {
          currentStatus: session.status,
          requiredStatus: 'prepared'
        });
      }

      return sendError(reply, 409, 'invalid_state_transition', 'Session cannot be started from current state', {
        currentStatus: session.status,
        attemptedStatus: 'active',
        allowedNextStatuses: allowedNextStates(session.status)
      });
    }

    const scope = ensureSessionActorScope(req, reply, store, session);
    if (!scope) return;

    const strictPolicy = evaluateStrictSessionPolicy({
      proposer: store.getAgent(session.proposerAgentId),
      counterparty: session.counterpartyAgentId ? store.getAgent(session.counterpartyAgentId) : undefined
    });

    if (!strictPolicy.ok) {
      return sendError(reply, 400, 'strict_policy_failed', 'Session participants failed strict policy checks', {
        sessionId: session.id,
        reasons: strictPolicy.reasons,
        policy: strictPolicy.details
      });
    }

    const escrowConfig = parseSessionEscrowConfig(session);
    if (escrowConfig) {
      const escrow = store.getEscrow(session.id);
      if (!escrow) {
        return sendError(reply, 409, 'prepare_required_before_start', 'Escrow must be prepared before session start', {
          sessionId: session.id
        });
      }

      if (escrow.status !== 'funded') {
        return sendError(reply, 409, 'funding_pending', 'Escrow deposits are incomplete', {
          sessionId: session.id,
          escrowStatus: escrow.status,
          playerADeposited: escrow.playerADeposited,
          playerBDeposited: escrow.playerBDeposited
        });
      }
    }

    const updated = store.patchSession(session.id, {
      status: 'active'
    });

    return {
      ok: true,
      session: updated
    };
  });

  app.post('/sessions/:id/adjudicate', async (req, reply) => {
    if (!requireRole(req, reply, 'operator', store)) return;

    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const parsedBody = adjudicateSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid adjudicate payload', {
        issues: parsedBody.error.issues
      });
    }

    const session = store.getSession(params.data.id);
    if (!session) {
      return sendError(reply, 404, 'not_found', 'Session not found', {
        sessionId: params.data.id
      });
    }

    if (!canTransitionSession(session.status, parsedBody.data.status)) {
      return sendError(reply, 409, 'invalid_state_transition', 'Session cannot be adjudicated from current state', {
        currentStatus: session.status,
        attemptedStatus: parsedBody.data.status,
        allowedNextStatuses: allowedNextStates(session.status)
      });
    }

    const manualSummary = {
      status: parsedBody.data.status,
      agreement: parsedBody.data.agreement ?? null,
      note: parsedBody.data.note,
      adjudicatedAt: nowIso(),
      adjudicatedByRole: 'operator'
    };

    if (privacyAssertionEnabled()) {
      assertPrivacySafePublicPayload(manualSummary, 'manual_adjudication_summary');
    }

    const updatedSession = store.patchSession(session.id, {
      status: parsedBody.data.status,
      terms: {
        ...(session.terms ?? {}),
        manualAdjudication: manualSummary,
        ...(parsedBody.data.agreement ? { agreement: parsedBody.data.agreement } : {})
      }
    });

    if (!updatedSession) {
      return sendError(reply, 500, 'internal_error', 'Failed to persist adjudicated session state');
    }

    const attestationResult = createAndPersistSessionAttestation(store, updatedSession.id);
    if (!attestationResult.ok && attestationEnabled()) {
      return sendError(reply, 500, 'attestation_verification_failed', 'Failed to generate session attestation', {
        reason: attestationResult.reason,
        sessionId: updatedSession.id
      });
    }

    if (attestationResult.ok && attestationEnabled() && !attestationResult.verification.valid) {
      return sendError(reply, 500, 'attestation_verification_failed', 'Session attestation verification failed', {
        sessionId: updatedSession.id,
        reasons: attestationResult.verification.reasons,
        checks: attestationResult.verification.checks
      });
    }

    const escrowSettlement = settleEscrowForSession(store, updatedSession.id);

    return reply.send({
      ok: true,
      session: updatedSession,
      adjudication: manualSummary,
      attestation: attestationResult.ok
        ? {
            record: attestationResult.attestation,
            verification: attestationResult.verification
          }
        : null,
      escrow: {
        action: escrowSettlement.action,
        escrow: escrowSettlement.escrow,
        reason: escrowSettlement.reason
      }
    });
  });

  app.post('/sessions/:id/private-inputs', async (req, reply) => {
    if (!requireRole(req, reply, 'agent', store)) return;

    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const parsed = privateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid private-input payload', {
        issues: parsed.error.issues
      });
    }

    const session = store.getSession(params.data.id);
    if (!session) {
      return sendError(reply, 404, 'not_found', 'Session not found', {
        sessionId: params.data.id
      });
    }

    const access = resolveAccessContext(req, store);
    const privileged = isPrivilegedRole(access.role);
    const targetAgentId = parsed.data.agentId ?? access.actorAgentId;

    if (!targetAgentId) {
      return sendError(reply, 400, 'invalid_request', 'agentId is required when no agent key is used');
    }

    if (!agentIsParticipant(targetAgentId, session)) {
      return sendError(reply, 400, 'invalid_request', 'agentId must be one of session participants', {
        targetAgentId,
        proposerAgentId: session.proposerAgentId,
        counterpartyAgentId: session.counterpartyAgentId ?? null
      });
    }

    if (!privileged && access.actorAgentId !== targetAgentId) {
      return sendError(reply, 403, 'actor_scope_violation', 'Agent can only upload private inputs for itself', {
        actorAgentId: access.actorAgentId ?? null,
        targetAgentId
      });
    }

    try {
      const sealed = sealPrivatePayload({
        payload: parsed.data.privateContext,
        sessionId: session.id,
        agentId: targetAgentId
      });
      const sealedRef = `${session.id}:${targetAgentId}:${generateApiKey('sealed').slice(7)}`;

      const saved = store.upsertSealedInput({
        sessionId: session.id,
        agentId: targetAgentId,
        sealedRef,
        keyId: sealed.keyId,
        cipherText: sealed.cipherText,
        iv: sealed.iv,
        authTag: sealed.authTag
      });

      const safePublicContext = parsed.data.publicContext ? redactSensitiveData(parsed.data.publicContext) : undefined;

      const responsePayload = {
        ok: true,
        sealedInput: {
          sessionId: saved.sessionId,
          agentId: saved.agentId,
          sealedRef: saved.sealedRef,
          keyId: saved.keyId,
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt
        },
        publicContext: safePublicContext
      };

      if (privacyAssertionEnabled()) {
        assertPrivacySafePublicPayload(responsePayload, 'private_input_response');
      }

      return reply.code(201).send(responsePayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'private_input_persist_failed';

      app.log.error(
        {
          err: redactForLog({ message }),
          sessionId: session.id,
          actorAgentId: access.actorAgentId ?? null
        },
        'private_input_upload_failed'
      );

      if (message.includes('sensitive_content_detected')) {
        return sendError(reply, 500, 'privacy_redaction_violation', 'Private input response failed privacy checks');
      }

      return sendError(reply, 500, 'internal_error', 'Failed to store private input');
    }
  });

  app.post('/sessions/:id/negotiate', async (req, reply) => {
    const params = parseParams(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const parsedBody = negotiateSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid negotiation payload', {
        issues: parsedBody.error.issues
      });
    }

    return executeNegotiation(app, req, reply, store, params.data.id, parsedBody.data.maxTurns);
  });

  app.post('/negotiate', async (req, reply) => {
    const parsedBody = negotiateDirectSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid negotiate payload', {
        issues: parsedBody.error.issues
      });
    }

    return executeNegotiation(app, req, reply, store, parsedBody.data.sessionId, parsedBody.data.maxTurns);
  });
}

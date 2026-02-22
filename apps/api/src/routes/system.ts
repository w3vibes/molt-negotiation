import type { FastifyInstance } from 'fastify';
import { authSummary, requireRole, resolveAccessRole } from '../services/access.js';
import { strictPolicySnapshot } from '../services/policy.js';
import { metrics } from '../services/metrics.js';
import { verifySessionAttestationRecord } from '../services/attestation.js';
import { evaluateLaunchReadiness } from '../services/launchReadiness.js';
import type { Store } from '../services/store.js';

function appIdsFromEnv(): string[] {
  const values = [
    process.env.ECLOUD_APP_ID_API,
    process.env.ECLOUD_APP_ID_WEB,
    ...(process.env.ECLOUD_APP_IDS ? process.env.ECLOUD_APP_IDS.split(',').map((v) => v.trim()) : []),
    // backwards-compatible fallbacks
    process.env.NEG_ECLOUD_APP_ID_API,
    process.env.NEG_ECLOUD_APP_ID_WEB,
    ...(process.env.NEG_ECLOUD_APP_IDS ? process.env.NEG_ECLOUD_APP_IDS.split(',').map((v) => v.trim()) : [])
  ].filter((v): v is string => Boolean(v));

  return [...new Set(values)];
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function runtimeProofSummary(store: Store) {
  const sessions = store.listSessions();

  let endpointExecutions = 0;
  let fallbackExecutions = 0;
  let localExecutions = 0;
  let sessionsWithProofSummary = 0;
  let proofVerifiedSessions = 0;
  let proofFailedSessions = 0;
  let verifiedDecisions = 0;
  let failedDecisions = 0;
  let runtimeVerifiedDecisions = 0;
  let runtimeFailedDecisions = 0;

  for (const session of sessions) {
    const negotiation = asObject(asObject(session.terms).negotiation);
    const execution = asObject(negotiation.execution);
    const mode = typeof execution.mode === 'string' ? execution.mode : undefined;

    if (mode === 'endpoint') endpointExecutions += 1;
    else if (mode === 'engine_fallback') fallbackExecutions += 1;
    else if (mode === 'engine') localExecutions += 1;

    const proofSummary = asObject(negotiation.proofSummary);
    if (Object.keys(proofSummary).length === 0) continue;

    sessionsWithProofSummary += 1;

    const verified = asNumber(proofSummary.verifiedDecisions);
    const failed = asNumber(proofSummary.failedDecisions);
    const runtimeVerified = asNumber(proofSummary.runtimeVerifiedDecisions);
    const runtimeFailed = asNumber(proofSummary.runtimeFailedDecisions);

    verifiedDecisions += verified;
    failedDecisions += failed;
    runtimeVerifiedDecisions += runtimeVerified;
    runtimeFailedDecisions += runtimeFailed;

    if (failed > 0) proofFailedSessions += 1;
    else if (verified > 0) proofVerifiedSessions += 1;
  }

  return {
    sessionsEvaluated: sessions.length,
    endpointExecutions,
    fallbackExecutions,
    localExecutions,
    sessionsWithProofSummary,
    proofVerifiedSessions,
    proofFailedSessions,
    verifiedDecisions,
    failedDecisions,
    runtimeVerifiedDecisions,
    runtimeFailedDecisions
  };
}

function runtimeAttestationSummary(store: Store) {
  const sessions = store.listSessions();

  let finalizedSessions = 0;
  let attestedSessions = 0;
  let validAttestations = 0;
  let invalidAttestations = 0;

  const invalidSamples: Array<{ sessionId: string; reasons: string[] }> = [];

  for (const session of sessions) {
    if (!['agreed', 'no_agreement', 'failed', 'settled', 'refunded'].includes(session.status)) continue;
    finalizedSessions += 1;

    const attestation = store.getAttestation(session.id);
    if (!attestation) continue;

    attestedSessions += 1;

    const verification = verifySessionAttestationRecord(attestation, session, store.listSessionTurns(session.id));
    if (verification.valid) {
      validAttestations += 1;
      continue;
    }

    invalidAttestations += 1;
    if (invalidSamples.length < 10) {
      invalidSamples.push({
        sessionId: session.id,
        reasons: verification.reasons
      });
    }
  }

  const coverage = finalizedSessions === 0 ? 0 : Number((attestedSessions / finalizedSessions).toFixed(4));

  return {
    finalizedSessions,
    attestedSessions,
    validAttestations,
    invalidAttestations,
    attestationCoverage: coverage,
    invalidSamples
  };
}

export function registerSystemRoutes(app: FastifyInstance, store: Store) {
  const startedAt = Date.now();

  app.get('/health', async () => {
    const launchReadiness = evaluateLaunchReadiness();

    return {
      ok: true,
      service: 'molt-negotiation-api',
      version: '0.1.0',
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      dbFile: store.file,
      counts: store.counts(),
      launchReady: launchReadiness.ready,
      now: new Date().toISOString()
    };
  });

  app.get('/metrics', async () => {
    return {
      ok: true,
      metrics: metrics.snapshot(),
      store: store.stats()
    };
  });

  app.get('/auth/status', async (req) => {
    return {
      ok: true,
      role: resolveAccessRole(req, store),
      config: authSummary()
    };
  });

  app.get('/policy/strict', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly', store)) return;

    return {
      ok: true,
      policy: strictPolicySnapshot()
    };
  });

  app.get('/verification/eigencompute', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly', store)) return;

    const environment = process.env.ECLOUD_ENV || process.env.NEG_ECLOUD_ENV || 'sepolia';
    const appIds = appIdsFromEnv();
    const verifyUrl = environment === 'mainnet-alpha'
      ? 'https://verify.eigencloud.xyz/'
      : 'https://verify-sepolia.eigencloud.xyz/';

    const proofRuntime = runtimeProofSummary(store);
    const attestationRuntime = runtimeAttestationSummary(store);
    const launchReadiness = evaluateLaunchReadiness();

    return {
      ok: true,
      environment,
      appIds,
      verifyUrl,
      checks: {
        appBound: appIds.length > 0,
        strictMode: strictPolicySnapshot(),
        launchReadiness,
        runtime: {
          proofRuntime,
          attestationRuntime
        }
      }
    };
  });

  app.get('/verification/eigencompute/sessions/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly', store)) return;

    const id = (req.params as { id?: string }).id?.trim();
    if (!id) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Session id is required'
        }
      });
    }

    const session = store.getSession(id);
    if (!session) {
      return reply.code(404).send({
        ok: false,
        error: {
          code: 'not_found',
          message: 'Session not found'
        }
      });
    }

    const negotiation = asObject(asObject(session.terms).negotiation);
    const proofSummary = asObject(negotiation.proofSummary);
    const attestation = store.getAttestation(session.id);

    const attestationVerification = attestation
      ? verifySessionAttestationRecord(attestation, session, store.listSessionTurns(session.id))
      : null;

    return {
      ok: true,
      sessionId: session.id,
      status: session.status,
      negotiation: {
        execution: asObject(negotiation.execution),
        proofSummary
      },
      attestation: attestation
        ? {
            record: attestation,
            verification: attestationVerification
          }
        : null
    };
  });
}


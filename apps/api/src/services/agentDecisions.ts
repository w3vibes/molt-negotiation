import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ethers } from 'ethers';
import type { AgentRecord } from '../types/domain.js';
import { canonicalStringify, sha256Hex } from '../utils/canonical.js';
import {
  turnProofMaxSkewMsByDefault,
  turnProofRequiredByDefault
} from './policy.js';
import type { RuntimeAttestationEvidence } from './runtimeVerification.js';

export type AgentEigenProfile = {
  appId: string;
  environment?: string;
  imageDigest?: string;
  signerAddress?: string;
};

export type AgentTurnProof = {
  version?: string;
  sessionId: string;
  turn: number;
  agentId: string;
  challenge: string;
  decisionHash: string;
  appId: string;
  environment?: string;
  imageDigest?: string;
  signer?: string;
  signature: string;
  timestamp: string;
  runtimeEvidence?: RuntimeAttestationEvidence;
};

export type AgentTurnDecision = {
  offer: number;
  publicNote?: string;
  rationale?: string;
  proof?: AgentTurnProof;
};

export type AgentDecisionRequest = {
  sessionId: string;
  topic: string;
  turn: number;
  maxTurns: number;
  role: 'buyer' | 'seller';
  challenge: string;
  agent: AgentRecord;
  privateContext: Record<string, unknown>;
  publicState: {
    buyerAgentId: string;
    sellerAgentId: string;
    priorTurns: Array<Record<string, unknown>>;
    latestBuyerOffer?: number;
    latestSellerAsk?: number;
  };
};

export type AgentDecisionResponse = {
  decision: AgentTurnDecision;
  checkedUrl: string;
  raw: Record<string, unknown>;
};

export type TurnProofVerification = {
  valid: boolean;
  recoveredAddress?: string;
  reason?: string;
  expectedDecisionHash: string;
};

const decisionResponseSchema = z.object({
  offer: z.number().finite(),
  publicNote: z.string().max(2_000).optional(),
  rationale: z.string().max(20_000).optional(),
  proof: z.object({
    version: z.string().min(1).optional(),
    sessionId: z.string().min(1),
    turn: z.number().int().min(1),
    agentId: z.string().min(1),
    challenge: z.string().min(1),
    decisionHash: z.string().min(1),
    appId: z.string().min(1),
    environment: z.string().min(1).optional(),
    imageDigest: z.string().min(1).optional(),
    signer: z.string().min(1).optional(),
    signature: z.string().min(1),
    timestamp: z.string().min(1),
    runtimeEvidence: z.object({
      provider: z.string().min(1).optional(),
      quote: z.string().min(1).optional(),
      verificationToken: z.string().min(1).optional(),
      reportDataHash: z.string().min(1).optional(),
      issuedAt: z.string().min(1).optional(),
      expiresAt: z.string().min(1).optional(),
      claims: z.object({
        appId: z.string().min(1).optional(),
        environment: z.string().min(1).optional(),
        imageDigest: z.string().min(1).optional(),
        signerAddress: z.string().min(1).optional(),
        reportDataHash: z.string().min(1).optional(),
        issuedAt: z.string().min(1).optional(),
        expiresAt: z.string().min(1).optional()
      }).partial().optional()
    }).partial().optional()
  }).optional()
}).passthrough();

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeLower(value: unknown): string | undefined {
  return normalizeText(value)?.toLowerCase();
}

function normalizeAddress(value: unknown): string | undefined {
  const normalized = normalizeLower(value);
  if (!normalized) return undefined;
  return normalized.startsWith('0x') ? normalized : `0x${normalized}`;
}

function decisionTimeoutMs(): number {
  const parsed = Number(process.env.NEG_AGENT_DECISION_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return 8_000;
  return Math.min(Math.floor(parsed), 60_000);
}

function parseTimestampMs(input: string): number {
  const numeric = Number(input);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function decisionPathCandidates(agent: AgentRecord): string[] {
  const metadata = asObject(agent.metadata);
  const base = agent.endpoint.trim().replace(/\/$/, '');

  const candidatesRaw = [
    normalizeText(metadata.decisionUrl),
    normalizeText(metadata.turnDecisionUrl),
    normalizeText(metadata.decisionPath),
    normalizeText(metadata.turnDecisionPath),
    normalizeText(process.env.NEG_AGENT_DECISION_PATH),
    '/decide',
    '/negotiate-turn',
    '/negotiate'
  ].filter((value): value is string => Boolean(value));

  const resolved = candidatesRaw.map((candidate) => {
    if (/^https?:\/\//i.test(candidate)) {
      return candidate;
    }

    const normalizedPath = candidate.startsWith('/') ? candidate : `/${candidate}`;
    return `${base}${normalizedPath}`;
  });

  return [...new Set(resolved)];
}

function decisionRequestHeaders(agent: AgentRecord): Record<string, string> {
  const metadata = asObject(agent.metadata);
  const endpointToken =
    normalizeText(metadata.endpointApiKey) ||
    normalizeText(metadata.endpointAuthToken) ||
    normalizeText(metadata.endpointToken);

  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-molt-negotiation-protocol': 'turn-decision-v1'
  };

  if (endpointToken) {
    headers.authorization = endpointToken.toLowerCase().startsWith('bearer ')
      ? endpointToken
      : `Bearer ${endpointToken}`;
  }

  return headers;
}

export function newTurnChallenge(): string {
  return randomBytes(20).toString('hex');
}

export function extractAgentEigenProfile(agent: AgentRecord): AgentEigenProfile | undefined {
  const metadata = asObject(agent.metadata);
  const eigen = asObject(metadata.eigencompute);

  const appId = normalizeLower(eigen.appId);
  if (!appId) return undefined;

  return {
    appId,
    ...(normalizeLower(eigen.environment ?? eigen.env) ? { environment: normalizeLower(eigen.environment ?? eigen.env) } : {}),
    ...(normalizeLower(eigen.imageDigest ?? eigen.image_digest ?? eigen.releaseDigest)
      ? { imageDigest: normalizeLower(eigen.imageDigest ?? eigen.image_digest ?? eigen.releaseDigest) }
      : {}),
    ...(normalizeAddress(eigen.signerAddress ?? eigen.signer ?? eigen.evmAddress)
      ? { signerAddress: normalizeAddress(eigen.signerAddress ?? eigen.signer ?? eigen.evmAddress) }
      : {})
  };
}

export function expectedDecisionHash(input: {
  sessionId: string;
  turn: number;
  agentId: string;
  role: 'buyer' | 'seller';
  offer: number;
  challenge: string;
  appId: string;
  environment?: string;
  imageDigest?: string;
  timestamp: string;
}): string {
  const payload = {
    protocol: 'MOLT_NEGOTIATION_TURN_PROOF',
    version: 'v1',
    sessionId: input.sessionId,
    turn: input.turn,
    agentId: input.agentId,
    role: input.role,
    offer: Number(input.offer.toFixed(4)),
    challenge: normalizeLower(input.challenge),
    appId: normalizeLower(input.appId),
    environment: normalizeLower(input.environment),
    imageDigest: normalizeLower(input.imageDigest),
    timestamp: input.timestamp
  };

  return `0x${sha256Hex(canonicalStringify(payload))}`;
}

export function buildTurnProofMessage(input: {
  sessionId: string;
  turn: number;
  agentId: string;
  role: 'buyer' | 'seller';
  offer: number;
  challenge: string;
  decisionHash: string;
  appId: string;
  environment?: string;
  imageDigest?: string;
  timestamp: string;
  version?: string;
}): string {
  return [
    'MOLT_NEGOTIATION_TURN_PROOF',
    normalizeLower(input.version) || 'v1',
    input.sessionId,
    String(input.turn),
    input.agentId,
    input.role,
    Number(input.offer.toFixed(4)).toString(),
    normalizeLower(input.challenge),
    normalizeLower(input.decisionHash),
    normalizeLower(input.appId),
    normalizeLower(input.environment),
    normalizeLower(input.imageDigest),
    input.timestamp
  ].join('|');
}

export function verifyAgentTurnProof(input: {
  expected: {
    sessionId: string;
    turn: number;
    agentId: string;
    role: 'buyer' | 'seller';
    offer: number;
    challenge: string;
    eigen: AgentEigenProfile;
  };
  proof?: AgentTurnProof;
}): TurnProofVerification {
  const expectedHash = expectedDecisionHash({
    sessionId: input.expected.sessionId,
    turn: input.expected.turn,
    agentId: input.expected.agentId,
    role: input.expected.role,
    offer: input.expected.offer,
    challenge: input.expected.challenge,
    appId: input.expected.eigen.appId,
    environment: input.expected.eigen.environment,
    imageDigest: input.expected.eigen.imageDigest,
    timestamp: input.proof?.timestamp ?? ''
  });

  const requireProof = turnProofRequiredByDefault();
  if (!input.proof) {
    return {
      valid: !requireProof,
      reason: requireProof ? 'turn_proof_missing' : undefined,
      expectedDecisionHash: expectedHash
    };
  }

  const proof = input.proof;

  if (normalizeLower(proof.sessionId) !== normalizeLower(input.expected.sessionId)) {
    return { valid: false, reason: 'turn_proof_session_id_mismatch', expectedDecisionHash: expectedHash };
  }

  if (proof.turn !== input.expected.turn) {
    return { valid: false, reason: 'turn_proof_turn_mismatch', expectedDecisionHash: expectedHash };
  }

  if (normalizeLower(proof.agentId) !== normalizeLower(input.expected.agentId)) {
    return { valid: false, reason: 'turn_proof_agent_id_mismatch', expectedDecisionHash: expectedHash };
  }

  if (normalizeLower(proof.challenge) !== normalizeLower(input.expected.challenge)) {
    return { valid: false, reason: 'turn_proof_challenge_mismatch', expectedDecisionHash: expectedHash };
  }

  if (normalizeLower(proof.appId) !== normalizeLower(input.expected.eigen.appId)) {
    return { valid: false, reason: 'turn_proof_app_id_mismatch', expectedDecisionHash: expectedHash };
  }

  if (input.expected.eigen.environment && normalizeLower(proof.environment) !== normalizeLower(input.expected.eigen.environment)) {
    return { valid: false, reason: 'turn_proof_environment_mismatch', expectedDecisionHash: expectedHash };
  }

  if (input.expected.eigen.imageDigest && normalizeLower(proof.imageDigest) !== normalizeLower(input.expected.eigen.imageDigest)) {
    return { valid: false, reason: 'turn_proof_image_digest_mismatch', expectedDecisionHash: expectedHash };
  }

  const timestampMs = parseTimestampMs(proof.timestamp);
  if (!Number.isFinite(timestampMs)) {
    return { valid: false, reason: 'turn_proof_timestamp_invalid', expectedDecisionHash: expectedHash };
  }

  if (Math.abs(Date.now() - timestampMs) > turnProofMaxSkewMsByDefault()) {
    return { valid: false, reason: 'turn_proof_timestamp_out_of_window', expectedDecisionHash: expectedHash };
  }

  const computedHash = expectedDecisionHash({
    sessionId: input.expected.sessionId,
    turn: input.expected.turn,
    agentId: input.expected.agentId,
    role: input.expected.role,
    offer: input.expected.offer,
    challenge: input.expected.challenge,
    appId: input.expected.eigen.appId,
    environment: input.expected.eigen.environment,
    imageDigest: input.expected.eigen.imageDigest,
    timestamp: proof.timestamp
  });

  if (normalizeLower(proof.decisionHash) !== normalizeLower(computedHash)) {
    return { valid: false, reason: 'turn_proof_hash_mismatch', expectedDecisionHash: computedHash };
  }

  try {
    const message = buildTurnProofMessage({
      sessionId: input.expected.sessionId,
      turn: input.expected.turn,
      agentId: input.expected.agentId,
      role: input.expected.role,
      offer: input.expected.offer,
      challenge: input.expected.challenge,
      decisionHash: computedHash,
      appId: input.expected.eigen.appId,
      environment: input.expected.eigen.environment,
      imageDigest: input.expected.eigen.imageDigest,
      timestamp: proof.timestamp,
      version: proof.version
    });

    const recoveredAddress = normalizeAddress(ethers.verifyMessage(message, proof.signature));
    if (!recoveredAddress) {
      return { valid: false, reason: 'turn_proof_signer_recovery_failed', expectedDecisionHash: computedHash };
    }

    if (proof.signer && normalizeAddress(proof.signer) !== recoveredAddress) {
      return {
        valid: false,
        recoveredAddress,
        reason: 'turn_proof_signer_mismatch',
        expectedDecisionHash: computedHash
      };
    }

    if (input.expected.eigen.signerAddress && input.expected.eigen.signerAddress !== recoveredAddress) {
      return {
        valid: false,
        recoveredAddress,
        reason: 'turn_proof_signer_not_allowed',
        expectedDecisionHash: computedHash
      };
    }

    return {
      valid: true,
      recoveredAddress,
      expectedDecisionHash: computedHash
    };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? `turn_proof_signature_invalid:${error.message}` : 'turn_proof_signature_invalid',
      expectedDecisionHash: computedHash
    };
  }
}

export async function requestAgentTurnDecision(input: AgentDecisionRequest): Promise<AgentDecisionResponse> {
  const urls = decisionPathCandidates(input.agent);
  const headers = decisionRequestHeaders(input.agent);

  const requestPayload = {
    protocol: 'molt-negotiation/turn-decision-v1',
    sessionId: input.sessionId,
    topic: input.topic,
    turn: input.turn,
    maxTurns: input.maxTurns,
    role: input.role,
    agentId: input.agent.id,
    challenge: input.challenge,
    privateContext: input.privateContext,
    publicState: input.publicState,
    expectedProofBinding: extractAgentEigenProfile(input.agent)
  };

  const errors: string[] = [];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(decisionTimeoutMs())
      });

      if (response.status === 404) {
        errors.push(`${url}:http_404`);
        continue;
      }

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        errors.push(`${url}:http_${response.status}`);
        continue;
      }

      const parsed = decisionResponseSchema.safeParse(payload);
      if (!parsed.success) {
        errors.push(`${url}:invalid_payload`);
        continue;
      }

      return {
        checkedUrl: url,
        decision: parsed.data,
        raw: asObject(payload)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request_failed';
      errors.push(`${url}:${message}`);
    }
  }

  throw new Error(`agent_turn_decision_failed:${input.agent.id}:${errors.join(';') || 'no_candidate_url'}`);
}

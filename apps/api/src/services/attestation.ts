import { createHash, timingSafeEqual } from 'node:crypto';
import { ethers } from 'ethers';
import { strictPolicySnapshot } from './policy.js';
import { evaluateStrictSessionPolicy } from './strictSessionPolicy.js';
import type { AttestationRecord, SessionRecord, SessionStatus, SessionTurnRecord } from '../types/domain.js';
import type { Store } from './store.js';
import { canonicalStringify, sha256Hex } from '../utils/canonical.js';

export type SessionAttestationPayload = {
  version: 1;
  sessionId: string;
  status: SessionStatus;
  turns: number;
  outcomeHash: string;
  policyHash: string;
  executionMode: 'strict';
  strictVerified: boolean;
  strictReasons: string[];
  participants: string[];
  generatedAt: string;
};

export type AttestationVerificationResult = {
  valid: boolean;
  checks: {
    payloadHashMatches: boolean;
    signatureMatches: boolean;
    signerAddressMatches: boolean;
    sessionIdMatches: boolean;
    outcomeHashMatches: boolean;
    strictVerified: boolean;
    executionModeStrict: boolean;
  };
  reasons: string[];
};

const FINAL_SESSION_STATUSES: SessionStatus[] = ['agreed', 'no_agreement', 'failed'];

function testLikeRuntime(): boolean {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv === 'test') return true;
  if (Boolean(process.env.VITEST)) return true;
  return false;
}

function productionRuntime(): boolean {
  return process.env.NODE_ENV?.trim().toLowerCase() === 'production';
}

function insecureDevKeysAllowed(): boolean {
  return process.env.NEG_ALLOW_INSECURE_DEV_KEYS?.trim().toLowerCase() === 'true';
}

function normalizePrivateKey(value: string, options?: { strictFormat?: boolean }): string {
  const strictFormat = options?.strictFormat === true;
  const trimmed = value.trim();
  const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;

  if (/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
    return prefixed.toLowerCase();
  }

  if (strictFormat) {
    throw new Error('invalid_attestation_signer_key_format');
  }

  return deterministicPrivateKey(`attestation:${trimmed}`);
}

function deterministicPrivateKey(seed: string): string {
  return `0x${createHash('sha256').update(seed).digest('hex')}`;
}

function resolveAttestationPrivateKey(): string {
  const configured = process.env.NEG_ATTESTATION_SIGNER_PRIVATE_KEY?.trim();
  if (configured) {
    return normalizePrivateKey(configured, { strictFormat: productionRuntime() });
  }

  if (testLikeRuntime()) {
    return deterministicPrivateKey('molt-negotiation-test-attestation-key');
  }

  if (insecureDevKeysAllowed()) {
    if (productionRuntime()) {
      throw new Error('insecure_dev_keys_not_allowed_in_production');
    }

    return deterministicPrivateKey('molt-negotiation-insecure-dev-attestation-key');
  }

  throw new Error('missing_attestation_signer_key');
}

function signerWallet() {
  const privateKey = resolveAttestationPrivateKey();
  return new ethers.Wallet(privateKey);
}

function signerAddressFromWallet(): string {
  return signerWallet().address.toLowerCase();
}

function signPayloadHash(payloadHash: string): string {
  const wallet = signerWallet();
  const digest = ethers.hashMessage(payloadHash);
  const signature = wallet.signingKey.sign(digest);
  return ethers.Signature.from(signature).serialized;
}

function policyHash(): string {
  return `0x${sha256Hex(canonicalStringify(strictPolicySnapshot()))}`;
}

function sessionOutcomeHash(session: SessionRecord, turns: SessionTurnRecord[]): string {
  const outcome = {
    sessionId: session.id,
    status: session.status,
    terms: session.terms ?? {},
    turns: turns.map((turn) => ({
      turn: turn.turn,
      status: turn.status,
      summary: turn.summary
    }))
  };

  return `0x${sha256Hex(canonicalStringify(outcome))}`;
}

function evaluateStrictSession(session: SessionRecord, store: Store): { strictVerified: boolean; reasons: string[] } {
  const reasons: string[] = [];

  const strictPolicy = evaluateStrictSessionPolicy({
    proposer: store.getAgent(session.proposerAgentId),
    counterparty: session.counterpartyAgentId ? store.getAgent(session.counterpartyAgentId) : undefined
  });

  if (!strictPolicy.ok) {
    reasons.push(...strictPolicy.reasons);
  }

  const proposerInput = store.getSealedInputForAgent(session.id, session.proposerAgentId);
  if (!proposerInput) reasons.push('proposer_private_input_missing');

  if (session.counterpartyAgentId) {
    const counterpartyInput = store.getSealedInputForAgent(session.id, session.counterpartyAgentId);
    if (!counterpartyInput) reasons.push('counterparty_private_input_missing');
  }

  if (!FINAL_SESSION_STATUSES.includes(session.status)) {
    reasons.push('session_not_final');
  }

  return {
    strictVerified: reasons.length === 0,
    reasons
  };
}

export function createSessionAttestationPayload(session: SessionRecord, turns: SessionTurnRecord[], store: Store): SessionAttestationPayload {
  const strict = evaluateStrictSession(session, store);

  return {
    version: 1,
    sessionId: session.id,
    status: session.status,
    turns: turns.length,
    outcomeHash: sessionOutcomeHash(session, turns),
    policyHash: policyHash(),
    executionMode: 'strict',
    strictVerified: strict.strictVerified,
    strictReasons: strict.reasons,
    participants: [session.proposerAgentId, session.counterpartyAgentId].filter((id): id is string => Boolean(id)),
    generatedAt: new Date().toISOString()
  };
}

export function createSessionAttestationRecord(session: SessionRecord, turns: SessionTurnRecord[], store: Store): AttestationRecord {
  const payload = createSessionAttestationPayload(session, turns, store);
  const payloadHash = `0x${sha256Hex(canonicalStringify(payload))}`;
  const signature = signPayloadHash(payloadHash);

  return {
    sessionId: session.id,
    signerAddress: signerAddressFromWallet(),
    payloadHash,
    signature,
    payload,
    createdAt: payload.generatedAt
  };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  try {
    const normalizedA = a.replace(/^0x/, '').toLowerCase();
    const normalizedB = b.replace(/^0x/, '').toLowerCase();
    const left = Buffer.from(normalizedA, 'hex');
    const right = Buffer.from(normalizedB, 'hex');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function verifySessionAttestationRecord(
  record: AttestationRecord,
  session: SessionRecord,
  turns: SessionTurnRecord[]
): AttestationVerificationResult {
  const payloadHash = `0x${sha256Hex(canonicalStringify(record.payload))}`;
  const expectedOutcomeHash = sessionOutcomeHash(session, turns);
  const payload = record.payload as Partial<SessionAttestationPayload>;

  const payloadHashMatches = constantTimeEqualHex(payloadHash, record.payloadHash);

  let recoveredAddress: string | undefined;
  let signatureMatches = false;
  try {
    recoveredAddress = ethers.verifyMessage(payloadHash, record.signature).toLowerCase();
    signatureMatches = recoveredAddress === signerAddressFromWallet();
  } catch {
    signatureMatches = false;
  }

  const signerAddressMatches =
    typeof recoveredAddress === 'string' &&
    recoveredAddress === record.signerAddress.toLowerCase() &&
    record.signerAddress.toLowerCase() === signerAddressFromWallet();

  const sessionIdMatches = payload.sessionId === session.id && record.sessionId === session.id;
  const outcomeHashMatches = payload.outcomeHash === expectedOutcomeHash;
  const strictVerified = payload.strictVerified === true;
  const executionModeStrict = payload.executionMode === 'strict';

  const checks = {
    payloadHashMatches,
    signatureMatches,
    signerAddressMatches,
    sessionIdMatches,
    outcomeHashMatches,
    strictVerified,
    executionModeStrict
  };

  const reasons: string[] = [];
  if (!payloadHashMatches) reasons.push('payload_hash_mismatch');
  if (!signatureMatches) reasons.push('signature_mismatch');
  if (!signerAddressMatches) reasons.push('signer_address_mismatch');
  if (!sessionIdMatches) reasons.push('session_id_mismatch');
  if (!outcomeHashMatches) reasons.push('outcome_hash_mismatch');
  if (!strictVerified) reasons.push('strict_not_verified');
  if (!executionModeStrict) reasons.push('execution_mode_not_strict');

  return {
    valid: reasons.length === 0,
    checks,
    reasons
  };
}

export function isFinalSessionStatus(status: SessionStatus): boolean {
  return FINAL_SESSION_STATUSES.includes(status);
}

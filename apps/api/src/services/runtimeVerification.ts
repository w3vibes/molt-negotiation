import {
  requireRuntimeAttestationByDefault,
  runtimeAttestationMaxAgeMsByDefault,
  runtimeAttestationRemoteVerifyByDefault,
  runtimeAttestationVerifierUrlByDefault
} from './policy.js';

type RuntimeClaims = {
  appId?: string;
  environment?: string;
  imageDigest?: string;
  signerAddress?: string;
  reportDataHash?: string;
  issuedAt?: string;
  expiresAt?: string;
};

export type RuntimeAttestationEvidence = {
  provider?: string;
  quote?: string;
  verificationToken?: string;
  reportDataHash?: string;
  issuedAt?: string;
  expiresAt?: string;
  claims?: RuntimeClaims;
};

export type RuntimeVerificationResult = {
  valid: boolean;
  mode: 'disabled' | 'self' | 'remote';
  reason?: string;
  claims?: RuntimeClaims;
};

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeLower(value: unknown): string | undefined {
  return normalizeText(value)?.toLowerCase();
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function claimsFromEvidence(evidence: RuntimeAttestationEvidence | undefined): RuntimeClaims {
  const claims = evidence?.claims || {};

  return {
    appId: normalizeLower(claims.appId),
    environment: normalizeLower(claims.environment),
    imageDigest: normalizeLower(claims.imageDigest),
    signerAddress: normalizeLower(claims.signerAddress),
    reportDataHash: normalizeLower(claims.reportDataHash ?? evidence?.reportDataHash),
    issuedAt: normalizeText(claims.issuedAt ?? evidence?.issuedAt),
    expiresAt: normalizeText(claims.expiresAt ?? evidence?.expiresAt)
  };
}

function validateClaims(input: {
  claims: RuntimeClaims;
  expected: {
    appId: string;
    environment?: string;
    imageDigest?: string;
    signerAddress?: string;
    reportDataHash: string;
  };
}): string | undefined {
  const claims = input.claims;

  if (!claims.reportDataHash) return 'runtime_attestation_report_data_missing';
  if (claims.reportDataHash !== normalizeLower(input.expected.reportDataHash)) {
    return 'runtime_attestation_report_data_mismatch';
  }

  if (!claims.appId) return 'runtime_attestation_app_id_missing';
  if (claims.appId !== normalizeLower(input.expected.appId)) {
    return 'runtime_attestation_app_id_mismatch';
  }

  if (input.expected.environment && claims.environment !== normalizeLower(input.expected.environment)) {
    return 'runtime_attestation_environment_mismatch';
  }

  if (input.expected.imageDigest && claims.imageDigest !== normalizeLower(input.expected.imageDigest)) {
    return 'runtime_attestation_image_digest_mismatch';
  }

  if (input.expected.signerAddress && claims.signerAddress !== normalizeLower(input.expected.signerAddress)) {
    return 'runtime_attestation_signer_mismatch';
  }

  const now = Date.now();
  const maxAgeMs = runtimeAttestationMaxAgeMsByDefault();

  if (claims.issuedAt) {
    const issuedAtMs = parseTimestamp(claims.issuedAt);
    if (!issuedAtMs) return 'runtime_attestation_issued_at_invalid';
    if (Math.abs(now - issuedAtMs) > maxAgeMs) return 'runtime_attestation_issued_at_out_of_window';
  }

  if (claims.expiresAt) {
    const expiresAtMs = parseTimestamp(claims.expiresAt);
    if (!expiresAtMs) return 'runtime_attestation_expires_at_invalid';
    if (now > expiresAtMs) return 'runtime_attestation_expired';
  }

  return undefined;
}

export async function verifyRuntimeAttestation(input: {
  evidence?: RuntimeAttestationEvidence;
  expected: {
    appId: string;
    environment?: string;
    imageDigest?: string;
    signerAddress?: string;
    reportDataHash: string;
  };
}): Promise<RuntimeVerificationResult> {
  const required = requireRuntimeAttestationByDefault();

  if (!required) {
    return { valid: true, mode: 'disabled' };
  }

  const evidence = input.evidence;
  if (!evidence) {
    return {
      valid: false,
      mode: runtimeAttestationRemoteVerifyByDefault() ? 'remote' : 'self',
      reason: 'runtime_attestation_missing'
    };
  }

  const remoteVerify = runtimeAttestationRemoteVerifyByDefault();

  if (!remoteVerify) {
    const claims = claimsFromEvidence(evidence);
    const reason = validateClaims({
      claims,
      expected: input.expected
    });

    return {
      valid: !reason,
      mode: 'self',
      reason,
      claims
    };
  }

  const verifierUrl = runtimeAttestationVerifierUrlByDefault();
  if (!verifierUrl) {
    return {
      valid: false,
      mode: 'remote',
      reason: 'runtime_attestation_verifier_not_configured'
    };
  }

  try {
    const response = await fetch(verifierUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        evidence,
        expected: {
          appId: input.expected.appId,
          environment: input.expected.environment,
          imageDigest: input.expected.imageDigest,
          signerAddress: input.expected.signerAddress,
          reportDataHash: input.expected.reportDataHash
        }
      }),
      signal: AbortSignal.timeout(10_000)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        valid: false,
        mode: 'remote',
        reason: `runtime_attestation_remote_http_${response.status}`
      };
    }

    if (payload?.valid !== true) {
      return {
        valid: false,
        mode: 'remote',
        reason: typeof payload?.reason === 'string' ? payload.reason : 'runtime_attestation_remote_invalid'
      };
    }

    const claims = claimsFromEvidence(payload?.claims || evidence);
    const reason = validateClaims({ claims, expected: input.expected });

    return {
      valid: !reason,
      mode: 'remote',
      reason,
      claims
    };
  } catch (error) {
    return {
      valid: false,
      mode: 'remote',
      reason: error instanceof Error ? `runtime_attestation_remote_failed:${error.message}` : 'runtime_attestation_remote_failed'
    };
  }
}

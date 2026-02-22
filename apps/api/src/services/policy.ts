import type { StrictPolicySnapshot } from '../types/domain.js';

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value.trim() === '') return fallback;
  return value.trim().toLowerCase() !== 'false';
}

function envNumber(name: string, fallback: number, min?: number, max?: number): number {
  const value = process.env[name];
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

  const boundedMin = min == null ? parsed : Math.max(parsed, min);
  const bounded = max == null ? boundedMin : Math.min(boundedMin, max);
  return Math.floor(bounded);
}

function testLikeRuntime(): boolean {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv === 'test') return true;
  if (Boolean(process.env.VITEST)) return true;
  return false;
}

export function endpointModeRequiredByDefault(): boolean {
  return envFlag('NEG_REQUIRE_ENDPOINT_MODE', true);
}

export function endpointNegotiationRequiredByDefault(): boolean {
  return envFlag('NEG_REQUIRE_ENDPOINT_NEGOTIATION', true);
}

export function turnProofRequiredByDefault(): boolean {
  return envFlag('NEG_REQUIRE_TURN_PROOF', true);
}

export function turnProofMaxSkewMsByDefault(): number {
  return envNumber('NEG_TURN_PROOF_MAX_SKEW_MS', 5 * 60 * 1000, 1_000, 60 * 60 * 1000);
}

function productionRuntime(): boolean {
  return process.env.NODE_ENV?.trim().toLowerCase() === 'production';
}

export function requireRuntimeAttestationByDefault(): boolean {
  return envFlag('NEG_REQUIRE_RUNTIME_ATTESTATION', true);
}

export function runtimeAttestationRemoteVerifyByDefault(): boolean {
  return envFlag('NEG_RUNTIME_ATTESTATION_REMOTE_VERIFY', productionRuntime());
}

export function runtimeAttestationMaxAgeMsByDefault(): number {
  return envNumber('NEG_RUNTIME_ATTESTATION_MAX_AGE_MS', 10 * 60 * 1000, 5_000, 24 * 60 * 60 * 1000);
}

export function runtimeAttestationVerifierUrlByDefault(): string | undefined {
  const configured = process.env.NEG_RUNTIME_ATTESTATION_VERIFIER_URL?.trim();
  if (configured) return configured;

  const environment = process.env.ECLOUD_ENV || process.env.NEG_ECLOUD_ENV;
  if (environment === 'mainnet-alpha') {
    return 'https://verify.eigencloud.xyz/verify';
  }

  if (environment === 'sepolia') {
    return 'https://verify-sepolia.eigencloud.xyz/verify';
  }

  return undefined;
}

export function allowEngineFallbackByDefault(): boolean {
  return envFlag('NEG_ALLOW_ENGINE_FALLBACK', testLikeRuntime());
}

export function eigenComputeRequiredByDefault(): boolean {
  return envFlag('NEG_REQUIRE_EIGENCOMPUTE', true);
}

export function sandboxParityRequiredByDefault(): boolean {
  return envFlag('NEG_REQUIRE_SANDBOX_PARITY', true);
}

export function eigenComputeEnvironmentRequiredByDefault(): boolean {
  return envFlag('NEG_REQUIRE_EIGENCOMPUTE_ENVIRONMENT', true);
}

export function eigenComputeImageDigestRequiredByDefault(): boolean {
  return envFlag('NEG_REQUIRE_EIGENCOMPUTE_IMAGE_DIGEST', true);
}

export function eigenComputeSignerRequiredByDefault(): boolean {
  return envFlag('NEG_REQUIRE_EIGENCOMPUTE_SIGNER', true);
}

export function independentAgentsRequiredByDefault(): boolean {
  return envFlag('NEG_REQUIRE_INDEPENDENT_AGENTS', true);
}

export function eigenAppBindingRequiredByDefault(): boolean {
  return envFlag('NEG_REQUIRE_EIGEN_APP_BINDING', false);
}

export function allowSimpleModeByDefault(): boolean {
  const value = process.env.NEG_ALLOW_SIMPLE_MODE;
  return value?.trim().toLowerCase() === 'true';
}

export function attestationRequiredByDefault(): boolean {
  return envFlag('NEG_REQUIRE_ATTESTATION', true);
}

export function privacyRedactionRequiredByDefault(): boolean {
  return envFlag('NEG_REQUIRE_PRIVACY_REDACTION', true);
}

export function allowInsecureDevKeysByDefault(): boolean {
  return envFlag('NEG_ALLOW_INSECURE_DEV_KEYS', false);
}

export function sealingKeyRequiredByDefault(): boolean {
  const fallback = !testLikeRuntime() && !allowInsecureDevKeysByDefault();
  return envFlag('NEG_REQUIRE_SEALING_KEY', fallback);
}

export function attestationSignerKeyRequiredByDefault(): boolean {
  const fallback = !testLikeRuntime() && !allowInsecureDevKeysByDefault();
  return envFlag('NEG_REQUIRE_ATTESTATION_SIGNER_KEY', fallback);
}

export function strictPolicySnapshot(): StrictPolicySnapshot {
  return {
    requireEndpointMode: endpointModeRequiredByDefault(),
    requireEndpointNegotiation: endpointNegotiationRequiredByDefault(),
    requireTurnProof: turnProofRequiredByDefault(),
    turnProofMaxSkewMs: turnProofMaxSkewMsByDefault(),
    requireRuntimeAttestation: requireRuntimeAttestationByDefault(),
    runtimeAttestationRemoteVerify: runtimeAttestationRemoteVerifyByDefault(),
    runtimeAttestationMaxAgeMs: runtimeAttestationMaxAgeMsByDefault(),
    runtimeAttestationVerifierUrlConfigured: Boolean(runtimeAttestationVerifierUrlByDefault()),
    allowEngineFallback: allowEngineFallbackByDefault(),
    requireEigenCompute: eigenComputeRequiredByDefault(),
    requireSandboxParity: sandboxParityRequiredByDefault(),
    requireEigenComputeEnvironment: eigenComputeEnvironmentRequiredByDefault(),
    requireEigenComputeImageDigest: eigenComputeImageDigestRequiredByDefault(),
    requireEigenComputeSigner: eigenComputeSignerRequiredByDefault(),
    requireIndependentAgents: independentAgentsRequiredByDefault(),
    requireEigenAppBinding: eigenAppBindingRequiredByDefault(),
    requireSealingKey: sealingKeyRequiredByDefault(),
    requireAttestationSignerKey: attestationSignerKeyRequiredByDefault(),
    allowInsecureDevKeys: allowInsecureDevKeysByDefault(),
    allowSimpleMode: allowSimpleModeByDefault(),
    requireAttestation: attestationRequiredByDefault(),
    requirePrivacyRedaction: privacyRedactionRequiredByDefault()
  };
}

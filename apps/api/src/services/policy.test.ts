import { afterEach, describe, expect, it } from 'vitest';
import {
  allowEngineFallbackByDefault,
  allowInsecureDevKeysByDefault,
  allowSimpleModeByDefault,
  attestationRequiredByDefault,
  attestationSignerKeyRequiredByDefault,
  eigenAppBindingRequiredByDefault,
  eigenComputeEnvironmentRequiredByDefault,
  eigenComputeImageDigestRequiredByDefault,
  eigenComputeRequiredByDefault,
  eigenComputeSignerRequiredByDefault,
  endpointModeRequiredByDefault,
  endpointNegotiationRequiredByDefault,
  independentAgentsRequiredByDefault,
  privacyRedactionRequiredByDefault,
  requireRuntimeAttestationByDefault,
  runtimeAttestationMaxAgeMsByDefault,
  runtimeAttestationRemoteVerifyByDefault,
  runtimeAttestationVerifierUrlByDefault,
  sandboxParityRequiredByDefault,
  sealingKeyRequiredByDefault,
  strictPolicySnapshot,
  turnProofMaxSkewMsByDefault,
  turnProofRequiredByDefault
} from './policy.js';

const touchedVars = [
  'NEG_REQUIRE_ENDPOINT_MODE',
  'NEG_REQUIRE_ENDPOINT_NEGOTIATION',
  'NEG_REQUIRE_TURN_PROOF',
  'NEG_TURN_PROOF_MAX_SKEW_MS',
  'NEG_ALLOW_ENGINE_FALLBACK',
  'NEG_REQUIRE_RUNTIME_ATTESTATION',
  'NEG_RUNTIME_ATTESTATION_REMOTE_VERIFY',
  'NEG_RUNTIME_ATTESTATION_MAX_AGE_MS',
  'NEG_RUNTIME_ATTESTATION_VERIFIER_URL',
  'NEG_ALLOW_INSECURE_DEV_KEYS',
  'NEG_REQUIRE_EIGENCOMPUTE',
  'NEG_REQUIRE_SANDBOX_PARITY',
  'NEG_REQUIRE_EIGENCOMPUTE_ENVIRONMENT',
  'NEG_REQUIRE_EIGENCOMPUTE_IMAGE_DIGEST',
  'NEG_REQUIRE_EIGENCOMPUTE_SIGNER',
  'NEG_REQUIRE_INDEPENDENT_AGENTS',
  'NEG_REQUIRE_EIGEN_APP_BINDING',
  'NEG_REQUIRE_SEALING_KEY',
  'NEG_REQUIRE_ATTESTATION_SIGNER_KEY',
  'NEG_ALLOW_SIMPLE_MODE',
  'NEG_REQUIRE_ATTESTATION',
  'NEG_REQUIRE_PRIVACY_REDACTION',
  'ECLOUD_ENV',
  'ECLOUD_APP_ID_API',
  'ECLOUD_APP_ID_WEB',
  'ECLOUD_APP_ID',
  'ECLOUD_APP_IDS',
  'NEG_ECLOUD_ENV',
  'NEG_ECLOUD_APP_ID_API',
  'NEG_ECLOUD_APP_ID_WEB',
  'NEG_ECLOUD_APP_ID',
  'NEG_ECLOUD_APP_IDS',
  'NODE_ENV',
  'VITEST'
] as const;

afterEach(() => {
  for (const key of touchedVars) {
    delete process.env[key];
  }
});

describe('policy defaults', () => {
  it('enables strict settings by default', () => {
    expect(endpointModeRequiredByDefault()).toBe(true);
    expect(endpointNegotiationRequiredByDefault()).toBe(true);
    expect(turnProofRequiredByDefault()).toBe(true);
    expect(turnProofMaxSkewMsByDefault()).toBe(5 * 60 * 1000);
    expect(requireRuntimeAttestationByDefault()).toBe(false);
    expect(runtimeAttestationRemoteVerifyByDefault()).toBe(false);
    expect(runtimeAttestationMaxAgeMsByDefault()).toBe(10 * 60 * 1000);
    expect(runtimeAttestationVerifierUrlByDefault()).toBeUndefined();
    expect(allowEngineFallbackByDefault()).toBe(true);
    expect(allowInsecureDevKeysByDefault()).toBe(false);
    expect(eigenComputeRequiredByDefault()).toBe(true);
    expect(sandboxParityRequiredByDefault()).toBe(true);
    expect(eigenComputeEnvironmentRequiredByDefault()).toBe(true);
    expect(eigenComputeImageDigestRequiredByDefault()).toBe(true);
    expect(eigenComputeSignerRequiredByDefault()).toBe(true);
    expect(independentAgentsRequiredByDefault()).toBe(true);
    expect(eigenAppBindingRequiredByDefault()).toBe(false);
    expect(attestationRequiredByDefault()).toBe(true);
    expect(privacyRedactionRequiredByDefault()).toBe(true);
    expect(allowSimpleModeByDefault()).toBe(false);
  });

  it('respects explicit false flags', () => {
    process.env.NEG_REQUIRE_ENDPOINT_MODE = 'false';
    process.env.NEG_REQUIRE_ENDPOINT_NEGOTIATION = 'false';
    process.env.NEG_REQUIRE_TURN_PROOF = 'false';
    process.env.NEG_REQUIRE_RUNTIME_ATTESTATION = 'false';
    process.env.NEG_RUNTIME_ATTESTATION_REMOTE_VERIFY = 'false';
    process.env.NEG_ALLOW_ENGINE_FALLBACK = 'false';
    process.env.NEG_ALLOW_INSECURE_DEV_KEYS = 'false';
    process.env.NEG_REQUIRE_EIGENCOMPUTE = 'false';
    process.env.NEG_REQUIRE_SANDBOX_PARITY = 'false';
    process.env.NEG_REQUIRE_EIGENCOMPUTE_ENVIRONMENT = 'false';
    process.env.NEG_REQUIRE_EIGENCOMPUTE_IMAGE_DIGEST = 'false';
    process.env.NEG_REQUIRE_EIGENCOMPUTE_SIGNER = 'false';
    process.env.NEG_REQUIRE_INDEPENDENT_AGENTS = 'false';
    process.env.NEG_REQUIRE_EIGEN_APP_BINDING = 'false';
    process.env.NEG_REQUIRE_ATTESTATION = 'false';
    process.env.NEG_REQUIRE_PRIVACY_REDACTION = 'false';

    expect(endpointModeRequiredByDefault()).toBe(false);
    expect(endpointNegotiationRequiredByDefault()).toBe(false);
    expect(turnProofRequiredByDefault()).toBe(false);
    expect(requireRuntimeAttestationByDefault()).toBe(false);
    expect(runtimeAttestationRemoteVerifyByDefault()).toBe(false);
    expect(allowEngineFallbackByDefault()).toBe(false);
    expect(allowInsecureDevKeysByDefault()).toBe(false);
    expect(eigenComputeRequiredByDefault()).toBe(false);
    expect(sandboxParityRequiredByDefault()).toBe(false);
    expect(eigenComputeEnvironmentRequiredByDefault()).toBe(false);
    expect(eigenComputeImageDigestRequiredByDefault()).toBe(false);
    expect(eigenComputeSignerRequiredByDefault()).toBe(false);
    expect(independentAgentsRequiredByDefault()).toBe(false);
    expect(eigenAppBindingRequiredByDefault()).toBe(false);
    expect(attestationRequiredByDefault()).toBe(false);
    expect(privacyRedactionRequiredByDefault()).toBe(false);
  });

  it('only enables simple mode when explicitly true', () => {
    process.env.NEG_ALLOW_SIMPLE_MODE = 'TRUE';
    expect(allowSimpleModeByDefault()).toBe(true);

    process.env.NEG_ALLOW_SIMPLE_MODE = 'false';
    expect(allowSimpleModeByDefault()).toBe(false);
  });

  it('bounds turn proof and runtime attestation windows to safe limits', () => {
    process.env.NEG_TURN_PROOF_MAX_SKEW_MS = '250';
    expect(turnProofMaxSkewMsByDefault()).toBe(1000);

    process.env.NEG_TURN_PROOF_MAX_SKEW_MS = String(2 * 60 * 60 * 1000);
    expect(turnProofMaxSkewMsByDefault()).toBe(60 * 60 * 1000);

    process.env.NEG_RUNTIME_ATTESTATION_MAX_AGE_MS = '100';
    expect(runtimeAttestationMaxAgeMsByDefault()).toBe(5000);

    process.env.NEG_RUNTIME_ATTESTATION_MAX_AGE_MS = String(3 * 24 * 60 * 60 * 1000);
    expect(runtimeAttestationMaxAgeMsByDefault()).toBe(24 * 60 * 60 * 1000);
  });

  it('optionally allows insecure dev keys only when explicitly enabled', () => {
    process.env.NEG_ALLOW_INSECURE_DEV_KEYS = 'true';
    process.env.NODE_ENV = 'production';
    delete process.env.VITEST;

    expect(allowInsecureDevKeysByDefault()).toBe(true);
    expect(sealingKeyRequiredByDefault()).toBe(false);
    expect(attestationSignerKeyRequiredByDefault()).toBe(false);
  });

  it('requires explicit cryptographic keys outside test-like runtime', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VITEST;

    expect(sealingKeyRequiredByDefault()).toBe(true);
    expect(attestationSignerKeyRequiredByDefault()).toBe(true);

    process.env.NEG_REQUIRE_SEALING_KEY = 'false';
    process.env.NEG_REQUIRE_ATTESTATION_SIGNER_KEY = 'false';

    expect(sealingKeyRequiredByDefault()).toBe(false);
    expect(attestationSignerKeyRequiredByDefault()).toBe(false);
  });

  it('enables app binding only when explicitly configured', () => {
    process.env.ECLOUD_APP_ID_API = '0xabc';
    expect(eigenAppBindingRequiredByDefault()).toBe(false);

    process.env.NEG_REQUIRE_EIGEN_APP_BINDING = 'true';
    expect(eigenAppBindingRequiredByDefault()).toBe(true);
  });

  it('derives runtime attestation verifier URL from environment when not explicitly configured', () => {
    process.env.ECLOUD_ENV = 'sepolia';
    expect(runtimeAttestationVerifierUrlByDefault()).toBe('https://verify-sepolia.eigencloud.xyz/verify');

    process.env.ECLOUD_ENV = 'mainnet-alpha';
    expect(runtimeAttestationVerifierUrlByDefault()).toBe('https://verify.eigencloud.xyz/verify');

    process.env.NEG_RUNTIME_ATTESTATION_VERIFIER_URL = 'https://custom-verifier.example.com/verify';
    expect(runtimeAttestationVerifierUrlByDefault()).toBe('https://custom-verifier.example.com/verify');
  });

  it('returns full strict snapshot', () => {
    process.env.NEG_ALLOW_SIMPLE_MODE = 'true';
    process.env.NEG_REQUIRE_EIGEN_APP_BINDING = 'false';
    process.env.NEG_REQUIRE_SEALING_KEY = 'false';
    process.env.NEG_REQUIRE_ATTESTATION_SIGNER_KEY = 'false';
    process.env.NEG_ALLOW_ENGINE_FALLBACK = 'true';
    process.env.NEG_TURN_PROOF_MAX_SKEW_MS = '7000';
    process.env.NEG_REQUIRE_RUNTIME_ATTESTATION = 'true';
    const snapshot = strictPolicySnapshot();

    expect(snapshot).toEqual({
      requireEndpointMode: true,
      requireEndpointNegotiation: true,
      requireTurnProof: true,
      turnProofMaxSkewMs: 7000,
      requireRuntimeAttestation: true,
      runtimeAttestationRemoteVerify: false,
      runtimeAttestationMaxAgeMs: 10 * 60 * 1000,
      runtimeAttestationVerifierUrlConfigured: false,
      allowEngineFallback: true,
      requireEigenCompute: true,
      requireSandboxParity: true,
      requireEigenComputeEnvironment: true,
      requireEigenComputeImageDigest: true,
      requireEigenComputeSigner: true,
      requireIndependentAgents: true,
      requireEigenAppBinding: false,
      requireSealingKey: false,
      requireAttestationSignerKey: false,
      allowInsecureDevKeys: false,
      allowSimpleMode: true,
      requireAttestation: true,
      requirePrivacyRedaction: true
    });
  });
});

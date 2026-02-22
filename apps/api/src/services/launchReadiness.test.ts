import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLaunchReadiness } from './launchReadiness.js';

const touchedVars = [
  'NODE_ENV',
  'NEG_REQUIRE_ENDPOINT_MODE',
  'NEG_REQUIRE_ENDPOINT_NEGOTIATION',
  'NEG_REQUIRE_TURN_PROOF',
  'NEG_ALLOW_ENGINE_FALLBACK',
  'NEG_REQUIRE_EIGENCOMPUTE',
  'NEG_REQUIRE_SANDBOX_PARITY',
  'NEG_REQUIRE_EIGENCOMPUTE_ENVIRONMENT',
  'NEG_REQUIRE_EIGENCOMPUTE_IMAGE_DIGEST',
  'NEG_REQUIRE_EIGENCOMPUTE_SIGNER',
  'NEG_REQUIRE_INDEPENDENT_AGENTS',
  'NEG_ALLOW_SIMPLE_MODE',
  'NEG_REQUIRE_ATTESTATION',
  'NEG_REQUIRE_PRIVACY_REDACTION',
  'NEG_ALLOW_INSECURE_DEV_KEYS',
  'NEG_REQUIRE_SEALING_KEY',
  'NEG_REQUIRE_ATTESTATION_SIGNER_KEY',
  'NEG_REQUIRE_RUNTIME_ATTESTATION',
  'NEG_RUNTIME_ATTESTATION_REMOTE_VERIFY',
  'NEG_RUNTIME_ATTESTATION_VERIFIER_URL',
  'NEG_SEALING_KEY',
  'NEG_ATTESTATION_SIGNER_PRIVATE_KEY',
  'VITEST'
] as const;

afterEach(() => {
  for (const key of touchedVars) delete process.env[key];
});

describe('launch readiness', () => {
  it('reports ready in production when strict flags and keys are present', () => {
    process.env.NODE_ENV = 'production';
    process.env.NEG_SEALING_KEY = '4f1c9f69fd3f4aa0c3147637e8fbd0f4f8ce2a7ae6b503d17f632de5af0cf2da';
    process.env.NEG_ATTESTATION_SIGNER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945386f4f5d7f54b52f9f7c4f6b8e0b7d7e3d1';
    process.env.NEG_ALLOW_ENGINE_FALLBACK = 'false';
    process.env.NEG_ALLOW_INSECURE_DEV_KEYS = 'false';
    process.env.NEG_REQUIRE_RUNTIME_ATTESTATION = 'true';
    process.env.NEG_RUNTIME_ATTESTATION_REMOTE_VERIFY = 'true';
    process.env.NEG_RUNTIME_ATTESTATION_VERIFIER_URL = 'https://verify-sepolia.eigencloud.xyz/verify';

    const report = evaluateLaunchReadiness();

    expect(report.production).toBe(true);
    expect(report.ready).toBe(true);
    expect(report.blockers).toHaveLength(0);
  });

  it('reports blockers when fallback and insecure keys are enabled in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.NEG_ALLOW_ENGINE_FALLBACK = 'true';
    process.env.NEG_ALLOW_INSECURE_DEV_KEYS = 'true';

    const report = evaluateLaunchReadiness();

    expect(report.ready).toBe(false);
    expect(report.blockers.some((reason) => reason.includes('allowEngineFallback'))).toBe(true);
    expect(report.blockers.some((reason) => reason.includes('allowInsecureDevKeys'))).toBe(true);
    expect(report.blockers.some((reason) => reason.includes('NEG_SEALING_KEY'))).toBe(true);
    expect(report.blockers.some((reason) => reason.includes('NEG_ATTESTATION_SIGNER_PRIVATE_KEY'))).toBe(true);
  });
});

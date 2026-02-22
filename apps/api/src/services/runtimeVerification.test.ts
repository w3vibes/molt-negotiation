import { afterEach, describe, expect, it } from 'vitest';
import { verifyRuntimeAttestation } from './runtimeVerification.js';

const touchedVars = [
  'NODE_ENV',
  'VITEST',
  'NEG_REQUIRE_RUNTIME_ATTESTATION',
  'NEG_RUNTIME_ATTESTATION_REMOTE_VERIFY',
  'NEG_RUNTIME_ATTESTATION_MAX_AGE_MS',
  'NEG_RUNTIME_ATTESTATION_VERIFIER_URL'
] as const;

afterEach(() => {
  for (const key of touchedVars) delete process.env[key];
});

describe('runtime attestation verification', () => {
  it('accepts valid self-verified runtime claims when remote verify is disabled', async () => {
    process.env.NEG_RUNTIME_ATTESTATION_REMOTE_VERIFY = 'false';
    process.env.NEG_RUNTIME_ATTESTATION_MAX_AGE_MS = String(5 * 60 * 1000);

    const reportDataHash = '0xabc123';
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const verification = await verifyRuntimeAttestation({
      expected: {
        appId: 'app_alpha',
        environment: 'sepolia',
        imageDigest: 'sha256:image',
        signerAddress: '0xabc',
        reportDataHash
      },
      evidence: {
        claims: {
          appId: 'app_alpha',
          environment: 'sepolia',
          imageDigest: 'sha256:image',
          signerAddress: '0xabc',
          reportDataHash,
          issuedAt,
          expiresAt
        }
      }
    });

    expect(verification.valid).toBe(true);
    expect(verification.mode).toBe('self');
  });

  it('rejects when required runtime attestation evidence is missing', async () => {
    process.env.NEG_RUNTIME_ATTESTATION_REMOTE_VERIFY = 'false';

    const verification = await verifyRuntimeAttestation({
      expected: {
        appId: 'app_alpha',
        reportDataHash: '0xabc123'
      }
    });

    expect(verification.valid).toBe(false);
    expect(verification.reason).toBe('runtime_attestation_missing');
  });
});

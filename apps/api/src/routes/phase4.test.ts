import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../server.js';
import { createStore } from '../services/store.js';

const touchedEnv = [
  'NEG_ALLOW_PUBLIC_READ',
  'NEG_REQUIRE_ENDPOINT_MODE',
  'NEG_REQUIRE_EIGENCOMPUTE',
  'NEG_REQUIRE_SANDBOX_PARITY',
  'NEG_REQUIRE_PRIVACY_REDACTION',
  'NEG_REQUIRE_ATTESTATION',
  'NEG_SEALING_KEY',
  'NEG_ATTESTATION_SIGNER_PRIVATE_KEY'
] as const;

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

function tempDbFile() {
  const dir = mkdtempSync(join(tmpdir(), 'molt-neg-phase4-'));
  tempDirs.push(dir);
  return join(dir, 'test.sqlite');
}

async function registerAgent(app: ReturnType<typeof buildServer>, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/agents/register',
    payload
  });
}

async function createFinalizedSession(app: ReturnType<typeof buildServer>) {
  const agentA = await registerAgent(app, {
    agent_name: `phase4-a-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    endpoint: 'https://phase4-a.example.com',
    sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
    eigencompute: { appId: 'phase4_app_a', environment: 'sepolia', imageDigest: 'sha256:shared_digest', signerAddress: '0xphase4_app_a_signer' }
  });

  const agentB = await registerAgent(app, {
    agent_name: `phase4-b-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    endpoint: 'https://phase4-b.example.com',
    sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
    eigencompute: { appId: 'phase4_app_b', environment: 'sepolia', imageDigest: 'sha256:shared_digest', signerAddress: '0xphase4_app_b_signer' }
  });

  const create = await app.inject({
    method: 'POST',
    url: '/sessions',
    headers: { authorization: `Bearer ${agentA.json().api_key}` },
    payload: {
      topic: 'phase4 verification flow',
      proposerAgentId: agentA.json().agent_id,
      counterpartyAgentId: agentB.json().agent_id
    }
  });

  const sessionId = create.json().session.id as string;

  await app.inject({
    method: 'POST',
    url: `/sessions/${sessionId}/accept`,
    headers: { authorization: `Bearer ${agentB.json().api_key}` },
    payload: { counterpartyAgentId: agentB.json().agent_id }
  });

  await app.inject({
    method: 'POST',
    url: `/sessions/${sessionId}/prepare`,
    headers: { authorization: `Bearer ${agentA.json().api_key}` }
  });

  await app.inject({
    method: 'POST',
    url: `/sessions/${sessionId}/start`,
    headers: { authorization: `Bearer ${agentB.json().api_key}` }
  });

  await app.inject({
    method: 'POST',
    url: `/sessions/${sessionId}/private-inputs`,
    headers: { authorization: `Bearer ${agentA.json().api_key}` },
    payload: {
      privateContext: {
        strategy: {
          role: 'buyer',
          reservationPrice: 120,
          initialPrice: 80,
          concessionStep: 10
        },
        attributes: { income: 3000, creditScore: 780 }
      }
    }
  });

  await app.inject({
    method: 'POST',
    url: `/sessions/${sessionId}/private-inputs`,
    headers: { authorization: `Bearer ${agentB.json().api_key}` },
    payload: {
      privateContext: {
        strategy: {
          role: 'seller',
          reservationPrice: 100,
          initialPrice: 140,
          concessionStep: 10
        },
        attributes: { income: 5500, creditScore: 730 }
      }
    }
  });

  const negotiate = await app.inject({
    method: 'POST',
    url: `/sessions/${sessionId}/negotiate`,
    headers: { authorization: `Bearer ${agentA.json().api_key}` },
    payload: { maxTurns: 8 }
  });

  expect(negotiate.statusCode).toBe(200);
  expect(['agreed', 'no_agreement', 'failed']).toContain(negotiate.json().result.finalStatus);

  return {
    sessionId,
    agentA: agentA.json(),
    agentB: agentB.json()
  };
}

afterEach(() => {
  for (const key of touchedEnv) delete process.env[key];
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('phase 4 attestation + trust gating', () => {
  it('returns valid attestation verification for finalized strict session', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'true';
    process.env.NEG_SEALING_KEY = 'hex:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
    process.env.NEG_ATTESTATION_SIGNER_PRIVATE_KEY = 'phase4-attest-secret';

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const store = createStore({ dbFile: tempDbFile() });
    const app = buildServer({ store });

    const flow = await createFinalizedSession(app);

    const attestation = await app.inject({
      method: 'GET',
      url: `/sessions/${flow.sessionId}/attestation`
    });

    expect(attestation.statusCode).toBe(200);
    expect(attestation.json().verification.valid).toBe(true);
    expect(attestation.json().verification.checks.signatureMatches).toBe(true);
    expect(attestation.json().verification.checks.outcomeHashMatches).toBe(true);

    await app.close();
  });

  it('rejects tampered attestation payload', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'true';
    process.env.NEG_SEALING_KEY = 'hex:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
    process.env.NEG_ATTESTATION_SIGNER_PRIVATE_KEY = 'phase4-attest-secret';

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const store = createStore({ dbFile: tempDbFile() });
    const app = buildServer({ store });

    const flow = await createFinalizedSession(app);

    const original = store.getAttestation(flow.sessionId);
    expect(original).toBeTruthy();

    store.saveAttestation({
      ...original!,
      payload: {
        ...(original!.payload as Record<string, unknown>),
        strictVerified: false
      }
    });

    const attestation = await app.inject({
      method: 'GET',
      url: `/sessions/${flow.sessionId}/attestation`
    });

    expect(attestation.statusCode).toBe(200);
    expect(attestation.json().verification.valid).toBe(false);
    expect(attestation.json().verification.reasons).toContain('payload_hash_mismatch');

    await app.close();
  });

  it('trusted leaderboard excludes non-verified sessions', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'true';
    process.env.NEG_SEALING_KEY = 'hex:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
    process.env.NEG_ATTESTATION_SIGNER_PRIVATE_KEY = 'phase4-attest-secret';

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const store = createStore({ dbFile: tempDbFile() });
    const app = buildServer({ store });

    const validFlow = await createFinalizedSession(app);
    const tamperedFlow = await createFinalizedSession(app);

    const tampered = store.getAttestation(tamperedFlow.sessionId)!;
    store.saveAttestation({
      ...tampered,
      signature: '0xdeadbeef'
    });

    const leaderboard = await app.inject({
      method: 'GET',
      url: '/leaderboard/trusted'
    });

    expect(leaderboard.statusCode).toBe(200);
    expect(leaderboard.json().summary.trustedSessions).toBe(1);
    expect(leaderboard.json().summary.excludedSessions).toBeGreaterThanOrEqual(1);

    const trustedIds = leaderboard.json().trustedSessions.map((row: { sessionId: string }) => row.sessionId);
    const excludedIds = leaderboard.json().excludedSessions.map((row: { sessionId: string }) => row.sessionId);

    expect(trustedIds).toContain(validFlow.sessionId);
    expect(excludedIds).toContain(tamperedFlow.sessionId);

    await app.close();
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../server.js';
import { createStore } from '../services/store.js';

const touchedEnv = [
  'NEG_ALLOW_PUBLIC_READ',
  'NEG_OPERATOR_API_KEY',
  'NEG_REQUIRE_ENDPOINT_MODE',
  'NEG_REQUIRE_EIGENCOMPUTE',
  'NEG_REQUIRE_SANDBOX_PARITY',
  'NEG_REQUIRE_PRIVACY_REDACTION',
  'NEG_AUTOMATION_ESCROW_ENABLED',
  'NEG_AUTOMATION_ESCROW_INTERVAL_MS'
] as const;

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

function tempDbFile() {
  const dir = mkdtempSync(join(tmpdir(), 'molt-neg-phase5-'));
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

async function createEscrowSession(app: ReturnType<typeof buildServer>) {
  const agentA = await registerAgent(app, {
    agent_name: `phase5-a-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    endpoint: 'https://phase5-a.example.com',
    sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
    eigencompute: { appId: 'phase5_app_a', environment: 'sepolia', imageDigest: 'sha256:shared_digest', signerAddress: '0xphase5_app_a_signer' }
  });

  const agentB = await registerAgent(app, {
    agent_name: `phase5-b-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    endpoint: 'https://phase5-b.example.com',
    sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
    eigencompute: { appId: 'phase5_app_b', environment: 'sepolia', imageDigest: 'sha256:shared_digest', signerAddress: '0xphase5_app_b_signer' }
  });

  const created = await app.inject({
    method: 'POST',
    url: '/sessions',
    headers: { authorization: `Bearer ${agentA.json().api_key}` },
    payload: {
      topic: 'phase5 escrow',
      proposerAgentId: agentA.json().agent_id,
      counterpartyAgentId: agentB.json().agent_id,
      escrow: {
        contractAddress: '0xescrow_contract',
        tokenAddress: '0xusdc',
        amountPerPlayer: '100'
      }
    }
  });

  expect(created.statusCode).toBe(201);

  return {
    sessionId: created.json().session.id,
    agentA: agentA.json(),
    agentB: agentB.json()
  };
}

async function acceptPrepare(app: ReturnType<typeof buildServer>, sessionId: string, agentAKey: string, agentBKey: string, agentBId: string) {
  const accepted = await app.inject({
    method: 'POST',
    url: `/sessions/${sessionId}/accept`,
    headers: { authorization: `Bearer ${agentBKey}` },
    payload: { counterpartyAgentId: agentBId }
  });

  const prepared = await app.inject({
    method: 'POST',
    url: `/sessions/${sessionId}/prepare`,
    headers: { authorization: `Bearer ${agentAKey}` }
  });

  expect(accepted.statusCode).toBe(200);
  expect(prepared.statusCode).toBe(200);
}

afterEach(() => {
  for (const key of touchedEnv) delete process.env[key];
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('phase 5 escrow + automation', () => {
  it('prepare endpoint is idempotent', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'true';
    process.env.NEG_AUTOMATION_ESCROW_ENABLED = 'false';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const app = buildServer({ dbFile: tempDbFile() });
    const flow = await createEscrowSession(app);

    const firstPrepare = await app.inject({
      method: 'POST',
      url: `/sessions/${flow.sessionId}/escrow/prepare`,
      headers: { authorization: `Bearer ${flow.agentA.api_key}` }
    });

    const secondPrepare = await app.inject({
      method: 'POST',
      url: `/sessions/${flow.sessionId}/escrow/prepare`,
      headers: { authorization: `Bearer ${flow.agentA.api_key}` }
    });

    expect(firstPrepare.statusCode).toBe(200);
    expect(firstPrepare.json().idempotent).toBe(false);
    expect(secondPrepare.statusCode).toBe(200);
    expect(secondPrepare.json().idempotent).toBe(true);

    await app.close();
  });

  it('blocks session start when escrow funding is incomplete', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'true';
    process.env.NEG_AUTOMATION_ESCROW_ENABLED = 'false';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const app = buildServer({ dbFile: tempDbFile() });
    const flow = await createEscrowSession(app);

    await acceptPrepare(app, flow.sessionId, flow.agentA.api_key, flow.agentB.api_key, flow.agentB.agent_id);

    const preparedEscrow = await app.inject({
      method: 'POST',
      url: `/sessions/${flow.sessionId}/escrow/prepare`,
      headers: { authorization: `Bearer ${flow.agentA.api_key}` }
    });
    expect(preparedEscrow.statusCode).toBe(200);

    const startBlocked = await app.inject({
      method: 'POST',
      url: `/sessions/${flow.sessionId}/start`,
      headers: { authorization: `Bearer ${flow.agentA.api_key}` }
    });

    expect(startBlocked.statusCode).toBe(409);
    expect(startBlocked.json().error.code).toBe('funding_pending');

    await app.close();
  });

  it('settles escrow on agreement path when funded', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'true';
    process.env.NEG_AUTOMATION_ESCROW_ENABLED = 'false';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const store = createStore({ dbFile: tempDbFile() });
    const app = buildServer({ store });
    const flow = await createEscrowSession(app);

    await acceptPrepare(app, flow.sessionId, flow.agentA.api_key, flow.agentB.api_key, flow.agentB.agent_id);

    await app.inject({
      method: 'POST',
      url: `/sessions/${flow.sessionId}/escrow/prepare`,
      headers: { authorization: `Bearer ${flow.agentA.api_key}` }
    });

    await app.inject({
      method: 'POST',
      url: `/sessions/${flow.sessionId}/escrow/deposit`,
      headers: { authorization: `Bearer ${flow.agentA.api_key}` },
      payload: { amount: '100' }
    });

    await app.inject({
      method: 'POST',
      url: `/sessions/${flow.sessionId}/escrow/deposit`,
      headers: { authorization: `Bearer ${flow.agentB.api_key}` },
      payload: { amount: '100' }
    });

    const start = await app.inject({
      method: 'POST',
      url: `/sessions/${flow.sessionId}/start`,
      headers: { authorization: `Bearer ${flow.agentA.api_key}` }
    });
    expect(start.statusCode).toBe(200);

    await app.inject({
      method: 'POST',
      url: `/sessions/${flow.sessionId}/private-inputs`,
      headers: { authorization: `Bearer ${flow.agentA.api_key}` },
      payload: {
        privateContext: {
          strategy: { role: 'buyer', reservationPrice: 120, initialPrice: 80, concessionStep: 10 }
        }
      }
    });

    await app.inject({
      method: 'POST',
      url: `/sessions/${flow.sessionId}/private-inputs`,
      headers: { authorization: `Bearer ${flow.agentB.api_key}` },
      payload: {
        privateContext: {
          strategy: { role: 'seller', reservationPrice: 100, initialPrice: 140, concessionStep: 10 }
        }
      }
    });

    const negotiate = await app.inject({
      method: 'POST',
      url: `/sessions/${flow.sessionId}/negotiate`,
      headers: { authorization: `Bearer ${flow.agentA.api_key}` },
      payload: { maxTurns: 8 }
    });

    expect(negotiate.statusCode).toBe(200);
    expect(negotiate.json().escrow.action).toBe('settled');

    const escrow = store.getEscrow(flow.sessionId);
    expect(escrow?.status).toBe('settled');

    await app.close();
  });

  it('automation tick retries and settles pending funded escrows', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'true';
    process.env.NEG_OPERATOR_API_KEY = 'operator_key';
    process.env.NEG_AUTOMATION_ESCROW_ENABLED = 'false';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const store = createStore({ dbFile: tempDbFile() });
    const app = buildServer({ store });
    const flow = await createEscrowSession(app);

    store.patchSession(flow.sessionId, {
      status: 'agreed',
      terms: {
        escrow: {
          contractAddress: '0xescrow_contract',
          amountPerPlayer: '100'
        }
      }
    });

    store.upsertEscrow({
      sessionId: flow.sessionId,
      contractAddress: '0xescrow_contract',
      tokenAddress: '0xusdc',
      stakeAmount: '100',
      status: 'settlement_pending',
      txHash: undefined,
      playerAAgentId: flow.agentA.agent_id,
      playerBAgentId: flow.agentB.agent_id,
      playerADeposited: true,
      playerBDeposited: true,
      settlementAttempts: 1,
      lastSettlementError: 'previous_error',
      lastSettlementAt: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const tick = await app.inject({
      method: 'POST',
      url: '/automation/tick',
      headers: { authorization: 'Bearer operator_key' }
    });

    expect(tick.statusCode).toBe(200);
    expect(tick.json().summary.settled).toBeGreaterThanOrEqual(1);

    const escrow = store.getEscrow(flow.sessionId);
    expect(escrow?.status).toBe('settled');

    await app.close();
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../server.js';

const touchedEnv = [
  'NEG_ALLOW_PUBLIC_READ',
  'NEG_ADMIN_API_KEY',
  'NEG_OPERATOR_API_KEY',
  'NEG_READONLY_API_KEY',
  'NEG_REQUIRE_ENDPOINT_MODE',
  'NEG_REQUIRE_EIGENCOMPUTE',
  'NEG_REQUIRE_SANDBOX_PARITY',
  'NEG_AGENT_HEALTH_TIMEOUT_MS'
] as const;

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

function tempDbFile() {
  const dir = mkdtempSync(join(tmpdir(), 'molt-neg-phase2-'));
  tempDirs.push(dir);
  return join(dir, 'test.sqlite');
}

async function registerAgent(
  app: ReturnType<typeof buildServer>,
  payload: Record<string, unknown>,
  authToken?: string
) {
  return app.inject({
    method: 'POST',
    url: '/api/agents/register',
    ...(authToken ? { headers: { authorization: `Bearer ${authToken}` } } : {}),
    payload
  });
}

afterEach(() => {
  for (const key of touchedEnv) delete process.env[key];
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('phase 2 routes', () => {
  it('rejects registration when strict metadata is missing', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'true';

    const app = buildServer({ dbFile: tempDbFile() });
    const response = await registerAgent(app, {
      agent_name: 'no-metadata-agent'
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('strict_policy_failed');

    const reasonCodes = response.json().error.details.reasons.map((reason: { code: string }) => reason.code);
    expect(reasonCodes).toContain('endpoint_mode_required');
    expect(reasonCodes).toContain('sandbox_metadata_required');
    expect(reasonCodes).toContain('eigencompute_metadata_required');

    await app.close();
  });

  it('registers agent and persists healthy probe status', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'true';

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const app = buildServer({ dbFile: tempDbFile() });
    const response = await registerAgent(app, {
      agent_name: 'alpha',
      endpoint: 'https://alpha.example.com',
      sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
      eigencompute: { appId: 'app_alpha', environment: 'sepolia', imageDigest: 'sha256:shared_digest', signerAddress: '0xapp_alpha_signer' }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().ok).toBe(true);
    expect(response.json().agent.lastHealthStatus).toBe('healthy');
    expect(response.json().api_key).toMatch(/^neg_/);

    const agents = await app.inject({ method: 'GET', url: '/agents' });
    expect(agents.statusCode).toBe(200);
    expect(agents.json()[0].lastHealthStatus).toBe('healthy');

    await app.close();
  });

  it('returns explicit health_probe_failed on manual probe failure', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'true';

    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect timeout');
    });

    const app = buildServer({ dbFile: tempDbFile() });
    const registration = await registerAgent(app, {
      agent_name: 'beta',
      endpoint: 'https://beta.example.com',
      sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
      eigencompute: { appId: 'app_beta', environment: 'sepolia', imageDigest: 'sha256:shared_digest', signerAddress: '0xapp_beta_signer' }
    });

    expect(registration.statusCode).toBe(201);
    expect(registration.json().agent.lastHealthStatus).toBe('unhealthy');

    const probe = await app.inject({
      method: 'POST',
      url: `/api/agents/${registration.json().agent_id}/probe`,
      headers: { authorization: `Bearer ${registration.json().api_key}` }
    });

    expect(probe.statusCode).toBe(502);
    expect(probe.json().error.code).toBe('health_probe_failed');

    await app.close();
  });

  it('enforces actor scope and state transitions in session lifecycle', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'false';

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const app = buildServer({ dbFile: tempDbFile() });

    const agentA = await registerAgent(app, {
      agent_name: 'agent-a',
      endpoint: 'https://a.example.com',
      sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
      eigencompute: { appId: 'app_a', environment: 'sepolia', imageDigest: 'sha256:shared_digest', signerAddress: '0xapp_a_signer' }
    });

    const agentB = await registerAgent(app, {
      agent_name: 'agent-b',
      endpoint: 'https://b.example.com',
      sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
      eigencompute: { appId: 'app_b', environment: 'sepolia', imageDigest: 'sha256:shared_digest', signerAddress: '0xapp_b_signer' }
    });

    const agentC = await registerAgent(app, {
      agent_name: 'agent-c',
      endpoint: 'https://c.example.com',
      sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
      eigencompute: { appId: 'app_c', environment: 'sepolia', imageDigest: 'sha256:shared_digest', signerAddress: '0xapp_c_signer' }
    });

    const createScopeViolation = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${agentA.json().api_key}` },
      payload: {
        topic: 'scope-check',
        proposerAgentId: agentB.json().agent_id,
        counterpartyAgentId: agentA.json().agent_id
      }
    });

    expect(createScopeViolation.statusCode).toBe(403);
    expect(createScopeViolation.json().error.code).toBe('actor_scope_violation');

    const created = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${agentA.json().api_key}` },
      payload: {
        topic: 'salary negotiation',
        proposerAgentId: agentA.json().agent_id,
        counterpartyAgentId: agentB.json().agent_id
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().session.status).toBe('created');

    const startBeforePrepare = await app.inject({
      method: 'POST',
      url: `/sessions/${created.json().session.id}/start`,
      headers: { authorization: `Bearer ${agentA.json().api_key}` }
    });

    expect(startBeforePrepare.statusCode).toBe(409);
    expect(startBeforePrepare.json().error.code).toBe('prepare_required_before_start');

    const accepted = await app.inject({
      method: 'POST',
      url: `/sessions/${created.json().session.id}/accept`,
      headers: { authorization: `Bearer ${agentB.json().api_key}` },
      payload: {
        counterpartyAgentId: agentB.json().agent_id
      }
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().session.status).toBe('accepted');

    const prepareByNonParticipant = await app.inject({
      method: 'POST',
      url: `/sessions/${created.json().session.id}/prepare`,
      headers: { authorization: `Bearer ${agentC.json().api_key}` }
    });

    expect(prepareByNonParticipant.statusCode).toBe(403);
    expect(prepareByNonParticipant.json().error.code).toBe('actor_scope_violation');

    const prepared = await app.inject({
      method: 'POST',
      url: `/sessions/${created.json().session.id}/prepare`,
      headers: { authorization: `Bearer ${agentA.json().api_key}` }
    });

    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().session.status).toBe('prepared');

    const acceptedAgain = await app.inject({
      method: 'POST',
      url: `/sessions/${created.json().session.id}/accept`,
      headers: { authorization: `Bearer ${agentB.json().api_key}` },
      payload: { counterpartyAgentId: agentB.json().agent_id }
    });

    expect(acceptedAgain.statusCode).toBe(409);
    expect(acceptedAgain.json().error.code).toBe('invalid_state_transition');

    const started = await app.inject({
      method: 'POST',
      url: `/sessions/${created.json().session.id}/start`,
      headers: { authorization: `Bearer ${agentB.json().api_key}` }
    });

    expect(started.statusCode).toBe(200);
    expect(started.json().session.status).toBe('active');

    const sessionStatus = await app.inject({
      method: 'GET',
      url: `/sessions/${created.json().session.id}`,
      headers: { authorization: `Bearer ${agentA.json().api_key}` }
    });

    expect(sessionStatus.statusCode).toBe(200);
    expect(sessionStatus.json().session.status).toBe('active');

    await app.close();
  });

  it('allows operator override for session actions', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'false';
    process.env.NEG_OPERATOR_API_KEY = 'operator_key';

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const app = buildServer({ dbFile: tempDbFile() });

    const agentA = await registerAgent(app, {
      agent_name: 'op-a',
      endpoint: 'https://opa.example.com',
      sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
      eigencompute: { appId: 'op_app_a', environment: 'sepolia', imageDigest: 'sha256:shared_digest', signerAddress: '0xop_app_a_signer' }
    });

    const agentB = await registerAgent(app, {
      agent_name: 'op-b',
      endpoint: 'https://opb.example.com',
      sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
      eigencompute: { appId: 'op_app_b', environment: 'sepolia', imageDigest: 'sha256:shared_digest', signerAddress: '0xop_app_b_signer' }
    });

    const created = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: 'Bearer operator_key' },
      payload: {
        topic: 'operator-flow',
        proposerAgentId: agentA.json().agent_id,
        counterpartyAgentId: agentB.json().agent_id
      }
    });

    expect(created.statusCode).toBe(201);

    const accepted = await app.inject({
      method: 'POST',
      url: `/sessions/${created.json().session.id}/accept`,
      headers: { authorization: 'Bearer operator_key' },
      payload: { counterpartyAgentId: agentB.json().agent_id }
    });

    expect(accepted.statusCode).toBe(200);

    const prepared = await app.inject({
      method: 'POST',
      url: `/sessions/${created.json().session.id}/prepare`,
      headers: { authorization: 'Bearer operator_key' }
    });

    expect(prepared.statusCode).toBe(200);

    const started = await app.inject({
      method: 'POST',
      url: `/sessions/${created.json().session.id}/start`,
      headers: { authorization: 'Bearer operator_key' }
    });

    expect(started.statusCode).toBe(200);
    expect(started.json().session.status).toBe('active');

    await app.close();
  });
});

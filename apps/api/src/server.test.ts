import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { createStore } from './services/store.js';

const touchedEnv = [
  'NEG_ALLOW_PUBLIC_READ',
  'NEG_ADMIN_API_KEY',
  'NEG_OPERATOR_API_KEY',
  'NEG_READONLY_API_KEY',
  'ECLOUD_ENV',
  'ECLOUD_APP_ID_API',
  'ECLOUD_APP_ID_WEB',
  'ECLOUD_APP_IDS',
  'NEG_ECLOUD_ENV',
  'NEG_ECLOUD_APP_ID_API',
  'NEG_ECLOUD_APP_ID_WEB',
  'NEG_ECLOUD_APP_IDS',
  'NEG_AUTOMATION_ESCROW_ENABLED',
  'NEG_AUTOMATION_ESCROW_INTERVAL_MS',
  'PUBLIC_API_URL'
] as const;

const tempDirs: string[] = [];

function tempDbFile() {
  const dir = mkdtempSync(join(tmpdir(), 'molt-neg-server-'));
  tempDirs.push(dir);
  return join(dir, 'test.sqlite');
}

afterEach(() => {
  for (const key of touchedEnv) delete process.env[key];
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('server routes', () => {
  it('serves health and verification with public readonly enabled', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'true';
    process.env.ECLOUD_APP_ID_API = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const app = buildServer({ dbFile: tempDbFile() });

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().ok).toBe(true);

    const strict = await app.inject({ method: 'GET', url: '/policy/strict' });
    expect(strict.statusCode).toBe(200);
    expect(strict.json().policy.requireEndpointMode).toBe(true);

    const verify = await app.inject({ method: 'GET', url: '/verification/eigencompute' });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().checks.strictMode.requireEndpointMode).toBe(true);
    expect(verify.json().checks.appBound).toBe(true);

    const verifyMissingSession = await app.inject({
      method: 'GET',
      url: '/verification/eigencompute/sessions/session_missing'
    });
    expect(verifyMissingSession.statusCode).toBe(404);
    expect(verifyMissingSession.json().error.code).toBe('not_found');

    await app.close();
  });

  it('rejects protected routes when public read is disabled', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'false';

    const app = buildServer({ dbFile: tempDbFile() });

    const strict = await app.inject({ method: 'GET', url: '/policy/strict' });
    expect(strict.statusCode).toBe(401);

    const verify = await app.inject({ method: 'GET', url: '/verification/eigencompute' });
    expect(verify.statusCode).toBe(401);
    expect(verify.json().error.code).toBe('unauthorized');

    await app.close();
  });

  it('serves skill.md installer markdown', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'true';
    process.env.PUBLIC_API_URL = 'https://neg.example.com';

    const app = buildServer({ dbFile: tempDbFile() });
    const res = await app.inject({ method: 'GET', url: '/skill.md' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toContain('name: moltnegotiation');
    expect(res.body).toContain('https://neg.example.com/skill.md');

    await app.close();
  });

  it('allows readonly key and agent key role detection', async () => {
    process.env.NEG_ALLOW_PUBLIC_READ = 'false';
    process.env.NEG_READONLY_API_KEY = 'readonly_key';

    const store = createStore({ dbFile: tempDbFile() });
    store.upsertAgent({
      id: 'agent_a',
      name: 'Agent A',
      endpoint: 'https://agent-a.example.com',
      apiKey: 'agent_key',
      enabled: true
    });

    const app = buildServer({ store });

    const authReadonly = await app.inject({
      method: 'GET',
      url: '/auth/status',
      headers: { authorization: 'Bearer readonly_key' }
    });
    expect(authReadonly.statusCode).toBe(200);
    expect(authReadonly.json().role).toBe('readonly');

    const authAgent = await app.inject({
      method: 'GET',
      url: '/auth/status',
      headers: { authorization: 'Bearer agent_key' }
    });
    expect(authAgent.statusCode).toBe(200);
    expect(authAgent.json().role).toBe('agent');

    const verifyReadonly = await app.inject({
      method: 'GET',
      url: '/verification/eigencompute',
      headers: { authorization: 'Bearer readonly_key' }
    });
    expect(verifyReadonly.statusCode).toBe(200);

    await app.close();
  });
});

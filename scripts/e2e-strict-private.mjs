#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { ethers } from 'ethers';

const API_BASE = (process.env.E2E_API_BASE || 'http://localhost:3000').replace(/\/$/, '');
const EXPECT_STRICT = process.env.E2E_EXPECT_STRICT !== 'false';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 10_000);
const runId = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function request(method, path, { body, expectedStatus = [200], headers = {}, label } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: timeoutSignal(TIMEOUT_MS)
  });

  const payload = await response.json().catch(() => ({}));
  const acceptedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];

  if (!acceptedStatuses.includes(response.status)) {
    throw new Error(
      `${label || `${method} ${path}`} failed: status=${response.status} payload=${JSON.stringify(payload)}`
    );
  }

  return payload;
}

function authHeader(apiKey) {
  return { authorization: `Bearer ${apiKey}` };
}

function ensureNoSensitiveLeak(rawText) {
  const blocked = ['creditScore', 'income', 'reservationPrice', 'privateContext', 'maxPrice'];
  for (const token of blocked) {
    assert(!rawText.includes(token), `Sensitive token leaked in response: ${token}`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeLower(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function round4(value) {
  return Math.round(Number(value) * 10_000) / 10_000;
}

function expectedDecisionHash(input) {
  const payload = {
    protocol: 'MOLT_NEGOTIATION_TURN_PROOF',
    version: 'v1',
    sessionId: input.sessionId,
    turn: input.turn,
    agentId: input.agentId,
    role: input.role,
    offer: round4(input.offer),
    challenge: normalizeLower(input.challenge),
    appId: normalizeLower(input.appId),
    environment: normalizeLower(input.environment),
    imageDigest: normalizeLower(input.imageDigest),
    timestamp: input.timestamp
  };

  return `0x${sha256Hex(canonicalStringify(payload))}`;
}

function buildTurnProofMessage(input) {
  return [
    'MOLT_NEGOTIATION_TURN_PROOF',
    normalizeLower(input.version) || 'v1',
    input.sessionId,
    String(input.turn),
    input.agentId,
    input.role,
    round4(input.offer).toString(),
    normalizeLower(input.challenge),
    normalizeLower(input.decisionHash),
    normalizeLower(input.appId),
    normalizeLower(input.environment),
    normalizeLower(input.imageDigest),
    input.timestamp
  ].join('|');
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function nextOffer({ role, privateContext, publicState }) {
  const strategy = privateContext?.strategy || {};
  const reservation = asNumber(strategy.reservationPrice);
  const initial = asNumber(strategy.initialPrice);
  const step = Math.max(0.1, asNumber(strategy.concessionStep) || 1);

  assert(Number.isFinite(reservation), `Missing reservationPrice for role=${role}`);

  if (role === 'buyer') {
    const current = asNumber(publicState?.latestBuyerOffer);
    const base = Number.isFinite(current)
      ? current
      : Number.isFinite(initial)
        ? initial
        : reservation - step * 2;
    return round4(Math.min(reservation, base + step));
  }

  const current = asNumber(publicState?.latestSellerAsk);
  const base = Number.isFinite(current)
    ? current
    : Number.isFinite(initial)
      ? initial
      : reservation + step * 2;
  return round4(Math.max(reservation, base - step));
}

function jsonResponse(res, code, payload) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

async function startMockAgentServer(input) {
  const wallet = new ethers.Wallet(input.privateKey);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return jsonResponse(res, 200, { ok: true, agent: input.agentName, role: input.role });
    }

    if (req.method !== 'POST' || !['/decide', '/negotiate-turn', '/negotiate'].includes(url.pathname)) {
      return jsonResponse(res, 404, { ok: false, error: 'not_found' });
    }

    try {
      const body = await readJsonBody(req);
      const offer = nextOffer({
        role: input.role,
        privateContext: body.privateContext,
        publicState: body.publicState
      });

      const timestamp = new Date().toISOString();
      const decisionHash = expectedDecisionHash({
        sessionId: body.sessionId,
        turn: body.turn,
        agentId: body.agentId,
        role: body.role,
        offer,
        challenge: body.challenge,
        appId: input.appId,
        environment: input.environment,
        imageDigest: input.imageDigest,
        timestamp
      });

      const message = buildTurnProofMessage({
        sessionId: body.sessionId,
        turn: body.turn,
        agentId: body.agentId,
        role: body.role,
        offer,
        challenge: body.challenge,
        decisionHash,
        appId: input.appId,
        environment: input.environment,
        imageDigest: input.imageDigest,
        timestamp,
        version: 'v1'
      });

      const digest = ethers.hashMessage(message);
      const signature = ethers.Signature.from(wallet.signingKey.sign(digest)).serialized;

      return jsonResponse(res, 200, {
        offer,
        publicNote: `${input.agentName} turn ${body.turn}`,
        proof: {
          version: 'v1',
          sessionId: body.sessionId,
          turn: body.turn,
          agentId: body.agentId,
          challenge: body.challenge,
          decisionHash,
          appId: input.appId,
          environment: input.environment,
          imageDigest: input.imageDigest,
          signer: wallet.address,
          signature,
          timestamp,
          runtimeEvidence: {
            provider: 'eigencompute',
            reportDataHash: decisionHash,
            issuedAt: timestamp,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            claims: {
              appId: input.appId,
              environment: input.environment,
              imageDigest: input.imageDigest,
              signerAddress: wallet.address,
              reportDataHash: decisionHash,
              issuedAt: timestamp,
              expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
            }
          }
        }
      });
    } catch (error) {
      return jsonResponse(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'mock_agent_error'
      });
    }
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind mock agent server');
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    signerAddress: wallet.address,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}

async function main() {
  console.log(`\n[Phase7 E2E] Starting strict endpoint+private flow against ${API_BASE}`);

  const sharedEnv = 'sepolia';
  const sharedImageDigest = `sha256:e2e_shared_digest_${runId}`;

  const mockBuyer = await startMockAgentServer({
    agentName: `e2e-alpha-${runId}`,
    role: 'buyer',
    privateKey: '0x59c6995e998f97a5a0044966f0945386f4f5d7f54b52f9f7c4f6b8e0b7d7e3d1',
    appId: `e2e_app_alpha_${runId}`,
    environment: sharedEnv,
    imageDigest: sharedImageDigest
  });

  const mockSeller = await startMockAgentServer({
    agentName: `e2e-beta-${runId}`,
    role: 'seller',
    privateKey: '0x8b3a350cf5c34c9194ca3ab0f6a8c4d13b7f3f1e9465d9b38787ec0f7e84d7f6',
    appId: `e2e_app_beta_${runId}`,
    environment: sharedEnv,
    imageDigest: sharedImageDigest
  });

  try {
    const health = await request('GET', '/health', { label: 'health' });
    assert(health.ok === true, 'Health endpoint not ok');

    const strict = await request('GET', '/policy/strict', { label: 'strict policy' });
    assert(strict.ok === true, 'Strict policy endpoint not ok');

    if (EXPECT_STRICT) {
      assert(strict.policy.requireEndpointMode === true, 'Strict policy requireEndpointMode=false');
      assert(strict.policy.requireEndpointNegotiation === true, 'Strict policy requireEndpointNegotiation=false');
      assert(strict.policy.requireTurnProof === true, 'Strict policy requireTurnProof=false');
      assert(strict.policy.requireRuntimeAttestation === true, 'Strict policy requireRuntimeAttestation=false');
      assert(strict.policy.allowEngineFallback === false, 'Strict policy allowEngineFallback=true');
      assert(strict.policy.requireSandboxParity === true, 'Strict policy requireSandboxParity=false');
      assert(strict.policy.requireEigenCompute === true, 'Strict policy requireEigenCompute=false');
      assert(strict.policy.allowSimpleMode === false, 'Strict policy allowSimpleMode=true');
      assert(strict.policy.requirePrivacyRedaction === true, 'Strict policy requirePrivacyRedaction=false');
    }

    const registerPayloadA = {
      agent_name: `e2e-alpha-${runId}`,
      endpoint: mockBuyer.endpoint,
      sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
      eigencompute: {
        appId: `e2e_app_alpha_${runId}`,
        environment: sharedEnv,
        imageDigest: sharedImageDigest,
        signerAddress: mockBuyer.signerAddress
      }
    };

    const registerPayloadB = {
      agent_name: `e2e-beta-${runId}`,
      endpoint: mockSeller.endpoint,
      sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
      eigencompute: {
        appId: `e2e_app_beta_${runId}`,
        environment: sharedEnv,
        imageDigest: sharedImageDigest,
        signerAddress: mockSeller.signerAddress
      }
    };

    const agentA = await request('POST', '/api/agents/register', {
      body: registerPayloadA,
      expectedStatus: [200, 201],
      label: 'register agent A'
    });

    const agentB = await request('POST', '/api/agents/register', {
      body: registerPayloadB,
      expectedStatus: [200, 201],
      label: 'register agent B'
    });

    assert(agentA.agent_id && agentA.api_key, 'Agent A registration missing credentials');
    assert(agentB.agent_id && agentB.api_key, 'Agent B registration missing credentials');

    const createSession = await request('POST', '/sessions', {
      headers: authHeader(agentA.api_key),
      body: {
        topic: `E2E strict private negotiation ${runId}`,
        proposerAgentId: agentA.agent_id,
        counterpartyAgentId: agentB.agent_id,
        escrow: {
          contractAddress: '0xescrow_contract',
          tokenAddress: '0xusdc',
          amountPerPlayer: '100'
        }
      },
      expectedStatus: 201,
      label: 'create session'
    });

    const sessionId = createSession.session.id;
    assert(sessionId, 'Session id missing');

    await request('POST', `/sessions/${sessionId}/accept`, {
      headers: authHeader(agentB.api_key),
      body: { counterpartyAgentId: agentB.agent_id },
      label: 'accept session'
    });

    await request('POST', `/sessions/${sessionId}/prepare`, {
      headers: authHeader(agentA.api_key),
      label: 'prepare session'
    });

    await request('POST', `/sessions/${sessionId}/escrow/prepare`, {
      headers: authHeader(agentA.api_key),
      label: 'escrow prepare #1'
    });

    await request('POST', `/sessions/${sessionId}/escrow/deposit`, {
      headers: authHeader(agentA.api_key),
      body: { amount: '100' },
      label: 'deposit A'
    });

    await request('POST', `/sessions/${sessionId}/escrow/deposit`, {
      headers: authHeader(agentB.api_key),
      body: { amount: '100' },
      label: 'deposit B'
    });

    const start = await request('POST', `/sessions/${sessionId}/start`, {
      headers: authHeader(agentA.api_key),
      label: 'start session'
    });
    assert(start.session.status === 'active', 'Session not active after start');

    await request('POST', `/sessions/${sessionId}/private-inputs`, {
      headers: authHeader(agentA.api_key),
      body: {
        privateContext: {
          strategy: {
            role: 'buyer',
            reservationPrice: 120,
            initialPrice: 80,
            concessionStep: 10
          },
          attributes: {
            income: 3000,
            creditScore: 790,
            urgency: 0.6
          }
        }
      },
      expectedStatus: 201,
      label: 'private input A'
    });

    await request('POST', `/sessions/${sessionId}/private-inputs`, {
      headers: authHeader(agentB.api_key),
      body: {
        privateContext: {
          strategy: {
            role: 'seller',
            reservationPrice: 100,
            initialPrice: 140,
            concessionStep: 10
          },
          attributes: {
            income: 5400,
            creditScore: 720,
            urgency: 0.55
          }
        }
      },
      expectedStatus: 201,
      label: 'private input B'
    });

    const negotiate = await request('POST', `/sessions/${sessionId}/negotiate`, {
      headers: authHeader(agentA.api_key),
      body: { maxTurns: 8 },
      label: 'negotiate'
    });

    assert(negotiate.ok === true, 'Negotiate not ok');
    assert(['agreed', 'no_agreement', 'failed'].includes(negotiate.result.finalStatus), 'Unexpected final status');
    if (EXPECT_STRICT) {
      assert(negotiate.result.execution?.mode === 'endpoint', 'Negotiation did not execute in endpoint mode');
      assert(negotiate.result.proofSummary?.verifiedDecisions > 0, 'Expected verified turn proofs');
      assert(negotiate.result.proofSummary?.runtimeVerifiedDecisions > 0, 'Expected verified runtime attestations');
      assert(negotiate.result.proofSummary?.failedDecisions === 0, 'Expected zero failed turn proofs');
      assert(negotiate.result.proofSummary?.runtimeFailedDecisions === 0, 'Expected zero failed runtime attestations');
      assert(negotiate.attestation?.verification?.valid === true, 'Attestation not valid in strict mode');
    }

    const transcriptResponse = await fetch(`${API_BASE}/sessions/${sessionId}/transcript`, {
      headers: authHeader(agentA.api_key),
      signal: timeoutSignal(TIMEOUT_MS)
    });
    const transcriptText = await transcriptResponse.text();
    assert(transcriptResponse.status === 200, `Transcript endpoint failed: ${transcriptResponse.status}`);
    ensureNoSensitiveLeak(transcriptText);

    const attestation = await request('GET', `/sessions/${sessionId}/attestation`, {
      headers: authHeader(agentA.api_key),
      label: 'attestation read'
    });
    if (EXPECT_STRICT) {
      assert(attestation.verification.valid === true, 'Attestation verification false');
    }

    const verificationSession = await request('GET', `/verification/eigencompute/sessions/${sessionId}`, {
      headers: authHeader(agentA.api_key),
      label: 'session verification'
    });

    if (EXPECT_STRICT) {
      assert(verificationSession.negotiation?.execution?.mode === 'endpoint', 'Session verification mode is not endpoint');
      assert((verificationSession.negotiation?.proofSummary?.verifiedDecisions || 0) > 0, 'Session verification missing proof count');
      assert((verificationSession.negotiation?.proofSummary?.failedDecisions || 0) === 0, 'Session verification has failed proofs');
      assert(verificationSession.attestation?.verification?.valid === true, 'Session verification attestation invalid');
    }

    const verificationGlobal = await request('GET', '/verification/eigencompute', {
      headers: authHeader(agentA.api_key),
      label: 'global verification'
    });

    if (EXPECT_STRICT) {
      assert((verificationGlobal.checks?.runtime?.proofRuntime?.verifiedDecisions || 0) > 0, 'Global runtime proof summary missing verified decisions');
      assert(verificationGlobal.checks?.launchReadiness?.ready === true, 'Launch readiness check failed');
    }

    const escrowStatus = await request('GET', `/sessions/${sessionId}/escrow/status`, {
      headers: authHeader(agentA.api_key),
      label: 'escrow status'
    });
    assert(['settled', 'refunded', 'settlement_pending', 'refund_pending'].includes(escrowStatus.escrow.status), 'Unexpected escrow status after negotiation');

    const leaderboard = await request('GET', '/leaderboard/trusted', {
      headers: authHeader(agentA.api_key),
      label: 'trusted leaderboard'
    });
    const trustedSessionIds = (leaderboard.trustedSessions || []).map((item) => item.sessionId);
    assert(trustedSessionIds.includes(sessionId), 'Trusted leaderboard missing expected session');

    console.log('[Phase7 E2E] SUCCESS');
    console.log(JSON.stringify({
      apiBase: API_BASE,
      sessionId,
      status: negotiate.result.finalStatus,
      executionMode: negotiate.result.execution?.mode,
      verifiedDecisions: negotiate.result.proofSummary?.verifiedDecisions || 0,
      runtimeVerifiedDecisions: negotiate.result.proofSummary?.runtimeVerifiedDecisions || 0,
      attestationValid: attestation.verification.valid,
      escrowStatus: escrowStatus.escrow.status,
      trustedSessions: leaderboard.summary.trustedSessions
    }, null, 2));
  } finally {
    await mockBuyer.close().catch(() => undefined);
    await mockSeller.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('[Phase7 E2E] FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from './store.js';

const tempDirs: string[] = [];

function tempDbFile() {
  const dir = mkdtempSync(join(tmpdir(), 'molt-neg-store-'));
  tempDirs.push(dir);
  return join(dir, 'test.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('store', () => {
  it('persists core records across reopen', () => {
    const dbFile = tempDbFile();

    {
      const store = createStore({ dbFile });
      store.upsertAgent({
        id: 'agent_a',
        name: 'Agent A',
        endpoint: 'https://agent-a.example.com',
        apiKey: 'key_a',
        enabled: true,
        metadata: {
          sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
          eigencompute: { appId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', environment: 'sepolia', imageDigest: 'sha256:shared_digest', signerAddress: '0x0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_signer' }
        }
      });

      store.createSession({
        id: 'session_1',
        topic: 'private salary negotiation',
        proposerAgentId: 'agent_a',
        status: 'created'
      });

      store.saveAttestation({
        sessionId: 'session_1',
        signerAddress: '0x19983Fd3Db22537502830b9F9602C1aD4DBEe1d0',
        payloadHash: '0xabc',
        signature: '0xsig',
        payload: { strictVerified: true },
        createdAt: new Date().toISOString()
      });

      store.upsertEscrow({
        sessionId: 'session_1',
        contractAddress: '0x1111111111111111111111111111111111111111',
        tokenAddress: '0x2222222222222222222222222222222222222222',
        stakeAmount: '1000000',
        status: 'prepared',
        playerAAgentId: 'agent_a',
        playerBAgentId: undefined,
        playerADeposited: false,
        playerBDeposited: false,
        settlementAttempts: 0,
        lastSettlementError: undefined,
        lastSettlementAt: undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      const counts = store.counts();
      expect(counts.agents).toBe(1);
      expect(counts.sessions).toBe(1);
      expect(counts.attestations).toBe(1);
      expect(counts.escrows).toBe(1);

      store.close();
    }

    {
      const reopened = createStore({ dbFile });
      expect(reopened.getAgent('agent_a')?.name).toBe('Agent A');
      expect(reopened.getSession('session_1')?.topic).toContain('salary');
      expect(reopened.getAttestation('session_1')?.payloadHash).toBe('0xabc');
      expect(reopened.getEscrow('session_1')?.status).toBe('prepared');
      reopened.close();
    }
  });

  it('finds enabled agent by api key only', () => {
    const store = createStore({ dbFile: tempDbFile() });

    store.upsertAgent({
      id: 'agent_enabled',
      name: 'Enabled',
      endpoint: 'https://enabled.example.com',
      apiKey: 'key_enabled',
      enabled: true
    });

    store.upsertAgent({
      id: 'agent_disabled',
      name: 'Disabled',
      endpoint: 'https://disabled.example.com',
      apiKey: 'key_disabled',
      enabled: false
    });

    expect(store.findAgentByApiKey('key_enabled')?.id).toBe('agent_enabled');
    expect(store.findAgentByApiKey('key_disabled')).toBeUndefined();

    store.close();
  });

  it('persists sealed inputs and transcript turns', () => {
    const dbFile = tempDbFile();

    {
      const store = createStore({ dbFile });

      store.upsertAgent({
        id: 'agent_a',
        name: 'Agent A',
        endpoint: 'https://a.example.com',
        enabled: true
      });

      store.upsertAgent({
        id: 'agent_b',
        name: 'Agent B',
        endpoint: 'https://b.example.com',
        enabled: true
      });

      store.createSession({
        id: 'session_sealed',
        topic: 'sealed',
        proposerAgentId: 'agent_a',
        counterpartyAgentId: 'agent_b',
        status: 'active'
      });

      store.upsertSealedInput({
        sessionId: 'session_sealed',
        agentId: 'agent_a',
        sealedRef: 'sealed_ref_a',
        keyId: 'key_a',
        cipherText: 'cipher_a',
        iv: 'iv_a',
        authTag: 'tag_a'
      });

      store.upsertSessionTurn({
        sessionId: 'session_sealed',
        turn: 1,
        status: 'continue',
        summary: { buyerOffer: 90, sellerAsk: 120, spread: 30 }
      });

      store.close();
    }

    {
      const reopened = createStore({ dbFile });
      const sealed = reopened.getSealedInputForAgent('session_sealed', 'agent_a');
      const turns = reopened.listSessionTurns('session_sealed');

      expect(sealed?.sealedRef).toBe('sealed_ref_a');
      expect(turns.length).toBe(1);
      expect(turns[0].summary.spread).toBe(30);

      reopened.close();
    }
  });
});

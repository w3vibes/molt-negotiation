import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  buildTurnProofMessage,
  expectedDecisionHash,
  verifyAgentTurnProof
} from './agentDecisions.js';

afterEach(() => {
  delete process.env.NEG_REQUIRE_TURN_PROOF;
  delete process.env.NEG_TURN_PROOF_MAX_SKEW_MS;
});

function signProofMessage(privateKey: string, message: string): string {
  const wallet = new ethers.Wallet(privateKey);
  const digest = ethers.hashMessage(message);
  return ethers.Signature.from(wallet.signingKey.sign(digest)).serialized;
}

describe('agent turn proof verification', () => {
  it('verifies a valid turn proof', () => {
    const privateKey = '0x59c6995e998f97a5a0044966f0945386f4f5d7f54b52f9f7c4f6b8e0b7d7e3d1';
    const wallet = new ethers.Wallet(privateKey);

    const expected = {
      sessionId: 'session_test_1',
      turn: 2,
      agentId: 'agent_alpha',
      role: 'buyer' as const,
      offer: 101.25,
      challenge: 'abc123challenge',
      eigen: {
        appId: 'app_alpha',
        environment: 'sepolia',
        imageDigest: 'sha256:test_digest',
        signerAddress: wallet.address.toLowerCase()
      }
    };

    const timestamp = new Date().toISOString();
    const decisionHash = expectedDecisionHash({
      ...expected,
      appId: expected.eigen.appId,
      environment: expected.eigen.environment,
      imageDigest: expected.eigen.imageDigest,
      timestamp
    });

    const message = buildTurnProofMessage({
      sessionId: expected.sessionId,
      turn: expected.turn,
      agentId: expected.agentId,
      role: expected.role,
      offer: expected.offer,
      challenge: expected.challenge,
      decisionHash,
      appId: expected.eigen.appId,
      environment: expected.eigen.environment,
      imageDigest: expected.eigen.imageDigest,
      timestamp
    });

    const proof = {
      sessionId: expected.sessionId,
      turn: expected.turn,
      agentId: expected.agentId,
      challenge: expected.challenge,
      decisionHash,
      appId: expected.eigen.appId,
      environment: expected.eigen.environment,
      imageDigest: expected.eigen.imageDigest,
      signer: wallet.address,
      signature: signProofMessage(privateKey, message),
      timestamp
    };

    const verification = verifyAgentTurnProof({
      expected,
      proof
    });

    expect(verification.valid).toBe(true);
    expect(verification.recoveredAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('rejects stale turn proofs outside allowed skew window', () => {
    process.env.NEG_TURN_PROOF_MAX_SKEW_MS = '1000';

    const privateKey = '0x59c6995e998f97a5a0044966f0945386f4f5d7f54b52f9f7c4f6b8e0b7d7e3d1';
    const wallet = new ethers.Wallet(privateKey);

    const expected = {
      sessionId: 'session_test_2',
      turn: 1,
      agentId: 'agent_beta',
      role: 'seller' as const,
      offer: 220,
      challenge: 'staleproof',
      eigen: {
        appId: 'app_beta',
        environment: 'sepolia',
        imageDigest: 'sha256:test_digest',
        signerAddress: wallet.address.toLowerCase()
      }
    };

    const timestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const decisionHash = expectedDecisionHash({
      ...expected,
      appId: expected.eigen.appId,
      environment: expected.eigen.environment,
      imageDigest: expected.eigen.imageDigest,
      timestamp
    });

    const message = buildTurnProofMessage({
      sessionId: expected.sessionId,
      turn: expected.turn,
      agentId: expected.agentId,
      role: expected.role,
      offer: expected.offer,
      challenge: expected.challenge,
      decisionHash,
      appId: expected.eigen.appId,
      environment: expected.eigen.environment,
      imageDigest: expected.eigen.imageDigest,
      timestamp
    });

    const verification = verifyAgentTurnProof({
      expected,
      proof: {
        sessionId: expected.sessionId,
        turn: expected.turn,
        agentId: expected.agentId,
        challenge: expected.challenge,
        decisionHash,
        appId: expected.eigen.appId,
        environment: expected.eigen.environment,
        imageDigest: expected.eigen.imageDigest,
        signer: wallet.address,
        signature: signProofMessage(privateKey, message),
        timestamp
      }
    });

    expect(verification.valid).toBe(false);
    expect(verification.reason).toBe('turn_proof_timestamp_out_of_window');
  });
});

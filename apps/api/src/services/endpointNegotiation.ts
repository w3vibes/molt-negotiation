import type { AgentRecord } from '../types/domain.js';
import type {
  NegotiationRunResult,
  PrivateNegotiationContext,
  PublicNegotiationTurn
} from './negotiationEngine.js';
import {
  extractAgentEigenProfile,
  newTurnChallenge,
  requestAgentTurnDecision,
  verifyAgentTurnProof
} from './agentDecisions.js';
import {
  requireRuntimeAttestationByDefault,
  turnProofRequiredByDefault
} from './policy.js';
import { verifyRuntimeAttestation } from './runtimeVerification.js';
import { optimizeAgreementPrice } from './dealOptimizer.js';

type Participant = {
  agent: AgentRecord;
  context: PrivateNegotiationContext;
};

type ProofFailure = {
  turn: number;
  agentId: string;
  stage: 'signature' | 'runtime';
  reason: string;
};

export type EndpointProofSummary = {
  proofRequired: boolean;
  runtimeAttestationRequired: boolean;
  verifiedDecisions: number;
  failedDecisions: number;
  runtimeVerifiedDecisions: number;
  runtimeFailedDecisions: number;
  failures: ProofFailure[];
  participants: Record<string, {
    verifiedDecisions: number;
    runtimeVerifiedDecisions: number;
    recoveredSigners: string[];
    attestedSigners: string[];
  }>;
};

export type EndpointNegotiationRunResult = NegotiationRunResult & {
  mode: 'endpoint';
  proofSummary: EndpointProofSummary;
};

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function initialBuyerOffer(context: PrivateNegotiationContext): number {
  const reservation = context.strategy.reservationPrice;
  const step = context.strategy.concessionStep && Number.isFinite(context.strategy.concessionStep)
    ? Math.max(context.strategy.concessionStep, 0.1)
    : 1;
  const fallback = reservation - step * 2;
  const proposed = context.strategy.initialPrice ?? fallback;
  return round4(Math.max(0, Math.min(reservation, proposed)));
}

function initialSellerAsk(context: PrivateNegotiationContext): number {
  const reservation = context.strategy.reservationPrice;
  const step = context.strategy.concessionStep && Number.isFinite(context.strategy.concessionStep)
    ? Math.max(context.strategy.concessionStep, 0.1)
    : 1;
  const fallback = reservation + step * 2;
  const proposed = context.strategy.initialPrice ?? fallback;
  return round4(Math.max(reservation, proposed));
}

function midpoint(a: number, b: number): number {
  return round4((a + b) / 2);
}

function participantEntry(summary: EndpointProofSummary, agentId: string) {
  if (!summary.participants[agentId]) {
    summary.participants[agentId] = {
      verifiedDecisions: 0,
      runtimeVerifiedDecisions: 0,
      recoveredSigners: [],
      attestedSigners: []
    };
  }

  return summary.participants[agentId];
}

function addProofFailure(summary: EndpointProofSummary, failure: ProofFailure) {
  summary.failedDecisions += 1;
  if (failure.stage === 'runtime') {
    summary.runtimeFailedDecisions += 1;
  }
  summary.failures.push(failure);
}

function addProofSuccess(summary: EndpointProofSummary, input: {
  agentId: string;
  recoveredAddress?: string;
}) {
  summary.verifiedDecisions += 1;

  const participant = participantEntry(summary, input.agentId);
  participant.verifiedDecisions += 1;

  if (input.recoveredAddress && !participant.recoveredSigners.includes(input.recoveredAddress)) {
    participant.recoveredSigners.push(input.recoveredAddress);
  }
}

function addRuntimeSuccess(summary: EndpointProofSummary, input: {
  agentId: string;
  attestedSigner?: string;
}) {
  summary.runtimeVerifiedDecisions += 1;

  const participant = participantEntry(summary, input.agentId);
  participant.runtimeVerifiedDecisions += 1;

  if (input.attestedSigner && !participant.attestedSigners.includes(input.attestedSigner)) {
    participant.attestedSigners.push(input.attestedSigner);
  }
}

export async function runEndpointNegotiation(input: {
  sessionId: string;
  topic: string;
  proposer: Participant;
  counterparty: Participant;
  maxTurns?: number;
}): Promise<EndpointNegotiationRunResult> {
  const maxTurns = Math.max(1, Math.min(50, input.maxTurns ?? 8));

  const participants = [input.proposer, input.counterparty];
  const buyer = participants.find((item) => item.context.strategy.role === 'buyer');
  const seller = participants.find((item) => item.context.strategy.role === 'seller');

  const proofSummary: EndpointProofSummary = {
    proofRequired: turnProofRequiredByDefault(),
    runtimeAttestationRequired: requireRuntimeAttestationByDefault(),
    verifiedDecisions: 0,
    failedDecisions: 0,
    runtimeVerifiedDecisions: 0,
    runtimeFailedDecisions: 0,
    failures: [],
    participants: {}
  };

  if (!buyer || !seller) {
    return {
      mode: 'endpoint',
      finalStatus: 'failed',
      turns: 0,
      transcript: [],
      reason: 'roles_must_include_buyer_and_seller',
      proofSummary
    };
  }

  if (buyer.agent.id === seller.agent.id) {
    return {
      mode: 'endpoint',
      finalStatus: 'failed',
      turns: 0,
      transcript: [],
      reason: 'buyer_and_seller_must_be_distinct_agents',
      proofSummary
    };
  }

  const buyerEigen = extractAgentEigenProfile(buyer.agent);
  const sellerEigen = extractAgentEigenProfile(seller.agent);

  if (!buyerEigen) {
    return {
      mode: 'endpoint',
      finalStatus: 'failed',
      turns: 0,
      transcript: [],
      reason: `buyer_eigen_profile_missing:${buyer.agent.id}`,
      proofSummary
    };
  }

  if (!sellerEigen) {
    return {
      mode: 'endpoint',
      finalStatus: 'failed',
      turns: 0,
      transcript: [],
      reason: `seller_eigen_profile_missing:${seller.agent.id}`,
      proofSummary
    };
  }

  const buyerReservation = round4(buyer.context.strategy.reservationPrice);
  const sellerReservation = round4(seller.context.strategy.reservationPrice);

  let buyerOffer = initialBuyerOffer(buyer.context);
  let sellerAsk = initialSellerAsk(seller.context);

  const transcript: PublicNegotiationTurn[] = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const priorTurnsForAgent = transcript.map((entry) => ({
      turn: entry.turn,
      status: entry.status,
      buyerOffer: entry.buyerOffer,
      sellerAsk: entry.sellerAsk,
      spread: entry.spread,
      agreedPrice: entry.agreedPrice
    }));

    const buyerChallenge = newTurnChallenge();
    const sellerChallenge = newTurnChallenge();

    let buyerDecision;
    try {
      buyerDecision = await requestAgentTurnDecision({
        sessionId: input.sessionId,
        topic: input.topic,
        turn,
        maxTurns,
        role: 'buyer',
        challenge: buyerChallenge,
        agent: buyer.agent,
        privateContext: buyer.context,
        publicState: {
          buyerAgentId: buyer.agent.id,
          sellerAgentId: seller.agent.id,
          priorTurns: priorTurnsForAgent,
          latestBuyerOffer: buyerOffer,
          latestSellerAsk: sellerAsk
        }
      });
    } catch (error) {
      return {
        mode: 'endpoint',
        finalStatus: 'failed',
        turns: transcript.length,
        transcript,
        reason: error instanceof Error ? error.message : 'buyer_decision_fetch_failed',
        proofSummary
      };
    }

    const nextBuyerOffer = round4(buyerDecision.decision.offer);
    if (!Number.isFinite(nextBuyerOffer)) {
      return {
        mode: 'endpoint',
        finalStatus: 'failed',
        turns: transcript.length,
        transcript,
        reason: `buyer_offer_invalid:${buyer.agent.id}`,
        proofSummary
      };
    }

    if (nextBuyerOffer > buyerReservation) {
      return {
        mode: 'endpoint',
        finalStatus: 'failed',
        turns: transcript.length,
        transcript,
        reason: `buyer_offer_exceeds_reservation:${buyer.agent.id}`,
        proofSummary
      };
    }

    if (turn > 1 && nextBuyerOffer < buyerOffer) {
      return {
        mode: 'endpoint',
        finalStatus: 'failed',
        turns: transcript.length,
        transcript,
        reason: `buyer_offer_regressed:${buyer.agent.id}`,
        proofSummary
      };
    }

    const buyerProofVerification = verifyAgentTurnProof({
      expected: {
        sessionId: input.sessionId,
        turn,
        agentId: buyer.agent.id,
        role: 'buyer',
        offer: nextBuyerOffer,
        challenge: buyerChallenge,
        eigen: buyerEigen
      },
      proof: buyerDecision.decision.proof
    });

    if (!buyerProofVerification.valid) {
      addProofFailure(proofSummary, {
        turn,
        agentId: buyer.agent.id,
        stage: 'signature',
        reason: buyerProofVerification.reason || 'buyer_turn_proof_invalid'
      });

      if (proofSummary.proofRequired) {
        return {
          mode: 'endpoint',
          finalStatus: 'failed',
          turns: transcript.length,
          transcript,
          reason: `buyer_turn_proof_invalid:${buyerProofVerification.reason || 'unknown'}`,
          proofSummary
        };
      }
    } else {
      addProofSuccess(proofSummary, {
        agentId: buyer.agent.id,
        recoveredAddress: buyerProofVerification.recoveredAddress
      });

      const buyerRuntimeVerification = await verifyRuntimeAttestation({
        evidence: buyerDecision.decision.proof?.runtimeEvidence,
        expected: {
          appId: buyerEigen.appId,
          environment: buyerEigen.environment,
          imageDigest: buyerEigen.imageDigest,
          signerAddress: buyerProofVerification.recoveredAddress ?? buyerEigen.signerAddress,
          reportDataHash: buyerProofVerification.expectedDecisionHash
        }
      });

      if (!buyerRuntimeVerification.valid) {
        addProofFailure(proofSummary, {
          turn,
          agentId: buyer.agent.id,
          stage: 'runtime',
          reason: buyerRuntimeVerification.reason || 'buyer_runtime_attestation_invalid'
        });

        if (proofSummary.runtimeAttestationRequired) {
          return {
            mode: 'endpoint',
            finalStatus: 'failed',
            turns: transcript.length,
            transcript,
            reason: `buyer_runtime_attestation_invalid:${buyerRuntimeVerification.reason || 'unknown'}`,
            proofSummary
          };
        }
      } else {
        addRuntimeSuccess(proofSummary, {
          agentId: buyer.agent.id,
          attestedSigner: buyerRuntimeVerification.claims?.signerAddress
        });
      }
    }

    let sellerDecision;
    try {
      sellerDecision = await requestAgentTurnDecision({
        sessionId: input.sessionId,
        topic: input.topic,
        turn,
        maxTurns,
        role: 'seller',
        challenge: sellerChallenge,
        agent: seller.agent,
        privateContext: seller.context,
        publicState: {
          buyerAgentId: buyer.agent.id,
          sellerAgentId: seller.agent.id,
          priorTurns: [...priorTurnsForAgent, {
            turn,
            status: 'continue',
            buyerOffer: nextBuyerOffer,
            sellerAsk,
            spread: round4(sellerAsk - nextBuyerOffer)
          }],
          latestBuyerOffer: nextBuyerOffer,
          latestSellerAsk: sellerAsk
        }
      });
    } catch (error) {
      return {
        mode: 'endpoint',
        finalStatus: 'failed',
        turns: transcript.length,
        transcript,
        reason: error instanceof Error ? error.message : 'seller_decision_fetch_failed',
        proofSummary
      };
    }

    const nextSellerAsk = round4(sellerDecision.decision.offer);
    if (!Number.isFinite(nextSellerAsk)) {
      return {
        mode: 'endpoint',
        finalStatus: 'failed',
        turns: transcript.length,
        transcript,
        reason: `seller_offer_invalid:${seller.agent.id}`,
        proofSummary
      };
    }

    if (nextSellerAsk < sellerReservation) {
      return {
        mode: 'endpoint',
        finalStatus: 'failed',
        turns: transcript.length,
        transcript,
        reason: `seller_offer_below_reservation:${seller.agent.id}`,
        proofSummary
      };
    }

    if (turn > 1 && nextSellerAsk > sellerAsk) {
      return {
        mode: 'endpoint',
        finalStatus: 'failed',
        turns: transcript.length,
        transcript,
        reason: `seller_offer_regressed:${seller.agent.id}`,
        proofSummary
      };
    }

    const sellerProofVerification = verifyAgentTurnProof({
      expected: {
        sessionId: input.sessionId,
        turn,
        agentId: seller.agent.id,
        role: 'seller',
        offer: nextSellerAsk,
        challenge: sellerChallenge,
        eigen: sellerEigen
      },
      proof: sellerDecision.decision.proof
    });

    if (!sellerProofVerification.valid) {
      addProofFailure(proofSummary, {
        turn,
        agentId: seller.agent.id,
        stage: 'signature',
        reason: sellerProofVerification.reason || 'seller_turn_proof_invalid'
      });

      if (proofSummary.proofRequired) {
        return {
          mode: 'endpoint',
          finalStatus: 'failed',
          turns: transcript.length,
          transcript,
          reason: `seller_turn_proof_invalid:${sellerProofVerification.reason || 'unknown'}`,
          proofSummary
        };
      }
    } else {
      addProofSuccess(proofSummary, {
        agentId: seller.agent.id,
        recoveredAddress: sellerProofVerification.recoveredAddress
      });

      const sellerRuntimeVerification = await verifyRuntimeAttestation({
        evidence: sellerDecision.decision.proof?.runtimeEvidence,
        expected: {
          appId: sellerEigen.appId,
          environment: sellerEigen.environment,
          imageDigest: sellerEigen.imageDigest,
          signerAddress: sellerProofVerification.recoveredAddress ?? sellerEigen.signerAddress,
          reportDataHash: sellerProofVerification.expectedDecisionHash
        }
      });

      if (!sellerRuntimeVerification.valid) {
        addProofFailure(proofSummary, {
          turn,
          agentId: seller.agent.id,
          stage: 'runtime',
          reason: sellerRuntimeVerification.reason || 'seller_runtime_attestation_invalid'
        });

        if (proofSummary.runtimeAttestationRequired) {
          return {
            mode: 'endpoint',
            finalStatus: 'failed',
            turns: transcript.length,
            transcript,
            reason: `seller_runtime_attestation_invalid:${sellerRuntimeVerification.reason || 'unknown'}`,
            proofSummary
          };
        }
      } else {
        addRuntimeSuccess(proofSummary, {
          agentId: seller.agent.id,
          attestedSigner: sellerRuntimeVerification.claims?.signerAddress
        });
      }
    }

    buyerOffer = nextBuyerOffer;
    sellerAsk = nextSellerAsk;

    const spread = round4(sellerAsk - buyerOffer);

    if (buyerOffer >= sellerAsk) {
      const optimized = optimizeAgreementPrice({
        buyer: buyer.context,
        seller: seller.context,
        buyerOffer,
        sellerAsk
      });

      const agreedPrice = optimized?.price ?? midpoint(buyerOffer, sellerAsk);
      transcript.push({
        turn,
        buyerAgentId: buyer.agent.id,
        sellerAgentId: seller.agent.id,
        buyerOffer,
        sellerAsk,
        spread,
        status: 'agreed',
        agreedPrice
      });

      return {
        mode: 'endpoint',
        finalStatus: 'agreed',
        turns: transcript.length,
        transcript,
        agreement: {
          price: agreedPrice,
          turn,
          buyerAgentId: buyer.agent.id,
          sellerAgentId: seller.agent.id,
          ...(optimized ? {
            pricingModel: optimized.method,
            objectiveScore: optimized.objective
          } : {})
        },
        proofSummary
      };
    }

    if (turn === maxTurns) {
      transcript.push({
        turn,
        buyerAgentId: buyer.agent.id,
        sellerAgentId: seller.agent.id,
        buyerOffer,
        sellerAsk,
        spread,
        status: 'no_agreement'
      });

      return {
        mode: 'endpoint',
        finalStatus: 'no_agreement',
        turns: transcript.length,
        transcript,
        proofSummary
      };
    }

    transcript.push({
      turn,
      buyerAgentId: buyer.agent.id,
      sellerAgentId: seller.agent.id,
      buyerOffer,
      sellerAsk,
      spread,
      status: 'continue'
    });
  }

  return {
    mode: 'endpoint',
    finalStatus: 'failed',
    turns: transcript.length,
    transcript,
    reason: 'endpoint_engine_exhausted_unexpectedly',
    proofSummary
  };
}

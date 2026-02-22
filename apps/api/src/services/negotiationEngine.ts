import { z } from 'zod';
import { optimizeAgreementPrice } from './dealOptimizer.js';

export const negotiationStrategySchema = z.object({
  role: z.enum(['buyer', 'seller']),
  reservationPrice: z.number().finite(),
  initialPrice: z.number().finite().optional(),
  concessionStep: z.number().positive().optional()
});

export const privateNegotiationContextSchema = z.object({
  strategy: negotiationStrategySchema,
  attributes: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().max(20_000).optional()
}).passthrough();

export type PrivateNegotiationContext = z.infer<typeof privateNegotiationContextSchema>;

type NegotiationParticipant = {
  agentId: string;
  context: PrivateNegotiationContext;
};

export type PublicNegotiationTurn = {
  turn: number;
  buyerAgentId: string;
  sellerAgentId: string;
  buyerOffer: number;
  sellerAsk: number;
  spread: number;
  status: 'continue' | 'agreed' | 'no_agreement';
  agreedPrice?: number;
};

export type NegotiationRunResult = {
  finalStatus: 'agreed' | 'no_agreement' | 'failed';
  turns: number;
  transcript: PublicNegotiationTurn[];
  agreement?: {
    price: number;
    turn: number;
    buyerAgentId: string;
    sellerAgentId: string;
    pricingModel?: string;
    objectiveScore?: number;
  };
  reason?: string;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function toConcessionStep(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN) || (value ?? 0) <= 0) return 1;
  return round2(value!);
}

function readNumericAttribute(attributes: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!attributes) return undefined;

  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return undefined;
}

function normalizedIncomeScore(attributes: Record<string, unknown> | undefined): number {
  const income = readNumericAttribute(attributes, ['income', 'monthlyIncome', 'annualIncome', 'salary']);
  if (!income || income <= 0) return 0.5;
  return clamp(Math.log1p(income) / Math.log1p(20000), 0, 1);
}

function normalizedCreditScore(attributes: Record<string, unknown> | undefined): number {
  const credit = readNumericAttribute(attributes, ['creditScore', 'credit_score', 'fico']);
  if (!credit || credit <= 0) return 0.5;
  return clamp((credit - 300) / 550, 0, 1);
}

function normalizedUrgencyScore(attributes: Record<string, unknown> | undefined): number {
  const urgency = readNumericAttribute(attributes, ['urgency', 'deadlinePressure', 'timePressure', 'urgencyScore']);
  if (!urgency) return 0.5;

  if (urgency > 1) {
    return clamp(urgency / 100, 0, 1);
  }

  return clamp(urgency, 0, 1);
}

function concessionProfile(context: PrivateNegotiationContext): {
  stepMultiplier: number;
  settlementWeight: number;
} {
  const attributes = context.attributes;

  const incomeScore = normalizedIncomeScore(attributes);
  const creditScore = normalizedCreditScore(attributes);
  const urgencyScore = normalizedUrgencyScore(attributes);
  const leverage = clamp((incomeScore + creditScore) / 2, 0, 1);

  if (context.strategy.role === 'buyer') {
    const pressureToClose = clamp((urgencyScore + leverage) / 2, 0, 1);
    return {
      stepMultiplier: round2(0.7 + pressureToClose * 1.1),
      settlementWeight: round2(clamp(0.45 + leverage * 0.35, 0.2, 0.8))
    };
  }

  const sellerConcessionPressure = clamp((urgencyScore + (1 - leverage)) / 2, 0, 1);
  return {
    stepMultiplier: round2(0.7 + sellerConcessionPressure * 1.1),
    settlementWeight: round2(clamp(0.55 - sellerConcessionPressure * 0.35, 0.2, 0.8))
  };
}

function weightedAgreementPrice(input: {
  buyerOffer: number;
  sellerAsk: number;
  buyerWeight: number;
  sellerWeight: number;
}): number {
  const normalizedBuyerWeight = clamp((input.buyerWeight + (1 - input.sellerWeight)) / 2, 0.2, 0.8);
  return round2(input.buyerOffer * normalizedBuyerWeight + input.sellerAsk * (1 - normalizedBuyerWeight));
}

function initialBuyerOffer(context: PrivateNegotiationContext): number {
  const reservation = context.strategy.reservationPrice;
  const profile = concessionProfile(context);
  const step = toConcessionStep(context.strategy.concessionStep) * profile.stepMultiplier;
  const fallback = reservation - step * 3;
  const proposed = context.strategy.initialPrice ?? fallback;
  return round2(Math.min(reservation, proposed));
}

function initialSellerAsk(context: PrivateNegotiationContext): number {
  const reservation = context.strategy.reservationPrice;
  const profile = concessionProfile(context);
  const step = toConcessionStep(context.strategy.concessionStep) * profile.stepMultiplier;
  const fallback = reservation + step * 3;
  const proposed = context.strategy.initialPrice ?? fallback;
  return round2(Math.max(reservation, proposed));
}

export function runNegotiationEngine(input: {
  proposer: NegotiationParticipant;
  counterparty: NegotiationParticipant;
  maxTurns?: number;
}): NegotiationRunResult {
  const maxTurns = Math.max(1, Math.min(50, input.maxTurns ?? 8));

  const participants = [input.proposer, input.counterparty];
  const buyer = participants.find((item) => item.context.strategy.role === 'buyer');
  const seller = participants.find((item) => item.context.strategy.role === 'seller');

  if (!buyer || !seller) {
    return {
      finalStatus: 'failed',
      turns: 0,
      transcript: [],
      reason: 'roles_must_include_buyer_and_seller'
    };
  }

  if (buyer.agentId === seller.agentId) {
    return {
      finalStatus: 'failed',
      turns: 0,
      transcript: [],
      reason: 'buyer_and_seller_must_be_distinct_agents'
    };
  }

  let buyerOffer = initialBuyerOffer(buyer.context);
  let sellerAsk = initialSellerAsk(seller.context);
  const buyerReservation = round2(buyer.context.strategy.reservationPrice);
  const sellerReservation = round2(seller.context.strategy.reservationPrice);

  const buyerProfile = concessionProfile(buyer.context);
  const sellerProfile = concessionProfile(seller.context);

  const baseBuyerStep = toConcessionStep(buyer.context.strategy.concessionStep);
  const baseSellerStep = toConcessionStep(seller.context.strategy.concessionStep);

  const transcript: PublicNegotiationTurn[] = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const spread = round2(sellerAsk - buyerOffer);

    if (buyerOffer >= sellerAsk) {
      const optimized = optimizeAgreementPrice({
        buyer: buyer.context,
        seller: seller.context,
        buyerOffer,
        sellerAsk
      });

      const agreedPrice = optimized?.price ?? weightedAgreementPrice({
        buyerOffer,
        sellerAsk,
        buyerWeight: buyerProfile.settlementWeight,
        sellerWeight: sellerProfile.settlementWeight
      });

      transcript.push({
        turn,
        buyerAgentId: buyer.agentId,
        sellerAgentId: seller.agentId,
        buyerOffer,
        sellerAsk,
        spread,
        status: 'agreed',
        agreedPrice
      });

      return {
        finalStatus: 'agreed',
        turns: transcript.length,
        transcript,
        agreement: {
          price: agreedPrice,
          turn,
          buyerAgentId: buyer.agentId,
          sellerAgentId: seller.agentId,
          ...(optimized ? {
            pricingModel: optimized.method,
            objectiveScore: optimized.objective
          } : {})
        }
      };
    }

    if (turn === maxTurns) {
      transcript.push({
        turn,
        buyerAgentId: buyer.agentId,
        sellerAgentId: seller.agentId,
        buyerOffer,
        sellerAsk,
        spread,
        status: 'no_agreement'
      });

      return {
        finalStatus: 'no_agreement',
        turns: transcript.length,
        transcript
      };
    }

    transcript.push({
      turn,
      buyerAgentId: buyer.agentId,
      sellerAgentId: seller.agentId,
      buyerOffer,
      sellerAsk,
      spread,
      status: 'continue'
    });

    const turnFactor = 1 + (turn / maxTurns) * 0.25;
    const buyerStep = baseBuyerStep * buyerProfile.stepMultiplier * turnFactor;
    const sellerStep = baseSellerStep * sellerProfile.stepMultiplier * turnFactor;

    buyerOffer = round2(Math.min(buyerReservation, buyerOffer + buyerStep));
    sellerAsk = round2(Math.max(sellerReservation, sellerAsk - sellerStep));
  }

  return {
    finalStatus: 'failed',
    turns: transcript.length,
    transcript,
    reason: 'engine_exhausted_unexpectedly'
  };
}

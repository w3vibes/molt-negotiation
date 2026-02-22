import type { PrivateNegotiationContext } from './negotiationEngine.js';

type Role = 'buyer' | 'seller';

export type OptimizedDealResult = {
  price: number;
  method: 'nash_weighted';
  objective: number;
};

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
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

function bargainingPower(context: PrivateNegotiationContext, role: Role): number {
  const attributes = context.attributes;

  const leverage = clamp(
    (normalizedIncomeScore(attributes) + normalizedCreditScore(attributes)) / 2,
    0,
    1
  );

  const urgency = normalizedUrgencyScore(attributes);

  if (role === 'buyer') {
    // Buyer power rises with leverage and falls with urgency to close.
    return clamp(leverage * 0.7 + (1 - urgency) * 0.3, 0, 1);
  }

  // Seller power similarly rises with leverage and low urgency.
  return clamp(leverage * 0.7 + (1 - urgency) * 0.3, 0, 1);
}

function normalizedBuyerUtility(price: number, buyerReservation: number, sellerReservation: number): number {
  const span = Math.max(1e-6, buyerReservation - sellerReservation);
  return clamp((buyerReservation - price) / span, 0, 1);
}

function normalizedSellerUtility(price: number, buyerReservation: number, sellerReservation: number): number {
  const span = Math.max(1e-6, buyerReservation - sellerReservation);
  return clamp((price - sellerReservation) / span, 0, 1);
}

export function optimizeAgreementPrice(input: {
  buyer: PrivateNegotiationContext;
  seller: PrivateNegotiationContext;
  buyerOffer: number;
  sellerAsk: number;
}): OptimizedDealResult | undefined {
  const buyerReservation = Number(input.buyer.strategy.reservationPrice);
  const sellerReservation = Number(input.seller.strategy.reservationPrice);

  if (!Number.isFinite(buyerReservation) || !Number.isFinite(sellerReservation)) return undefined;
  if (buyerReservation < sellerReservation) return undefined;

  const lower = Math.max(Math.min(input.sellerAsk, input.buyerOffer), sellerReservation);
  const upper = Math.min(Math.max(input.sellerAsk, input.buyerOffer), buyerReservation);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper < lower) return undefined;

  const buyerPower = bargainingPower(input.buyer, 'buyer');
  const sellerPower = bargainingPower(input.seller, 'seller');
  const totalPower = Math.max(1e-6, buyerPower + sellerPower);

  // Weight buyer utility according to relative bargaining power.
  const buyerWeight = clamp(buyerPower / totalPower, 0.15, 0.85);
  const sellerWeight = clamp(1 - buyerWeight, 0.15, 0.85);

  const candidateCount = 41;
  const step = (upper - lower) / Math.max(1, candidateCount - 1);

  let bestPrice = lower;
  let bestObjective = -Infinity;

  for (let index = 0; index < candidateCount; index++) {
    const candidate = index === candidateCount - 1 ? upper : lower + step * index;

    const buyerUtility = normalizedBuyerUtility(candidate, buyerReservation, sellerReservation);
    const sellerUtility = normalizedSellerUtility(candidate, buyerReservation, sellerReservation);

    const objective =
      Math.pow(Math.max(buyerUtility, 1e-6), buyerWeight) *
      Math.pow(Math.max(sellerUtility, 1e-6), sellerWeight);

    if (objective > bestObjective) {
      bestObjective = objective;
      bestPrice = candidate;
    }
  }

  return {
    price: round4(bestPrice),
    method: 'nash_weighted',
    objective: round4(bestObjective)
  };
}

import { describe, expect, it } from 'vitest';
import { optimizeAgreementPrice } from './dealOptimizer.js';

describe('deal optimizer', () => {
  it('returns a price inside overlap bounds', () => {
    const result = optimizeAgreementPrice({
      buyer: {
        strategy: {
          role: 'buyer',
          reservationPrice: 150,
          initialPrice: 100,
          concessionStep: 5
        },
        attributes: {
          income: 4000,
          creditScore: 760,
          urgency: 0.4
        }
      },
      seller: {
        strategy: {
          role: 'seller',
          reservationPrice: 90,
          initialPrice: 130,
          concessionStep: 5
        },
        attributes: {
          income: 3500,
          creditScore: 720,
          urgency: 0.6
        }
      },
      buyerOffer: 120,
      sellerAsk: 110
    });

    expect(result).toBeDefined();
    expect(result?.price).toBeGreaterThanOrEqual(110);
    expect(result?.price).toBeLessThanOrEqual(120);
    expect(result?.method).toBe('nash_weighted');
    expect((result?.objective || 0)).toBeGreaterThan(0);
  });

  it('returns undefined when no feasible overlap exists', () => {
    const result = optimizeAgreementPrice({
      buyer: {
        strategy: {
          role: 'buyer',
          reservationPrice: 90,
          initialPrice: 80,
          concessionStep: 2
        }
      },
      seller: {
        strategy: {
          role: 'seller',
          reservationPrice: 100,
          initialPrice: 120,
          concessionStep: 2
        }
      },
      buyerOffer: 85,
      sellerAsk: 110
    });

    expect(result).toBeUndefined();
  });
});

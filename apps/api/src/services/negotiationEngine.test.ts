import { describe, expect, it } from 'vitest';
import { runNegotiationEngine } from './negotiationEngine.js';

describe('negotiation engine', () => {
  it('is deterministic for identical inputs', () => {
    const input = {
      proposer: {
        agentId: 'agent_a',
        context: {
          strategy: {
            role: 'buyer' as const,
            reservationPrice: 120,
            initialPrice: 80,
            concessionStep: 10
          }
        }
      },
      counterparty: {
        agentId: 'agent_b',
        context: {
          strategy: {
            role: 'seller' as const,
            reservationPrice: 100,
            initialPrice: 140,
            concessionStep: 10
          }
        }
      },
      maxTurns: 10
    };

    const first = runNegotiationEngine(input);
    const second = runNegotiationEngine(input);

    expect(second).toEqual(first);
    expect(first.finalStatus).toBe('agreed');
  });

  it('fails if roles are invalid', () => {
    const result = runNegotiationEngine({
      proposer: {
        agentId: 'agent_a',
        context: {
          strategy: {
            role: 'buyer',
            reservationPrice: 100
          }
        }
      },
      counterparty: {
        agentId: 'agent_b',
        context: {
          strategy: {
            role: 'buyer',
            reservationPrice: 80
          }
        }
      },
      maxTurns: 5
    });

    expect(result.finalStatus).toBe('failed');
    expect(result.reason).toContain('roles_must_include_buyer_and_seller');
  });
});

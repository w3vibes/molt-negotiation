import { describe, expect, it } from 'vitest';
import {
  assertPrivacySafePublicPayload,
  redactSensitiveData
} from './privacy.js';

describe('privacy service', () => {
  it('redacts sensitive fields recursively', () => {
    const payload = {
      public: 'ok',
      income: 5000,
      nested: {
        creditScore: 780,
        safe: 'value'
      }
    };

    const redacted = redactSensitiveData(payload);
    expect(redacted.public).toBe('ok');
    expect(redacted.income).toBe('[REDACTED]');
    expect(redacted.nested.creditScore).toBe('[REDACTED]');
    expect(redacted.nested.safe).toBe('value');
  });

  it('fails privacy assertion for sensitive payloads', () => {
    expect(() => {
      assertPrivacySafePublicPayload({ reservationPrice: 100 }, 'test_payload');
    }).toThrow(/sensitive_content_detected/);
  });
});

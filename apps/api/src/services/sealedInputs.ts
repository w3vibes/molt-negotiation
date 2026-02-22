import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { SealedInputRecord } from '../types/domain.js';

export type SealedPayload = {
  keyId: string;
  iv: string;
  authTag: string;
  cipherText: string;
};

function testLikeRuntime(): boolean {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv === 'test') return true;
  if (Boolean(process.env.VITEST)) return true;
  return false;
}

function productionRuntime(): boolean {
  return process.env.NODE_ENV?.trim().toLowerCase() === 'production';
}

function insecureDevKeysAllowed(): boolean {
  return process.env.NEG_ALLOW_INSECURE_DEV_KEYS?.trim().toLowerCase() === 'true';
}

function decodeSealingKey(raw: string): Buffer | undefined {
  if (raw.startsWith('hex:')) {
    const hex = raw.slice(4).trim();
    const decoded = Buffer.from(hex, 'hex');
    if (decoded.length === 32) return decoded;
    return undefined;
  }

  if (raw.startsWith('base64:')) {
    const b64 = raw.slice(7).trim();
    const decoded = Buffer.from(b64, 'base64');
    if (decoded.length === 32) return decoded;
    return undefined;
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  const asBase64 = Buffer.from(raw, 'base64');
  if (asBase64.length === 32) {
    return asBase64;
  }

  return undefined;
}

function normalizeSealingKeyMaterial(): Buffer {
  const raw = process.env.NEG_SEALING_KEY?.trim();
  if (!raw) {
    if (testLikeRuntime()) {
      return createHash('sha256').update('molt-negotiation-test-sealing-key').digest();
    }

    if (insecureDevKeysAllowed()) {
      if (productionRuntime()) {
        throw new Error('insecure_dev_keys_not_allowed_in_production');
      }

      return createHash('sha256').update('molt-negotiation-insecure-dev-sealing-key').digest();
    }

    throw new Error('missing_sealing_key');
  }

  const decoded = decodeSealingKey(raw);
  if (decoded) {
    return decoded;
  }

  if (productionRuntime()) {
    throw new Error('invalid_sealing_key_format');
  }

  return createHash('sha256').update(raw).digest();
}

function deriveScopedKey(masterKey: Buffer, scope: { sessionId: string; agentId: string }): Buffer {
  const scopeLabel = `sealed:${scope.sessionId}:${scope.agentId}`;
  return createHmac('sha256', masterKey).update(scopeLabel).digest();
}

function keyId(key: Buffer, scope: { sessionId: string; agentId: string }): string {
  return createHash('sha256')
    .update(key)
    .update(scope.sessionId)
    .update(scope.agentId)
    .digest('hex')
    .slice(0, 24);
}

export function sealPrivatePayload(input: {
  payload: unknown;
  sessionId: string;
  agentId: string;
}): SealedPayload {
  const masterKey = normalizeSealingKeyMaterial();
  const key = deriveScopedKey(masterKey, {
    sessionId: input.sessionId,
    agentId: input.agentId
  });

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(input.payload));

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    keyId: keyId(key, { sessionId: input.sessionId, agentId: input.agentId }),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    cipherText: encrypted.toString('base64')
  };
}

export function unsealPrivatePayload(
  record: Pick<SealedInputRecord, 'sessionId' | 'agentId' | 'iv' | 'authTag' | 'cipherText'>
): unknown {
  const masterKey = normalizeSealingKeyMaterial();
  const key = deriveScopedKey(masterKey, {
    sessionId: record.sessionId,
    agentId: record.agentId
  });

  const iv = Buffer.from(record.iv, 'base64');
  const authTag = Buffer.from(record.authTag, 'base64');
  const cipherText = Buffer.from(record.cipherText, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
}

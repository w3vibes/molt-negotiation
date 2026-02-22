import { randomBytes } from 'node:crypto';

export function randomHex(bytes = 12): string {
  return randomBytes(bytes).toString('hex');
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40);
}

export function generateAgentId(agentName: string): string {
  const slug = slugify(agentName) || 'agent';
  return `${slug}_${randomHex(4)}`;
}

export function generateApiKey(prefix = 'neg'): string {
  return `${prefix}_${randomHex(24)}`;
}

export function generateSessionId(): string {
  return `session_${randomHex(8)}`;
}

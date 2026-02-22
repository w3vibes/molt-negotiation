import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from './errors.js';
import type { Store } from './store.js';

export type AccessRole = 'public' | 'readonly' | 'agent' | 'operator' | 'admin';

type AccessContext = {
  role: AccessRole;
  actorAgentId?: string;
};

const ROLE_LEVEL: Record<AccessRole, number> = {
  public: 0,
  readonly: 1,
  agent: 2,
  operator: 3,
  admin: 4
};

function configuredKeys() {
  return {
    admin: process.env.NEG_ADMIN_API_KEY?.trim(),
    operator: process.env.NEG_OPERATOR_API_KEY?.trim(),
    readonly: process.env.NEG_READONLY_API_KEY?.trim()
  };
}

function allowPublicRead(): boolean {
  return process.env.NEG_ALLOW_PUBLIC_READ !== 'false';
}

function extractApiKey(req: FastifyRequest): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string') return xApiKey.trim();
  if (Array.isArray(xApiKey)) return xApiKey[0]?.trim();
  return undefined;
}

export function resolveAccessContext(req: FastifyRequest, store: Store): AccessContext {
  const keys = configuredKeys();
  const token = extractApiKey(req);

  if (!token) {
    return { role: allowPublicRead() ? 'readonly' : 'public' };
  }

  if (keys.admin && token === keys.admin) return { role: 'admin' };
  if (keys.operator && token === keys.operator) return { role: 'operator' };
  if (keys.readonly && token === keys.readonly) return { role: 'readonly' };

  const agent = store.findAgentByApiKey(token);
  if (agent) return { role: 'agent', actorAgentId: agent.id };

  return { role: 'public' };
}

export function resolveAccessRole(req: FastifyRequest, store: Store): AccessRole {
  return resolveAccessContext(req, store).role;
}

export function resolveActorAgentId(req: FastifyRequest, store: Store): string | undefined {
  return resolveAccessContext(req, store).actorAgentId;
}

export function isPrivilegedRole(role: AccessRole): boolean {
  return role === 'operator' || role === 'admin';
}

export function requireRole(req: FastifyRequest, reply: FastifyReply, role: AccessRole, store: Store): boolean {
  const actualRole = resolveAccessRole(req, store);
  if (ROLE_LEVEL[actualRole] >= ROLE_LEVEL[role]) return true;

  sendError(reply, 401, 'unauthorized', 'Insufficient role for this action', {
    requiredRole: role,
    currentRole: actualRole
  });
  return false;
}

export function authSummary() {
  const keys = configuredKeys();
  return {
    allowPublicRead: allowPublicRead(),
    hasAdminKey: Boolean(keys.admin),
    hasOperatorKey: Boolean(keys.operator),
    hasReadonlyKey: Boolean(keys.readonly),
    acceptsAgentApiKeys: true
  };
}

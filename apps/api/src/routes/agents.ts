import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { probeAgentEndpoint } from '../services/agentHealth.js';
import {
  registerAgentSchema,
  validateStrictAgentMetadata
} from '../services/agentValidation.js';
import {
  isPrivilegedRole,
  requireRole,
  resolveAccessContext
} from '../services/access.js';
import { sendError } from '../services/errors.js';
import type { Store } from '../services/store.js';
import { generateAgentId, generateApiKey } from '../utils/ids.js';

const probeParamSchema = z.object({
  id: z.string().min(1)
});

function normalizeAgentId(input: string): string {
  return input.trim();
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseBody<T extends z.ZodTypeAny>(schema: T, input: unknown) {
  return schema.safeParse(input);
}

function resolveUniqueAgentId(store: Store, preferredName: string): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = generateAgentId(preferredName);
    if (!store.getAgent(id)) return id;
  }

  return `${generateAgentId(preferredName)}_${Date.now()}`;
}

export function registerAgentRoutes(app: FastifyInstance, store: Store) {
  app.post('/api/agents/register', async (req, reply) => {
    const parsed = parseBody(registerAgentSchema, req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid registration payload', {
        issues: parsed.error.issues
      });
    }

    const input = parsed.data;
    const access = resolveAccessContext(req, store);
    const privileged = isPrivilegedRole(access.role);

    const requestedId = input.agent_id ?? input.id;
    const requestedName = input.agent_name ?? input.name ?? requestedId ?? 'agent';

    const targetAgentId = requestedId
      ? normalizeAgentId(requestedId)
      : access.actorAgentId
        ? access.actorAgentId
        : resolveUniqueAgentId(store, requestedName);

    const existing = store.getAgent(targetAgentId);

    if (existing && !privileged) {
      if (!access.actorAgentId || access.actorAgentId !== targetAgentId) {
        return sendError(reply, 403, 'actor_scope_violation', 'You can only update your own agent profile', {
          targetAgentId,
          actorAgentId: access.actorAgentId ?? null,
          role: access.role
        });
      }
    }

    const existingMetadata = asObject(existing?.metadata);
    const existingSandbox = asObject(existingMetadata.sandbox);
    const existingEigenCompute = asObject(existingMetadata.eigencompute);

    const sandbox = {
      ...existingSandbox,
      ...asObject(input.sandbox)
    };

    const eigencompute = {
      ...existingEigenCompute,
      ...asObject(input.eigencompute)
    };

    const endpoint = input.endpoint?.trim() || existing?.endpoint;
    const strictValidation = validateStrictAgentMetadata({
      endpoint,
      sandbox,
      eigencompute
    });

    if (!strictValidation.ok) {
      return sendError(reply, 400, 'strict_policy_failed', 'Agent metadata failed strict policy checks', {
        reasons: strictValidation.reasons
      });
    }

    if (!endpoint) {
      return sendError(reply, 400, 'endpoint_mode_required', 'Endpoint is required');
    }

    const name = input.agent_name ?? input.name ?? existing?.name ?? targetAgentId;
    const payoutAddress = input.payout_address ?? input.payoutAddress ?? existing?.payoutAddress;
    const apiKeyInput = input.api_key ?? input.apiKey;
    const nextApiKey = apiKeyInput ?? existing?.apiKey ?? generateApiKey();

    const keyOwner = store.findAgentByApiKey(nextApiKey);
    if (keyOwner && keyOwner.id !== targetAgentId) {
      return sendError(reply, 409, 'agent_id_conflict', 'Provided API key is already in use by another agent', {
        keyOwnerAgentId: keyOwner.id
      });
    }

    const mergedMetadata = {
      ...existingMetadata,
      ...(input.metadata ?? {}),
      sandbox,
      eigencompute
    };

    const isNew = !existing;

    try {
      const saved = store.upsertAgent({
        id: targetAgentId,
        name,
        endpoint,
        apiKey: nextApiKey,
        payoutAddress,
        enabled: input.enabled ?? existing?.enabled ?? true,
        metadata: mergedMetadata
      });

      const health = await probeAgentEndpoint(saved.endpoint);
      const updated = store.updateAgentHealth({
        id: saved.id,
        status: health.status,
        error: health.error,
        checkedAt: new Date().toISOString()
      }) ?? saved;

      return reply.code(isNew ? 201 : 200).send({
        ok: true,
        agent_id: updated.id,
        api_key: nextApiKey,
        agent: updated,
        health
      });
    } catch (error) {
      req.log.error({ err: error }, 'agent_register_failed');
      return sendError(reply, 500, 'internal_error', 'Failed to register agent');
    }
  });

  app.post('/api/agents/:id/probe', async (req, reply) => {
    if (!requireRole(req, reply, 'agent', store)) return;

    const params = probeParamSchema.safeParse(req.params);
    if (!params.success) {
      return sendError(reply, 400, 'invalid_request', 'Invalid path params', {
        issues: params.error.issues
      });
    }

    const targetAgentId = normalizeAgentId(params.data.id);
    const targetAgent = store.getAgent(targetAgentId);

    if (!targetAgent) {
      return sendError(reply, 404, 'not_found', 'Agent not found', { agentId: targetAgentId });
    }

    const access = resolveAccessContext(req, store);
    if (!isPrivilegedRole(access.role) && access.actorAgentId !== targetAgentId) {
      return sendError(reply, 403, 'actor_scope_violation', 'Agents can only probe their own endpoint', {
        actorAgentId: access.actorAgentId ?? null,
        targetAgentId
      });
    }

    const health = await probeAgentEndpoint(targetAgent.endpoint);
    const updated = store.updateAgentHealth({
      id: targetAgentId,
      status: health.status,
      error: health.error,
      checkedAt: new Date().toISOString()
    });

    if (health.status !== 'healthy') {
      return sendError(reply, 502, 'health_probe_failed', 'Agent endpoint health probe failed', {
        agentId: targetAgentId,
        health,
        persistedStatus: updated?.lastHealthStatus ?? 'unhealthy'
      });
    }

    return {
      ok: true,
      agent_id: targetAgentId,
      health,
      agent: updated ?? targetAgent
    };
  });
}

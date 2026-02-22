import type { FastifyReply } from 'fastify';

export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'not_found'
  | 'strict_policy_failed'
  | 'endpoint_mode_required'
  | 'sandbox_metadata_required'
  | 'eigencompute_metadata_required'
  | 'actor_scope_violation'
  | 'invalid_state_transition'
  | 'prepare_required_before_start'
  | 'funding_pending'
  | 'attestation_required'
  | 'attestation_verification_failed'
  | 'trust_filter_excluded'
  | 'private_context_required'
  | 'negotiation_not_active'
  | 'privacy_redaction_violation'
  | 'health_probe_failed'
  | 'agent_id_conflict'
  | 'internal_error';

export type ApiErrorEnvelope = {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>
): FastifyReply {
  const payload: ApiErrorEnvelope = {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {})
    }
  };

  return reply.code(statusCode).send(payload);
}

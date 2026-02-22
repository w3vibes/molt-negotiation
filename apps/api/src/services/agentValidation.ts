import { z } from 'zod';
import {
  eigenComputeEnvironmentRequiredByDefault,
  eigenComputeImageDigestRequiredByDefault,
  eigenComputeRequiredByDefault,
  eigenComputeSignerRequiredByDefault,
  endpointModeRequiredByDefault,
  sandboxParityRequiredByDefault
} from './policy.js';

export const sandboxSchema = z.object({
  runtime: z.string().min(1),
  version: z.string().min(1),
  cpu: z.number().int().min(1).max(128),
  memory: z.number().int().min(128).max(1_048_576)
});

export const eigenComputeSchema = z.object({
  appId: z.string().min(1),
  environment: z.string().min(1).optional(),
  imageDigest: z.string().min(1).optional(),
  signerAddress: z.string().min(1).optional(),
  signer: z.string().min(1).optional()
});

export const registerAgentSchema = z.object({
  agent_id: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  agent_name: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  endpoint: z.string().url().optional(),
  payout_address: z.string().optional(),
  payoutAddress: z.string().optional(),
  api_key: z.string().min(16).optional(),
  apiKey: z.string().min(16).optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sandbox: sandboxSchema.partial().optional(),
  eigencompute: eigenComputeSchema.partial().optional()
});

export type RegisterAgentInput = z.infer<typeof registerAgentSchema>;

export type StrictValidationReason = {
  code:
    | 'endpoint_mode_required'
    | 'endpoint_url_invalid'
    | 'sandbox_metadata_required'
    | 'eigencompute_metadata_required'
    | 'eigencompute_environment_required'
    | 'eigencompute_image_digest_required'
    | 'eigencompute_signer_required';
  message: string;
};

export type StrictValidationResult = {
  ok: true;
} | {
  ok: false;
  reasons: StrictValidationReason[];
};

export function validateStrictAgentMetadata(input: {
  endpoint?: string;
  sandbox?: Record<string, unknown>;
  eigencompute?: Record<string, unknown>;
}): StrictValidationResult {
  const reasons: StrictValidationReason[] = [];

  if (endpointModeRequiredByDefault()) {
    if (!input.endpoint) {
      reasons.push({
        code: 'endpoint_mode_required',
        message: 'Strict mode requires a reachable endpoint URL'
      });
    } else {
      try {
        const parsed = new URL(input.endpoint);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          reasons.push({
            code: 'endpoint_url_invalid',
            message: 'Endpoint URL must use http(s) scheme'
          });
        }
      } catch {
        reasons.push({
          code: 'endpoint_url_invalid',
          message: 'Endpoint URL is invalid'
        });
      }
    }
  }

  if (sandboxParityRequiredByDefault()) {
    const parsedSandbox = sandboxSchema.safeParse(input.sandbox);
    if (!parsedSandbox.success) {
      reasons.push({
        code: 'sandbox_metadata_required',
        message: 'Strict mode requires sandbox metadata: runtime, version, cpu, memory'
      });
    }
  }

  if (eigenComputeRequiredByDefault()) {
    const parsedEigen = eigenComputeSchema.safeParse(input.eigencompute);
    if (!parsedEigen.success) {
      reasons.push({
        code: 'eigencompute_metadata_required',
        message: 'Strict mode requires EigenCompute metadata with appId'
      });
    } else {
      const eigen = parsedEigen.data;

      if (eigenComputeEnvironmentRequiredByDefault() && !eigen.environment?.trim()) {
        reasons.push({
          code: 'eigencompute_environment_required',
          message: 'Strict mode requires eigencompute.environment'
        });
      }

      if (eigenComputeImageDigestRequiredByDefault() && !eigen.imageDigest?.trim()) {
        reasons.push({
          code: 'eigencompute_image_digest_required',
          message: 'Strict mode requires eigencompute.imageDigest'
        });
      }

      if (eigenComputeSignerRequiredByDefault() && !(eigen.signerAddress?.trim() || eigen.signer?.trim())) {
        reasons.push({
          code: 'eigencompute_signer_required',
          message: 'Strict mode requires eigencompute.signerAddress'
        });
      }
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  return { ok: true };
}

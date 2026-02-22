import type { AgentRecord } from '../types/domain.js';
import {
  eigenAppBindingRequiredByDefault,
  eigenComputeEnvironmentRequiredByDefault,
  eigenComputeImageDigestRequiredByDefault,
  eigenComputeRequiredByDefault,
  eigenComputeSignerRequiredByDefault,
  endpointModeRequiredByDefault,
  endpointNegotiationRequiredByDefault,
  independentAgentsRequiredByDefault,
  requireRuntimeAttestationByDefault,
  runtimeAttestationRemoteVerifyByDefault,
  sandboxParityRequiredByDefault,
  turnProofRequiredByDefault
} from './policy.js';
import { validateStrictAgentMetadata } from './agentValidation.js';

type SandboxProfile = {
  runtime: string;
  version: string;
  cpu: number;
  memory: number;
};

type EigenProfile = {
  appId: string;
  environment?: string;
  imageDigest?: string;
  signerAddress?: string;
};

export type StrictSessionPolicyResult = {
  ok: boolean;
  reasons: string[];
  details: {
    endpointModeRequired: boolean;
    endpointNegotiationRequired: boolean;
    turnProofRequired: boolean;
    runtimeAttestationRequired: boolean;
    runtimeAttestationRemoteVerify: boolean;
    sandboxParityRequired: boolean;
    eigenComputeRequired: boolean;
    eigenEnvironmentRequired: boolean;
    eigenImageDigestRequired: boolean;
    eigenSignerRequired: boolean;
    independentAgentsRequired: boolean;
    eigenAppBindingRequired: boolean;
    appBindingConfigured: boolean;
  };
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function normalizeLower(value: unknown): string | undefined {
  return normalizeText(value)?.toLowerCase();
}

function endpointHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function configuredEigenAppIds(): Set<string> {
  const values = [
    process.env.ECLOUD_APP_ID_API,
    process.env.ECLOUD_APP_ID_WEB,
    process.env.ECLOUD_APP_ID,
    ...(process.env.ECLOUD_APP_IDS ? process.env.ECLOUD_APP_IDS.split(',').map((v) => v.trim()) : []),
    process.env.NEG_ECLOUD_APP_ID_API,
    process.env.NEG_ECLOUD_APP_ID_WEB,
    process.env.NEG_ECLOUD_APP_ID,
    ...(process.env.NEG_ECLOUD_APP_IDS ? process.env.NEG_ECLOUD_APP_IDS.split(',').map((v) => v.trim()) : [])
  ]
    .map((value) => normalizeLower(value))
    .filter((value): value is string => Boolean(value));

  return new Set(values);
}

function extractSandbox(agent: AgentRecord): SandboxProfile | undefined {
  const metadata = asObject(agent.metadata);
  const sandbox = asObject(metadata.sandbox);

  const runtime = normalizeLower(sandbox.runtime);
  const version = normalizeLower(sandbox.version);
  const cpu = Number(sandbox.cpu);
  const memory = Number(sandbox.memory);

  if (!runtime || !version || !Number.isFinite(cpu) || !Number.isFinite(memory)) return undefined;

  return {
    runtime,
    version,
    cpu,
    memory
  };
}

function extractEigen(agent: AgentRecord): EigenProfile | undefined {
  const metadata = asObject(agent.metadata);
  const eigen = asObject(metadata.eigencompute);

  const appId = normalizeLower(eigen.appId);
  if (!appId) return undefined;

  const environment = normalizeLower(eigen.environment ?? eigen.env);
  const imageDigest = normalizeLower(eigen.imageDigest ?? eigen.image_digest ?? eigen.releaseDigest);
  const signerAddress = normalizeLower(eigen.signerAddress ?? eigen.signer ?? eigen.evmAddress);

  return {
    appId,
    ...(environment ? { environment } : {}),
    ...(imageDigest ? { imageDigest } : {}),
    ...(signerAddress ? { signerAddress } : {})
  };
}

export function evaluateStrictSessionPolicy(input: {
  proposer?: AgentRecord;
  counterparty?: AgentRecord;
}): StrictSessionPolicyResult {
  const requireEndpointMode = endpointModeRequiredByDefault();
  const requireEndpointNegotiation = endpointNegotiationRequiredByDefault();
  const requireTurnProof = turnProofRequiredByDefault();
  const requireRuntimeAttestation = requireRuntimeAttestationByDefault();
  const runtimeAttestationRemoteVerify = runtimeAttestationRemoteVerifyByDefault();
  const requireSandboxParity = sandboxParityRequiredByDefault();
  const requireEigenCompute = eigenComputeRequiredByDefault();
  const requireEigenEnvironment = eigenComputeEnvironmentRequiredByDefault();
  const requireEigenImageDigest = eigenComputeImageDigestRequiredByDefault();
  const requireEigenSigner = eigenComputeSignerRequiredByDefault();
  const requireIndependentAgents = independentAgentsRequiredByDefault();
  const requireEigenAppBinding = eigenAppBindingRequiredByDefault();

  const appBindings = configuredEigenAppIds();
  const reasons: string[] = [];

  if (!input.proposer || !input.counterparty) {
    if (!input.proposer) reasons.push('proposer_agent_missing');
    if (!input.counterparty) reasons.push('counterparty_agent_missing');

    return {
      ok: false,
      reasons,
      details: {
        endpointModeRequired: requireEndpointMode,
        endpointNegotiationRequired: requireEndpointNegotiation,
        turnProofRequired: requireTurnProof,
        runtimeAttestationRequired: requireRuntimeAttestation,
        runtimeAttestationRemoteVerify,
        sandboxParityRequired: requireSandboxParity,
        eigenComputeRequired: requireEigenCompute,
        eigenEnvironmentRequired: requireEigenEnvironment,
        eigenImageDigestRequired: requireEigenImageDigest,
        eigenSignerRequired: requireEigenSigner,
        independentAgentsRequired: requireIndependentAgents,
        eigenAppBindingRequired: requireEigenAppBinding,
        appBindingConfigured: appBindings.size > 0
      }
    };
  }

  const proposer = input.proposer;
  const counterparty = input.counterparty;

  for (const participant of [
    { label: 'proposer', agent: proposer },
    { label: 'counterparty', agent: counterparty }
  ]) {
    const strictValidation = validateStrictAgentMetadata({
      endpoint: participant.agent.endpoint,
      sandbox: asObject(asObject(participant.agent.metadata).sandbox),
      eigencompute: asObject(asObject(participant.agent.metadata).eigencompute)
    });

    if (!strictValidation.ok) {
      reasons.push(...strictValidation.reasons.map((reason) => `${participant.label}:${reason.code}`));
    }

    if (requireEndpointMode || requireEndpointNegotiation) {
      try {
        const parsed = new URL(participant.agent.endpoint);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          reasons.push(`${participant.label}:invalid_endpoint_protocol`);
        }

        if (requireEndpointNegotiation) {
          const host = parsed.hostname.toLowerCase();
          const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
          if (!loopback && parsed.protocol !== 'https:') {
            reasons.push(`${participant.label}:endpoint_tls_required_for_negotiation`);
          }
        }
      } catch {
        reasons.push(`${participant.label}:invalid_endpoint_url`);
      }
    }
  }

  const proposerSandbox = extractSandbox(proposer);
  const counterpartySandbox = extractSandbox(counterparty);

  if (requireSandboxParity) {
    if (!proposerSandbox || !counterpartySandbox) {
      if (!proposerSandbox) reasons.push('proposer:sandbox_profile_missing');
      if (!counterpartySandbox) reasons.push('counterparty:sandbox_profile_missing');
    } else {
      const mismatches = (['runtime', 'version', 'cpu', 'memory'] as const)
        .filter((field) => proposerSandbox[field] !== counterpartySandbox[field]);

      if (mismatches.length > 0) {
        reasons.push(`sandbox_profile_mismatch:${mismatches.join(',')}`);
      }
    }
  }

  const proposerEigen = extractEigen(proposer);
  const counterpartyEigen = extractEigen(counterparty);

  if (requireEigenCompute) {
    if (!proposerEigen || !counterpartyEigen) {
      if (!proposerEigen) reasons.push('proposer:eigencompute_profile_missing');
      if (!counterpartyEigen) reasons.push('counterparty:eigencompute_profile_missing');
    } else {
      if (requireEigenEnvironment) {
        if (!proposerEigen.environment) reasons.push('proposer:eigen_environment_missing');
        if (!counterpartyEigen.environment) reasons.push('counterparty:eigen_environment_missing');
        if (proposerEigen.environment && counterpartyEigen.environment && proposerEigen.environment !== counterpartyEigen.environment) {
          reasons.push('eigen_environment_mismatch');
        }
      }

      if (requireEigenImageDigest) {
        if (!proposerEigen.imageDigest) reasons.push('proposer:eigen_image_digest_missing');
        if (!counterpartyEigen.imageDigest) reasons.push('counterparty:eigen_image_digest_missing');
        if (proposerEigen.imageDigest && counterpartyEigen.imageDigest && proposerEigen.imageDigest !== counterpartyEigen.imageDigest) {
          reasons.push('eigen_image_digest_mismatch');
        }
      }

      if (requireEigenSigner) {
        if (!proposerEigen.signerAddress) reasons.push('proposer:eigen_signer_missing');
        if (!counterpartyEigen.signerAddress) reasons.push('counterparty:eigen_signer_missing');
      }

      if (requireEigenAppBinding) {
        if (appBindings.size === 0) {
          reasons.push('eigen_app_binding_not_configured');
        } else {
          if (!appBindings.has(proposerEigen.appId)) {
            reasons.push(`proposer:eigen_app_not_bound:${proposerEigen.appId}`);
          }
          if (!appBindings.has(counterpartyEigen.appId)) {
            reasons.push(`counterparty:eigen_app_not_bound:${counterpartyEigen.appId}`);
          }
        }
      }
    }
  }

  if (requireIndependentAgents) {
    if (proposer.id === counterparty.id) {
      reasons.push('independence_same_agent_id');
    }

    const proposerHost = endpointHost(proposer.endpoint);
    const counterpartyHost = endpointHost(counterparty.endpoint);
    if (proposerHost && counterpartyHost && proposerHost === counterpartyHost) {
      reasons.push('independence_shared_endpoint_host');
    }

    const proposerPayout = normalizeLower(proposer.payoutAddress);
    const counterpartyPayout = normalizeLower(counterparty.payoutAddress);
    if (proposerPayout && counterpartyPayout && proposerPayout === counterpartyPayout) {
      reasons.push('independence_shared_payout_address');
    }

    if (proposerEigen?.appId && counterpartyEigen?.appId && proposerEigen.appId === counterpartyEigen.appId) {
      reasons.push('independence_shared_eigen_app');
    }

    if (proposerEigen?.signerAddress && counterpartyEigen?.signerAddress && proposerEigen.signerAddress === counterpartyEigen.signerAddress) {
      reasons.push('independence_shared_eigen_signer');
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    details: {
      endpointModeRequired: requireEndpointMode,
      endpointNegotiationRequired: requireEndpointNegotiation,
      turnProofRequired: requireTurnProof,
      runtimeAttestationRequired: requireRuntimeAttestation,
      runtimeAttestationRemoteVerify,
      sandboxParityRequired: requireSandboxParity,
      eigenComputeRequired: requireEigenCompute,
      eigenEnvironmentRequired: requireEigenEnvironment,
      eigenImageDigestRequired: requireEigenImageDigest,
      eigenSignerRequired: requireEigenSigner,
      independentAgentsRequired: requireIndependentAgents,
      eigenAppBindingRequired: requireEigenAppBinding,
      appBindingConfigured: appBindings.size > 0
    }
  };
}

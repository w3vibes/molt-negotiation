import {
  allowEngineFallbackByDefault,
  allowInsecureDevKeysByDefault,
  allowSimpleModeByDefault,
  attestationRequiredByDefault,
  attestationSignerKeyRequiredByDefault,
  eigenComputeEnvironmentRequiredByDefault,
  eigenComputeImageDigestRequiredByDefault,
  eigenComputeRequiredByDefault,
  eigenComputeSignerRequiredByDefault,
  endpointModeRequiredByDefault,
  endpointNegotiationRequiredByDefault,
  independentAgentsRequiredByDefault,
  privacyRedactionRequiredByDefault,
  requireRuntimeAttestationByDefault,
  runtimeAttestationRemoteVerifyByDefault,
  runtimeAttestationVerifierUrlByDefault,
  sandboxParityRequiredByDefault,
  sealingKeyRequiredByDefault,
  turnProofRequiredByDefault
} from './policy.js';

export type LaunchCheck = {
  key: string;
  pass: boolean;
  expected: unknown;
  actual: unknown;
  message?: string;
};

export type LaunchReadinessReport = {
  production: boolean;
  ready: boolean;
  checks: LaunchCheck[];
  blockers: string[];
};

function productionRuntime(): boolean {
  return process.env.NODE_ENV?.trim().toLowerCase() === 'production';
}

function hasEnvValue(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function addCheck(
  checks: LaunchCheck[],
  input: {
    key: string;
    expected: unknown;
    actual: unknown;
    message?: string;
  }
) {
  checks.push({
    key: input.key,
    expected: input.expected,
    actual: input.actual,
    pass: Object.is(input.actual, input.expected),
    message: input.message
  });
}

export function evaluateLaunchReadiness(): LaunchReadinessReport {
  const production = productionRuntime();
  const checks: LaunchCheck[] = [];

  addCheck(checks, {
    key: 'requireEndpointMode',
    expected: true,
    actual: endpointModeRequiredByDefault()
  });
  addCheck(checks, {
    key: 'requireEndpointNegotiation',
    expected: true,
    actual: endpointNegotiationRequiredByDefault()
  });
  addCheck(checks, {
    key: 'requireTurnProof',
    expected: true,
    actual: turnProofRequiredByDefault()
  });
  addCheck(checks, {
    key: 'requireRuntimeAttestation',
    expected: true,
    actual: requireRuntimeAttestationByDefault()
  });
  const runtimeRemoteVerify = runtimeAttestationRemoteVerifyByDefault();
  addCheck(checks, {
    key: 'runtimeAttestationRemoteVerify',
    expected: production ? true : runtimeRemoteVerify,
    actual: runtimeRemoteVerify,
    message: production ? 'NEG_RUNTIME_ATTESTATION_REMOTE_VERIFY must be true in production' : undefined
  });

  if (production || runtimeRemoteVerify) {
    addCheck(checks, {
      key: 'runtimeAttestationVerifierConfigured',
      expected: true,
      actual: Boolean(runtimeAttestationVerifierUrlByDefault()),
      message: 'NEG_RUNTIME_ATTESTATION_VERIFIER_URL should be configured (or derivable from ECLOUD_ENV)'
    });
  }
  addCheck(checks, {
    key: 'allowEngineFallback',
    expected: false,
    actual: allowEngineFallbackByDefault()
  });
  addCheck(checks, {
    key: 'requireEigenCompute',
    expected: true,
    actual: eigenComputeRequiredByDefault()
  });
  addCheck(checks, {
    key: 'requireSandboxParity',
    expected: true,
    actual: sandboxParityRequiredByDefault()
  });
  addCheck(checks, {
    key: 'requireEigenComputeEnvironment',
    expected: true,
    actual: eigenComputeEnvironmentRequiredByDefault()
  });
  addCheck(checks, {
    key: 'requireEigenComputeImageDigest',
    expected: true,
    actual: eigenComputeImageDigestRequiredByDefault()
  });
  addCheck(checks, {
    key: 'requireEigenComputeSigner',
    expected: true,
    actual: eigenComputeSignerRequiredByDefault()
  });
  addCheck(checks, {
    key: 'requireIndependentAgents',
    expected: true,
    actual: independentAgentsRequiredByDefault()
  });
  addCheck(checks, {
    key: 'allowSimpleMode',
    expected: false,
    actual: allowSimpleModeByDefault()
  });
  addCheck(checks, {
    key: 'requireAttestation',
    expected: true,
    actual: attestationRequiredByDefault()
  });
  addCheck(checks, {
    key: 'requirePrivacyRedaction',
    expected: true,
    actual: privacyRedactionRequiredByDefault()
  });
  addCheck(checks, {
    key: 'allowInsecureDevKeys',
    expected: false,
    actual: allowInsecureDevKeysByDefault()
  });

  if (production || sealingKeyRequiredByDefault()) {
    addCheck(checks, {
      key: 'sealingKeyConfigured',
      expected: true,
      actual: hasEnvValue('NEG_SEALING_KEY'),
      message: 'NEG_SEALING_KEY must be configured for production launch'
    });
  }

  if (production || attestationSignerKeyRequiredByDefault()) {
    addCheck(checks, {
      key: 'attestationSignerKeyConfigured',
      expected: true,
      actual: hasEnvValue('NEG_ATTESTATION_SIGNER_PRIVATE_KEY'),
      message: 'NEG_ATTESTATION_SIGNER_PRIVATE_KEY must be configured for production launch'
    });
  }

  const blockers = checks
    .filter((check) => !check.pass)
    .map((check) => check.message || `${check.key} expected=${String(check.expected)} actual=${String(check.actual)}`);

  return {
    production,
    ready: blockers.length === 0,
    checks,
    blockers
  };
}

export function assertProductionLaunchReadiness() {
  const report = evaluateLaunchReadiness();
  if (!report.production) return;

  if (!report.ready) {
    throw new Error(`launch_readiness_failed:${report.blockers.join(';')}`);
  }
}

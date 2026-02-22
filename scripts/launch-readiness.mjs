#!/usr/bin/env node

const API_BASE = (process.env.LAUNCH_API_BASE || process.env.E2E_API_BASE || 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = process.env.LAUNCH_API_KEY || process.env.NEG_READONLY_API_KEY || '';
const REQUIRE_RUNTIME_EVIDENCE = process.env.LAUNCH_REQUIRE_RUNTIME_EVIDENCE === 'true';
const TIMEOUT_MS = Number(process.env.LAUNCH_TIMEOUT_MS || 10_000);

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function getJson(path) {
  const headers = { accept: 'application/json' };
  if (API_KEY) headers.authorization = `Bearer ${API_KEY}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers,
    signal: timeoutSignal(TIMEOUT_MS)
  });

  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function check(checks, key, pass, details) {
  checks.push({ key, pass, details });
}

async function main() {
  const checks = [];

  const health = await getJson('/health');
  check(checks, 'health_ok', health.status === 200 && health.body.ok === true, health);

  const strict = await getJson('/policy/strict');
  check(checks, 'policy_readable', strict.status === 200 && strict.body.ok === true, strict.status);

  const verify = await getJson('/verification/eigencompute');
  check(checks, 'verification_readable', verify.status === 200 && verify.body.ok === true, verify.status);

  if (strict.status === 200 && strict.body?.policy) {
    const policy = strict.body.policy;
    check(checks, 'strict_require_endpoint_mode', policy.requireEndpointMode === true, policy.requireEndpointMode);
    check(checks, 'strict_require_endpoint_negotiation', policy.requireEndpointNegotiation === true, policy.requireEndpointNegotiation);
    check(checks, 'strict_require_turn_proof', policy.requireTurnProof === true, policy.requireTurnProof);
    check(checks, 'strict_require_runtime_attestation', policy.requireRuntimeAttestation === true, policy.requireRuntimeAttestation);
    check(checks, 'strict_disallow_engine_fallback', policy.allowEngineFallback === false, policy.allowEngineFallback);
    check(checks, 'strict_require_eigencompute', policy.requireEigenCompute === true, policy.requireEigenCompute);
    check(checks, 'strict_disallow_simple_mode', policy.allowSimpleMode === false, policy.allowSimpleMode);
    check(checks, 'strict_require_attestation', policy.requireAttestation === true, policy.requireAttestation);
    check(checks, 'strict_require_privacy_redaction', policy.requirePrivacyRedaction === true, policy.requirePrivacyRedaction);
    check(checks, 'strict_disallow_insecure_dev_keys', policy.allowInsecureDevKeys === false, policy.allowInsecureDevKeys);
  }

  if (verify.status === 200 && verify.body?.checks) {
    const launchReadiness = verify.body.checks.launchReadiness;
    check(checks, 'launch_readiness_report_ready', launchReadiness?.ready === true, launchReadiness?.blockers || []);

    if (REQUIRE_RUNTIME_EVIDENCE) {
      const proofRuntime = verify.body.checks.runtime?.proofRuntime || {};
      const attestationRuntime = verify.body.checks.runtime?.attestationRuntime || {};
      check(checks, 'runtime_has_verified_turn_proofs', Number(proofRuntime.verifiedDecisions || 0) > 0, proofRuntime);
      check(checks, 'runtime_has_verified_runtime_attestations', Number(proofRuntime.runtimeVerifiedDecisions || 0) > 0, proofRuntime);
      check(checks, 'runtime_has_valid_attestations', Number(attestationRuntime.validAttestations || 0) > 0, attestationRuntime);
    }
  }

  const failed = checks.filter((item) => !item.pass);
  const report = {
    apiBase: API_BASE,
    requireRuntimeEvidence: REQUIRE_RUNTIME_EVIDENCE,
    checks,
    ready: failed.length === 0,
    failedCount: failed.length
  };

  console.log(JSON.stringify(report, null, 2));

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('launch_readiness_check_failed');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

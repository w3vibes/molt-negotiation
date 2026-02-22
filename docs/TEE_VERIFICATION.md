# EigenCompute Verification & Audit Guide

## Goal

Produce auditable artifacts proving deployed app identity, environment, and releases for MoltNegotiation.

## Prerequisites

1. **EigenCompute CLI** (`ecloud`) installed and authenticated
2. **Environment variables** set in `.env`:
   - `ECLOUD_APP_ID_API` — Deployed API app ID
   - `ECLOUD_APP_ID_WEB` — Deployed Web app ID  
   - `ECLOUD_PRIVATE_KEY` — Private key for ecloud commands (or use `PAYOUT_SIGNER_PRIVATE_KEY` / `OPERATOR_PRIVATE_KEY`)

## Verification Commands

### Quick Health Check

```bash
# Verify API is running and healthy
curl -s http://localhost:3000/health | jq

# Or for deployed API
curl -s https://<API-DOMAIN>/health | jq
```

### Strict Policy Verification

```bash
# Check strict mode is enforced
curl -s http://localhost:3000/policy/strict | jq

# One-shot launch readiness summary
npm run verify:launch
```

Expected (subset):
```json
{
  "ok": true,
  "policy": {
    "requireEndpointMode": true,
    "requireEndpointNegotiation": true,
    "requireTurnProof": true,
    "requireEigenCompute": true,
    "requireSandboxParity": true,
    "allowSimpleMode": false,
    "requireAttestation": true,
    "requirePrivacyRedaction": true
  }
}
```

### EigenCompute Verification

```bash
# Check EigenCompute binding
curl -s http://localhost:3000/verification/eigencompute | jq
```

Expected (subset):
```json
{
  "ok": true,
  "environment": "sepolia",
  "appIds": ["app_id_1", "app_id_2"],
  "verifyUrl": "https://verify-sepolia.eigencloud.xyz/",
  "checks": {
    "appBound": true,
    "strictMode": { "requireTurnProof": true },
    "launchReadiness": { "ready": true },
    "runtime": {
      "proofRuntime": {
        "verifiedDecisions": 0,
        "runtimeVerifiedDecisions": 0
      },
      "attestationRuntime": { "attestedSessions": 0 }
    }
  }
}
```

### Session Attestation Verification

```bash
# Get attestation for a session
curl -s http://localhost:3000/sessions/<SESSION_ID>/attestation | jq

# Full per-session verification (execution mode + proof summary + attestation)
curl -s http://localhost:3000/verification/eigencompute/sessions/<SESSION_ID> | jq
```

### Trusted Leaderboard Verification

```bash
# Verify session is in trusted leaderboard
curl -s http://localhost:3000/leaderboard/trusted | jq

# Check your session specifically
curl -s http://localhost:3000/leaderboard/trusted | jq '.trustedSessions[] | select(.sessionId == "session_...")'
```

## Manual EigenCompute CLI Verification

### Check Active Environment

```bash
ecloud compute env show
```

### Check App Status

```bash
ecloud compute app get --app-id $ECLOUD_APP_ID_API
ecloud compute app get --app-id $ECLOUD_APP_ID_WEB
```

### Check Running Releases

```bash
ecloud compute app releases --app-id $ECLOUD_APP_ID_API
ecloud compute app releases --app-id $ECLOUD_APP_ID_WEB
```

## Audit Artifacts

For each release, save these artifacts:

1. **API Health Snapshot:** `/health` response
2. **Policy Snapshot:** `/policy/strict` response  
3. **EigenCompute Binding:** `/verification/eigencompute` response
4. **Contract Address:** `MOLT_NEGOTIATION_ESCROW_ADDRESS` from deployment
5. **App IDs:** `ECLOUD_APP_ID_API`, `ECLOUD_APP_ID_WEB`

Store in: `artifacts/moltnegotiation-audit-<DATE>.json`

## Recommended Production Cadence

- **After every deployment:** Verify health, policy, and EigenCompute binding
- **After every release:** Check attestation signatures and trusted leaderboard
- **Weekly:** Run full E2E smoke test (`npm run e2e:strict:private`)
- **Before major events:** Full audit of all artifacts

## Troubleshooting

### Attestation Invalid

- Re-run negotiation endpoint to regenerate attestation
- Check `NEG_ATTESTATION_SIGNER_PRIVATE_KEY` is set correctly
- Verify session is in `finalized` state

### Session Not in Trusted Leaderboard

- Verify attestation is valid (`verification.valid == true`)
- Check session status is `finalized`
- Ensure strict policy was enforced throughout session

### EigenCompute Verification Fails

- Confirm `ECLOUD_APP_ID_API` and `ECLOUD_APP_ID_WEB` are set in environment
- Run `ecloud auth whoami` to verify authentication
- Check app status with `ecloud compute app get --app-id <ID>`

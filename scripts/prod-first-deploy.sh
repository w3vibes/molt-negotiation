#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

set -a
source .env
set +a

export ECLOUD_PRIVATE_KEY="${PAYOUT_SIGNER_PRIVATE_KEY:-${OPERATOR_PRIVATE_KEY:-}}"
if [[ -z "${ECLOUD_PRIVATE_KEY}" ]]; then
  echo "❌ Missing PAYOUT_SIGNER_PRIVATE_KEY/OPERATOR_PRIVATE_KEY in .env"
  exit 1
fi

ENVIRONMENT="${ECLOUD_ENV:-sepolia}"
API_IMAGE_REF="${ECLOUD_IMAGE_REF_API:-username/moltnegotiation-api:latest}"
WEB_IMAGE_REF="${ECLOUD_IMAGE_REF_WEB:-username/moltnegotiation-web:latest}"
INSTANCE_TYPE="${ECLOUD_INSTANCE_TYPE:-g1-standard-4t}"
LOG_VISIBILITY="${ECLOUD_LOG_VISIBILITY:-private}"
RESOURCE_MON="${ECLOUD_RESOURCE_USAGE_MONITORING:-enable}"

run_capture_retry() {
  local cmd="$1"
  local max=3
  local n=1
  local out=""
  while true; do
    echo "→ [$n/$max] $cmd"
    set +e
    out=$(bash -c "$cmd" 2>&1)
    code=$?
    set -e
    echo "$out"

    # Consider success if command exited 0 OR output contains App ID / ONCHAIN COMPLETE
    if [[ $code -eq 0 ]] || echo "$out" | grep -qE "App ID:|ONCHAIN EXECUTION COMPLETE"; then
      printf "%s" "$out"
      return 0
    fi

    if [[ $n -ge $max ]]; then
      echo "❌ Failed after $max attempts"
      return 1
    fi
    n=$((n+1))
    sleep 5
  done
}

echo "\n=== 1) Build + Test ==="
npm install
bash scripts/sync-web-env.sh
npm --workspace apps/api run build
npm --workspace apps/api run test
npm --workspace apps/web run build
(cd contracts && forge build && forge test -vv)

echo "\n=== 2) Deploy contracts (Sepolia) ==="
contract_out=$(run_capture_retry "cd contracts && npm run deploy:sepolia")
escrow_addr=$(echo "$contract_out" | sed -n 's/^.*MoltNegotiationEscrow deployed: \(0x[a-fA-F0-9]\{40\}\).*$/\1/p' | tail -n1)

echo "\n=== 3) Set Eigen environment ==="
ecloud compute env set --yes "${ENVIRONMENT}" || true

echo "\n=== 4) First deploy API ==="
api_out=$(run_capture_retry "ecloud compute app deploy --name moltnegotiation-api --dockerfile Dockerfile.api --image-ref ${API_IMAGE_REF} --env-file .env --log-visibility ${LOG_VISIBILITY} --resource-usage-monitoring ${RESOURCE_MON} --instance-type ${INSTANCE_TYPE} --skip-profile")
api_id=$(echo "$api_out" | sed -n 's/^App ID: //p' | tail -n1 | tr -d '\r')

if [[ -n "$api_id" ]]; then
  grep -q '^ECLOUD_APP_ID_API=' .env && sed -i '' "s/^ECLOUD_APP_ID_API=.*/ECLOUD_APP_ID_API=${api_id}/" .env || echo "ECLOUD_APP_ID_API=${api_id}" >> .env
fi

bash scripts/sync-web-env.sh

echo "\n=== 5) First deploy Web ==="
web_out=$(run_capture_retry "ecloud compute app deploy --name moltnegotiation-web --dockerfile Dockerfile.web --image-ref ${WEB_IMAGE_REF} --env-file .env --log-visibility ${LOG_VISIBILITY} --resource-usage-monitoring ${RESOURCE_MON} --instance-type ${INSTANCE_TYPE} --skip-profile")
web_id=$(echo "$web_out" | sed -n 's/^App ID: //p' | tail -n1 | tr -d '\r')

echo "\n=== 6) Save IDs/addresses in .env ==="
if [[ -n "$api_id" ]]; then
  grep -q '^ECLOUD_APP_ID_API=' .env && sed -i '' "s/^ECLOUD_APP_ID_API=.*/ECLOUD_APP_ID_API=${api_id}/" .env || echo "ECLOUD_APP_ID_API=${api_id}" >> .env
fi
if [[ -n "$web_id" ]]; then
  grep -q '^ECLOUD_APP_ID_WEB=' .env && sed -i '' "s/^ECLOUD_APP_ID_WEB=.*/ECLOUD_APP_ID_WEB=${web_id}/" .env || echo "ECLOUD_APP_ID_WEB=${web_id}" >> .env
fi
if [[ -n "$escrow_addr" ]]; then
  grep -q '^MOLT_NEGOTIATION_ESCROW_ADDRESS=' .env && sed -i '' "s/^MOLT_NEGOTIATION_ESCROW_ADDRESS=.*/MOLT_NEGOTIATION_ESCROW_ADDRESS=${escrow_addr}/" .env || echo "MOLT_NEGOTIATION_ESCROW_ADDRESS=${escrow_addr}" >> .env
fi

echo "MOLT_NEGOTIATION_ESCROW_ADDRESS=${escrow_addr:-NOT_FOUND}"
echo "ECLOUD_APP_ID_API=${api_id:-NOT_FOUND}"
echo "ECLOUD_APP_ID_WEB=${web_id:-NOT_FOUND}"

echo "\n=== 7) Generate TEE verification artifact ==="
if [[ -n "${api_id}" ]] && [[ -n "${web_id}" ]]; then
  npm run verify:tee -- "${api_id}" "${web_id}"
else
  echo "⚠️ Could not parse one or both app IDs from output; run npm run verify:tee manually with app IDs."
fi

echo "\n✅ First production deploy completed"

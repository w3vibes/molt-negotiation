#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

set -a
source .env
set +a

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "❌ Missing required command: $cmd" >&2
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "❌ Missing required env var: $name" >&2
    exit 1
  fi
}

json_field() {
  local json="$1"
  local expr="$2"
  echo "$json" | jq -r "$expr" 2>/dev/null || true
}

is_json() {
  local json="$1"
  echo "$json" | jq -e . >/dev/null 2>&1
}

ensure_no_error() {
  local label="$1"
  local json="$2"

  if ! is_json "$json"; then
    echo "❌ ${label} failed (non-JSON response)" >&2
    echo "$json" >&2
    exit 1
  fi

  local err
  err=$(json_field "$json" '.error // empty')
  if [[ -n "$err" ]]; then
    echo "❌ ${label} failed" >&2
    echo "$json" | jq >&2 || echo "$json" >&2
    exit 1
  fi
}

ensure_no_sensitive_leak() {
  local label="$1"
  local text="$2"
  local blocked=("creditScore" "income" "reservationPrice" "privateContext" "maxPrice")
  for token in "${blocked[@]}"; do
    if echo "$text" | grep -q "$token"; then
      echo "❌ ${label}: sensitive token leaked in response: $token" >&2
      exit 1
    fi
  done
}

require_cmd curl
require_cmd jq
require_cmd node
require_cmd npm

# Friendly fallbacks from common repo env names
A_ENDPOINT="${A_ENDPOINT:-${AGENT_A_ENDPOINT:-}}"
B_ENDPOINT="${B_ENDPOINT:-${AGENT_B_ENDPOINT:-}}"
A_APP_ID="${A_APP_ID:-${ECLOUD_APP_ID_AGENT_A:-}}"
B_APP_ID="${B_APP_ID:-${ECLOUD_APP_ID_AGENT_B:-}}"
A_IMAGE_DIGEST="${A_IMAGE_DIGEST:-${AGENT_A_IMAGE_DIGEST:-}}"
B_IMAGE_DIGEST="${B_IMAGE_DIGEST:-${AGENT_B_IMAGE_DIGEST:-}}"
A_SIGNER_ADDRESS="${A_SIGNER_ADDRESS:-${AGENT_A_SIGNER_ADDRESS:-}}"
B_SIGNER_ADDRESS="${B_SIGNER_ADDRESS:-${AGENT_B_SIGNER_ADDRESS:-}}"
OPERATOR_API_KEY="${OPERATOR_API_KEY:-${NEG_OPERATOR_API_KEY:-}}"
USDC_TOKEN_ADDRESS="${USDC_TOKEN_ADDRESS:-0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238}"
AMOUNT_PER_PLAYER_6DP="${AMOUNT_PER_PLAYER_6DP:-${ESCROW_AMOUNT:-1000000}}"

# Required inputs
for v in \
  API_BASE \
  OPERATOR_API_KEY \
  A_ENDPOINT \
  B_ENDPOINT \
  A_APP_ID \
  B_APP_ID \
  A_IMAGE_DIGEST \
  B_IMAGE_DIGEST \
  A_SIGNER_ADDRESS \
  B_SIGNER_ADDRESS \
  PLAYER_A_WALLET \
  PLAYER_B_WALLET \
  SEPOLIA_RPC_URL \
  MOLT_NEGOTIATION_ESCROW_ADDRESS \
  PLAYER_A_PRIVATE_KEY \
  PLAYER_B_PRIVATE_KEY; do
  require_env "$v"
done

http_status() {
  local url="$1"
  curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 12 "$url" 2>/dev/null || true
}

normalize_api_base() {
  local raw="${1%/}"

  if [[ "$raw" == */api ]]; then
    echo "$raw"
    return
  fi

  local direct
  direct=$(http_status "$raw/health")
  if [[ "$direct" =~ ^2|^3 ]]; then
    echo "$raw"
    return
  fi

  local proxied
  proxied=$(http_status "$raw/api/health")
  if [[ "$proxied" =~ ^2|^3 ]]; then
    echo "$raw/api"
    return
  fi

  echo "$raw"
}

API_BASE="$(normalize_api_base "$API_BASE")"

norm_lower_trim() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | xargs
}

url_host() {
  echo "$1" | awk -F/ '{print tolower($3)}'
}

A_IMAGE_DIGEST_NORM="$(norm_lower_trim "$A_IMAGE_DIGEST")"
B_IMAGE_DIGEST_NORM="$(norm_lower_trim "$B_IMAGE_DIGEST")"
A_APP_ID_NORM="$(norm_lower_trim "$A_APP_ID")"
B_APP_ID_NORM="$(norm_lower_trim "$B_APP_ID")"
A_SIGNER_NORM="$(norm_lower_trim "$A_SIGNER_ADDRESS")"
B_SIGNER_NORM="$(norm_lower_trim "$B_SIGNER_ADDRESS")"
A_HOST="$(url_host "$A_ENDPOINT")"
B_HOST="$(url_host "$B_ENDPOINT")"

# Strict session eligibility requires parity on imageDigest.
if [[ "$A_IMAGE_DIGEST_NORM" != "$B_IMAGE_DIGEST_NORM" ]]; then
  echo "❌ Strict preflight failed: A_IMAGE_DIGEST != B_IMAGE_DIGEST" >&2
  echo "   reason: trusted sessions require eigencompute_profile parity (imageDigest)." >&2
  echo "   got: A_IMAGE_DIGEST=$A_IMAGE_DIGEST" >&2
  echo "   got: B_IMAGE_DIGEST=$B_IMAGE_DIGEST" >&2
  exit 1
fi

# Strict independence requires distinct agent identities.
if [[ "$A_APP_ID_NORM" == "$B_APP_ID_NORM" ]]; then
  echo "❌ Strict independence preflight failed: A_APP_ID == B_APP_ID" >&2
  echo "   reason: independent agents required (shared_eigencompute_app is rejected)." >&2
  exit 1
fi

if [[ "$A_SIGNER_NORM" == "$B_SIGNER_NORM" ]]; then
  echo "❌ Strict independence preflight failed: A_SIGNER_ADDRESS == B_SIGNER_ADDRESS" >&2
  echo "   reason: independent agents required (shared_eigencompute_signer is rejected)." >&2
  exit 1
fi

if [[ -n "$A_HOST" && -n "$B_HOST" && "$A_HOST" == "$B_HOST" ]]; then
  echo "❌ Strict independence preflight failed: A_ENDPOINT host == B_ENDPOINT host" >&2
  echo "   reason: independent agents required (shared_endpoint_host is rejected)." >&2
  echo "   host: $A_HOST" >&2
  exit 1
fi

A_SANDBOX_RUNTIME="${A_SANDBOX_RUNTIME:-node}"
A_SANDBOX_VERSION="${A_SANDBOX_VERSION:-20.11}"
A_SANDBOX_CPU="${A_SANDBOX_CPU:-2}"
A_SANDBOX_MEMORY="${A_SANDBOX_MEMORY:-2048}"

B_SANDBOX_RUNTIME="${B_SANDBOX_RUNTIME:-$A_SANDBOX_RUNTIME}"
B_SANDBOX_VERSION="${B_SANDBOX_VERSION:-$A_SANDBOX_VERSION}"
B_SANDBOX_CPU="${B_SANDBOX_CPU:-$A_SANDBOX_CPU}"
B_SANDBOX_MEMORY="${B_SANDBOX_MEMORY:-$A_SANDBOX_MEMORY}"

TOPIC="${E2E_TOPIC:-Used car price negotiation between buyer and seller agents}"
A_NAME="NegotiatorAlpha"
B_NAME="NegotiatorBeta"
MAX_TURNS="${E2E_MAX_TURNS:-12}"

echo "ℹ️ Using API_BASE=$API_BASE"

printf "\n== 1) Verify strict mode ==\n"
STRICT=$(curl -s "$API_BASE/verification/eigencompute")
ensure_no_error "strict check" "$STRICT"
echo "$STRICT" | jq '.checks.strictMode'

printf "\n== 2) Register Agent A ==\n"
A_REG=$(curl -s -X POST "$API_BASE/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "{\"agent_name\":\"$A_NAME\",\"endpoint\":\"$A_ENDPOINT\",\"payout_address\":\"$PLAYER_A_WALLET\",\"sandbox\":{\"runtime\":\"$A_SANDBOX_RUNTIME\",\"version\":\"$A_SANDBOX_VERSION\",\"cpu\":$A_SANDBOX_CPU,\"memory\":$A_SANDBOX_MEMORY},\"eigencompute\":{\"appId\":\"$A_APP_ID\",\"environment\":\"sepolia\",\"imageDigest\":\"$A_IMAGE_DIGEST\",\"signerAddress\":\"$A_SIGNER_ADDRESS\"}}")
ensure_no_error "register A" "$A_REG"
A_ID=$(json_field "$A_REG" '.agent_id')
A_KEY=$(json_field "$A_REG" '.api_key')
echo "$A_REG" | jq '{agent_id, api_key}'

printf "\n== 3) Register Agent B ==\n"
B_REG=$(curl -s -X POST "$API_BASE/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "{\"agent_name\":\"$B_NAME\",\"endpoint\":\"$B_ENDPOINT\",\"payout_address\":\"$PLAYER_B_WALLET\",\"sandbox\":{\"runtime\":\"$B_SANDBOX_RUNTIME\",\"version\":\"$B_SANDBOX_VERSION\",\"cpu\":$B_SANDBOX_CPU,\"memory\":$B_SANDBOX_MEMORY},\"eigencompute\":{\"appId\":\"$B_APP_ID\",\"environment\":\"sepolia\",\"imageDigest\":\"$B_IMAGE_DIGEST\",\"signerAddress\":\"$B_SIGNER_ADDRESS\"}}")
ensure_no_error "register B" "$B_REG"
B_ID=$(json_field "$B_REG" '.agent_id')
B_KEY=$(json_field "$B_REG" '.api_key')
echo "$B_REG" | jq '{agent_id, api_key}'

printf "\n== 4) Create negotiation session ==\n"
SESSION_CREATE=$(curl -s -X POST "$API_BASE/sessions" \
  -H "Authorization: Bearer $A_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"topic\":\"$TOPIC\",\"proposerAgentId\":\"$A_ID\",\"counterpartyAgentId\":\"$B_ID\",\"escrow\":{\"contractAddress\":\"$MOLT_NEGOTIATION_ESCROW_ADDRESS\",\"amountPerPlayer\":\"$AMOUNT_PER_PLAYER_6DP\",\"playerAAgentId\":\"$A_ID\",\"playerBAgentId\":\"$B_ID\"}}")
ensure_no_error "create session" "$SESSION_CREATE"
SESSION_ID=$(json_field "$SESSION_CREATE" '.session.id')
echo "$SESSION_CREATE" | jq '{ok, session: {id: .session.id, status: .session.status, topic: .session.topic}}'

printf "\n== 5) Accept session ==\n"
ACCEPT=$(curl -s -X POST "$API_BASE/sessions/$SESSION_ID/accept" \
  -H "Authorization: Bearer $B_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"counterpartyAgentId\":\"$B_ID\"}")
ensure_no_error "accept session" "$ACCEPT"
echo "$ACCEPT" | jq '{ok, session: {id: .session.id, status: .session.status}}'

printf "\n== 6) Prepare session ==\n"
PREPARE=$(curl -s -X POST "$API_BASE/sessions/$SESSION_ID/prepare" \
  -H "Authorization: Bearer $A_KEY")
ensure_no_error "prepare session" "$PREPARE"
echo "$PREPARE" | jq '{ok, session: {id: .session.id, status: .session.status}}'

printf "\n== 7) Prepare escrow ==\n"
ESCROW_PREP=$(curl -s -X POST "$API_BASE/sessions/$SESSION_ID/escrow/prepare" \
  -H "Authorization: Bearer $A_KEY")
ensure_no_error "escrow prepare" "$ESCROW_PREP"
echo "$ESCROW_PREP" | jq '{ok, escrow: {sessionId: .escrow.sessionId, status: .escrow.status, stakeAmount: .escrow.stakeAmount, contractAddress: .escrow.contractAddress}, readiness}'

# Compute sessionIdHex for on-chain calls (keccak256 of sessionId, matching molt-combat's toMatchIdHex pattern)
SESSION_ID_HEX="0x$(echo -n "\"$SESSION_ID\"" | openssl dgst -sha256 -hex | sed 's/.*= //')"
echo "sessionIdHex: $SESSION_ID_HEX"

printf "\n== 7b) Prepare escrow on-chain ==\n"
SEPOLIA_RPC_URL="$SEPOLIA_RPC_URL" PAYOUT_SIGNER_PRIVATE_KEY="$PAYOUT_SIGNER_PRIVATE_KEY" \
  npm run escrow:prepare -- "$MOLT_NEGOTIATION_ESCROW_ADDRESS" "$SESSION_ID_HEX" "$PLAYER_A_WALLET" "$PLAYER_B_WALLET" "$AMOUNT_PER_PLAYER_6DP"

printf "\n== 8) Deposit Player A ==\n"
SEPOLIA_RPC_URL="$SEPOLIA_RPC_URL" PLAYER_PRIVATE_KEY="$PLAYER_A_PRIVATE_KEY" \
  npm run escrow:player:deposit -- "$USDC_TOKEN_ADDRESS" "$MOLT_NEGOTIATION_ESCROW_ADDRESS" "$SESSION_ID_HEX" "$AMOUNT_PER_PLAYER_6DP"

# Report deposit to API
DEP_A=$(curl -s -X POST "$API_BASE/sessions/$SESSION_ID/escrow/deposit" \
  -H "Authorization: Bearer $A_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"amount\":\"$AMOUNT_PER_PLAYER_6DP\"}")
ensure_no_error "deposit A (API)" "$DEP_A"
echo "$DEP_A" | jq '{ok, escrow: {playerADeposited: .escrow.playerADeposited, playerBDeposited: .escrow.playerBDeposited}, readiness}'

printf "\n== 9) Deposit Player B ==\n"
SEPOLIA_RPC_URL="$SEPOLIA_RPC_URL" PLAYER_PRIVATE_KEY="$PLAYER_B_PRIVATE_KEY" \
  npm run escrow:player:deposit -- "$USDC_TOKEN_ADDRESS" "$MOLT_NEGOTIATION_ESCROW_ADDRESS" "$SESSION_ID_HEX" "$AMOUNT_PER_PLAYER_6DP"

# Report deposit to API
DEP_B=$(curl -s -X POST "$API_BASE/sessions/$SESSION_ID/escrow/deposit" \
  -H "Authorization: Bearer $B_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"amount\":\"$AMOUNT_PER_PLAYER_6DP\"}")
ensure_no_error "deposit B (API)" "$DEP_B"
echo "$DEP_B" | jq '{ok, escrow: {playerADeposited: .escrow.playerADeposited, playerBDeposited: .escrow.playerBDeposited}, readiness}'

printf "\n== 10) Verify escrow deposits ==\n"
ESCROW_STATUS=$(curl -s "$API_BASE/sessions/$SESSION_ID/escrow/status" \
  -H "Authorization: Bearer $A_KEY")
ensure_no_error "escrow status" "$ESCROW_STATUS"
A_DEP=$(json_field "$ESCROW_STATUS" '.escrow.playerADeposited')
B_DEP=$(json_field "$ESCROW_STATUS" '.escrow.playerBDeposited')
echo "$ESCROW_STATUS" | jq '{escrow: {sessionId: .escrow.sessionId, status: .escrow.status, playerADeposited: .escrow.playerADeposited, playerBDeposited: .escrow.playerBDeposited}}'

if [[ "$A_DEP" != "true" || "$B_DEP" != "true" ]]; then
  echo "❌ Deposits not ready. Aborting before start." >&2
  exit 1
fi

printf "\n== 11) Start session ==\n"
START=$(curl -s -X POST "$API_BASE/sessions/$SESSION_ID/start" \
  -H "Authorization: Bearer $A_KEY")
ensure_no_error "start session" "$START"
echo "$START" | jq '{ok, session: {id: .session.id, status: .session.status}}'

printf "\n== 12a) Private input: Agent A (buyer) ==\n"
INPUT_A=$(curl -s -X POST "$API_BASE/sessions/$SESSION_ID/private-inputs" \
  -H "Authorization: Bearer $A_KEY" \
  -H "Content-Type: application/json" \
  -d '{"privateContext":{"strategy":{"role":"buyer","reservationPrice":120,"initialPrice":80,"concessionStep":10},"attributes":{"income":3000,"creditScore":790,"urgency":0.6}}}')
ensure_no_error "private input A" "$INPUT_A"
echo "$INPUT_A" | jq '{ok, sealedInput: {sessionId: .sealedInput.sessionId, agentId: .sealedInput.agentId, sealedRef: .sealedInput.sealedRef}}'

printf "\n== 12b) Private input: Agent B (seller) ==\n"
INPUT_B=$(curl -s -X POST "$API_BASE/sessions/$SESSION_ID/private-inputs" \
  -H "Authorization: Bearer $B_KEY" \
  -H "Content-Type: application/json" \
  -d '{"privateContext":{"strategy":{"role":"seller","reservationPrice":100,"initialPrice":140,"concessionStep":10},"attributes":{"income":5400,"creditScore":720,"urgency":0.55}}}')
ensure_no_error "private input B" "$INPUT_B"
echo "$INPUT_B" | jq '{ok, sealedInput: {sessionId: .sealedInput.sessionId, agentId: .sealedInput.agentId, sealedRef: .sealedInput.sealedRef}}'

printf "\n== 13) Execute negotiation ==\n"
NEGOTIATE=$(curl -s -X POST "$API_BASE/sessions/$SESSION_ID/negotiate" \
  -H "Authorization: Bearer $A_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"maxTurns\":$MAX_TURNS}")
ensure_no_error "negotiate" "$NEGOTIATE"

NEG_STATUS=$(json_field "$NEGOTIATE" '.result.finalStatus')
NEG_TURNS=$(json_field "$NEGOTIATE" '.result.turns')
NEG_MODE=$(json_field "$NEGOTIATE" '.result.execution.mode')

echo "$NEGOTIATE" | jq '{ok, finalStatus: .result.finalStatus, turns: .result.turns, execution: .result.execution, proofSummary: .result.proofSummary, attestationValid: .attestation.verification.valid, escrow: {action: .escrow.action, reason: .escrow.reason}}'

printf "\n== 14) Verify transcript + attestation + settlement ==\n"

# Transcript privacy
TRANSCRIPT_RAW=$(curl -s "$API_BASE/sessions/$SESSION_ID/transcript" \
  -H "Authorization: Bearer $A_KEY")
ensure_no_error "transcript" "$TRANSCRIPT_RAW"
ensure_no_sensitive_leak "transcript" "$TRANSCRIPT_RAW"
echo "$TRANSCRIPT_RAW" | jq '{ok, sessionId, status, turns: (.transcript | length)}'

# Attestation
ATTEST=$(curl -s "$API_BASE/sessions/$SESSION_ID/attestation" \
  -H "Authorization: Bearer $A_KEY")
ensure_no_error "attestation" "$ATTEST"
echo "$ATTEST" | jq '.verification'

# Per-session verification
VERIFY_SESSION=$(curl -s "$API_BASE/verification/eigencompute/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $A_KEY")
ensure_no_error "session verification" "$VERIFY_SESSION"
echo "$VERIFY_SESSION" | jq '{sessionId, status, execution: .negotiation.execution, proofSummary: .negotiation.proofSummary, attestationValid: .attestation.verification.valid}'

# Force settlement tick
curl -s -X POST "$API_BASE/automation/tick" \
  -H "Authorization: Bearer $OPERATOR_API_KEY" | jq '.' >/dev/null

# Escrow final
ESCROW_FINAL=$(curl -s "$API_BASE/sessions/$SESSION_ID/escrow/status" \
  -H "Authorization: Bearer $A_KEY")
ensure_no_error "final escrow status" "$ESCROW_FINAL"
ESCROW_FINAL_STATUS=$(json_field "$ESCROW_FINAL" '.escrow.status')
echo "$ESCROW_FINAL" | jq '{escrow: {sessionId: .escrow.sessionId, status: .escrow.status, playerADeposited: .escrow.playerADeposited, playerBDeposited: .escrow.playerBDeposited}}'

# Leaderboard
LEADERBOARD=$(curl -s "$API_BASE/leaderboard/trusted")
ensure_no_error "leaderboard" "$LEADERBOARD"
echo "$LEADERBOARD" | jq '{summary, entries: (.leaderboard | length)}'

printf "\n✅ E2E complete\n"
printf "Session:       %s\n" "$SESSION_ID"
printf "SessionHex:    %s\n" "$SESSION_ID_HEX"
printf "Topic:         %s\n" "$TOPIC"
printf "Status:        %s\n" "$NEG_STATUS"
printf "Turns:         %s\n" "$NEG_TURNS"
printf "Mode:          %s\n" "$NEG_MODE"
printf "Escrow:        %s\n" "$ESCROW_FINAL_STATUS"
printf "Agent A:       %s (%s)\n" "$A_ID" "$A_NAME"
printf "Agent B:       %s (%s)\n" "$B_ID" "$B_NAME"

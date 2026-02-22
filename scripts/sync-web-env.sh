#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

set -a
source .env
set +a

# Resolve API URL from explicit NEXT_PUBLIC_API_URL first.
api_url="${NEXT_PUBLIC_API_URL:-}"

# Fallback: derive from running API app id if NEXT_PUBLIC_API_URL is missing.
if [[ -z "$api_url" ]] && [[ -n "${ECLOUD_APP_ID_API:-}" ]]; then
  info=$(ecloud compute app info "$ECLOUD_APP_ID_API" 2>/dev/null || true)
  ip=$(echo "$info" | sed -n 's/^  IP:[[:space:]]*//p' | head -n1 | tr -d '[:space:]')

  if [[ -n "$ip" ]] && [[ "$ip" != "-" ]] && [[ "$ip" != "REDACTED" ]]; then
    api_url="http://${ip}:3000"

    if grep -q '^NEXT_PUBLIC_API_URL=' .env; then
      sed -i '' "s|^NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=${api_url}|" .env
    else
      echo "NEXT_PUBLIC_API_URL=${api_url}" >> .env
    fi
  fi
fi

if [[ -z "$api_url" ]]; then
  api_url="http://localhost:3000"
fi

readonly_key="${NEXT_PUBLIC_READONLY_API_KEY:-${NEG_READONLY_API_KEY:-}}"

cat > apps/web/.env.local <<EOF
NEXT_PUBLIC_API_URL=${api_url}
NEXT_PUBLIC_READONLY_API_KEY=${readonly_key}
EOF

echo "✅ Synced apps/web/.env.local"
echo "NEXT_PUBLIC_API_URL=${api_url}"
if [[ -n "$readonly_key" ]]; then
  echo "NEXT_PUBLIC_READONLY_API_KEY=<set>"
else
  echo "NEXT_PUBLIC_READONLY_API_KEY=<empty>"
fi

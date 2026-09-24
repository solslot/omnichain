#!/usr/bin/env bash
set -euo pipefail
umask 077
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "${SOLSLOT_PORTAL_EXECUTE:-}" == approved ]] || { printf 'Approved exact portal plan required.\n' >&2; exit 1; }
for name in SOLSLOT_PORTAL_PLAN SOLSLOT_PORTAL_PLAN_SHA256 SOLSLOT_ACTION_ENVELOPE_ID SOLSLOT_PORTAL_JOURNAL SOLSLOT_OMNICHAIN_SOURCE_SHA BASE_MAINNET_RPC_URL BASE_MAINNET_SECONDARY_RPC_URL SOLSLOT_PORTAL_DEPLOYMENT_OUTPUT; do
  [[ -n "${!name:-}" ]] || { printf '%s is required\n' "$name" >&2; exit 1; }
done
export SOLSLOT_DEPLOYER_KEYSTORE_PATH="${SOLSLOT_DEPLOYER_KEYSTORE_PATH:-${HOME}/secure/solslot-secrets/evm-operator.keystore.json}"
cd "$repo_dir"
if [[ -e "$SOLSLOT_PORTAL_JOURNAL/signed-sequence.json" ]]; then
  node scripts/deploy-bounded-portal.js
  exit
fi
SOLSLOT_PORTAL_EXECUTE=preview node scripts/deploy-bounded-portal.js
read -r -s -p 'EVM operator keystore passphrase (local only): ' portal_passphrase
printf '\n' >&2
portal_passphrase_file="$(mktemp /dev/shm/solslot-portal-passphrase.XXXXXX)"
cleanup() {
  exec 3<&- 2>/dev/null || true
  [[ -z "${portal_passphrase_file:-}" ]] || rm -f -- "$portal_passphrase_file"
  unset portal_passphrase
}
trap cleanup EXIT HUP INT TERM
printf '%s' "$portal_passphrase" > "$portal_passphrase_file"
exec 3<"$portal_passphrase_file"
rm -f -- "$portal_passphrase_file"
portal_passphrase_file=""
unset portal_passphrase
export SOLSLOT_KEYSTORE_PASSPHRASE_FD=3
node scripts/deploy-bounded-portal.js

#!/usr/bin/env bash
set -euo pipefail
umask 077
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "${SOLSLOT_TEST_TOKEN_EXECUTE:-}" == approved ]] || { printf 'Approved exact plan required.\n' >&2; exit 1; }
for name in SOLSLOT_TEST_TOKEN_PLAN SOLSLOT_TEST_TOKEN_PLAN_SHA256 SOLSLOT_ACTION_ENVELOPE_ID SOLSLOT_TEST_TOKEN_JOURNAL SOLSLOT_OMNICHAIN_SOURCE_SHA BASE_MAINNET_RPC_URL BASE_MAINNET_SECONDARY_RPC_URL; do
  [[ -n "${!name:-}" ]] || { printf '%s is required\n' "$name" >&2; exit 1; }
done
export SOLSLOT_DEPLOYER_KEYSTORE_PATH="${SOLSLOT_DEPLOYER_KEYSTORE_PATH:-${HOME}/secure/solslot-secrets/evm-operator.keystore.json}"
cd "$repo_dir"
# Reconcile an existing signed journal without asking for the secret again.
if [[ -e "$SOLSLOT_TEST_TOKEN_JOURNAL/signed-test-token.json" ]]; then
  HARDHAT_NETWORK=baseMainnet node scripts/deploy-test-token.js
  exit
fi
# Validate the exact public plan and both RPCs before asking for a secret.
SOLSLOT_TEST_TOKEN_EXECUTE=preview HARDHAT_NETWORK=baseMainnet node scripts/deploy-test-token.js
read -r -s -p 'EVM operator keystore passphrase (local only): ' token_passphrase
printf '\n' >&2
token_passphrase_file="$(mktemp /dev/shm/solslot-test-token-passphrase.XXXXXX)"
cleanup() {
  exec 3<&- 2>/dev/null || true
  [[ -z "${token_passphrase_file:-}" ]] || rm -f -- "$token_passphrase_file"
  unset token_passphrase
}
trap cleanup EXIT HUP INT TERM
printf '%s' "$token_passphrase" > "$token_passphrase_file"
exec 3<"$token_passphrase_file"
rm -f -- "$token_passphrase_file"
token_passphrase_file=""
unset token_passphrase
export SOLSLOT_KEYSTORE_PASSPHRASE_FD=3
HARDHAT_NETWORK=baseMainnet node scripts/deploy-test-token.js

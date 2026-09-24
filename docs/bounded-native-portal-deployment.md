# Native test portal deployment

This runner installs the validator Safe, Portal implementation and atomically
initialized transparent proxy on Base 8453. The bridge is restricted by its
candidate configuration to Chia Testnet11 and valueless test assets. It does not
activate a bridge route or replace the current alpha genesis.

`prepare-bounded-portal.js` uses two independent Base RPC hosts, verifies the
published Safe 1.4.1 dependency code hashes, reconstructs the three-owner,
two-signature Safe and checks the hash-pinned Portal artifacts. It rehearses
all three exact calls in a local chain-31337 fork before writing a plan. The
reviewed plan fixes nonces, calldata, created addresses and runtime hashes.
Each fee budget includes execution, L1 data and the Base operator fee.

Set `BASE_MAINNET_RPC_URL`, `BASE_MAINNET_SECONDARY_RPC_URL`,
`SOLSLOT_OMNICHAIN_SOURCE_SHA`, `SOLSLOT_DEPLOYER_ADDRESS`,
`SOLSLOT_ACTION_ENVELOPE_ID`, `SOLSLOT_WARP_SOURCE_ROOT`,
`SOLSLOT_WARP_VALIDATOR_ROSTER_PATH`, `SOLSLOT_WARP_VALIDATOR_ROSTER_HASH`,
`SOLSLOT_PORTAL_PLAN` and `SOLSLOT_PORTAL_REHEARSAL`, then run:

```
node scripts/prepare-bounded-portal.js
```

After review, pin the canonical plan file's SHA-256 in
`SOLSLOT_PORTAL_PLAN_SHA256`. Set `SOLSLOT_PORTAL_JOURNAL` to a new owner-only
directory outside the repository and `SOLSLOT_PORTAL_DEPLOYMENT_OUTPUT` to a
new evidence path. Explicit authorized execution requires
`SOLSLOT_PORTAL_EXECUTE=approved` and the same ActionEnvelope identifier.

```
bash scripts/deploy-bounded-portal-from-keystore.sh
```

The shell asks for the keystore passphrase locally, without echoing it, and
passes it through a dedicated file descriptor. All three signatures are
persisted and fsynced before the first send. Every subsequent operation waits
for 12 confirmations and agreement from both RPCs, including exact transaction
fields, bytecode and the previous operation's configuration. Downstream portal
evidence is validated by both RPCs before publication.

A timeout retains the signed journal. Rerunning reconciles those same bytes
without unlocking or signing again. If a previously attempted transaction is
absent from both RPCs, the runner stops with `reconciliation_required`.
After inspecting the nonce and chain evidence, explicit
`SOLSLOT_PORTAL_RESUBMIT_ORIGINAL=true` resends only the saved transaction.
There is no automated nonce replacement, cancellation or fee bump. A signing
lock left by a crash also requires reconciliation; do not remove it blindly.

The local fork starts in fork mode directly because resetting a non-fork
Hardhat 2.28 provider retains genesis storage overrides unsupported by EDR
forks. No rehearsal calls or test funding are sent to the public chain.

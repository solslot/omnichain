# Bounded Authority V3 deployment

This runner prepares the Base 8453 administrator hierarchy for a fresh Chia
Testnet11 genesis. It does not approve genesis, activate financial routes, or
reuse the disposable genesis's approvals. All three enrollment records and
completed recovery-kit records must match the exported fresh ceremony roster.

The sequence has 19 transactions: recovery coordinator, five guards, setup
helper, five Safe proxies, recovery topology binding, five guard bindings, and
the timelock. Identity Safes have one daily owner and the recovery module;
the coadministrator Safe accepts either coadministrator identity; the root
requires the owner identity plus the coadministrator Safe. The timelock keeps
the existing 24-hour delay. The coordinator initializes recovery revisions at
one; a roster with a rotated revision is rejected before signing and requires
an explicit migration plan.

## Prepare

Compile from a clean source revision. Export the schema-v3 roster from the
planned ceremony ledger using the API's `export_authority_v3_roster.py`. Set:

- `BASE_MAINNET_RPC_URL` and `BASE_MAINNET_SECONDARY_RPC_URL`: independent hosts.
- `SOLSLOT_OMNICHAIN_SOURCE_SHA`: exact clean checkout SHA.
- `SOLSLOT_DEPLOYER_ADDRESS`: reviewed operator address.
- `SOLSLOT_ACTION_ENVELOPE_ID`: concrete deployment envelope.
- `SOLSLOT_AUTHORITY_V3_ROSTER_PATH` and `SOLSLOT_AUTHORITY_V3_ROSTER_HASH`.
- `SOLSLOT_AUTHORITY_PLAN`: new output path.
- `SOLSLOT_AUTHORITY_REHEARSAL`: new rehearsal receipt path.
- `SOLSLOT_AUTHORITY_REHEARSAL_EVIDENCE`: new simulated governance receipt path.

Run `node scripts/prepare-bounded-authority.js`. It never opens a keystore. It
checks the official Safe 1.4.1 dependency hashes on both providers and deploys
the complete sequence in an in-process fork. The fork uses chain ID 8453 so
the recovery coordinator's EIP-712 immutable bytecode matches Base. The
rehearsal checks every transaction's resulting state and the full existing
Authority V3 evidence validator. No simulated receipt is a live deployment.

Gas limits have a 25% margin. Base execution, L1 data and operator fees are
bounded in each transaction. The entire sequence cannot exceed 0.001 Base ETH.
The plan fixes the roster, launcher IDs, source manifest, addresses, nonces,
calldata, bytecode hashes, and postconditions. A changed plan requires a new
review and a separate journal.

## Execute and resume

Set `SOLSLOT_AUTHORITY_PLAN_SHA256` to the reviewed file's SHA-256, plus the
roster path, both RPCs, source SHA, and envelope. A preview with
`node scripts/deploy-bounded-authority.js` does not sign or write a journal.

For the authorized deployment, set `SOLSLOT_AUTHORITY_EXECUTE=approved`,
`SOLSLOT_AUTHORITY_JOURNAL` to an owner-only directory, and
`SOLSLOT_AUTHORITY_DEPLOYMENT_OUTPUT` to a new public receipt path. The shared
keystore loader uses `SOLSLOT_DEPLOYER_KEYSTORE_PATH` and
`SOLSLOT_KEYSTORE_PASSPHRASE_FD`; pass the password through a local hidden prompt
and inherited descriptor, never an environment value or command argument.

The runner saves the exact signed sequence before broadcasting. It advances
only after both providers agree on each successful canonical receipt with at
least 12 confirmations. Binding-call postconditions are checked at the
receipt block, allowing correct recovery after later bindings have changed
the latest state. No public receipt is published until the complete live
governance state also passes both providers. Its adjacent `.acceptance.json`
records that final validation.

After interruption, use the same plan and journal. If a submitted hash is
absent from both providers, the default is `reconciliation_required`. After
reconciling its nonce and canonical history, an authorized exact-byte resend
uses `SOLSLOT_AUTHORITY_RESUBMIT_ORIGINAL=true`. This does not change fees,
nonce, calldata, or signatures. Preserve all original evidence and journals.

## Validation

`test/BoundedAuthorityDeployment.test.js` executes the complete topology using
official Safe runtimes with pinned package provenance. The generic sequence
tests cover lost responses, restart, canonical confirmation, altered bytes,
state-check disagreement, and no-creation binding calls. Existing v1 portal
and escrow plans retain their original schema and recovery behavior.

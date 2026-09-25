# Paused Base test-payment deployment

Use `prepare-bounded-payment.js` and `deploy-bounded-payment.js` for the new
Testnet11 checkout gateway and escrow on Base 8453. Only valueless, attested
six-decimal TEST assets are accepted. Native SOLS is a separate three-decimal
asset and must not be substituted for the TEST-SOLS checkout fixture.

The sequence has seven transactions: deploy gateway, pause gateway, nominate
the governance timelock as owner, deploy escrow, pause escrow, configure the
trusted escrow, and nominate the timelock as escrow owner. The deployer remains
owner until the existing administrator-governed ownership activation completes.
Neither script accepts ownership or unpauses anything. Preserve the 24-hour
timelock and owner-plus-one administrator approvals.

## Inputs and read-only preparation

Compile from a clean, pinned checkout. Create an owner-only canonical JSON file:

```json
{
  "schema": "solslot.bounded-payment-inputs.v1",
  "portalSourceSha": "<original portal deployment source SHA>",
  "environment": {},
  "evidence": {
    "governance": {"path": "<absolute Authority V3 receipt path>", "artifactHash": "<hash>"},
    "samuel": {"path": "<absolute Samuel coordinate path>", "artifactHash": "<hash>"},
    "portal": {"path": "<absolute original portal receipt path>", "artifactHash": "<hash>"},
    "testAsset": {"path": "<absolute test-token creation receipt path>", "artifactHash": "<hash>"}
  }
}
```

All `environment` fields are required strings; unknown fields are rejected:

- Scope: `SOLSLOT_OMNICHAIN_TESTNET_DEPLOYMENT=true`,
  `SOLSLOT_CHIA_NETWORK=testnet11`, `SOLSLOT_BRIDGE_TEST_ONLY=true`.
- Authority: `PAYOUT_ADDRESS` equals `ROOT_SAFE_ADDRESS`; `GOVERNANCE_ADDRESS`
  is the distinct Authority V3 timelock. Both must match the live governance
  receipt, including recovery identities and all Safe configuration.
- Token: `USDC_ADDRESS` is the exact reviewed fixture address. The token receipt
  must match its canonical creation transaction and the compiled faucet code.
- Route: `DEPLOY_GATEWAY=true`, `HUB_CHAIN_SELECTOR=15971525489660198786`,
  `WARP_PORTAL_ADDRESS`, `WARP_CHIA_CHAIN=0x786368`,
  `SAMUEL_BRIDGING_PUZZLE`, `SAMUEL_RETURN_PUZZLE`,
  `VOUCHER_RESULT_AUTHORIZATION_MOD_HASH`, `VOUCHER_BURN_INNER_HASH`.
- Sources: `SOLSLOT_PROTOCOL_SOURCE_SHA` and `SOLSLOT_SAMUEL_SOURCE_SHA` are full
  reviewed commits matching the coordinate artifact.
- Limits: `CCIP_CALLBACK_GAS`, `EMERGENCY_REFUND_DELAY_SECONDS` (at least 604800),
  `SOLSLOT_OMNICHAIN_CONFIRMATIONS=12`, `MAX_WARP_TOLL_WEI`, `MAX_CCIP_FEE_WEI`.

The existing portal receipt keeps its original source SHA. Do not rewrite it to
match the newer deployment tool commit. Pin its full artifact hash in the input;
both public providers must validate the portal bytecode, proxy slots, signers,
threshold, zero toll, ownership, original creation receipts and confirmations.

Set these process variables before preparation:

- `BASE_MAINNET_RPC_URL` and `BASE_MAINNET_SECONDARY_RPC_URL`: independent hosts.
- `SOLSLOT_OMNICHAIN_SOURCE_SHA`: exact clean checkout HEAD.
- `SOLSLOT_DEPLOYER_ADDRESS` and `SOLSLOT_ACTION_ENVELOPE_ID`.
- `SOLSLOT_PAYMENT_INPUTS` and `SOLSLOT_PAYMENT_INPUTS_SHA256`: canonical file
  and its file SHA-256 (not an artifact hash).
- `SOLSLOT_PAYMENT_PLAN` and `SOLSLOT_PAYMENT_REHEARSAL`: new output paths.

Run `node scripts/prepare-bounded-payment.js`. It validates all dependencies,
pins a common public block, requires matching latest/pending nonces, rehearses
every transaction in an in-process Base fork, and checks immutable parameters,
paused state and pending ownership. The plan fixes calldata, nonces, dependency
hashes, postconditions and a total fee ceiling of at most 0.001 Base ETH. Gas
estimates include a margin and separate L1/operator fee budgets. The rehearsal
record is explicitly simulated and is not a usable deployment receipt.

## Execution and recovery

Additionally set `SOLSLOT_PAYMENT_PLAN_SHA256` to the approved plan file SHA-256.
Run `node scripts/deploy-bounded-payment.js` without an execution flag for a
read-only preview. To execute the authorized exact plan, set:

- `SOLSLOT_PAYMENT_EXECUTE=approved`.
- `SOLSLOT_PAYMENT_JOURNAL`: a new owner-only directory outside the repository.
- `SOLSLOT_PAYMENT_DEPLOYMENT_OUTPUT`: a new public receipt path.
- `SOLSLOT_DEPLOYER_KEYSTORE_PATH` and `SOLSLOT_KEYSTORE_PASSPHRASE_FD`: local
  keystore and inherited descriptor. Never use chat or command-line passwords.

The signer writes the complete signed sequence before the first broadcast. Each
step must confirm on both providers before the next is sent. Postconditions use
the original receipt block, so a subsequent authorized setup call cannot break
reconciliation of an earlier step. A timeout or missing response does not allow
a nonce replacement. Preserve the input, plan and journal; rerun the same
sequence. `SOLSLOT_PAYMENT_RESUBMIT_ORIGINAL=true` permits retransmitting only
the identical saved signed bytes after reconciliation.

After all receipts confirm, the script rechecks dependency governance and both
contracts' current paused state. Only then does it publish the schema-v5
deployment receipt and a separate acceptance record. Existing ownership
preparation tools consume that receipt. Ownership acceptance and later route
activation remain separate reviewed timelock operations; a paused deployment
does not make checkout available.

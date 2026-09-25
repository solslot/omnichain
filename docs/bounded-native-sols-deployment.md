# Paused native SOLS deployment

This deploys `SolslotTestSols` on Base 8453 for the native Chia Testnet11 SOLS
CAT from the fresh signed genesis. It is not the six-decimal TEST-SOLS checkout
fixture. The representation has three decimals and one wrapped unit per CAT
mojo. It starts paused with zero supply and no faucet. Only the existing
two-of-three validator Safe owns it. Activation is a separate reviewed action.

## Inputs

Use an exact clean Omnichain checkout, compiled with `npm run build`, and clean
protocol/Samuel checkouts matching the fresh genesis. Set two independent Base
RPC hosts in `BASE_MAINNET_RPC_URL` and `BASE_MAINNET_SECONDARY_RPC_URL`.

The canonical input JSON has exactly these fields:

| Field | Value |
| --- | --- |
| `schema` | `solslot.bounded-native-sols-inputs.v1` |
| `testOnly` | `true` |
| `basePortalPath`, `basePortalHash`, `basePortalSourceSha` | Original confirmed Base portal receipt, artifact hash and build commit |
| `chiaPortalPath`, `chiaPortalHash`, `chiaPortalSourceSha` | Original Chia portal confirmation, manifest hash and build commit |
| `genesisPath`, `genesisHash` | New owner-plus-one signed public genesis artifact and its artifact hash |
| `protocolRoot`, `protocolSourceSha` | Exact clean protocol checkout and signed commit |
| `samuelRoot`, `samuelSourceSha` | Exact clean route derivation checkout and signed commit |
| `omnichainSourceSha` | This deployment tool's clean commit, also bound in genesis |
| `python` | Absolute path to the hashlocked bridge Python runtime |
| `chiaRpcRoot`, `chiaRpcPort` | Local authenticated full-node certificate/config root and port |
| `maxTransferMojos`, `maxSupplyMojos`, `maxMessageTollWei` | Reviewed canonical decimal strings; transfer/supply are uint64 bounds |

All paths must be absolute. Preserve historical portal build commits even when
the new route source differs. The helper reconstructs the genesis, verifies its
administrator signatures, and checks all nine spent inputs and 45 outputs at
the signed height against both the authenticated node and Coinset Testnet11.
Both must agree on a canonical block with at least twelve confirmations. The
genesis must select Base payments and the real 18+ plus sanctions identity policy
on Sepolia. The helper also reconstructs current portal history from its launcher
and checks the original portal confirmation remains canonical.

## Prepare and execute

Set `SOLSLOT_OMNICHAIN_SOURCE_SHA`, `SOLSLOT_DEPLOYER_ADDRESS`, and the approved
`SOLSLOT_ACTION_ENVELOPE_ID`. Set `SOLSLOT_SOLS_INPUTS` and
`SOLSLOT_SOLS_INPUTS_SHA256` to the input file and its file SHA-256. Choose new
`SOLSLOT_SOLS_PLAN` and `SOLSLOT_SOLS_REHEARSAL` output paths. Run:

```sh
node scripts/prepare-bounded-sols.js
```

Preparation only reads public state and executes on an in-process Base fork. It
does not open a keystore. It fixes the exact constructor, CREATE address, nonce,
runtime hashes, owner, token identity, units, caps, pause and zero-supply checks.
The total fee budget includes Base L1/operator fees and cannot exceed 0.001 ETH.

Inspect the plan and rehearsal before setting `SOLSLOT_SOLS_PLAN_SHA256`,
`SOLSLOT_SOLS_JOURNAL` (private persistent directory), and
`SOLSLOT_SOLS_DEPLOYMENT_OUTPUT`. Execution additionally requires
`SOLSLOT_SOLS_EXECUTE=approved` and the exact ActionEnvelope. Use the existing
keystore-file and passphrase-FD interface in `deploy-bounded-portal.js`; never
put a passphrase or private key in command arguments or release evidence.

```sh
node scripts/deploy-bounded-sols.js
```

Signed bytes are saved before sending. A timeout or interrupted terminal does
not mean deployment failed. Rerun with the same plan and journal to reconcile;
`SOLSLOT_SOLS_RESUBMIT_ORIGINAL=true` resends only identical saved bytes. Do not
change the nonce, genesis, caps or plan to retry a pending transaction.

The final deployment receipt is written only after both Base providers agree
on twelve confirmations, the exact deployed runtime and all final invariants,
and the genesis and portals pass another read. Rehearsal output is explicitly
simulated and cannot substitute for a deployment receipt. Receipt acceptance
does not activate SOLS or establish hosted round-trip acceptance.

## Validation

`test/BoundedSolsDeployment.test.js` exercises the paused constructor, exact
identity and unit bindings, plan replay, unexpected activation and input bounds.
Its compact local dependencies are fixtures, not live Safe/portal attestations.
`test/test_native_sols_genesis.py` uses real EIP-712 test signatures and the pinned
protocol reconstruction; it rejects invalid signatures, stale policies, mismatched
sources, shallow confirmations, conflicting coins and reorganizations.

Run Python tests with the protocol checkout on `PYTHONPATH` and the bridge
runtime. A live deployment rehearsal must wait for the new signed genesis.

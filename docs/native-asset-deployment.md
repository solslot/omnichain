# Native test escrow deployment preparation

`scripts/lib/native-asset-deployment.js` prepares and checks the exact constructor
for `SolslotTestAssetBridge`. It does not sign, broadcast, or activate a route.
The initial owner is the confirmed two-of-three validator Safe. Ownership can
later move to the reviewed Authority V3 governance through its normal handoff.

The deployment coordinator must supply hash-pinned Base and Chia portal
confirmation artifacts, exact TEST-USDC and TEST-USDT addresses, and route
artifacts freshly derived by the pinned Samuel checkout. Derive each route with
`drivers.solslot_test_asset_route.derive_test_asset_route` using the predicted
CREATE address for the reviewed deployer nonce. The helper checks artifact
commitments and binding consistency; it does not reimplement the Chia puzzle
derivation or authenticate an arbitrary caller-supplied artifact.

Before preparing the bounded deployment plan:

1. Verify both portal confirmations against their respective independent chain
   providers. Require 12 confirmations and the reviewed validator roster.
2. Verify both test-token creation receipts and runtime bytecode using
   `validateTestAssetRecord`, explicitly allowing TEST-USDC and TEST-USDT.
3. Derive the two routes locally. Pass them and the reviewed caps into
   `assetBridgeSpec`. A changed deployer nonce requires new derived routes.
4. Rehearse the single deployment on a canonical Base fork. Record its full
   runtime hash, including immutable constructor bindings, and call
   `verifyPausedBridge` against the deployed contract.
5. Use the existing bounded sequence executor with `verifyAssetBridgePlan` and
   fresh dependency checks. Preserve signed bytes before any broadcast; use its
   existing reconciliation rules for uncertain outcomes.
6. After both providers confirm the deployment, call `verifyPausedBridge` on
   each. Bind the TEST-USDC `catTailHash` into the new SGT-sale genesis plan.
   Keep the escrow paused until the full release and route acceptance are ready.

`test/native-asset-deployment.test.js` exercises an actual local deployment and
checks constructor substitution, wrong networks, incomplete confirmations,
amount limits, and accidental activation. Local fixtures are not chain evidence.
`prepare-native-assets.js` runs these checks, derives the routes in a clean pinned
Samuel checkout, and rehearses the constructor on a canonical Base fork. The
Python derivation helper reconstructs the portal from its launcher on the
authenticated Chia node and Coinset. Both must still observe the confirmed,
unused initial portal with the reviewed two-of-three authority.

`deploy-native-assets.js` repeats the dependency checks and route derivation,
then uses the bounded sequence journal. It accepts only one constructor and no
activation transaction. After twelve confirmations on two independent Base RPC
hosts, it verifies every escrow binding and writes a new deployment receipt.
Hosted round trips and route activation remain separate acceptance work.

Set `BASE_MAINNET_RPC_URL`, `BASE_MAINNET_SECONDARY_RPC_URL`,
`SOLSLOT_OMNICHAIN_SOURCE_SHA`, `SOLSLOT_DEPLOYER_ADDRESS`,
`SOLSLOT_ACTION_ENVELOPE_ID`, `SOLSLOT_ASSET_INPUTS`,
`SOLSLOT_ASSET_INPUTS_SHA256`, `SOLSLOT_ASSET_PLAN`, and
`SOLSLOT_ASSET_REHEARSAL` for preparation. The inputs JSON contains the portal
artifact paths and hashes, original portal source SHA, roster hash and three EVM
validators, ordered TEST-USDC/TEST-USDT evidence paths, Samuel root and source
SHA, isolated Python executable, Chia RPC root and localhost port, transfer and
outstanding caps in CAT mojos, and maximum message toll in wei.

For execution add `SOLSLOT_ASSET_PLAN_SHA256`,
`SOLSLOT_ASSET_EXECUTE=approved`, `SOLSLOT_ASSET_JOURNAL`,
`SOLSLOT_ASSET_DEPLOYMENT_OUTPUT`, `SOLSLOT_DEPLOYER_KEYSTORE_PATH`, and the
dedicated `SOLSLOT_KEYSTORE_PASSPHRASE_FD`. File SHA256 values are plain
hexadecimal hashes of exact file bytes. A missing response preserves the original
signed transaction; explicit `SOLSLOT_ASSET_RESUBMIT_ORIGINAL=true` can resend
only those saved bytes after reconciliation. It cannot replace a nonce or raise
the signed fee cap.

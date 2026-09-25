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
The deployment CLI/fork orchestration and hosted acceptance remain integration
work; this library alone is not a deployable release or a readiness claim.

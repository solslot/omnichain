# Base bridge portal preparation

This candidate supports a Solslot-controlled portal on Base mainnet (8453)
for valueless assets paired with Chia Testnet11. It retains the historical
Base Sepolia (84532) evidence format. Ethereum Sepolia identity verification
is a separate deployment and is not selected by these tools.

The candidate is not a deployed bridge. The active disposable vault/identity
genesis must be replaced before bridge testing; do not repin its signed plan.

## Explicit network selection

For `scripts/deploy-warp-portal.js` on Hardhat network `baseMainnet`, require:

- `SOLSLOT_WARP_TESTNET_DEPLOYMENT=true`
- `SOLSLOT_CHIA_NETWORK=testnet11`
- `SOLSLOT_BRIDGE_TEST_ONLY=true`
- `BASE_MAINNET_RPC_URL`, matching chain 8453
- A newly attested Base 8453 Samuel roster and its exact artifact hash

The existing source SHA, artifact source root, new evidence path, confirmation,
deployer, balance, and roster-path requirements still apply. The Safe SDK uses
the selected network's RPC; it cannot fall back to the Sepolia RPC. Base ETH
gas remains real even when all bridge assets are test fixtures.

Create the roster with Samuel's chain-aware attestation and assembly tools.
Its domain must be `solslot-alpha-native-bridge-testnet11-base-mainnet` for the
roster and each of the three members. Samuel verifies BLS and EVM possession
proofs before producing the sealed roster. This JavaScript loader checks the
explicitly pinned hash, member domains and unique keys; it does not independently
perform BLS proof verification. Changing a domain string is not reattestation.
The existing validator keys can be retained using Samuel's host-local
reattestation tool; preserve prior public proofs and private key files.

Base portal evidence uses schema 2 and kind
`solslot-native-bridge-base-mainnet-portal-deployment`, with explicit
`chiaNetwork: testnet11`, `testOnly: true` and `validatorIdentityDomain`.
Schema 1 remains Base Sepolia only. Evidence readers reject a selected-chain
mismatch, wrong RPC chain, missing test scope or mismatched member domain.
Coordinate and portal readers are passed the caller's configured chain.

## Controls retained

- Exact historical EVM source/build pin
  `425a69650ccdf0b28e9f4fccb91d736b05b20512`; this change does not substitute
  another upstream revision or attest that source as newly reviewed.
- Proxy constructor initialization in the same deployment transaction.
- Three validator signers, threshold two, validator Safe ownership.
- Live Safe/signers, implementation/admin slots, code hashes, and confirmed
  creation receipts rechecked before the gateway accepts the portal evidence.
- Original evidence is never overwritten, and dirty source cannot deploy.

The patched Samuel CAT burner is separate from the pinned EVM Portal. Its new
module hash changes wrapped CAT IDs, requiring a fresh coordinated deployment.

## Remaining before hosted E2E

The Base 8453 omnibus preflight and the API evidence reader now require explicit
Testnet11/test-only scope, exact test-token evidence, and Authority V3 governance.
The ownership operation supports the actual nested Safe topology: owner plus
one coadministrator, with each administrator represented by its daily/recovery
identity Safe. Local tests use the Safe 1.4.1 contract implementation. These
changes still need a new deployment and independent live evidence review.

Install the three owned TLS relays and host identities, add separately bound
native-asset dispatch, and bind exact test token/CAT IDs, amounts, decimals,
caps and emergency policy. A `testOnly` label records intended scope; it does
not prove a token is valueless or activate an asset route. Hosted round trips
and escrow/liability reconciliation remain required.

The inventory V3 checkout puzzle pins the existing six-decimal `TEST-SOLS`
fixture at `0xd48548a2dccb9b05f31a3f342f7bfd14b72c29c3`. This token is not
platform SOLS or a stablecoin. The separate `TEST-USDC` and `TEST-USDT` fixtures
are for the native bridge and CAT-backed flows. Changing checkout to either
fixture requires another reviewed inventory puzzle; do not relabel a token.

`prepare-payment-test-asset.js` prepares a bounded plan using two independent
Base RPC hosts. It does not sign or deploy. `attest-payment-test-asset.js` checks
the canonical constructor, runtime, receipt and confirmations. Fresh source
commits are required before preparing plans; test receipts are not substitutes
for live contract evidence.

## Validation

The focused local suite includes both network formats, wrong RPC/network
rejection, missing test scope, mixed validator domains, duplicate keys and
live mock-contract authority/receipt checks. These are local regressions,
not Base deployment receipts or hosted Testnet11 E2E results.

```bash
npx hardhat test test/WarpPortalDeployment.test.js \
  test/SamuelCoordinates.test.js test/DeploymentPreflight.test.js \
  test/AuthorityV3Deployment.test.js
```

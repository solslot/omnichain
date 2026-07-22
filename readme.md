# SolSlot CCIP-to-Warp Omnichain

SolSlot keeps settlement tokens on each origin chain while Chainlink CCIP carries payment messages to a Base Warp gateway, preserving the existing Warp -> Samuel -> KoS -> Warp result path.

## Architecture

- The alpha `OmnichainEscrowSpoke` accepts only its immutable six-decimal USDC contract. Base Sepolia is pinned to Circle USDC at `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; no test USDT is accepted or deployed.
- `SolomonWarpGateway` is deployed on Base and Ethereum. Base is primary; Ethereum remains disabled until a controlled failover. Gateway callbacks queue work, while separate permissionless calls pay Warp/CCIP fees and retry forwarding.
- Protocol V2 derives a globally unique payment ID from protocol version, origin selector, origin spoke, settlement-token address, and local payment ID.
- The Samuel/KoS request is ten words: `[globalPaymentId, purchaseId, artifactHash, amount, quantity, collectionId, deedLauncherId, vaultLauncherId, destinationPuzzle, quoteExpiresAt]`. Samuel verifies every word against the coordinator's persisted purchase artifact before asking KoS to reserve or deliver a deed. The Warp result remains `[globalPaymentId, amount, passFail]`.
- CCIP transfers no tokens. USDC remains on the origin spoke throughout processing.

## Network inventory

The alpha deployment is Base Sepolia only. Other historical profiles remain in
`config/networks.json` for later review and are not evidence for this rail.

Router addresses and selectors are pinned from the official Chainlink CCIP directory. `scripts/check-network.js` verifies the RPC chain, router bytecode, and selected hub lane before deployment.

## Development

```bash
npm install
npm run build
npm test
```

Deterministic tests cover local and remote routes, exact success/refund settlement, spoofed CCIP sources, Warp authentication, replay protection, amount mismatch, fee caps, global-ID separation, and delayed emergency refunds. The legacy live-network script is intentionally excluded from `npm test`.

## Deployment

Copy `.env.example` to `.env`, supply only reviewed values, then validate and deploy:

```bash
npm run check:network -- --network baseSepolia
npm run deploy:governance -- --network baseSepolia
npm run preflight:testnet -- --network baseSepolia
npm run deploy -- --network baseSepolia
npm run prepare:ownership -- --network baseSepolia
npm run attest:activation -- --network baseSepolia
```

`preflight:testnet` is read-only and deliberately requires
`SOLSLOT_OMNICHAIN_TESTNET_DEPLOYMENT=true`. It checks the pinned source SHA,
RPC chain/router, deployer balance floor, three-Safe authority/timelock and Warp-portal runtime
code, the immutable USDC runtime contract and six-decimal interface,
all gateway constructor inputs, the 12-confirmation policy, and a fresh
owner-only evidence output. It prevents the deployment command from reaching a
gateway or spoke transaction until those same contract-readiness checks pass.

```bash
SOLSLOT_OMNICHAIN_TESTNET_DEPLOYMENT=true \
SOLSLOT_OMNICHAIN_SOURCE_SHA=$(git rev-parse HEAD) \
SOLSLOT_GOVERNANCE_EVIDENCE_PATH=/secure/omnichain/governance.json \
SOLSLOT_SAMUEL_COORDINATE_EVIDENCE_PATH=/secure/omnichain/samuel-coordinates.json \
SOLSLOT_OMNICHAIN_MIN_DEPLOYER_WEI=10000000000000000 \
SOLSLOT_OMNICHAIN_PREFLIGHT_OUTPUT=/secure/omnichain/base-sepolia-preflight.json \
npm run preflight:testnet -- --network baseSepolia
```

Deployment must consume that same fresh receipt and records its hash in the
immutable deployment evidence. The coordinator requires the matching preflight,
deployment, and ownership-acceptance records before it exposes the rail.

```bash
SOLSLOT_OMNICHAIN_PREFLIGHT_EVIDENCE_PATH=/secure/omnichain/base-sepolia-preflight.json \
SOLSLOT_OMNICHAIN_PREFLIGHT_MAX_AGE_SECONDS=3600 \
SOLSLOT_OMNICHAIN_DEPLOYMENT_OUTPUT=/secure/omnichain/base-sepolia-deployment.json \
npm run deploy -- --network baseSepolia
```

`deploy:governance` deterministically deploys three Safe 1.4.1 accounts from
the verified ceremony roster. The Owner Identity Safe is 1-of-1 slot 0, the
Coadmin Safe is 1-of-2 slots 1 and 2, and the root Safe is 2-of-2 over those
two child Safes. Consequently every root action requires slot 0 plus either
coadmin; slots 1 and 2 cannot act together without slot 0. The root Safe is the
immutable payout address and sole proposer, canceller, and executor of the
self-administered 24-hour timelock. `GOVERNANCE_ADDRESS` is always the
timelock and `ROOT_SAFE_ADDRESS` is always the root Safe.

The same deployment installs a distinct immutable guard on every Safe and a
recovery module on the Owner Identity Safe. The guards block direct owner,
threshold, module, fallback, and guard reconfiguration while permitting normal
calls and the official Safe `SignMessageLib`. Recovery requires initiation by
a separate secp256k1 guardian, approval by both coadmins, explicit acceptance by the replacement
owner, and a seven-day delay. A separate 48-byte BLS recovery public key is
committed in the immutable deployment evidence for the corresponding Chia
recovery runbook; neither guardian may reuse an administrator key.

The rail deployment creates a dedicated gateway and spoke, configures the
trusted spoke while the deployer is still owner, and starts two-step ownership
transfer to the timelock. It rejects old mainnet Warp coordinates and requires
the fresh 2-of-3 Samuel coordinate artifact.

Every deployment also requires `SOLSLOT_OMNICHAIN_SOURCE_SHA` to match a clean
checkout, `SOLSLOT_OMNICHAIN_CONFIRMATIONS` of at least 12 outside Hardhat,
and a new `SOLSLOT_OMNICHAIN_DEPLOYMENT_OUTPUT` path. The path is validated
before any transaction is sent. The script writes a
non-overwritable, owner-only JSON record containing the source SHA, chain and
token configuration, deployment receipts, ownership-handoff state, and runtime
code hashes. The coordinator must not enable an external-payment rail until
governance ownership is accepted and this evidence has been independently
reviewed. After the governance timelock accepts both contract transfers, run:

```bash
SOLSLOT_OMNICHAIN_DEPLOYMENT_EVIDENCE_PATH=/secure/omnichain/deployment.json \
SOLSLOT_OWNERSHIP_ACTIVATION_INTENT_OUTPUT=/secure/omnichain/ownership-intent.json \
npm run prepare:ownership -- --network baseSepolia
```

For each root transaction, have the Owner Identity Safe approve the exact root
Safe message through the official `SignMessageLib`, then have either coadmin do
the same through the Coadmin Safe. Submit both EIP-1271 contract signatures to
the 2-of-2 root Safe. Wait at least 86,400 seconds between the timelock schedule
and execution transactions; both transactions use the same child-Safe approval
flow.
Only after the operation is complete may activation evidence be produced:

```bash
SOLSLOT_OMNICHAIN_DEPLOYMENT_EVIDENCE_PATH=/secure/omnichain/deployment.json \
SOLSLOT_GOVERNANCE_EVIDENCE_PATH=/secure/omnichain/governance.json \
SOLSLOT_OWNERSHIP_ACTIVATION_INTENT_PATH=/secure/omnichain/ownership-intent.json \
SOLSLOT_OMNICHAIN_ACTIVATION_EVIDENCE_OUTPUT=/secure/omnichain/activation.json \
SOLSLOT_OMNICHAIN_GATEWAY_PROFILE=bse \
GOVERNANCE_ADDRESS=0x... \
ROOT_SAFE_ADDRESS=0x... \
npm run attest:activation -- --network baseSepolia
```

The activation attestation requires the recorded timelock operation to be done,
then re-reads the live `owner()` and runtime bytecode of
the gateway and spoke, binds both to the immutable deployment artifact, and
refuses pending or mismatched ownership. It is also non-overwritable.

RC19 authority evidence is intentionally breaking: governance uses schema v2,
while preflight, rail deployment, ownership intent, and activation use schemas
v3, v3, v2, and v3 respectively. Schema-v1 flat-Safe authority and schema-v2
rail deployment files are rejected. See
[`security/EVM_AUTHORITY.md`](security/EVM_AUTHORITY.md) for signing and
recovery procedures.

Run the read-only escrow event relayer as a separate service after activation:

```bash
SOLSLOT_OMNICHAIN_ACTIVATION_EVIDENCE_PATH=/secure/omnichain/activation.json \
SOLSLOT_ESCROW_CALLBACK_URL=https://staging.solslot.com/protocol/purchase-intents/escrow-webhook \
SOLSLOT_ESCROW_CALLBACK_TOKEN=... \
SOLSLOT_ESCROW_RELAYER_STATE_PATH=/var/lib/solslot/escrow-relayer.json \
SOLSLOT_ESCROW_START_BLOCK=... \
SOLSLOT_ESCROW_CONFIRMATIONS=12 \
npm run relay:escrow -- --network baseSepolia
```

The relayer has no signer and never settles funds. It verifies the RPC chain,
activation-bound spoke bytecode, and at least 12 confirmations; reads the full
deposit struct for each `PaymentDeposited` log; submits the exact ten-word
message and block provenance to the authenticated backend callback; and then
advances an owner-only local checkpoint. A failed callback leaves the block
uncheckpointed for an idempotent retry. The callback token is a backend secret
and must not enter a browser bundle or shell history.

Before accepting a testnet rail, produce a non-overwritable settlement rehearsal
receipt for each terminal path. This command is read-only: it neither creates a
purchase nor signs, relays, or settles a transaction. It verifies a confirmed
`PaymentDeposited` transaction against the activation evidence and the exact
canonical `purchaseArtifactV2`, then requires the on-chain deposit to have
reached either `SettledSuccess` or `SettledRefund`.

```bash
SOLSLOT_OMNICHAIN_ACTIVATION_EVIDENCE_PATH=/secure/omnichain/activation.json \
SOLSLOT_REHEARSAL_PURCHASE_ARTIFACT_PATH=/secure/omnichain/purchase-artifact.json \
SOLSLOT_REHEARSAL_DEPOSIT_TX_HASH=0x... \
SOLSLOT_REHEARSAL_EXPECTED_OUTCOME=success \
SOLSLOT_REHEARSAL_CONFIRMATIONS=12 \
SOLSLOT_REHEARSAL_OUTPUT=/secure/omnichain/rehearsal-success.json \
npm run rehearse:escrow -- --network baseSepolia
```

Run it once with `success` and once with `refund`, using separate output paths.
The purchase artifact and output are owner-only local files; the command rejects
symlinks, oversized inputs, stale/mismatched runtime code, unconfirmed receipts,
multiple deposit events, non-terminal outcomes, and any payment field or token
that differs from the canonical artifact.

Deploy Base gateway/spoke first, configure every spoke allowlist in both directions, run testnet end-to-end payments, and only then deploy the disabled Ethereum failover gateway. Existing payments never change hubs.

## Security

- CCIP callbacks require the official router plus the exact source selector and allowlisted sender.
- Warp results require the exact portal, `xch` source, Samuel return puzzle, unused nonce, global payment ID, exact amount, and boolean result.
- Settlement is one-way and idempotent. Partial payouts and arbitrary administrator recipients are removed.
- Emergency resolution has a minimum seven-day delay and can refund only the original depositor.
- Hub native-fee spending is capped per message, and fee shortages leave retryable queued state.
- Contracts are non-upgradeable and versioned.

Review `security/THREAT_MODEL.md`, `security/INVARIANTS.md`, `security/DEPLOYMENT_RUNBOOK.md`, and `security/AUDIT_SCOPE.md`. An independent external audit is mandatory before accepting mainnet value.

`NftRedemption.sol` remains an independent legacy attestation-redemption contract and is not part of the CCIP payment path.

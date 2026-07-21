# SolSlot CCIP-to-Warp Omnichain

SolSlot keeps settlement tokens on each origin chain while Chainlink CCIP carries payment messages to a Base Warp gateway, preserving the existing Warp → Samuel → KoS → Warp result path.

## Architecture

- `OmnichainEscrowSpoke` is deployed once per enabled EVM network. It accepts only its immutable six-decimal USDC and USDT contracts, records the selected token per deposit, authenticates the result, and pays or refunds that exact token.
- `SolomonWarpGateway` is deployed on Base and Ethereum. Base is primary; Ethereum remains disabled until a controlled failover. Gateway callbacks queue work, while separate permissionless calls pay Warp/CCIP fees and retry forwarding.
- Protocol V2 derives a globally unique payment ID from protocol version, origin selector, origin spoke, settlement-token address, and local payment ID.
- The Samuel/KoS request is ten words: `[globalPaymentId, purchaseId, artifactHash, amount, quantity, collectionId, deedLauncherId, vaultLauncherId, destinationPuzzle, quoteExpiresAt]`. Samuel verifies every word against the coordinator's persisted purchase artifact before asking KoS to reserve or deliver a deed. The Warp result remains `[globalPaymentId, amount, passFail]`.
- CCIP transfers no tokens. USDC or USDT remains on the origin spoke throughout processing.

## V1 networks

Ethereum, Base, Polygon, Optimism, Avalanche, and Robinhood Chain are represented in `config/networks.json`. Robinhood remains disabled until reviewed six-decimal USDC and USDT contracts and a deployed spoke are configured. Aztec and Tron are not supported in V1.

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
npm run deploy -- --network baseSepolia
npm run configure:gateway -- --network baseSepolia
```

The deployment script rejects missing/placeholder addresses, verifies RPC chain identity and router bytecode, and starts two-step ownership transfer to `GOVERNANCE_ADDRESS`. Governance must be an audited timelock controlled by a multisig and must accept ownership before operations begin.

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
SOLSLOT_OMNICHAIN_ACTIVATION_EVIDENCE_OUTPUT=/secure/omnichain/activation.json \
SOLSLOT_OMNICHAIN_GATEWAY_PROFILE=bse \
GOVERNANCE_ADDRESS=0x... \
npm run attest:activation -- --network baseSepolia
```

The activation attestation re-reads the live `owner()` and runtime bytecode of
the gateway and spoke, binds both to the immutable deployment artifact, and
refuses pending or mismatched ownership. It is also non-overwritable.

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

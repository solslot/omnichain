# External Audit Scope

## In scope

- `contracts/OmnichainEscrowSpoke.sol`
- `contracts/SolomonWarpGateway.sol`
- `contracts/libraries/OmnichainMessageCodec.sol`
- `contracts/interfaces/`
- Deployment/configuration scripts and pinned network metadata
- Samuel gateway-profile, global-ID, reconciliation, and Warp-return changes
- SolSlot omnichain purchase and network-registry services

## Review priorities

- Cross-bridge authentication and composed CCIP/Warp trust assumptions
- Replay domains, canonical serialization, global payment uniqueness, and ordering
- Token conservation, token behavior assumptions, terminal settlement, and emergency refunds
- Callback gas, fee caps, fee depletion, queued retries, and failed CCIP execution
- Governance, pause behavior, route changes, Base/Ethereum failover, and deployer revocation
- Samuel validator/KoS idempotency, finality handling, database migration, and secret handling

## Excluded

- Chainlink CCIP and Warp protocol internals
- Chia consensus and unchanged legacy portal puzzles
- KoS internals
- Aztec, Tron, token bridging, swaps, active/active hubs, and proxy upgrades

## Required evidence

- Exact source commit and lockfiles
- Deployed bytecode/constructor/configuration manifests
- Unit, coverage, static, fuzz/invariant, fork, and testnet E2E reports
- Threat model, invariants, privilege matrix, and incident runbook
- Previous findings and remediation diffs

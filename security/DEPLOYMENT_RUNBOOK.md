# Deployment and Incident Runbook

## Release gates

1. Pin the source commit, dependency lockfile, compiler, optimizer, and network metadata.
2. Pass compilation, unit tests, coverage, static analysis, dependency review, fork configuration checks, and Samuel/frontend builds.
3. Resolve all internal critical/high findings and document every accepted medium finding.
4. Complete an independent external audit before accepting mainnet value.
5. Verify each contract source and constructor argument on its explorer.

## Deployment order

1. Deploy Base gateway paused, then Base spoke paused.
2. Deploy each satellite spoke paused and configure its Base gateway route.
3. Allowlist every spoke selector/address on Base and verify both directions against official CCIP metadata.
4. Deploy Ethereum gateway and spoke paused; keep the Ethereum gateway unavailable to normal routing.
5. Transfer ownership to the audited timelock, accept ownership from the timelock, and remove deployer access.
6. Fund gateway native-fee treasury with canary limits and alert thresholds.
7. Run one end-to-end testnet payment per chain before enabling deposits.
8. Enable Base canary first, then Polygon, Optimism, Avalanche, Robinhood, and Ethereum-origin traffic with value caps.

## Failover

1. Pause new deposits on affected spokes; never reroute existing deposits.
2. Reconcile all Base in-flight global IDs and preserve Base treasury funds.
3. Verify Ethereum Warp, Samuel, KoS, CCIP lanes, fee caps, allowlists, and treasury.
4. Queue a timelocked `setHubRoute` operation for future deposits only.
5. Execute a canary payment through Ethereum before reopening capped traffic.
6. Fail back using the same process; do not disable processing of old Ethereum requests.

## Stuck payment

1. Identify the last confirmed state from spoke, CCIP explorer, gateway, Warp watcher, Chia, Samuel DB, and KoS.
2. Retry only the next idempotent forwarding operation. Do not create a second payment ID or switch hubs.
3. If CCIP execution failed, use Chainlink manual execution with the original message ID.
4. Schedule emergency refund only after KoS fulfillment is halted and the incident owner confirms no successful result can be accepted.
5. Wait the contract delay, execute the refund to the original depositor, and retain the full incident record.

## Key compromise

1. Pause affected gateways and spokes immediately.
2. Rotate Samuel hot keys and validator configuration using the existing Chia/Warp governance process.
3. Rotate EVM governance through the timelock/multisig recovery process.
4. Reconcile all pending messages before unpausing; never change in-flight payment routing.

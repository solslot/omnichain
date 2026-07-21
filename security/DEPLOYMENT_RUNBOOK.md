# Deployment and Incident Runbook

## Release gates

1. Pin the source commit, dependency lockfile, compiler, optimizer, and network metadata.
2. Pass compilation, unit tests, coverage, static analysis, dependency review, fork configuration checks, and Samuel/frontend builds.
3. Resolve all internal critical/high findings and document every accepted medium finding.
4. Complete an independent external audit before accepting mainnet value.
5. Verify each contract source and constructor argument on its explorer.

## Deployment order

1. Export and independently compare the three Safe owners against the latest
   completed genesis enrollment; require threshold 2 and no duplicates.
2. Generate three dedicated Samuel identities on the validator hosts and launch
   a fresh 2-of-3 Testnet11 portal plus a dedicated Base Sepolia portal.
3. Deploy the 2-of-3 Safe and self-administered 86,400-second timelock. Verify
   live owners, threshold, roles, bytecode, and immutable Safe payout binding.
4. Produce the read-only schema-v2 preflight for the exact source SHA, Circle
   Base Sepolia USDC, fresh Samuel coordinates, Safe, and timelock.
5. Deploy the dedicated Base Sepolia gateway and USDC-only spoke, configure the
   trusted spoke, then nominate the timelock as pending owner of both.
6. Submit the generated ownership schedule through the Safe, wait at least 24
   hours, execute through the Safe, and attest accepted ownership on chain.
7. Fund the gateway fee treasury with canary limits and run one complete
   zkPassport-bound purchase plus the required refund rehearsal.
8. Enable the coordinator rail only after all evidence hashes match. Every
   non-Base-Sepolia rail and all production rails remain disabled.

## Failover

Alpha has no pre-approved cross-chain failover route. Pause new purchases,
reconcile every in-flight global payment ID, and keep processing the original
Base Sepolia route. A replacement route requires its own design review,
deployment evidence, and rehearsal; never reroute an existing deposit.

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

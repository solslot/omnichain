# Deployment and Incident Runbook

## Release gates

1. Pin the source commit, dependency lockfile, compiler, optimizer, and network metadata.
2. Pass compilation, unit tests, coverage, static analysis, dependency review, fork configuration checks, and Samuel/frontend builds.
3. Resolve all internal critical/high findings and document every accepted medium finding.
4. Complete an independent external audit before accepting mainnet value.
5. Verify each contract source and constructor argument on its explorer.

## Deployment order

1. Export and independently compare the three administrator EOAs against the
   latest completed genesis enrollment. Require slot 0 as the sole Owner
   Identity Safe owner, slots 1 and 2 as the two Coadmin Safe owners, no
   duplicates, child thresholds 1, and a root threshold of 2 over exactly the
   two child Safe addresses.
2. Generate three dedicated Samuel identities on the validator hosts. Launch
   the fresh 2-of-3 Testnet11 portal, then run `npm run
   build:warp-artifacts` against Warp commit
   `425a69650ccdf0b28e9f4fccb91d736b05b20512`. Deploy the dedicated Base
   Sepolia portal with `npm run deploy:warp-portal -- --network baseSepolia`.
   Require the same three validator EVM addresses, threshold 2, atomic proxy
   initialization, zero testnet toll, `xch` support, Safe ownership of both the
   Portal and ProxyAdmin, and twelve confirmed blocks.
3. Deploy the slot-0 Owner Identity Safe, 1-of-2 Coadmin Safe, 2-of-2 root Safe,
   guarded recovery module, and self-administered 86,400-second timelock. Verify
   live owners, thresholds, guard/module/fallback state, roles, bytecode,
   guardian separation, and immutable root-Safe payout binding.
4. Export fresh schema-v3 Samuel coordinates using the confirmed Base portal
   and the gateway address predicted from the deployer's then-current nonce.
   Produce the read-only schema-v5 Omnichain preflight for the exact source
   SHA, Circle Base Sepolia USDC, fresh Samuel coordinates, hash-sealed Warp
   portal deployment, root Safe, and timelock.
5. Deploy the dedicated Base Sepolia gateway and USDC-only spoke, configure the
   trusted spoke, then nominate the timelock as pending owner of both.
6. Approve the generated ownership schedule through both child Safes, submit it
   through the root Safe, wait at least 24 hours, repeat for execution, and
   attest accepted ownership on chain.
7. Fund the gateway fee treasury with canary limits and run one complete
   zkPassport-bound purchase plus the required refund rehearsal.
8. Enable the coordinator rail only after all evidence hashes match. Every
   non-Base-Sepolia rail and all production rails remain disabled.

The three guards intentionally freeze each Safe's owner graph. Rotating either
coadmin therefore requires a fresh reviewed governance deployment and evidence
set; it is not an emergency in-place mutation. Slot-0 replacement is the only
in-place rotation path and must use the seven-day recovery flow below.

The tracked npm lockfile must contain no path outside this repository. The
runtime dependency audit (`npm audit --omit=dev`) must be clean. The full
development-tool audit currently includes upstream Hardhat 2 and Chainlink CCIP
tooling advisories; those tools must run only in an isolated trusted release
environment with reviewed inputs. Their breaking Hardhat 3/CCIP 2 migration is
a release-engineering gate and must be completed or explicitly dispositioned
before mainnet value is accepted.

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
3. For a compromised slot-0 key, have the separate secp256k1 guardian initiate
   recovery, have both coadmins approve, have the replacement key accept, wait
   seven days, and execute the recovery module. Do not use a root Safe or
   timelock action to bypass this sequence.
4. Reconcile all pending messages before unpausing; never change in-flight payment routing.

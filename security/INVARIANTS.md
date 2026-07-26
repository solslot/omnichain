# Contract Invariants

## `OmnichainEscrowSpoke`

- `status == None` implies no token amount is assigned to the global payment ID.
- `RequestSent` deposits hold exactly their recorded amount of the immutable USDC contract unless that token contract itself is compromised.
- USDC balances are conserved; settlement and refund always transfer the configured USDC token.
- `ResultReceived` requires the result origin, spoke, global ID, amount, and nonzero Warp nonce to match the deposit.
- `SettledSuccess`, `SettledRefund`, and `EmergencyRefund` are mutually exclusive terminal states.
- A terminal state cannot transition again.
- Success recipient is always immutable `payoutAddress`; refund recipient is always immutable `depositor`.
- `hubChainSelector` and `hubGateway` stored on a deposit never change.

## `SolomonWarpGateway`

- `Queued` requests have a valid canonical global ID and an allowlisted selector/spoke pair.
- `WarpSent` can only follow `Queued` and emits exactly ten protocol V2 payload words.
- `ResultQueued` can only follow one authenticated Warp result with an unused `(sourceChain, nonce)` pair.
- `ResultSent` can only follow `ResultQueued` and targets the request's original selector and spoke.
- The gateway never holds or transfers settlement tokens.

## Cross-component

- For every payment, the Warp payload amount equals the spoke escrow amount in six-decimal units and the Warp result must repeat that exact amount.
- The request's purchase ID, artifact hash, collection, deed, vault, destination puzzle, quantity, and expiry must equal the coordinator's persisted canonical purchase artifact before KoS is invoked.
- Global payment IDs are domain-separated by origin selector, origin spoke, settlement-token address, and local payment ID.
- Base/Ethereum failover changes cannot affect an existing request because routing is embedded in the request and deposit.
- CCIP message arrays contain zero token transfers in both directions.

## EVM authority

- The Owner Identity Safe has exactly slot 0 as its sole owner and threshold 1.
- The Coadmin Safe has exactly slots 1 and 2 as owners and threshold 1.
- The root Safe has exactly the two child Safes as owners and threshold 2.
- Only the root Safe has proposer, executor, and canceller roles on the 86,400-second self-administered timelock.
- Operational contracts are owned by the timelock; the immutable payout address is the root Safe.
- All three Safes always have distinct reviewed guards and the official compatibility fallback handler installed; only the Owner Identity Safe has the reviewed recovery module.
- Owner recovery cannot execute without guardian initiation, both coadmin approvals, replacement acceptance, unchanged Safe state, and 604,800 elapsed seconds.
- Schema-v1 flat-Safe governance evidence and pre-RC19 rail evidence never authorize an API payment rail.

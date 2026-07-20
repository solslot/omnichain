# Contract Invariants

## `OmnichainEscrowSpoke`

- `status == None` implies no token amount is assigned to the global payment ID.
- `RequestSent` deposits hold exactly their recorded amount of the recorded immutable USDC or USDT contract unless that token contract itself is compromised.
- USDC and USDT balances are conserved independently; settlement and refund always transfer the deposit's recorded token.
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

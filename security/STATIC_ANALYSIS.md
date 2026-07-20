# Static Analysis Review

Slither 0.11.5 reports three high-confidence heuristic findings in the new contracts after filtering legacy and dependency code.

## Reviewed findings

### `reentrancy-balance` in `OmnichainEscrowSpoke.depositPayment`

The function reads the token balance, executes `safeTransferFrom`, and reads the balance again to reject fee-on-transfer or rebasing behavior. This is an intentional exact-receipt check. The entire entry point is protected by `nonReentrant`; all escrow identity, route, amount, and status effects are committed before the transfer, and any failed delta check reverts the transaction atomically.

### `reentrancy-eth` in `OmnichainEscrowSpoke.depositPayment`

Slither identifies `requestMessageId` assignment after the router/local-gateway call and the optional fee-refund call. The entry point and both result callback paths are protected by the same `ReentrancyGuard`. The deposit is already in `RequestSent` before external interaction, so duplicate admission fails. The post-call field only records the transport-generated identifier and does not control value release.

### `reentrancy-eth` in `SolomonWarpGateway.forwardResult`

Slither identifies `outboundMessageId` assignment after the router/local-spoke call. `forwardResult` is `nonReentrant` and changes status to `ResultSent` before the call. A duplicate or callback reentry therefore cannot forward again. The post-call field is correlation metadata only.

### `timestamp`

The seven-day emergency-refund delay intentionally compares `block.timestamp` to a scheduled deadline; miner timestamp latitude is immaterial at that duration. Slither also associates a status-enum comparison with this detector even though it does not depend on timestamp.

### `low-level-calls`

Native fee overpayment refunds and governance treasury withdrawals use checked Solidity `call` because `transfer` has a brittle fixed gas stipend. Both paths revert on failure and are protected by `nonReentrant`.

## Gate

`npm run security:slither` runs every other Slither detector against the new contracts and fails on unsuppressed findings. The four detector classes above are excluded only after this explicit manual review. Re-run the full unfiltered command during external audit and whenever callback/state ordering changes.

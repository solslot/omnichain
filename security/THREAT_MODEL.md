# SolSlot Omnichain Threat Model

## Assets and trust boundaries

- Origin-chain settlement tokens remain in `OmnichainEscrowSpoke` until one exact terminal result is accepted and settled.
- Chainlink CCIP authenticates transport, but contracts independently authenticate the router, source selector, and source contract.
- Warp authenticates transport between Base/Ethereum and Chia; `SolomonWarpGateway` independently authenticates the portal, `xch` source, Samuel return puzzle, and nonce.
- Samuel validator threshold and KoS are external trust domains. The request is a ten-word protocol V2 message bound to the coordinator's canonical purchase artifact; the response remains the three-word `[globalPaymentId, amount, passFail]` result.
- Owners must be external audited timelocks controlled by multisigs. Deployer ownership is temporary only.

## Security invariants

1. A global payment ID is domain-separated by protocol version, origin selector, origin spoke, settlement-token address, and local payment ID.
2. One global payment can be admitted once, select one immutable hub, accept one Warp result, and settle once.
3. Successful payouts plus refunds cannot exceed exact token inflows.
4. Settlement requires the returned amount to equal the recorded amount; partial settlement is forbidden.
5. Success always pays the immutable protocol payout. Failure and emergency resolution always pay the original depositor.
6. CCIP token arrays must be empty; protocol V2 never moves USDC or USDT cross-chain.
7. Duplicate, malformed, out-of-order, wrong-selector, wrong-sender, wrong-puzzle, wrong-portal, and replayed-nonce messages cannot advance state.
8. Fee depletion and forwarding failure leave queued state available for retry without changing escrow ownership.
9. Route changes apply only to deposits created after the change; each deposit stores its selected selector and gateway.

## Adversaries and mitigations

| Threat | Mitigation |
| --- | --- |
| Forged CCIP callback | `CCIPReceiver.onlyRouter`, source selector check, ABI-decoded sender allowlist, canonical codec validation |
| Forged Warp result | Exact portal, chain, return puzzle, nonce, payment, amount, and pass/fail checks |
| Cross-chain payment collision | Domain-separated `globalPaymentId` |
| Replay or duplicate delivery | Message ID, Warp nonce, global ID, and monotonic status guards |
| Reentrancy or malicious token | Immutable USDC/USDT allowlist, six-decimal constructor validation, `ReentrancyGuard`, `SafeERC20`, checks-effects-interactions, and exact balance delta |
| Fee griefing | User-paid outbound quote, per-message hub caps, queue/forward split |
| Arbitrary administrator payout | No arbitrary recipient function; emergency path is delayed and refund-only |
| Compromised route administrator | External timelock/multisig, immutable per-payment route, pause and monitored events |
| Base outage | Governance switches only future deposits to the pre-audited Ethereum gateway; in-flight Base payments remain on Base |
| Duplicate failover delivery | No active/active route and no in-flight rerouting |
| KoS retry duplication or deed substitution | Samuel verifies the ten-word message against the coordinator, persists checkout/succeeded flags and the global payment ID, and signs a domain-separated KoS fulfillment containing the purchase, artifact, deed, vault, and destination; KoS bindings are idempotent and immutable |
| Bridge delay after emergency refund | Spoke terminal emergency status rejects later settlement; operations must halt KoS before executing emergency refund |

## Residual risks

- CCIP, Warp, Chia validators, Samuel keys, KoS, RPC providers, stablecoins, and chain finality remain external dependencies.
- Emergency refunds can conflict with irreversible off-chain fulfillment. They require a seven-day minimum delay and an incident runbook; production governance should use a longer audited delay.
- Robinhood Chain must remain disabled until independently reviewed six-decimal USDC and USDT contracts and a deployed spoke are available.
- Ethereum failover remains disabled until its Warp portal lane, Samuel profile, and full drill are independently verified.

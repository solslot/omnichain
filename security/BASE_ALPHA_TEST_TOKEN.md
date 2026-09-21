# Base mainnet alpha payment token

The selected alpha payment asset is `Solslot Alpha Test Token` (`TEST-SOLS`),
a six-decimal, valueless ERC20. It is distinct from SGT and from Circle USDC.
It has no backing, redemption promise, governance rights or monetary value.
Chia assets remain on Testnet11. Base transactions consume real ETH.

The constructor gives the deploying operator 10,000,000 test tokens. Anyone
can call `claim()` for 1,000,000 test tokens every 24 hours per address. This
is a convenience cooldown, not an identity or scarcity control. There is no
owner, upgrade mechanism, token sale, or native ETH payment entry point.

Six decimals preserve integer accounting in the escrow contract; the alpha
UI must label amounts as test tokens and any dollar amounts as simulated.
The `usdcToken` getter on the existing escrow contract is a historical ABI
name. It identifies the constructor-pinned token, not a certification that
the token is USDC. The deployment must explicitly select and prove the
test-token profile; it must never fall back to mainnet USDC.

## Exact deployment

1. Compile and test the clean pinned checkout. `prepare-test-token.js` requires
   its exact `SOLSLOT_OMNICHAIN_SOURCE_SHA`. It only reads public RPCs and
   creates new plan/inspection files; it never opens a keystore.
2. Supply two independent Base mainnet RPC hosts, the operator address,
   ActionEnvelope ID, fixed gas and EIP-1559 fee limits, and an L1 fee budget.
   Both RPCs must agree on a common block, chain 8453, nonce, vacant CREATE
   address, adequate balance and gas estimate. The plan pins constructor data,
   compiled init/runtime hashes, recipient, token metadata and predicted address.
3. Pin the canonical plan file's SHA-256 independently. Execute with the
   local `deploy-test-token-from-keystore.sh` wrapper. The passphrase is read
   silently into an unlinked owner-only tmpfs descriptor. Never paste it in chat
   or put it in an environment variable. The encrypted key is not changed.
4. A private journal saves the signed bytes before broadcasting. Run the same
   wrapper to reconcile a pending or mined transaction without unlocking again.
   The runner requires 12 confirmations and checks canonical receipts, exact
   transaction fields and deployed runtime against both RPCs. It does not wait
   indefinitely or automatically replace transactions.
5. If neither RPC can find a previously signed transaction, reconcile the
   original transaction hash and nonce. Only `SOLSLOT_TEST_TOKEN_RESUBMIT_ORIGINAL=true`
   permits retransmission of the identical saved bytes. Never delete a journal
   or crash lock to reuse the nonce. A token deployment is irreversible; rollback
   means not activating that address in the release, not removing chain history.

The execution fee cap is `gasLimit * maxFeePerGas`. Base's L1 fee is separate;
`getL1FeeUpperBound` is checked against the plan's L1 budget immediately before
signing and sending. That budget is not an onchain hard cap on future L1 fees.
See [Base network fees](https://docs.base.org/specifications/transactions/network-fees).
The ERC20 uses the repository's pinned OpenZeppelin 4.9.6 implementation and
an explicit decimals override, following its [ERC20 documentation](https://docs.openzeppelin.com/contracts/4.x/erc20).

## Release boundary

The token is independently deployable and carries no enrollment release
identity. Its deployment does **not** activate payments or prove a working
Base-mainnet-to-Chia-Testnet11 route. Existing signed releases, inventory
modules and Base Sepolia voucher commitments keep their meanings. The new
payment profile must bind the confirmed token address/runtime, new consensus
module identities and the selected validator route before live payment writes
can be enabled. SGT issuance and the owner-including two-of-three policy are
unchanged by this token.

Validation covers faucet boundaries, ERC20 spending, Base-local escrow payout
and refund with mocked Warp results, rejection of other tokens, and the exact
deployment/recovery logic. The local escrow tests do not constitute a live
cross-chain proof.

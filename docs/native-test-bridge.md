# Native bridge contract candidates

Local preparation under `AE-SOLSLOT-NATIVE-BRIDGE-PREP-20260924-98` for SOLSLOT.
Neither contract has been deployed or activated by this work.

`SolslotTestAssetBridge` escrows only the exact TEST-USDC and TEST-USDT runtimes
and fixture identities. It starts paused. All token, portal, Chia minter/burner,
launcher, amount-limit and toll-limit bindings are immutable constructor values.
There is no first-initializer window, arbitrary token route or escrow rescue.
Governance can pause and resume both directions but cannot change asset IDs.

One CAT mojo corresponds to 1,000 ERC20 units (three versus six decimals).
Deposits transfer the exact quantity and emit a three-word authenticated message.
Releases require the portal, correct Chia burner, exact three-word contents,
canonical address padding, nonzero receiver/amount and an unused burn nonce.
Each asset has its own outstanding-liability counter. Donations do not increase
that counter. Actual balance deltas must match every transfer. Pausing also stops
releases; operational recovery must explicitly reconcile users' pending funds.

`SolslotTestSols` is the separate Base representation of the native Chia SOLS CAT.
It is not the existing TEST-SOLS checkout fixture. Its name/symbol clearly mark
it as a valueless wrapped test asset (`TEST-wSOLS`); native SOLS remains SOLS.
It has no faucet or administrator mint. Authenticated Chia locks mint exactly
one unit per CAT mojo; burning those units emits the two-word release message.
The native CAT, launcher, locker/unlocker, transfer/supply cap and toll cap are
constructor-bound. Three decimals match native SOLS. Nonces prevent replay,
portal failure rolls the burn back, and emergency pause also stops transfers.

Use a reviewed CREATE nonce to predict the contract address, derive the Chia
puzzles with that exact address, then include those hashes in the constructor
plan. Never deploy before the native asset identity and portal graph are bound.
The stablecoin graph determines the wrapped TEST-USDC CAT accepted for SGT
sales. The native SOLS counterpart can only be finalized after the new genesis
establishes its native SOLS CAT ID.

Deployment preparation still needs canonical portal/authority receipts, exact
reviewed caps, both-chain worker integration, independent security review and
hosted round trips. Passing local tests is not activation approval. Keep routes
closed until the complete release graph and acceptance receipts agree.

# RC19 EVM Authority

## Authority graph

The Base Sepolia alpha uses three canonical Safe 1.4.1 accounts:

1. `Owner Identity Safe`: one owner, ceremony slot 0, threshold 1.
2. `Coadmin Safe`: ceremony slots 1 and 2, threshold 1.
3. `Root Safe`: the two child Safe addresses, threshold 2.

The root Safe is the payout treasury and the only proposer, executor, and
canceller on `SolslotAlphaTimelock`. The timelock is self-administered, has an
86,400-second minimum delay, and owns the gateway and escrow spoke. This graph
implements `slot0 AND (slot1 OR slot2)` without trusting an API role or an
off-chain convention.

## Normal operation

For one root transaction:

1. Produce the exact root Safe transaction and hash from reviewed release evidence.
2. Slot 0 records approval of that hash through the Owner Identity Safe using the official Safe `SignMessageLib`.
3. Slot 1 or slot 2 records approval through the Coadmin Safe.
4. Assemble the two EIP-1271 contract signatures and submit the root transaction.
5. For a timelocked operation, repeat the child approvals once for `schedule` and again after 86,400 seconds for `execute`.

Never replace a child-Safe contract signature with an EOA signature. The root
Safe owners are the child Safe addresses, not the three administrator EOAs.
Every submitted transaction must be checked against the evidence artifact hash,
network, chain ID, target, value, calldata, nonce, and expiry used by the
coordinator.

## Safe guards

Each Safe has its own immutable `SolslotAuthorityGuard`. The guard permits
ordinary calls and only one delegatecall:
the official `signMessage(bytes)` entry point at the evidence-bound
`SignMessageLib`. It blocks owner changes, threshold changes, module changes,
guard changes, fallback changes, singleton changes, setup replay, and arbitrary
delegatecalls. This prevents a coadmin from rewriting the Coadmin Safe and
prevents the root Safe from replacing either child Safe outside the fixed
authority graph. `SolslotOwnerIdentitySetup` installs each guard, plus the
owner recovery module where applicable, during the Safe initializer so there
is no usable unguarded authority window.

## Recovery

`SolslotOwnerRecovery` is an immutable Safe module. Recovery is valid only when:

- the dedicated secp256k1 guardian initiates one exact replacement;
- slot 1 and slot 2 each approve that recovery ID;
- the replacement address accepts that recovery ID;
- the Owner Identity Safe still has exactly the recorded old owner and threshold 1;
- the recovery module remains enabled; and
- at least 604,800 seconds have elapsed.

The guardian may cancel a pending request but cannot approve or execute one.
The old owner cannot cancel recovery. The replacement cannot be an existing
administrator, guardian, or Safe address. A separate BLS guardian public-key
commitment is carried in deployment evidence for Chia-side recovery; its secret
must never be colocated with the secp256k1 guardian or administrator keys.

The guard freezes the Coadmin Safe owner set. Replacing slot 1 or slot 2 is a
new authority deployment with fresh evidence, not an in-place admin operation.
Only the slot-0 Owner Identity Safe has the guarded recovery module described
above.

## Evidence versions

- Governance deployment: schema v2.
- Omnichain preflight: schema v3.
- Omnichain deployment: schema v3.
- Ownership activation intent: schema v2.
- Activation attestation: schema v3.

The coordinator verifies canonical artifact hashes and cross-links every file.
Legacy flat 2-of-3 Safe evidence is unsupported. A fresh RC19 deployment is
required; no RC17/RC18 ownership coordinate may be reused.

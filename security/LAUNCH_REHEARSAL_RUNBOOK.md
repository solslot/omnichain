# RC27 Stripe Voucher Rehearsal

## Purpose

The launch wizard observes the real Stripe test-mode voucher workflow after
genesis. It does not create a separate payment or ask an administrator to sign
an EVM transaction.

The check requires two distinct customer journeys through the normal UI:

1. A succeeded Stripe test payment issues a voucher and delivers the governed
   SmartDeed to the configured zkPassport-approved Testnet11 vault.
2. A second succeeded Stripe test payment issues a different voucher. The
   holder cancels it before delivery, the exact terminal spend confirms, and
   Stripe returns the full collected amount.

The evidence is accepted only when it includes the canonical purchase and
settlement receipt, both validator quorums, voucher confirmation, the immutable
Key of Solomon bundle, a bounded non-zero medium-speed fee from the fee till,
mempool observation, confirmed output coin IDs, and the completed exact refund.

## Administrator Workflow

Complete these steps in the admin UI:

1. Finish genesis and lock the signed public artifact.
2. Publish a small governed test collection with at least two deeds.
3. Approve one test vault with zkPassport.
4. Open **Payment Check** and start the check.
5. In the normal customer flow, buy one deed with a Stripe test payment and
   wait until **Delivered** appears.
6. Buy a second deed with a separate Stripe test payment, request cancellation,
   and wait until **Refunded** appears.
7. Return to **Payment Check**. It seals the proof automatically.

Never paste a PaymentIntent, transaction hash, voucher ID, destination, price,
or chain output into the launch wizard. Those values are reconstructed from the
production records and Testnet11.

## Fixed Configuration

The write-once RC27 payload has this shape:

```json
{
  "schemaVersion": 3,
  "kind": "solslot-rc27-stripe-voucher-rehearsal-config",
  "releaseTag": "solslot-v2-alpha-rc27-YYYYMMDD",
  "releaseEvidenceHash": "0x...",
  "network": "testnet11",
  "candidatesApiUrl": "https://solslot.com/protocol-api/presales/stripe-rehearsal/candidates",
  "approvedVaultLauncherId": "0x...",
  "collectionId": "0x...",
  "stripe": {
    "accountId": "acct_...",
    "mode": "test",
    "livemode": false,
    "apiVersion": "2026-02-25.clover"
  },
  "validatorThreshold": 2,
  "validators": [
    { "id": "validator-0" },
    { "id": "validator-1" },
    { "id": "validator-2" }
  ]
}
```

Generate the envelope once:

```bash
npm run prepare:launch-rehearsal -- payload.json rehearsal-config.json
```

The configured vault and collection are the only records the coordinator will
observe. Regenerate the envelope if the release, validator roster, Stripe test
account, collection, or approved test vault changes.

## Service Configuration

Create three root-readable files with mode `0600`:

- launch-rehearsal service bearer token
- evidence HMAC secret
- API service token matching `SOLSLOT_PROTOCOL_ARTIFACT_API_TOKEN`

The loopback service requires:

```text
SOLSLOT_LAUNCH_REHEARSAL_CONFIG_PATH=/etc/solslot/evidence/rehearsal-config.json
SOLSLOT_LAUNCH_REHEARSAL_TOKEN_FILE=/etc/solslot/secrets/rehearsal-token
SOLSLOT_LAUNCH_REHEARSAL_HMAC_FILE=/etc/solslot/secrets/rehearsal-hmac
SOLSLOT_LAUNCH_REHEARSAL_API_TOKEN_FILE=/etc/solslot/secrets/protocol-artifact-token
SOLSLOT_LAUNCH_REHEARSAL_STATE_DIR=/var/lib/solslot/rehearsal
SOLSLOT_LAUNCH_REHEARSAL_HOST=127.0.0.1
SOLSLOT_LAUNCH_REHEARSAL_PORT=8794
```

The API receives the same public config hash and HMAC secret:

```text
SOLSLOT_LAUNCH_REHEARSAL_SERVICE_URL=http://127.0.0.1:8794
SOLSLOT_LAUNCH_REHEARSAL_SERVICE_TOKEN=...
SOLSLOT_LAUNCH_REHEARSAL_CONFIG_HASH=0x...
SOLSLOT_LAUNCH_REHEARSAL_EVIDENCE_HMAC_SECRET=...
SOLSLOT_LAUNCH_SETTLEMENT_REHEARSAL_PATH=/var/lib/solslot/api/rehearsal-evidence.json
```

The staging deployment environment pins
`SOLSLOT_REHEARSAL_NODE_BIN=/opt/solslot/runtime/node-v22.23.2/bin/node`,
`SOLSLOT_REHEARSAL_NODE_VERSION=v22.23.2`, and
`SOLSLOT_REHEARSAL_PORT=8794`. Deployment stops before changing the systemd
unit if the Node path is not absolute and executable, its version differs, or
the port is invalid. Port `8793` is reserved for Key of Solomon and is rejected
by the rehearsal deployment.

The service binds to loopback. Do not expose port `8794` publicly. Stripe,
validator, wallet, and faucet secrets remain in their existing server services;
the coordinator receives none of them.

## Failure Handling

- A payment alone never passes the check.
- A voucher without confirmed issuance never passes.
- A KoS dispatch without mempool observation and confirmed outputs never passes.
- A partial, live-mode, or differently identified Stripe refund never passes.
- Delivery and refund must use different purchases, PaymentIntents, and vouchers.
- Existing evidence files are write-once; changed bytes stop activation.

Use **Sales & Refunds** for deterministic retry or exact refund. Do not edit the
database, replace a transaction, or manufacture rehearsal evidence.

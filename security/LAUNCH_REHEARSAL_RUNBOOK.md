# RC22 Customer Payment Rehearsal

## Purpose

The launch wizard uses this loopback service after genesis to prove both Base
Sepolia outcomes before customer presale or purchase windows can open:

1. Faucet USDC produces the exact governed SmartDeed delivery.
2. A second faucet-USDC payment returns the exact principal to its depositor.

The coordinator does not price a property, choose a vault, mint a deed, or
decide an outcome. It accepts only coordinator-issued `PurchaseArtifactV2`
records and verifies the resulting EVM and Chia evidence.

## Operator Workflow

Complete these steps in the admin UI:

1. Finish genesis and lock the signed public artifact.
2. Publish a small governed canary collection with two test deeds.
3. Use an approved test vault. It must have a current zkPassport stamp.
4. Create one delivery artifact and one refund artifact from the collection
   desk. Each quote must remain valid for at least ten minutes.
5. Generate and activate the rehearsal configuration.
6. An enrolled coadministrator opens **Customer Payments** and follows the one
   action shown at a time.

The browser shows ordinary labels and amounts. Exact contract, deed, and vault
coordinates remain available under **Verify exact destination**.

## Administrator Safety

- Use only the enrolled administrator wallet assigned by the desk.
- Check that the wallet says **Base Sepolia** before every approval.
- The approval must equal the displayed faucet-USDC amount. Never approve an
  unlimited amount.
- Never type or share a recovery phrase, private key, Google recovery password,
  or Safe owner key in Solslot, email, chat, or a support ticket.
- Stop if the wallet target or amount differs from the decision receipt.
- A failed transaction is retried as the same fixed step. Do not improvise a
  replacement transaction.

## Service Files

Create three root-readable, mode `0600` files:

- service bearer token
- evidence HMAC secret
- coordinator API ingest token

The service environment requires:

```text
SOLSLOT_OMNICHAIN_ACTIVATION_EVIDENCE_PATH=/etc/solslot/evidence/activation.json
SOLSLOT_LAUNCH_REHEARSAL_CONFIG_PATH=/etc/solslot/evidence/rehearsal-config.json
SOLSLOT_LAUNCH_REHEARSAL_TOKEN_FILE=/etc/solslot/secrets/rehearsal-token
SOLSLOT_LAUNCH_REHEARSAL_HMAC_FILE=/etc/solslot/secrets/rehearsal-hmac
SOLSLOT_LAUNCH_REHEARSAL_API_TOKEN_FILE=/etc/solslot/secrets/omnichain-ingest-token
SOLSLOT_LAUNCH_REHEARSAL_RPC_URL=https://BASE_SEPOLIA_RPC
SOLSLOT_LAUNCH_REHEARSAL_STATE_DIR=/var/lib/solslot/rehearsal
SOLSLOT_LAUNCH_REHEARSAL_HOST=127.0.0.1
SOLSLOT_LAUNCH_REHEARSAL_PORT=8793
```

Terminate TLS in the existing authenticated reverse proxy. The API-facing URL
must be HTTPS. Do not expose port `8793` publicly.

The coordinator API must receive the same public config hash and HMAC secret:

```text
SOLSLOT_LAUNCH_REHEARSAL_SERVICE_URL=https://INTERNAL_HOST/launch-rehearsal
SOLSLOT_LAUNCH_REHEARSAL_SERVICE_TOKEN=...
SOLSLOT_LAUNCH_REHEARSAL_CONFIG_HASH=0x...
SOLSLOT_LAUNCH_REHEARSAL_EVIDENCE_HMAC_SECRET=...
SOLSLOT_LAUNCH_SETTLEMENT_REHEARSAL_PATH=/var/lib/solslot/api/rehearsal-evidence.json
```

Generate the write-once envelope:

```bash
npm run prepare:launch-rehearsal -- payload.json rehearsal-config.json
```

The payload is release-specific and post-genesis. Never reuse it after an
artifact expires, a roster changes, or the activation evidence changes.

## Rotation And Recovery

Administrator replacement is an on-chain roster update, not a database edit.
It must preserve the owner slot, increment authority version by exactly one,
bind signatures to the exact old and new roster, receive owner-plus-one
approval, and confirm on Testnet11 before the old key is considered removed.

Until the guided roster-replacement screen reports chain confirmation, the
existing roster remains authoritative. Server operators must not manually
rewrite administrator records to simulate a rotation.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { expect } = require("chai");

const { sha256, stableJson } = require("../scripts/lib/deployment-evidence");
const {
  CONFIG_KIND,
  EVIDENCE_KIND,
  LaunchRehearsalCoordinator,
  loadCoordinatorConfig,
} = require("../scripts/lib/launch-rehearsal-coordinator");

function hex(seed, bytes = 32) {
  return `0x${seed.toString(16).padStart(2, "0").repeat(bytes)}`;
}

function lane(seed, kind) {
  const refund = kind === "refund";
  const roles = refund
    ? { series: hex(seed + 20), terminalVoucher: hex(seed + 21), vault: hex(seed + 22) }
    : {
      coordination: hex(seed + 20),
      deed: hex(seed + 21),
      series: hex(seed + 22),
      terminalVoucher: hex(seed + 23),
    };
  const value = {
    stripeAccountId: "acct_testnet_alpha",
    livemode: false,
    success: true,
    purchaseId: hex(seed),
    artifactHash: hex(seed + 1),
    paymentIntentId: `pi_rehearsal_${seed}_payment`,
    eventId: `evt_rehearsal_${seed}_payment`,
    baseAmountMinor: "10000",
    technologyFeeMinor: "100",
    processingChargeMinor: "0",
    amountMinor: "10100",
    approvedVaultLauncherId: hex(80),
    deedLauncherId: hex(seed + 2),
    zkPassportRoot: hex(seed + 3),
    settlementReceiptHash: hex(seed + 4),
    signerIndices: [0, 2],
    voucher: {
      serial: seed,
      signerIndices: [0, 1],
      issuanceBundleId: hex(seed + 5),
      voucherCoinId: hex(seed + 6),
      paymentCommitmentCoinId: hex(seed + 7),
      issuanceConfirmedHeight: 1234 + seed,
    },
    execution: {
      schema: "solslot.stripe-voucher-terminal-execution.v1",
      mode: refund ? "REFUND_OWNER" : "REDEEM",
      action: 7,
      spendBundleId: hex(seed + 8),
      feeCoinId: hex(seed + 9),
      feeMojos: "42",
      mempoolObservedAt: 1785844800 + seed,
      outputRoles: roles,
    },
    chain: refund ? {
      confirmationHeight: 1300 + seed,
      seriesOutputCoinId: roles.series,
      terminalVoucherCoinId: roles.terminalVoucher,
      vaultOutputCoinId: roles.vault,
    } : {
      confirmationHeight: 1300 + seed,
      deedOutputCoinId: roles.deed,
      seriesOutputCoinId: roles.series,
      terminalVoucherCoinId: roles.terminalVoucher,
      coordinationCoinId: roles.coordination,
    },
  };
  if (refund) {
    value.exactRefund = true;
    value.stripeRefund = {
      refundId: `re_rehearsal_${seed}_refund`,
      refundedMinor: "10100",
      currency: "usd",
      livemode: false,
      observedAt: 1785844900 + seed,
    };
  }
  return value;
}

function config() {
  return {
    configHash: hex(90),
    releaseTag: "solslot-v2-alpha-rc27-20260804",
    releaseEvidenceHash: hex(91),
    network: "testnet11",
    candidatesApiUrl: "https://solslot.com/protocol-api/presales/stripe-rehearsal/candidates",
    approvedVaultLauncherId: hex(80),
    collectionId: hex(81),
    stripe: {
      accountId: "acct_testnet_alpha",
      mode: "test",
      livemode: false,
      apiVersion: "2026-02-25.clover",
    },
    validatorThreshold: 2,
    validators: [{ id: "validator-0" }, { id: "validator-1" }, { id: "validator-2" }],
  };
}

function request(current) {
  return {
    ceremonyId: "ceremony_rc27_alpha",
    releaseTag: current.releaseTag,
    releaseEvidenceHash: current.releaseEvidenceHash,
    configHash: current.configHash,
    network: "testnet11",
    rehearsalKind: EVIDENCE_KIND,
    requiredLanes: ["stripe-voucher-delivery", "stripe-voucher-refund"],
    walletAddress: `0x${"ab".repeat(20)}`,
  };
}

function responseBody(current, candidates, createdAfter) {
  return {
    schema: "solslot.stripe-voucher-rehearsal-candidates.v1",
    createdAfter,
    vaultLauncherId: current.approvedVaultLauncherId,
    collectionId: current.collectionId,
    delivery: candidates.delivery,
    refund: candidates.refund,
  };
}

describe("RC27 Stripe voucher launch rehearsal", function () {
  it("loads only a pinned Testnet11 Stripe-test configuration", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-rehearsal-config-"));
    const payload = {
      schemaVersion: 3,
      kind: CONFIG_KIND,
      releaseTag: "solslot-v2-alpha-rc27-20260804",
      releaseEvidenceHash: hex(91),
      network: "testnet11",
      candidatesApiUrl: "https://solslot.com/protocol-api/presales/stripe-rehearsal/candidates",
      approvedVaultLauncherId: hex(80),
      collectionId: hex(81),
      stripe: {
        accountId: "acct_testnet_alpha",
        mode: "test",
        livemode: false,
        apiVersion: "2026-02-25.clover",
      },
      validatorThreshold: 2,
      validators: [{ id: "validator-0" }, { id: "validator-1" }, { id: "validator-2" }],
    };
    const configPath = path.join(directory, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ configHash: sha256(payload), payload }));
    const loaded = loadCoordinatorConfig({ SOLSLOT_LAUNCH_REHEARSAL_CONFIG_PATH: configPath });
    expect(loaded.network).to.equal("testnet11");
    expect(loaded.stripe.livemode).to.equal(false);

    payload.stripe.livemode = true;
    fs.writeFileSync(configPath, JSON.stringify({ configHash: sha256(payload), payload }));
    expect(() => loadCoordinatorConfig({ SOLSLOT_LAUNCH_REHEARSAL_CONFIG_PATH: configPath }))
      .to.throw("pinned test account");
  });

  it("observes distinct production delivery and exact-refund vouchers", async function () {
    const current = config();
    const candidates = { delivery: [], refund: [] };
    let observedAfter = 0;
    const coordinator = new LaunchRehearsalCoordinator({
      config: current,
      secrets: {
        candidatesApiToken: "candidate-token-at-least-thirty-two-characters",
        evidenceHmacSecret: "evidence-secret-at-least-thirty-two-characters",
      },
      stateDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "solslot-rehearsal-")),
      now: () => 1785844800,
      fetchImplementation: async (url) => {
        observedAfter = Number(new URL(url).searchParams.get("created_after"));
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(responseBody(current, candidates, observedAfter)),
        };
      },
    });

    const started = await coordinator.start(request(current));
    expect(started.phase).to.equal("WAITING_DELIVERY_PURCHASE");
    expect(started.walletTransaction).to.equal(null);
    expect(observedAfter).to.equal(1785844800);

    candidates.delivery.push(lane(10, "delivery"));
    const delivered = await coordinator.get(started.jobId);
    expect(delivered.phase).to.equal("WAITING_REFUND_PURCHASE");
    expect(delivered.completedSteps).to.equal(2);

    candidates.refund.push(lane(40, "refund"));
    const completed = await coordinator.get(started.jobId);
    expect(completed.state).to.equal("SUCCEEDED");
    expect(completed.evidence.schemaVersion).to.equal(3);
    expect(completed.evidence.lanes.delivery.purchaseId)
      .to.not.equal(completed.evidence.lanes.refund.purchaseId);
    expect(completed.evidence.lanes.delivery).to.not.have.property("stripeAccountId");
    const expected = crypto.createHmac(
      "sha256",
      "evidence-secret-at-least-thirty-two-characters",
    ).update(stableJson(completed.evidence)).digest("hex");
    expect(completed.evidenceHmac).to.equal(`0x${expected}`);
  });

  it("fails closed when confirmed output evidence changes", async function () {
    const current = config();
    const altered = lane(10, "delivery");
    altered.chain.deedOutputCoinId = hex(99);
    const coordinator = new LaunchRehearsalCoordinator({
      config: current,
      secrets: {
        candidatesApiToken: "candidate-token-at-least-thirty-two-characters",
        evidenceHmacSecret: "evidence-secret-at-least-thirty-two-characters",
      },
      stateDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "solslot-rehearsal-")),
      now: () => 1785844800,
      fetchImplementation: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(responseBody(current, {
          delivery: [altered],
          refund: [],
        }, 1785844800)),
      }),
    });
    const status = await coordinator.start(request(current));
    expect(status.state).to.equal("FAILED");
    expect(status.message).to.include("confirmed output differs");
  });
});

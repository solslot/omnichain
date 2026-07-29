const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("ethers");

const {
  BASE_SEPOLIA_USDC,
  LaunchRehearsalCoordinator,
  SPOKE_ABI,
  validateLanePair,
} = require("../scripts/lib/launch-rehearsal-coordinator");
const { stableJson } = require("../scripts/lib/deployment-evidence");

function hex(byte, length) {
  return `0x${byte.repeat(length)}`;
}

function tokenAssetId(address) {
  return `0x${"00".repeat(12)}${address.slice(2).toLowerCase()}`;
}

function purchase(byte, expiresAt) {
  return {
    schema: "solslot.payment_artifact.v2",
    rail: 2,
    railChainId: 84532,
    railAssetId: tokenAssetId(BASE_SEPOLIA_USDC),
    railAssetDecimals: 6,
    railAmount: 5_000_000,
    purchaseId: hex(byte, 32),
    artifactHash: hex(`${Number.parseInt(byte, 16) + 1}`.padStart(2, "0"), 32),
    collectionId: hex("31", 32),
    deedLauncherId: hex("41", 32),
    vaultLauncherId: hex("51", 32),
    vaultP2PuzzleHash: hex("52", 32),
    quoteExpiresAt: expiresAt,
  };
}

function config(now) {
  const runtimeCode = "0x6001600055";
  const wallet = ethers.getAddress(hex("71", 20));
  return {
    runtimeCode,
    wallet,
    value: {
      activation: {
        artifactHash: hex("20", 32),
        chainId: 84532,
        contracts: {
          spoke: ethers.getAddress(hex("21", 20)),
          gateway: ethers.getAddress(hex("22", 20)),
        },
        runtimeCodeHashes: { spoke: ethers.keccak256(runtimeCode) },
      },
      configHash: hex("23", 32),
      releaseTag: "solslot-v2-alpha-rc22-20260727",
      releaseEvidenceHash: hex("24", 32),
      network: "testnet11-base-sepolia",
      confirmations: 12,
      settlementApiUrl: "https://api.example/protocol-api/presales/base-settlements",
      allowedWallets: [
        wallet,
        ethers.getAddress(hex("72", 20)),
        ethers.getAddress(hex("73", 20)),
      ],
      validatorThreshold: 2,
      validators: [
        { id: "validator-1", evidenceHash: hex("81", 32) },
        { id: "validator-2", evidenceHash: hex("82", 32) },
        { id: "validator-3", evidenceHash: hex("83", 32) },
      ],
      lanes: {
        delivery: {
          localPaymentId: hex("91", 32),
          expectedOutcome: "DELIVERED",
          purchaseArtifact: purchase("11", now + 3600),
        },
        refund: {
          localPaymentId: hex("92", 32),
          expectedOutcome: "REFUND",
          purchaseArtifact: purchase("12", now + 3600),
        },
      },
    },
  };
}

function authorization(selected, job, laneName, globalPaymentId) {
  const lane = selected.value.lanes[laneName];
  const delivered = laneName === "delivery";
  return {
    authorizationId: hex(delivered ? "a1" : "a2", 32),
    authorizationHash: hex(delivered ? "a1" : "a2", 32),
    state: "RELAYED",
    authorization: {
      outcome: lane.expectedOutcome,
      globalPaymentId,
      purchaseId: lane.purchaseArtifact.purchaseId,
      purchaseArtifactHash: lane.purchaseArtifact.artifactHash,
      collectionId: lane.purchaseArtifact.collectionId,
      deedLauncherId: lane.purchaseArtifact.deedLauncherId,
      vaultLauncherId: lane.purchaseArtifact.vaultLauncherId,
      vaultP2PuzzleHash: lane.purchaseArtifact.vaultP2PuzzleHash,
      originalPayer: ethers.zeroPadValue(job.walletAddress, 32).toLowerCase(),
      payment: {
        principal: lane.purchaseArtifact.railAmount,
        chainId: 84532,
      },
      chia: delivered
        ? { deedOutputCoinId: hex("b1", 32), confirmedHeight: 2_345_678 }
        : { terminalVoucherCoinId: hex("b2", 32), confirmedHeight: 2_345_679 },
    },
    relayEvidence: {
      baseTransactionHash: hex(delivered ? "c1" : "c2", 32),
    },
  };
}

describe("guided launch rehearsal coordinator", function () {
  it("binds both outcomes to one canary deed while keeping payments unique", function () {
    const selected = config(1_784_000_000);
    expect(() => validateLanePair(selected.value.lanes)).not.to.throw();

    selected.value.lanes.refund.purchaseArtifact.deedLauncherId = hex("42", 32);
    expect(() => validateLanePair(selected.value.lanes))
      .to.throw("same canary deedLauncherId");
  });

  it("binds four reviewed wallet steps to one coadmin and seals both outcomes", async function () {
    const now = 1_784_000_000;
    const selected = config(now);
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-launch-rehearsal-"));
    const iface = new ethers.Interface(SPOKE_ABI);
    const transactions = new Map();
    const receipts = new Map();
    const globalIds = {
      delivery: hex("d1", 32),
      refund: hex("d2", 32),
    };
    let activeLane = "delivery";
    let currentJob;

    const provider = {
      getNetwork: async () => ({ chainId: 84532n }),
      getCode: async () => selected.runtimeCode,
      getTransaction: async (hash) => transactions.get(hash) || null,
      getTransactionReceipt: async (hash) => receipts.get(hash) || null,
      getBlockNumber: async () => 120,
      getBlock: async () => ({ hash: hex("aa", 32) }),
    };
    const spoke = {
      interface: iface,
      quoteDepositFee: async () => 0n,
      globalPaymentForPurchase: async (purchaseId) =>
        purchaseId === selected.value.lanes.delivery.purchaseArtifact.purchaseId
          ? globalIds.delivery
          : globalIds.refund,
      getDeposit: async (globalPaymentId) => {
        const laneName = globalPaymentId === globalIds.delivery ? "delivery" : "refund";
        const lane = selected.value.lanes[laneName];
        return {
          localPaymentId: lane.localPaymentId,
          purchaseId: lane.purchaseArtifact.purchaseId,
          artifactHash: lane.purchaseArtifact.artifactHash,
          collectionId: lane.purchaseArtifact.collectionId,
          deedLauncherId: lane.purchaseArtifact.deedLauncherId,
          vaultLauncherId: lane.purchaseArtifact.vaultLauncherId,
          destinationPuzzle: lane.purchaseArtifact.vaultP2PuzzleHash,
          settlementToken: BASE_SEPOLIA_USDC,
          hubGateway: selected.value.activation.contracts.gateway,
          depositor: selected.wallet,
          amount: BigInt(lane.purchaseArtifact.railAmount),
          quantity: 1n,
          quoteExpiresAt: BigInt(lane.purchaseArtifact.quoteExpiresAt),
          status: laneName === "delivery" ? 3n : 4n,
          succeeded: laneName === "delivery",
        };
      },
    };
    const fetchImplementation = async (url) => {
      const globalPaymentId = url.split("/").pop();
      const laneName = globalPaymentId === globalIds.delivery ? "delivery" : "refund";
      return new Response(JSON.stringify(
        authorization(selected, currentJob, laneName, globalPaymentId),
      ), { status: 200 });
    };
    const coordinator = new LaunchRehearsalCoordinator({
      config: selected.value,
      secrets: {
        evidenceHmacSecret: "evidence-secret-that-is-at-least-32-characters",
        settlementApiToken: "api-token-that-is-at-least-32-characters",
      },
      stateDirectory,
      provider,
      fetchImplementation,
      now: () => now,
      contractFactory: () => spoke,
    });
    const request = {
      ceremonyId: hex("e1", 32),
      releaseTag: selected.value.releaseTag,
      releaseEvidenceHash: selected.value.releaseEvidenceHash,
      configHash: selected.value.configHash,
      network: selected.value.network,
      requiredLanes: ["delivery", "refund"],
      walletAddress: selected.wallet,
    };

    let status = await coordinator.start(request);
    currentJob = coordinator.readJob(status.jobId);
    expect(status).to.include({
      state: "AWAITING_WALLET",
      phase: "APPROVE_DELIVERY",
      completedSteps: 0,
    });

    async function submitCurrent(hashByte, includeDeposit = false) {
      const hash = hex(hashByte, 32);
      const expected = status.walletTransaction;
      transactions.set(hash, {
        from: selected.wallet,
        to: expected.to,
        value: 0n,
        data: expected.data,
        chainId: 84532,
      });
      const logs = [];
      if (includeDeposit) {
        const lane = selected.value.lanes[activeLane];
        const encoded = iface.encodeEventLog(iface.getEvent("PaymentDeposited"), [
          globalIds[activeLane],
          lane.localPaymentId,
          selected.wallet,
          BASE_SEPOLIA_USDC,
          BigInt(lane.purchaseArtifact.railAmount),
          10344971235874465080n,
          selected.value.activation.contracts.gateway,
          hex("f1", 32),
          0n,
        ]);
        logs.push({
          address: selected.value.activation.contracts.spoke,
          topics: encoded.topics,
          data: encoded.data,
        });
      }
      receipts.set(hash, {
        status: 1,
        blockNumber: 100,
        blockHash: hex("aa", 32),
        logs,
      });
      status = await coordinator.submit(status.jobId, hash);
      status = await coordinator.get(status.jobId);
      currentJob = coordinator.readJob(status.jobId);
    }

    await submitCurrent("01");
    expect(status.phase).to.equal("PAY_DELIVERY");
    await submitCurrent("02", true);
    expect(status.phase).to.equal("APPROVE_REFUND");
    expect(status.completedSteps).to.equal(2);

    activeLane = "refund";
    await submitCurrent("03");
    expect(status.phase).to.equal("PAY_REFUND");
    await submitCurrent("04", true);
    expect(status).to.include({
      state: "SUCCEEDED",
      phase: "COMPLETE",
      completedSteps: 4,
    });
    expect(status.evidence.lanes.refund.exactRefund).to.equal(true);
    expect(status.evidence.validators).to.have.length(3);
    expect(status.evidenceHmac).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("rejects a transaction from a wallet other than the enrolled coadmin", async function () {
    const now = 1_784_000_000;
    const selected = config(now);
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-launch-rehearsal-"));
    const transactions = new Map();
    const provider = {
      getNetwork: async () => ({ chainId: 84532n }),
      getCode: async () => selected.runtimeCode,
      getTransaction: async (hash) => transactions.get(hash),
    };
    const coordinator = new LaunchRehearsalCoordinator({
      config: selected.value,
      secrets: {
        evidenceHmacSecret: "evidence-secret-that-is-at-least-32-characters",
        settlementApiToken: "api-token-that-is-at-least-32-characters",
      },
      stateDirectory,
      provider,
      now: () => now,
    });
    const status = await coordinator.start({
      ceremonyId: hex("e1", 32),
      releaseTag: selected.value.releaseTag,
      releaseEvidenceHash: selected.value.releaseEvidenceHash,
      configHash: selected.value.configHash,
      network: selected.value.network,
      requiredLanes: ["delivery", "refund"],
      walletAddress: selected.wallet,
    });
    const hash = hex("09", 32);
    transactions.set(hash, {
      from: ethers.getAddress(hex("99", 20)),
      to: status.walletTransaction.to,
      value: 0n,
      data: status.walletTransaction.data,
      chainId: 84532,
    });

    await expect(coordinator.submit(status.jobId, hash))
      .to.be.rejectedWith("differs from the reviewed wallet step");
    const stored = coordinator.readJob(status.jobId);
    expect(stored.transactions).to.deep.equal({});
    expect(stableJson(stored.walletTransaction)).to.equal(
      stableJson(status.walletTransaction),
    );
  });

  it("serializes simultaneous submissions for the same wallet step", async function () {
    const now = 1_784_000_000;
    const selected = config(now);
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-launch-rehearsal-"));
    const transactions = new Map();
    const provider = {
      getNetwork: async () => ({ chainId: 84532n }),
      getCode: async () => selected.runtimeCode,
      getTransaction: async (hash) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return transactions.get(hash) || null;
      },
    };
    const coordinator = new LaunchRehearsalCoordinator({
      config: selected.value,
      secrets: {
        evidenceHmacSecret: "evidence-secret-that-is-at-least-32-characters",
        settlementApiToken: "api-token-that-is-at-least-32-characters",
      },
      stateDirectory,
      provider,
      now: () => now,
    });
    const status = await coordinator.start({
      ceremonyId: hex("e1", 32),
      releaseTag: selected.value.releaseTag,
      releaseEvidenceHash: selected.value.releaseEvidenceHash,
      configHash: selected.value.configHash,
      network: selected.value.network,
      requiredLanes: ["delivery", "refund"],
      walletAddress: selected.wallet,
    });
    for (const byte of ["0a", "0b"]) {
      transactions.set(hex(byte, 32), {
        from: selected.wallet,
        to: status.walletTransaction.to,
        value: 0n,
        data: status.walletTransaction.data,
        chainId: 84532,
      });
    }

    const attempts = await Promise.allSettled([
      coordinator.submit(status.jobId, hex("0a", 32)),
      coordinator.submit(status.jobId, hex("0b", 32)),
    ]);

    expect(attempts.filter((item) => item.status === "fulfilled")).to.have.length(1);
    expect(attempts.filter((item) => item.status === "rejected")).to.have.length(1);
    expect(attempts.find((item) => item.status === "rejected").reason.message)
      .to.equal("the rehearsal is not waiting for a wallet transaction");
    expect(Object.keys(coordinator.readJob(status.jobId).transactions)).to.have.length(1);
  });

  it("rejects a confirmed transaction whose receipt block is not canonical", async function () {
    const now = 1_784_000_000;
    const selected = config(now);
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-launch-rehearsal-"));
    const hash = hex("0c", 32);
    let expected;
    const provider = {
      getNetwork: async () => ({ chainId: 84532n }),
      getCode: async () => selected.runtimeCode,
      getTransaction: async () => ({
        from: selected.wallet,
        to: expected.to,
        value: 0n,
        data: expected.data,
        chainId: 84532,
      }),
      getTransactionReceipt: async () => ({
        status: 1,
        blockNumber: 100,
        blockHash: hex("aa", 32),
        logs: [],
      }),
      getBlockNumber: async () => 120,
      getBlock: async () => ({ hash: hex("bb", 32) }),
    };
    const coordinator = new LaunchRehearsalCoordinator({
      config: selected.value,
      secrets: {
        evidenceHmacSecret: "evidence-secret-that-is-at-least-32-characters",
        settlementApiToken: "api-token-that-is-at-least-32-characters",
      },
      stateDirectory,
      provider,
      now: () => now,
    });
    const status = await coordinator.start({
      ceremonyId: hex("e1", 32),
      releaseTag: selected.value.releaseTag,
      releaseEvidenceHash: selected.value.releaseEvidenceHash,
      configHash: selected.value.configHash,
      network: selected.value.network,
      requiredLanes: ["delivery", "refund"],
      walletAddress: selected.wallet,
    });
    expected = status.walletTransaction;
    await coordinator.submit(status.jobId, hash);

    await expect(coordinator.get(status.jobId))
      .to.be.rejectedWith("receipt block could not be authenticated");
  });
});

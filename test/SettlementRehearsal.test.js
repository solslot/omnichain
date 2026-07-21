const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("ethers");

const { PAYMENT_DEPOSITED_ABI } = require("../scripts/lib/escrow-relayer");
const {
  tokenAddressFromAssetId,
  verifySettlementRehearsal,
} = require("../scripts/lib/settlement-rehearsal");

function hex(byte, length) {
  return `0x${byte.repeat(length)}`;
}

function tokenAssetId(address) {
  return `0x${"00".repeat(12)}${address.slice(2).toLowerCase()}`;
}

function artifact(token) {
  return {
    schema: "solslot.payment_artifact.v2",
    rail: 2,
    railChainId: 84532,
    railAssetId: tokenAssetId(token),
    railAssetDecimals: 6,
    railAmount: 125_000_000,
    purchaseId: hex("11", 32),
    artifactHash: hex("12", 32),
    collectionId: hex("13", 32),
    deedLauncherId: hex("14", 32),
    vaultLauncherId: hex("15", 32),
    vaultP2PuzzleHash: hex("16", 32),
    quoteExpiresAt: 1_784_700_000,
  };
}

function rehearsalConfig(outputPath) {
  const runtimeCode = "0x6001600055";
  const token = hex("35", 20);
  return {
    activation: {
      artifactHash: hex("21", 32),
      sourceSha: "a".repeat(40),
      network: "baseSepolia",
      chainId: 84532,
      contracts: { spoke: hex("22", 20), gateway: hex("36", 20) },
      runtimeCodeHashes: { spoke: ethers.keccak256(runtimeCode) },
    },
    purchaseArtifact: artifact(token),
    transactionHash: hex("32", 32),
    confirmations: 12,
    expectedOutcome: "success",
    outputPath,
    runtimeCode,
    token,
  };
}

function settledDeposit(selected, overrides = {}) {
  return {
    purchaseId: selected.purchaseArtifact.purchaseId,
    artifactHash: selected.purchaseArtifact.artifactHash,
    collectionId: selected.purchaseArtifact.collectionId,
    deedLauncherId: selected.purchaseArtifact.deedLauncherId,
    vaultLauncherId: selected.purchaseArtifact.vaultLauncherId,
    destinationPuzzle: selected.purchaseArtifact.vaultP2PuzzleHash,
    settlementToken: selected.token,
    localPaymentId: hex("33", 32),
    amount: BigInt(selected.purchaseArtifact.railAmount),
    quantity: 1n,
    quoteExpiresAt: BigInt(selected.purchaseArtifact.quoteExpiresAt),
    hubGateway: selected.activation.contracts.gateway,
    status: 3n,
    succeeded: true,
    resultMessageId: hex("41", 32),
    warpNonce: hex("42", 32),
    ...overrides,
  };
}

function scenario(selected, overrides = {}) {
  const iface = new ethers.Interface(PAYMENT_DEPOSITED_ABI);
  const globalPaymentId = hex("10", 32);
  const blockHash = hex("31", 32);
  const encoded = iface.encodeEventLog(iface.getEvent("PaymentDeposited"), [
    globalPaymentId,
    hex("33", 32),
    hex("34", 20),
    selected.token,
    BigInt(selected.purchaseArtifact.railAmount),
    10344971235874465080n,
    selected.activation.contracts.gateway,
    hex("37", 32),
    0n,
  ]);
  const receipt = {
    status: 1,
    to: selected.activation.contracts.spoke,
    blockNumber: 100,
    blockHash,
    logs: [{
      address: selected.activation.contracts.spoke,
      topics: encoded.topics,
      data: encoded.data,
      index: 2,
    }],
    ...overrides.receipt,
  };
  const provider = {
    getNetwork: async () => ({ chainId: 84532n }),
    getCode: async () => selected.runtimeCode,
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => 111,
    getBlock: async () => ({ hash: blockHash }),
    ...overrides.provider,
  };
  const spoke = {
    interface: iface,
    getDeposit: async () => overrides.deposit || settledDeposit(selected),
    deriveGlobalPaymentId: async () => globalPaymentId,
    globalPaymentForPurchase: async () => globalPaymentId,
  };
  return { provider, spoke, globalPaymentId };
}

describe("confirmed escrow settlement rehearsal", function () {
  it("binds one terminal success deposit to its canonical artifact and writes immutable evidence", async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-rehearsal-"));
    const selected = rehearsalConfig(path.join(directory, "success.json"));
    const { provider, spoke, globalPaymentId } = scenario(selected);

    const result = await verifySettlementRehearsal(
      selected,
      provider,
      () => spoke,
    );

    expect(result.deposit).to.deep.include({
      globalPaymentId,
      confirmations: 12,
      status: 3,
      statusLabel: "SettledSuccess",
      succeeded: true,
    });
    expect(result.purchase).to.deep.equal(selected.purchaseArtifact);
    expect(JSON.parse(fs.readFileSync(selected.outputPath, "utf8"))).to.deep.equal(
      Object.fromEntries(Object.entries(result).filter(([key]) => key !== "evidencePath")),
    );
    expect(fs.statSync(selected.outputPath).mode & 0o077).to.equal(0);
  });

  it("rejects an asset ID that is not exactly a padded EVM token address", function () {
    expect(() => tokenAddressFromAssetId(hex("35", 32))).to.throw("left-padded");
    expect(() => tokenAddressFromAssetId(`0x${"00".repeat(12)}${"00".repeat(20)}`)).to.throw("non-zero");
  });

  it("accepts a terminal refund only when that outcome was explicitly selected", async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-rehearsal-"));
    const selected = rehearsalConfig(path.join(directory, "refund.json"));
    selected.expectedOutcome = "refund";
    const { provider, spoke } = scenario(selected, {
      deposit: settledDeposit(selected, { status: 4n, succeeded: false }),
    });

    const result = await verifySettlementRehearsal(selected, provider, () => spoke);

    expect(result.deposit).to.include({
      status: 4,
      statusLabel: "SettledRefund",
      succeeded: false,
    });
  });

  it("rejects a deposit that changes the artifact-bound destination before writing evidence", async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-rehearsal-"));
    const selected = rehearsalConfig(path.join(directory, "mismatch.json"));
    const { provider, spoke } = scenario(selected, {
      deposit: settledDeposit(selected, { destinationPuzzle: hex("19", 32) }),
    });

    await expect(verifySettlementRehearsal(selected, provider, () => spoke))
      .to.be.rejectedWith("destinationPuzzle does not match");
    expect(fs.existsSync(selected.outputPath)).to.equal(false);
  });

  it("rejects insufficiently confirmed and non-terminal receipts", async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-rehearsal-"));
    const selected = rehearsalConfig(path.join(directory, "failure.json"));
    const insufficient = scenario(selected, { provider: { getBlockNumber: async () => 110 } });
    await expect(verifySettlementRehearsal(selected, insufficient.provider, () => insufficient.spoke))
      .to.be.rejectedWith("does not have enough confirmations");

    const pending = scenario(selected, {
      deposit: settledDeposit(selected, { status: 2n, succeeded: true }),
    });
    await expect(verifySettlementRehearsal(selected, pending.provider, () => pending.spoke))
      .to.be.rejectedWith("expected terminal success");
    expect(fs.existsSync(selected.outputPath)).to.equal(false);
  });

  it("rejects a spoke whose runtime no longer matches its activation evidence", async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-rehearsal-"));
    const selected = rehearsalConfig(path.join(directory, "runtime.json"));
    const { provider, spoke } = scenario(selected, {
      provider: { getCode: async () => "0x6002600055" },
    });

    await expect(verifySettlementRehearsal(selected, provider, () => spoke))
      .to.be.rejectedWith("runtime differs from activation evidence");
    expect(fs.existsSync(selected.outputPath)).to.equal(false);
  });
});

const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("ethers");

const {
  PAYMENT_DEPOSITED_ABI,
  confirmedHead,
  depositDisposition,
  escrowMessageFromDeposit,
  postEscrowCallback,
  readState,
  runOnce,
  writeState,
} = require("../scripts/lib/escrow-relayer");

function hex(byte, length) {
  return `0x${byte.repeat(length)}`;
}

function deposit(overrides = {}) {
  return {
    purchaseId: hex("11", 32),
    artifactHash: hex("12", 32),
    amount: 125_000_000n,
    quantity: 1n,
    collectionId: hex("13", 32),
    deedLauncherId: hex("14", 32),
    vaultLauncherId: hex("15", 32),
    destinationPuzzle: hex("16", 32),
    quoteExpiresAt: 1_784_700_000n,
    status: 1n,
    succeeded: false,
    ...overrides,
  };
}

function config(statePath) {
  return {
    activation: {
      artifactHash: hex("21", 32),
      chainId: 84532,
      contracts: { spoke: hex("22", 20) },
    },
    callbackUrl: "https://staging.solslot.com/protocol/purchase-intents/escrow-webhook",
    callbackToken: "test-callback-token-that-is-long-enough",
    statePath,
    startBlock: 100,
  };
}

describe("confirmed escrow event relayer", function () {
  it("encodes the exact ten-word chain message", function () {
    expect(escrowMessageFromDeposit(hex("10", 32), deposit(), "base_testnet")).to.deep.equal({
      gatewayProfile: "base_testnet",
      globalPaymentId: hex("10", 32),
      purchaseId: hex("11", 32),
      artifactHash: hex("12", 32),
      amount: 125_000_000,
      quantity: 1,
      collectionId: hex("13", 32),
      deedLauncherId: hex("14", 32),
      vaultLauncherId: hex("15", 32),
      destinationPuzzle: hex("16", 32),
      quoteExpiresAt: 1_784_700_000,
    });
  });

  it("rejects refunded, failed, zero, and inexact deposits", function () {
    expect(() => escrowMessageFromDeposit(hex("10", 32), deposit({ status: 4n }), "base_testnet"))
      .to.throw("not eligible");
    expect(() => escrowMessageFromDeposit(hex("10", 32), deposit({ status: 2n }), "base_testnet"))
      .to.throw("not eligible");
    expect(() => escrowMessageFromDeposit(hex("00", 32), deposit(), "base_testnet"))
      .to.throw("globalPaymentId");
    expect(() => escrowMessageFromDeposit(
      hex("10", 32),
      deposit({ amount: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
      "base_testnet",
    )).to.throw("exact JSON integer range");
  });

  it("checkpoints terminal failed deposits without sending them for fulfillment", function () {
    expect(depositDisposition(deposit())).to.equal("verify");
    expect(depositDisposition(deposit({ status: 2n, succeeded: true }))).to.equal("verify");
    expect(depositDisposition(deposit({ status: 2n, succeeded: false }))).to.equal("skip-failed");
    expect(depositDisposition(deposit({ status: 4n }))).to.equal("skip-failed");
    expect(depositDisposition(deposit({ status: 5n }))).to.equal("skip-failed");
    expect(() => depositDisposition(deposit({ status: 0n }))).to.throw("impossible");
  });

  it("requires twelve confirmed blocks", function () {
    expect(confirmedHead(100, 12)).to.equal(89);
    expect(() => confirmedHead(100, 11)).to.throw("at least 12 confirmations");
  });

  it("persists an activation-bound checkpoint with owner-only permissions", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-relayer-"));
    const statePath = path.join(directory, "state.json");
    const selected = config(statePath);
    const state = readState(selected);
    expect(state.nextBlock).to.equal(100);
    state.nextBlock = 240;
    writeState(selected, state);
    expect(readState(selected)).to.deep.equal(state);
    expect(fs.statSync(statePath).mode & 0o077).to.equal(0);

    const changed = config(statePath);
    changed.activation.artifactHash = hex("23", 32);
    expect(() => readState(changed)).to.throw("does not match activation evidence");
  });

  it("sends the callback token only in the authorization header", async function () {
    const selected = config("/tmp/not-used.json");
    let request;
    const fetchImplementation = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          escrow: { verified: true },
          verification: { verified: true },
        }),
      };
    };
    const payload = { escrowMessage: { purchaseId: hex("11", 32) }, source: {} };
    await postEscrowCallback(selected, payload, fetchImplementation);

    expect(request.url).to.equal(selected.callbackUrl);
    expect(request.options.headers.Authorization).to.equal(`Bearer ${selected.callbackToken}`);
    expect(request.options.body).not.to.contain(selected.callbackToken);
  });

  it("relays only confirmed spoke logs and advances the checkpoint", async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-relayer-run-"));
    const selected = {
      ...config(path.join(directory, "state.json")),
      confirmations: 12,
      blockRange: 1000,
    };
    const runtimeCode = "0x6001600055";
    selected.activation.runtimeCodeHashes = { spoke: ethers.keccak256(runtimeCode) };
    selected.activation.gatewayProfile = "base_testnet";
    const blockHash = hex("31", 32);
    const transactionHash = hex("32", 32);
    const globalPaymentId = hex("10", 32);
    const iface = new ethers.Interface(PAYMENT_DEPOSITED_ABI);
    const encoded = iface.encodeEventLog(iface.getEvent("PaymentDeposited"), [
      globalPaymentId,
      hex("33", 32),
      hex("34", 20),
      hex("35", 20),
      125_000_000n,
      10344971235874465080n,
      hex("36", 20),
      hex("37", 32),
      0n,
    ]);
    const log = {
      address: selected.activation.contracts.spoke,
      topics: encoded.topics,
      data: encoded.data,
      blockNumber: 100,
      blockHash,
      transactionHash,
      index: 2,
    };
    const provider = {
      getNetwork: async () => ({ chainId: 84532n }),
      getCode: async () => runtimeCode,
      getBlockNumber: async () => 111,
      getLogs: async (filter) => {
        expect(filter.fromBlock).to.equal(100);
        expect(filter.toBlock).to.equal(100);
        return [log];
      },
      getBlock: async () => ({ hash: blockHash }),
    };
    const spoke = {
      interface: iface,
      getDeposit: async (paymentId) => {
        expect(paymentId).to.equal(globalPaymentId);
        return deposit();
      },
    };
    let callbackPayload;
    const fetchImplementation = async (_url, options) => {
      callbackPayload = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          escrow: { verified: true },
          verification: { verified: true },
        }),
      };
    };

    const result = await runOnce(
      selected,
      provider,
      fetchImplementation,
      () => spoke,
    );

    expect(result).to.deep.equal({ processed: 1, skipped: 0, nextBlock: 101 });
    expect(callbackPayload.escrowMessage.purchaseId).to.equal(hex("11", 32));
    expect(callbackPayload.source).to.deep.include({
      chainId: 84532,
      transactionHash,
      blockNumber: 100,
      blockHash,
      logIndex: 2,
      confirmations: 12,
    });
    expect(readState(selected).nextBlock).to.equal(101);
  });
});

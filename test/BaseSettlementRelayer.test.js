const { expect } = require("chai");
const crypto = require("node:crypto");
const { ethers } = require("ethers");

const { PAYMENT_DEPOSITED_ABI } = require("../scripts/lib/escrow-relayer");
const {
  AUTHORIZATION_SCHEMA,
  GATEWAY_ABI,
  canonicalJson,
  settleAuthorization,
  validateAuthorization,
} = require("../scripts/lib/base-settlement-relayer");

function hex(byte, length) {
  return `0x${byte.repeat(length)}`;
}

function paddedAddress(value) {
  return ethers.zeroPadValue(value, 32).toLowerCase();
}

function fixture() {
  const spoke = hex("21", 20);
  const gateway = hex("22", 20);
  const safe = hex("23", 20);
  const depositor = hex("24", 20);
  const token = hex("25", 20);
  const globalPaymentId = hex("31", 32);
  const deposit = {
    globalPaymentId,
    depositor,
    settlementToken: token,
    localPaymentId: hex("32", 32),
    purchaseId: hex("33", 32),
    artifactHash: hex("34", 32),
    collectionId: hex("35", 32),
    deedLauncherId: hex("36", 32),
    vaultLauncherId: hex("37", 32),
    destinationPuzzle: hex("38", 32),
    amount: 1_030_000n,
    quantity: 1n,
    quoteExpiresAt: 1_800_000_000n,
    status: 2n,
    succeeded: true,
  };
  const authorization = {
    schema: AUTHORIZATION_SCHEMA,
    outcome: "DELIVERED",
    globalPaymentId,
    purchaseId: deposit.purchaseId,
    purchaseArtifactHash: deposit.artifactHash,
    termsHash: hex("39", 32),
    seriesSingletonId: hex("3a", 32),
    collectionId: deposit.collectionId,
    metadataRoot: hex("3b", 32),
    allocationRoot: hex("3c", 32),
    serial: 0,
    deedLauncherId: deposit.deedLauncherId,
    vaultLauncherId: deposit.vaultLauncherId,
    vaultP2PuzzleHash: deposit.destinationPuzzle,
    originalPayer: paddedAddress(depositor),
    payment: {
      rail: "BASE_SEPOLIA_USDC",
      chainId: 84532,
      assetId: paddedAddress(token),
      assetDecimals: 6,
      escrowContract: paddedAddress(spoke),
      principal: 1_030_000,
      evidenceHash: hex("3d", 32),
    },
    chia: {
      confirmedHeight: 100,
      spendBundleId: hex("3e", 32),
    },
  };
  const digest = `0x${crypto.createHash("sha256").update(canonicalJson(authorization)).digest("hex")}`;
  const envelope = {
    authorizationId: digest,
    authorizationHash: digest,
    state: "PENDING",
    authorization,
    createdAt: 1_700_000_000,
    relayedAt: null,
    relayEvidence: null,
  };
  const activation = {
    chainId: 84532,
    contracts: { spoke, gateway },
    governanceRootSafe: safe,
  };
  return { activation, deposit, envelope, gateway, globalPaymentId, safe, spoke };
}

describe("Base settlement authorization relayer", function () {
  it("binds the API authorization to the exact escrow deposit", function () {
    const selected = fixture();
    const validated = validateAuthorization(
      selected.envelope,
      selected.activation,
      selected.deposit,
    );
    expect(validated.succeeded).to.equal(true);

    selected.deposit.amount += 1n;
    expect(() => validateAuthorization(
      selected.envelope,
      selected.activation,
      selected.deposit,
    )).to.throw("settlement payment differs");
  });

  it("forwards, settles, and acknowledges only the matching Solomon result", async function () {
    const selected = fixture();
    const spokeInterface = new ethers.Interface(PAYMENT_DEPOSITED_ABI);
    const gatewayInterface = new ethers.Interface(GATEWAY_ABI);
    const warpNonce = hex("41", 32);
    const transactionHash = hex("42", 32);
    const blockNumber = 1_234_567;
    let gatewayStatus = 3n;
    let depositStatus = 2n;
    const settledLog = spokeInterface.encodeEventLog(
      spokeInterface.getEvent("PaymentSettled"),
      [
        selected.globalPaymentId,
        selected.safe,
        selected.deposit.settlementToken,
        selected.deposit.amount,
        true,
        false,
      ],
    );
    const receipt = {
      hash: transactionHash,
      status: 1,
      blockNumber,
      logs: [{
        address: selected.spoke,
        topics: settledLog.topics,
        data: settledLog.data,
      }],
    };
    const gatewayRecord = () => ({
      request: {
        globalPaymentId: selected.globalPaymentId,
        purchaseId: selected.deposit.purchaseId,
        artifactHash: selected.deposit.artifactHash,
        amount: selected.deposit.amount,
        quantity: 1n,
        collectionId: selected.deposit.collectionId,
        deedLauncherId: selected.deposit.deedLauncherId,
        vaultLauncherId: selected.deposit.vaultLauncherId,
        destinationPuzzle: selected.deposit.destinationPuzzle,
      },
      warpNonce,
      status: gatewayStatus,
      succeeded: true,
    });
    const spoke = {
      interface: spokeInterface,
      getDeposit: async () => ({ ...selected.deposit, status: depositStatus }),
      settle: async () => {
        depositStatus = 3n;
        return { wait: async (confirmations) => {
          expect(confirmations).to.equal(12);
          return receipt;
        } };
      },
    };
    const gateway = {
      interface: gatewayInterface,
      getRequest: async () => gatewayRecord(),
      forwardResult: async () => {
        gatewayStatus = 4n;
        return { wait: async () => ({ status: 1 }) };
      },
    };
    const config = {
      activation: selected.activation,
      callbackToken: "test-settlement-token-that-is-long-enough",
      settlementUrl: "https://staging.solslot.com/protocol-api/presales/base-settlements",
      confirmations: 12,
      startBlock: 100,
    };
    const provider = {
      getBlock: async () => ({ timestamp: 1_754_000_000 }),
    };
    let acknowledgement;
    const fetchImplementation = async (url, options) => {
      acknowledgement = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          authorizationId: selected.envelope.authorizationId,
          state: "RELAYED",
        }),
      };
    };
    const result = await settleAuthorization(
      config,
      selected.envelope,
      provider,
      {},
      fetchImplementation,
      (address) => (
        address.toLowerCase() === selected.spoke.toLowerCase()
          ? spoke
          : gateway
      ),
    );

    expect(result.status).to.equal("SETTLED_SUCCESS");
    expect(acknowledgement.url).to.equal(
      `${config.settlementUrl}/${selected.envelope.authorizationId}/relay-evidence`,
    );
    expect(acknowledgement.options.headers.Authorization).to.equal(
      `Bearer ${config.callbackToken}`,
    );
    expect(acknowledgement.body).to.deep.equal({
      warpMessageId: warpNonce,
      baseTransactionHash: transactionHash,
      confirmedBlockNumber: blockNumber,
      confirmedAt: 1_754_000_000,
    });
  });

  it("waits rather than inventing an outcome before Warp confirms", async function () {
    const selected = fixture();
    const spoke = {
      getDeposit: async () => selected.deposit,
    };
    const gateway = {
      getRequest: async () => ({
        request: {
          globalPaymentId: selected.globalPaymentId,
          purchaseId: selected.deposit.purchaseId,
          artifactHash: selected.deposit.artifactHash,
          amount: selected.deposit.amount,
          quantity: 1n,
          collectionId: selected.deposit.collectionId,
          deedLauncherId: selected.deposit.deedLauncherId,
          vaultLauncherId: selected.deposit.vaultLauncherId,
          destinationPuzzle: selected.deposit.destinationPuzzle,
        },
        warpNonce: ethers.ZeroHash,
        status: 2n,
        succeeded: false,
      }),
    };
    const result = await settleAuthorization(
      {
        activation: selected.activation,
        callbackToken: "test-settlement-token-that-is-long-enough",
        settlementUrl: "https://staging.solslot.com/protocol-api/presales/base-settlements",
        confirmations: 12,
        startBlock: 100,
      },
      selected.envelope,
      {},
      {},
      fetch,
      (address) => (
        address.toLowerCase() === selected.spoke.toLowerCase()
          ? spoke
          : gateway
      ),
    );
    expect(result.status).to.equal("WAITING_FOR_WARP");
  });
});

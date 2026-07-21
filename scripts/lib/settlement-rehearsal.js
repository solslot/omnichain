const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const {
  readEvidence,
  withArtifactHash,
  writeEvidence,
} = require("./deployment-evidence");
const {
  PAYMENT_DEPOSITED_ABI,
  verifyProvider,
} = require("./escrow-relayer");

const MAX_PURCHASE_ARTIFACT_BYTES = 64 * 1024;
const TERMINAL_OUTCOMES = {
  success: { status: 3, succeeded: true },
  refund: { status: 4, succeeded: false },
};

function requiredHex(value, bytes, label, allowZero = false) {
  if (!ethers.isHexString(value, bytes) || (!allowZero && BigInt(value) === 0n)) {
    throw new Error(`${label} must be a ${allowZero ? "" : "non-zero "}${bytes}-byte hex value`);
  }
  return value.toLowerCase();
}

function exactInteger(value, label, minimum = 0) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer${minimum ? ` of at least ${minimum}` : ""}`);
  }
  return value;
}

function uintFromChain(value, label, minimum = 0) {
  const parsed = BigInt(value);
  if (parsed < BigInt(minimum) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is outside the exact JSON integer range`);
  }
  return Number(parsed);
}

function tokenAddressFromAssetId(assetId) {
  const normalized = requiredHex(assetId, 32, "railAssetId");
  if (!/^0x0{24}[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("railAssetId must be a left-padded EVM token address");
  }
  const token = ethers.getAddress(`0x${normalized.slice(-40)}`);
  if (token === ethers.ZeroAddress) {
    throw new Error("railAssetId must not encode the zero address");
  }
  return token;
}

function readPurchaseArtifact(inputPath) {
  if (!inputPath) throw new Error("SOLSLOT_REHEARSAL_PURCHASE_ARTIFACT_PATH is required");
  const resolved = path.resolve(inputPath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_PURCHASE_ARTIFACT_BYTES) {
    throw new Error("purchase artifact path is invalid");
  }
  const envelope = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("purchase artifact must be an object");
  }
  const artifact = envelope.purchaseArtifactV2 || envelope;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("purchaseArtifactV2 must be an object");
  }
  const normalized = {
    schema: artifact.schema,
    rail: exactInteger(artifact.rail, "rail"),
    railChainId: exactInteger(artifact.railChainId, "railChainId", 1),
    railAssetId: requiredHex(artifact.railAssetId, 32, "railAssetId"),
    railAssetDecimals: exactInteger(artifact.railAssetDecimals, "railAssetDecimals", 1),
    railAmount: exactInteger(artifact.railAmount, "railAmount", 1),
    purchaseId: requiredHex(artifact.purchaseId, 32, "purchaseId"),
    artifactHash: requiredHex(artifact.artifactHash, 32, "artifactHash"),
    collectionId: requiredHex(artifact.collectionId, 32, "collectionId"),
    deedLauncherId: requiredHex(artifact.deedLauncherId, 32, "deedLauncherId"),
    vaultLauncherId: requiredHex(artifact.vaultLauncherId, 32, "vaultLauncherId"),
    vaultP2PuzzleHash: requiredHex(artifact.vaultP2PuzzleHash, 32, "vaultP2PuzzleHash"),
    quoteExpiresAt: exactInteger(artifact.quoteExpiresAt, "quoteExpiresAt", 1),
  };
  if (normalized.schema !== "solslot.payment_artifact.v2" || normalized.rail !== 2) {
    throw new Error("purchase artifact is not an EVM stablecoin V2 artifact");
  }
  if (normalized.railAssetDecimals !== 6) {
    throw new Error("purchase artifact stablecoin must use six decimals");
  }
  tokenAddressFromAssetId(normalized.railAssetId);
  return normalized;
}

function loadRehearsalConfig(environment = process.env) {
  const activation = readEvidence(
    environment.SOLSLOT_OMNICHAIN_ACTIVATION_EVIDENCE_PATH,
    "activation",
  );
  if (
    activation.kind !== "ccip-warp-escrow-activation" ||
    activation.ownershipAccepted !== true ||
    !Number.isSafeInteger(activation.chainId) ||
    !ethers.isAddress(activation.contracts?.spoke) ||
    !ethers.isAddress(activation.contracts?.gateway) ||
    !ethers.isHexString(activation.runtimeCodeHashes?.spoke, 32)
  ) {
    throw new Error("activation evidence is not usable by the settlement rehearsal");
  }
  const transactionHash = requiredHex(
    environment.SOLSLOT_REHEARSAL_DEPOSIT_TX_HASH,
    32,
    "SOLSLOT_REHEARSAL_DEPOSIT_TX_HASH",
  );
  const confirmations = Number(environment.SOLSLOT_REHEARSAL_CONFIRMATIONS || 12);
  if (!Number.isSafeInteger(confirmations) || confirmations < 12) {
    throw new Error("SOLSLOT_REHEARSAL_CONFIRMATIONS must be at least 12");
  }
  const expectedOutcome = String(environment.SOLSLOT_REHEARSAL_EXPECTED_OUTCOME || "success").toLowerCase();
  if (!TERMINAL_OUTCOMES[expectedOutcome]) {
    throw new Error("SOLSLOT_REHEARSAL_EXPECTED_OUTCOME must be success or refund");
  }
  if (!environment.SOLSLOT_REHEARSAL_OUTPUT) {
    throw new Error("SOLSLOT_REHEARSAL_OUTPUT is required");
  }
  const purchaseArtifact = readPurchaseArtifact(environment.SOLSLOT_REHEARSAL_PURCHASE_ARTIFACT_PATH);
  if (purchaseArtifact.railChainId !== activation.chainId) {
    throw new Error("purchase artifact chain does not match activation evidence");
  }
  return {
    activation,
    purchaseArtifact,
    transactionHash,
    confirmations,
    expectedOutcome,
    outputPath: environment.SOLSLOT_REHEARSAL_OUTPUT,
  };
}

function exactHex(left, right, label) {
  if (String(left).toLowerCase() !== String(right).toLowerCase()) {
    throw new Error(`${label} does not match the canonical purchase artifact`);
  }
}

function exactNumber(left, right, label) {
  if (uintFromChain(left, label) !== right) {
    throw new Error(`${label} does not match the canonical purchase artifact`);
  }
}

function statusLabel(status) {
  return ["None", "RequestSent", "ResultReceived", "SettledSuccess", "SettledRefund", "EmergencyRefund"][status] || "Unknown";
}

function validateDeposit(artifact, globalPaymentId, deposit, event) {
  exactHex(globalPaymentId, event.args.globalPaymentId, "event globalPaymentId");
  exactHex(deposit.localPaymentId, event.args.localPaymentId, "event localPaymentId");
  exactHex(deposit.purchaseId, artifact.purchaseId, "purchaseId");
  exactHex(deposit.artifactHash, artifact.artifactHash, "artifactHash");
  exactHex(deposit.collectionId, artifact.collectionId, "collectionId");
  exactHex(deposit.deedLauncherId, artifact.deedLauncherId, "deedLauncherId");
  exactHex(deposit.vaultLauncherId, artifact.vaultLauncherId, "vaultLauncherId");
  exactHex(deposit.destinationPuzzle, artifact.vaultP2PuzzleHash, "destinationPuzzle");
  exactNumber(deposit.amount, artifact.railAmount, "amount");
  exactNumber(deposit.quantity, 1, "quantity");
  exactNumber(deposit.quoteExpiresAt, artifact.quoteExpiresAt, "quoteExpiresAt");
  if (ethers.getAddress(deposit.settlementToken) !== tokenAddressFromAssetId(artifact.railAssetId)) {
    throw new Error("settlement token does not match the canonical purchase artifact");
  }
  if (ethers.getAddress(event.args.settlementToken) !== ethers.getAddress(deposit.settlementToken)) {
    throw new Error("PaymentDeposited settlement token does not match the stored deposit");
  }
  if (ethers.getAddress(event.args.hubGateway) !== ethers.getAddress(deposit.hubGateway)) {
    throw new Error("PaymentDeposited hub gateway does not match the stored deposit");
  }
  exactNumber(event.args.amount, artifact.railAmount, "PaymentDeposited amount");
}

async function verifySettlementRehearsal(
  config,
  provider,
  contractFactory = (address, abi, runner) => new ethers.Contract(address, abi, runner),
) {
  await verifyProvider(config, provider);
  const receipt = await provider.getTransactionReceipt(config.transactionHash);
  if (!receipt || receipt.status !== 1 || !receipt.to || ethers.getAddress(receipt.to) !== ethers.getAddress(config.activation.contracts.spoke)) {
    throw new Error("rehearsal transaction is not a successful spoke transaction");
  }
  const latestBlock = await provider.getBlockNumber();
  const confirmations = latestBlock - receipt.blockNumber + 1;
  if (confirmations < config.confirmations) {
    throw new Error("rehearsal transaction does not have enough confirmations");
  }
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block || block.hash !== receipt.blockHash) {
    throw new Error("rehearsal receipt block could not be authenticated");
  }
  const spoke = contractFactory(config.activation.contracts.spoke, PAYMENT_DEPOSITED_ABI, provider);
  const deposits = receipt.logs
    .filter((log) => ethers.getAddress(log.address) === ethers.getAddress(config.activation.contracts.spoke))
    .map((log) => {
      try {
        return { log, parsed: spoke.interface.parseLog(log) };
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.parsed?.name === "PaymentDeposited");
  if (deposits.length !== 1) {
    throw new Error("rehearsal transaction must contain exactly one PaymentDeposited event");
  }
  const { log, parsed } = deposits[0];
  const globalPaymentId = requiredHex(parsed.args.globalPaymentId, 32, "globalPaymentId");
  const deposit = await spoke.getDeposit(globalPaymentId);
  validateDeposit(config.purchaseArtifact, globalPaymentId, deposit, parsed);
  const derivedPaymentId = await spoke.deriveGlobalPaymentId(
    deposit.settlementToken,
    deposit.localPaymentId,
    deposit.purchaseId,
    deposit.artifactHash,
  );
  exactHex(derivedPaymentId, globalPaymentId, "derived globalPaymentId");
  const mappedPaymentId = await spoke.globalPaymentForPurchase(config.purchaseArtifact.purchaseId);
  exactHex(mappedPaymentId, globalPaymentId, "purchase payment mapping");
  if (ethers.getAddress(deposit.hubGateway) !== ethers.getAddress(config.activation.contracts.gateway)) {
    throw new Error("deposit hub gateway does not match activation evidence");
  }
  const expected = TERMINAL_OUTCOMES[config.expectedOutcome];
  const status = uintFromChain(deposit.status, "deposit status");
  if (status !== expected.status || deposit.succeeded !== expected.succeeded) {
    throw new Error(`deposit did not reach the expected terminal ${config.expectedOutcome} outcome`);
  }
  const evidence = withArtifactHash({
    schemaVersion: 1,
    kind: "solslot-omnichain-settlement-rehearsal",
    sourceSha: config.activation.sourceSha,
    activationArtifactHash: config.activation.artifactHash,
    network: config.activation.network,
    chainId: config.activation.chainId,
    contracts: {
      spoke: ethers.getAddress(config.activation.contracts.spoke),
      gateway: ethers.getAddress(config.activation.contracts.gateway),
    },
    expectedOutcome: config.expectedOutcome,
    purchase: config.purchaseArtifact,
    deposit: {
      globalPaymentId,
      transactionHash: config.transactionHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      logIndex: log.index,
      confirmations,
      settlementToken: ethers.getAddress(deposit.settlementToken),
      amount: uintFromChain(deposit.amount, "deposit amount"),
      status,
      statusLabel: statusLabel(status),
      succeeded: deposit.succeeded,
      resultMessageId: requiredHex(deposit.resultMessageId, 32, "resultMessageId", true),
      warpNonce: requiredHex(deposit.warpNonce, 32, "warpNonce", true),
    },
    verifiedAt: new Date().toISOString(),
  });
  const evidencePath = writeEvidence(config.outputPath, evidence, "SOLSLOT_REHEARSAL_OUTPUT");
  return { ...evidence, evidencePath };
}

module.exports = {
  loadRehearsalConfig,
  readPurchaseArtifact,
  tokenAddressFromAssetId,
  validateDeposit,
  verifySettlementRehearsal,
};

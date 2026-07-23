const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { readEvidence } = require("./deployment-evidence");

const MAX_STATE_BYTES = 16 * 1024;
const PAYMENT_DEPOSITED_ABI = [
  "event PaymentDeposited(bytes32 indexed globalPaymentId, bytes32 indexed localPaymentId, address indexed depositor, address settlementToken, uint256 amount, uint64 hubChainSelector, address hubGateway, bytes32 requestMessageId, uint256 bridgeFee)",
  "event ResultReceived(bytes32 indexed globalPaymentId, bytes32 indexed resultMessageId, bytes32 indexed warpNonce, bool succeeded)",
  "event PaymentSettled(bytes32 indexed globalPaymentId, address indexed recipient, address settlementToken, uint256 amount, bool succeeded, bool emergency)",
  "function getDeposit(bytes32 globalPaymentId) view returns ((address depositor,address settlementToken,bytes32 localPaymentId,bytes32 purchaseId,bytes32 artifactHash,bytes32 collectionId,bytes32 deedLauncherId,bytes32 vaultLauncherId,bytes32 destinationPuzzle,bytes32 requestMessageId,bytes32 resultMessageId,bytes32 warpNonce,uint256 amount,uint256 quantity,uint64 hubChainSelector,address hubGateway,uint64 createdAt,uint64 quoteExpiresAt,uint8 status,bool succeeded))",
  "function deriveGlobalPaymentId(address token,bytes32 localPaymentId,bytes32 purchaseId,bytes32 artifactHash) view returns (bytes32)",
  "function settle(bytes32 globalPaymentId)",
];

function requiredHex(value, bytes, label) {
  if (!ethers.isHexString(value, bytes) || BigInt(value) === 0n) {
    throw new Error(`${label} must be a non-zero ${bytes}-byte hex value`);
  }
  return value.toLowerCase();
}

function requiredAddress(value, label) {
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${label} must be a non-zero EVM address`);
  }
  return ethers.getAddress(value);
}

function safeInteger(value, label) {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is outside the exact JSON integer range`);
  }
  return Number(parsed);
}

function escrowMessageFromDeposit(globalPaymentId, deposit, gatewayProfile) {
  if (!/^[a-z0-9_-]{1,32}$/.test(gatewayProfile)) {
    throw new Error("gateway profile is invalid");
  }
  const status = safeInteger(deposit.status, "deposit status");
  if (![1, 2, 3].includes(status) || (status >= 2 && deposit.succeeded !== true)) {
    throw new Error("deposit is not eligible for protocol verification");
  }
  return {
    gatewayProfile,
    globalPaymentId: requiredHex(globalPaymentId, 32, "globalPaymentId"),
    localPaymentId: requiredHex(deposit.localPaymentId, 32, "localPaymentId"),
    depositor: requiredAddress(deposit.depositor, "depositor"),
    settlementToken: requiredAddress(deposit.settlementToken, "settlementToken"),
    purchaseId: requiredHex(deposit.purchaseId, 32, "purchaseId"),
    artifactHash: requiredHex(deposit.artifactHash, 32, "artifactHash"),
    amount: safeInteger(deposit.amount, "amount"),
    quantity: safeInteger(deposit.quantity, "quantity"),
    collectionId: requiredHex(deposit.collectionId, 32, "collectionId"),
    deedLauncherId: requiredHex(deposit.deedLauncherId, 32, "deedLauncherId"),
    vaultLauncherId: requiredHex(deposit.vaultLauncherId, 32, "vaultLauncherId"),
    destinationPuzzle: requiredHex(deposit.destinationPuzzle, 32, "destinationPuzzle"),
    quoteExpiresAt: safeInteger(deposit.quoteExpiresAt, "quoteExpiresAt"),
  };
}

function depositDisposition(deposit) {
  const status = safeInteger(deposit.status, "deposit status");
  if (status === 1 || ((status === 2 || status === 3) && deposit.succeeded === true)) {
    return "verify";
  }
  if ((status === 2 && deposit.succeeded === false) || status === 4 || status === 5) {
    return "skip-failed";
  }
  throw new Error("deposit has an impossible relayer status");
}

function confirmedHead(latestBlock, confirmations) {
  if (!Number.isSafeInteger(latestBlock) || latestBlock < 0) {
    throw new Error("latest block is invalid");
  }
  if (!Number.isSafeInteger(confirmations) || confirmations < 12) {
    throw new Error("at least 12 confirmations are required");
  }
  return latestBlock + 1 < confirmations ? -1 : latestBlock - confirmations + 1;
}

function loadRelayerConfig(environment = process.env) {
  const activation = readEvidence(
    environment.SOLSLOT_OMNICHAIN_ACTIVATION_EVIDENCE_PATH,
    "activation",
  );
  if (
    activation.kind !== "ccip-warp-escrow-activation" ||
    activation.ownershipAccepted !== true ||
    !Number.isSafeInteger(activation.chainId) ||
    !ethers.isAddress(activation.contracts?.spoke) ||
    !ethers.isHexString(activation.runtimeCodeHashes?.spoke, 32)
  ) {
    throw new Error("activation evidence is not usable by the escrow relayer");
  }
  const callbackUrl = String(environment.SOLSLOT_ESCROW_CALLBACK_URL || "").trim();
  if (!/^https:\/\//.test(callbackUrl) || !callbackUrl.endsWith("/protocol/purchase-intents/escrow-webhook")) {
    throw new Error("SOLSLOT_ESCROW_CALLBACK_URL must be the HTTPS escrow webhook URL");
  }
  const callbackToken = String(environment.SOLSLOT_ESCROW_CALLBACK_TOKEN || "");
  if (callbackToken.length < 32) {
    throw new Error("SOLSLOT_ESCROW_CALLBACK_TOKEN must contain at least 32 characters");
  }
  const statePath = path.resolve(String(environment.SOLSLOT_ESCROW_RELAYER_STATE_PATH || ""));
  if (!environment.SOLSLOT_ESCROW_RELAYER_STATE_PATH) {
    throw new Error("SOLSLOT_ESCROW_RELAYER_STATE_PATH is required");
  }
  const startBlock = Number(environment.SOLSLOT_ESCROW_START_BLOCK);
  if (!Number.isSafeInteger(startBlock) || startBlock < 1) {
    throw new Error("SOLSLOT_ESCROW_START_BLOCK must be a positive block number");
  }
  const confirmations = Number(environment.SOLSLOT_ESCROW_CONFIRMATIONS || 12);
  confirmedHead(0, confirmations);
  const blockRange = Number(environment.SOLSLOT_ESCROW_BLOCK_RANGE || 1000);
  if (!Number.isSafeInteger(blockRange) || blockRange < 1 || blockRange > 5000) {
    throw new Error("SOLSLOT_ESCROW_BLOCK_RANGE must be between 1 and 5000");
  }
  const pollMilliseconds = Number(environment.SOLSLOT_ESCROW_POLL_MILLISECONDS || 15000);
  if (!Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 5000 || pollMilliseconds > 60000) {
    throw new Error("SOLSLOT_ESCROW_POLL_MILLISECONDS must be between 5000 and 60000");
  }
  return {
    activation,
    callbackUrl,
    callbackToken,
    statePath,
    startBlock,
    confirmations,
    blockRange,
    pollMilliseconds,
  };
}

function initialState(config) {
  return {
    schemaVersion: 1,
    activationArtifactHash: config.activation.artifactHash,
    chainId: config.activation.chainId,
    spoke: ethers.getAddress(config.activation.contracts.spoke),
    nextBlock: config.startBlock,
  };
}

function readState(config) {
  if (!fs.existsSync(config.statePath)) return initialState(config);
  const stat = fs.lstatSync(config.statePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_STATE_BYTES) {
    throw new Error("escrow relayer state path is invalid");
  }
  const state = JSON.parse(fs.readFileSync(config.statePath, "utf8"));
  const expected = initialState(config);
  if (
    state.schemaVersion !== expected.schemaVersion ||
    state.activationArtifactHash !== expected.activationArtifactHash ||
    state.chainId !== expected.chainId ||
    state.spoke !== expected.spoke ||
    !Number.isSafeInteger(state.nextBlock) ||
    state.nextBlock < config.startBlock
  ) {
    throw new Error("escrow relayer state does not match activation evidence");
  }
  return state;
}

function writeState(config, state) {
  fs.mkdirSync(path.dirname(config.statePath), { recursive: true, mode: 0o700 });
  const temporary = `${config.statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temporary, config.statePath);
}

async function postEscrowCallback(config, payload, fetchImplementation = fetch) {
  const response = await fetchImplementation(config.callbackUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.callbackToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`escrow callback returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok || body.escrow?.verified !== true || body.verification?.verified !== true) {
    throw new Error(`escrow callback rejected payment with HTTP ${response.status}`);
  }
  return body;
}

async function verifyProvider(config, provider) {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.activation.chainId) {
    throw new Error("relayer RPC chain does not match activation evidence");
  }
  const code = await provider.getCode(config.activation.contracts.spoke);
  if (code === "0x" || ethers.keccak256(code) !== config.activation.runtimeCodeHashes.spoke) {
    throw new Error("relayer spoke runtime differs from activation evidence");
  }
}

async function runOnce(
  config,
  provider,
  fetchImplementation = fetch,
  contractFactory = (address, abi, runner) => new ethers.Contract(address, abi, runner),
) {
  await verifyProvider(config, provider);
  const state = readState(config);
  const latestBlock = await provider.getBlockNumber();
  const safeBlock = confirmedHead(latestBlock, config.confirmations);
  if (safeBlock < state.nextBlock) return { processed: 0, nextBlock: state.nextBlock };

  const spoke = contractFactory(config.activation.contracts.spoke, PAYMENT_DEPOSITED_ABI, provider);
  const event = spoke.interface.getEvent("PaymentDeposited");
  let processed = 0;
  let skipped = 0;
  for (let fromBlock = state.nextBlock; fromBlock <= safeBlock; fromBlock += config.blockRange) {
    const toBlock = Math.min(safeBlock, fromBlock + config.blockRange - 1);
    const logs = await provider.getLogs({
      address: config.activation.contracts.spoke,
      topics: [event.topicHash],
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      const parsed = spoke.interface.parseLog(log);
      const globalPaymentId = parsed.args.globalPaymentId;
      const deposit = await spoke.getDeposit(globalPaymentId);
      if (
        requiredHex(parsed.args.localPaymentId, 32, "event localPaymentId")
          !== requiredHex(deposit.localPaymentId, 32, "deposit localPaymentId")
        || requiredAddress(parsed.args.depositor, "event depositor")
          !== requiredAddress(deposit.depositor, "deposit depositor")
        || requiredAddress(parsed.args.settlementToken, "event settlementToken")
          !== requiredAddress(deposit.settlementToken, "deposit settlementToken")
      ) {
        throw new Error("confirmed escrow event differs from the stored deposit");
      }
      if (depositDisposition(deposit) === "skip-failed") {
        skipped += 1;
        continue;
      }
      const escrowMessage = escrowMessageFromDeposit(
        globalPaymentId,
        deposit,
        config.activation.gatewayProfile,
      );
      const block = await provider.getBlock(log.blockNumber);
      if (!block || block.hash !== log.blockHash) {
        throw new Error("confirmed escrow log block could not be authenticated");
      }
      await postEscrowCallback(
        config,
        {
          escrowMessage,
          source: {
            chainId: config.activation.chainId,
            spoke: ethers.getAddress(config.activation.contracts.spoke),
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            blockTimestamp: safeInteger(block.timestamp, "block timestamp"),
            logIndex: log.index,
            confirmations: latestBlock - log.blockNumber + 1,
          },
        },
        fetchImplementation,
      );
      processed += 1;
    }
    state.nextBlock = toBlock + 1;
    writeState(config, state);
  }
  return { processed, skipped, nextBlock: state.nextBlock };
}

module.exports = {
  PAYMENT_DEPOSITED_ABI,
  confirmedHead,
  depositDisposition,
  escrowMessageFromDeposit,
  initialState,
  loadRelayerConfig,
  postEscrowCallback,
  readState,
  runOnce,
  verifyProvider,
  writeState,
};

const crypto = require("node:crypto");
const { ethers } = require("ethers");
const {
  PAYMENT_DEPOSITED_ABI,
  verifyProvider,
} = require("./escrow-relayer");

const AUTHORIZATION_SCHEMA = "solslot.base-voucher-settlement-authorization.v2";
const GATEWAY_ABI = [
  "function getRequest(bytes32 globalPaymentId) view returns (((uint64 originChainSelector,address originSpoke,bytes32 globalPaymentId,bytes32 purchaseId,bytes32 artifactHash,uint256 amount,uint256 quantity,bytes32 collectionId,bytes32 deedLauncherId,bytes32 vaultLauncherId,bytes32 destinationPuzzle,uint64 hubChainSelector,address hubGateway,uint64 quoteExpiresAt) request,bytes32 inboundMessageId,bytes32 outboundMessageId,bytes32 warpNonce,uint64 queuedAt,uint8 status,bool succeeded))",
  "function forwardResult(bytes32 globalPaymentId) returns (bytes32 messageId)",
];
const MAX_RESPONSE_BYTES = 128 * 1024;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
  ).join(",")}}`;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const observed = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (observed.length !== wanted.length || observed.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields are invalid`);
  }
  return value;
}

function requiredHex(value, bytes, label) {
  if (!ethers.isHexString(value, bytes) || BigInt(value) === 0n) {
    throw new Error(`${label} must be a non-zero ${bytes}-byte hex value`);
  }
  return value.toLowerCase();
}

function exactInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an exact integer`);
  }
  return value;
}

function uintFromChain(value, label) {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is outside the exact JSON integer range`);
  }
  return Number(parsed);
}

function paddedAddress(address) {
  return ethers.zeroPadValue(ethers.getAddress(address), 32).toLowerCase();
}

function loadSettlementConfig(config, environment = process.env) {
  const settlementUrl = String(environment.SOLSLOT_BASE_SETTLEMENT_URL || "").trim();
  if (
    !settlementUrl.startsWith("https://")
    || !settlementUrl.endsWith("/presales/base-settlements")
  ) {
    throw new Error(
      "SOLSLOT_BASE_SETTLEMENT_URL must be the HTTPS Base settlement API URL",
    );
  }
  const privateKey = String(environment.SOLSLOT_ESCROW_RELAYER_PRIVATE_KEY || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey) || BigInt(privateKey) === 0n) {
    throw new Error("SOLSLOT_ESCROW_RELAYER_PRIVATE_KEY is required");
  }
  if (
    !ethers.isAddress(config.activation.contracts?.gateway)
    || !ethers.isAddress(config.activation.governanceRootSafe)
    || !ethers.isHexString(config.activation.runtimeCodeHashes?.gateway, 32)
  ) {
    throw new Error("activation evidence lacks the gateway or payout Safe");
  }
  return {
    ...config,
    settlementUrl,
    privateKey,
  };
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} returned an oversized response`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`);
  }
}

async function pendingAuthorizations(config, fetchImplementation = fetch) {
  const response = await fetchImplementation(`${config.settlementUrl}/pending?limit=100`, {
    method: "GET",
    headers: { Authorization: `Bearer ${config.callbackToken}` },
    signal: AbortSignal.timeout(20000),
  });
  const body = await readJsonResponse(response, "settlement authorization API");
  if (
    !response.ok
    || body.schema !== AUTHORIZATION_SCHEMA
    || !Array.isArray(body.authorizations)
  ) {
    throw new Error(`settlement authorization API rejected HTTP ${response.status}`);
  }
  return body.authorizations;
}

function validateAuthorization(envelope, activation, deposit) {
  exactKeys(
    envelope,
    [
      "authorizationId",
      "authorizationHash",
      "state",
      "authorization",
      "createdAt",
      "relayedAt",
      "relayEvidence",
    ],
    "settlement authorization envelope",
  );
  const authorization = exactKeys(
    envelope.authorization,
    [
      "schema",
      "outcome",
      "globalPaymentId",
      "purchaseId",
      "purchaseArtifactHash",
      "termsHash",
      "seriesSingletonId",
      "collectionId",
      "metadataRoot",
      "allocationRoot",
      "serial",
      "deedLauncherId",
      "vaultLauncherId",
      "vaultP2PuzzleHash",
      "originalPayer",
      "payment",
      "chia",
    ],
    "settlement authorization",
  );
  if (
    envelope.state !== "PENDING"
    || authorization.schema !== AUTHORIZATION_SCHEMA
    || !["DELIVERED", "REFUND"].includes(authorization.outcome)
  ) {
    throw new Error("settlement authorization state or outcome is invalid");
  }
  const digest = `0x${crypto.createHash("sha256").update(canonicalJson(authorization)).digest("hex")}`;
  if (
    requiredHex(envelope.authorizationId, 32, "authorizationId") !== digest
    || requiredHex(envelope.authorizationHash, 32, "authorizationHash") !== digest
  ) {
    throw new Error("settlement authorization hash changed");
  }
  const bindings = [
    ["globalPaymentId", deposit.globalPaymentId],
    ["purchaseId", deposit.purchaseId],
    ["purchaseArtifactHash", deposit.artifactHash],
    ["collectionId", deposit.collectionId],
    ["deedLauncherId", deposit.deedLauncherId],
    ["vaultLauncherId", deposit.vaultLauncherId],
    ["vaultP2PuzzleHash", deposit.destinationPuzzle],
  ];
  for (const [field, expected] of bindings) {
    if (requiredHex(authorization[field], 32, field) !== String(expected).toLowerCase()) {
      throw new Error(`settlement authorization changes ${field}`);
    }
  }
  if (
    requiredHex(authorization.originalPayer, 32, "originalPayer").slice(-40)
    !== ethers.getAddress(deposit.depositor).toLowerCase().slice(2)
  ) {
    throw new Error("settlement authorization changes the original depositor");
  }
  const payment = exactKeys(
    authorization.payment,
    [
      "rail",
      "chainId",
      "assetId",
      "assetDecimals",
      "escrowContract",
      "principal",
      "evidenceHash",
    ],
    "settlement payment",
  );
  if (
    payment.rail !== "BASE_SEPOLIA_USDC"
    || payment.chainId !== activation.chainId
    || payment.assetDecimals !== 6
    || exactInteger(payment.principal, "payment principal", 1)
      !== uintFromChain(deposit.amount, "deposit amount")
    || requiredHex(payment.assetId, 32, "payment asset") !== paddedAddress(deposit.settlementToken)
    || requiredHex(payment.escrowContract, 32, "escrow contract")
      !== paddedAddress(activation.contracts.spoke)
  ) {
    throw new Error("settlement payment differs from the escrow deposit");
  }
  requiredHex(payment.evidenceHash, 32, "payment evidence hash");
  return { envelope, authorization, succeeded: authorization.outcome === "DELIVERED" };
}

async function verifySettlementProvider(config, provider) {
  await verifyProvider(config, provider);
  const gatewayCode = await provider.getCode(config.activation.contracts.gateway);
  if (
    gatewayCode === "0x"
    || ethers.keccak256(gatewayCode) !== config.activation.runtimeCodeHashes.gateway
  ) {
    throw new Error("relayer gateway runtime differs from activation evidence");
  }
}

function validateGatewayRequest(authorization, gatewayRecord, succeeded) {
  const request = gatewayRecord.request;
  const bindings = [
    ["globalPaymentId", request.globalPaymentId],
    ["purchaseId", request.purchaseId],
    ["purchaseArtifactHash", request.artifactHash],
    ["collectionId", request.collectionId],
    ["deedLauncherId", request.deedLauncherId],
    ["vaultLauncherId", request.vaultLauncherId],
    ["vaultP2PuzzleHash", request.destinationPuzzle],
  ];
  for (const [field, expected] of bindings) {
    if (requiredHex(authorization[field], 32, field) !== String(expected).toLowerCase()) {
      throw new Error(`Solomon gateway changes ${field}`);
    }
  }
  if (
    uintFromChain(request.amount, "gateway amount") !== authorization.payment.principal
    || uintFromChain(request.quantity, "gateway quantity") !== 1
    || (uintFromChain(gatewayRecord.status, "gateway status") >= 3
      && gatewayRecord.succeeded !== succeeded)
  ) {
    throw new Error("Solomon gateway result differs from authorization");
  }
}

async function settlementReceipt(config, spoke, globalPaymentId, provider) {
  const events = await spoke.queryFilter(
    spoke.filters.PaymentSettled(globalPaymentId),
    config.startBlock,
    "latest",
  );
  if (events.length !== 1) {
    throw new Error("settled payment must have exactly one terminal event");
  }
  const receipt = await provider.getTransactionReceipt(events[0].transactionHash);
  if (!receipt || receipt.status !== 1) {
    throw new Error("settlement transaction receipt is unavailable");
  }
  const latest = await provider.getBlockNumber();
  if (latest - receipt.blockNumber + 1 < config.confirmations) {
    return null;
  }
  return receipt;
}

function validateSettlementReceipt(
  spoke,
  receipt,
  {
    globalPaymentId,
    deposit,
    succeeded,
    activation,
  },
) {
  const parsed = receipt.logs
    .filter(
      (log) => ethers.getAddress(log.address) === ethers.getAddress(activation.contracts.spoke),
    )
    .map((log) => {
      try {
        return spoke.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter((event) => event?.name === "PaymentSettled");
  if (parsed.length !== 1) {
    throw new Error("settlement receipt must contain one PaymentSettled event");
  }
  const event = parsed[0];
  const expectedRecipient = succeeded
    ? activation.governanceRootSafe
    : deposit.depositor;
  if (
    requiredHex(event.args.globalPaymentId, 32, "settled globalPaymentId")
      !== globalPaymentId
    || ethers.getAddress(event.args.recipient) !== ethers.getAddress(expectedRecipient)
    || ethers.getAddress(event.args.settlementToken)
      !== ethers.getAddress(deposit.settlementToken)
    || uintFromChain(event.args.amount, "settled amount")
      !== uintFromChain(deposit.amount, "deposit amount")
    || event.args.succeeded !== succeeded
    || event.args.emergency !== false
  ) {
    throw new Error("PaymentSettled event differs from authorization");
  }
}

async function acknowledgeAuthorization(
  config,
  envelope,
  evidence,
  fetchImplementation = fetch,
) {
  const response = await fetchImplementation(
    `${config.settlementUrl}/${envelope.authorizationId}/relay-evidence`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.callbackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(evidence),
      signal: AbortSignal.timeout(20000),
    },
  );
  const body = await readJsonResponse(response, "settlement acknowledgement API");
  if (
    !response.ok
    || body.authorizationId !== envelope.authorizationId
    || body.state !== "RELAYED"
  ) {
    throw new Error(`settlement acknowledgement failed HTTP ${response.status}`);
  }
  return body;
}

async function settleAuthorization(
  config,
  envelope,
  provider,
  signer,
  fetchImplementation = fetch,
  contractFactory = (address, abi, runner) => new ethers.Contract(address, abi, runner),
) {
  const spoke = contractFactory(
    config.activation.contracts.spoke,
    PAYMENT_DEPOSITED_ABI,
    signer,
  );
  const gateway = contractFactory(
    config.activation.contracts.gateway,
    GATEWAY_ABI,
    signer,
  );
  const globalPaymentId = envelope.authorization.globalPaymentId;
  let deposit = await spoke.getDeposit(globalPaymentId);
  const normalizedDeposit = { ...deposit, globalPaymentId };
  const validated = validateAuthorization(
    envelope,
    config.activation,
    normalizedDeposit,
  );
  let gatewayRecord = await gateway.getRequest(globalPaymentId);
  validateGatewayRequest(validated.authorization, gatewayRecord, validated.succeeded);
  let gatewayStatus = uintFromChain(gatewayRecord.status, "gateway status");
  if (gatewayStatus < 3) {
    return { authorizationId: envelope.authorizationId, status: "WAITING_FOR_WARP" };
  }
  if (gatewayStatus === 3) {
    const transaction = await gateway.forwardResult(globalPaymentId);
    await transaction.wait(1);
    gatewayRecord = await gateway.getRequest(globalPaymentId);
    validateGatewayRequest(validated.authorization, gatewayRecord, validated.succeeded);
    gatewayStatus = uintFromChain(gatewayRecord.status, "gateway status");
  }
  if (gatewayStatus !== 4) {
    throw new Error("Solomon gateway has an impossible terminal status");
  }

  deposit = await spoke.getDeposit(globalPaymentId);
  let depositStatus = uintFromChain(deposit.status, "deposit status");
  let receipt;
  if (depositStatus === 2) {
    if (deposit.succeeded !== validated.succeeded) {
      throw new Error("spoke result differs from authorization");
    }
    const transaction = await spoke.settle(globalPaymentId);
    receipt = await transaction.wait(config.confirmations);
    if (!receipt || receipt.status !== 1) {
      throw new Error("spoke settlement transaction failed");
    }
    deposit = await spoke.getDeposit(globalPaymentId);
    depositStatus = uintFromChain(deposit.status, "deposit status");
  } else if (depositStatus === 3 || depositStatus === 4) {
    receipt = await settlementReceipt(config, spoke, globalPaymentId, provider);
    if (!receipt) {
      return {
        authorizationId: envelope.authorizationId,
        status: "WAITING_FOR_CONFIRMATIONS",
      };
    }
  } else {
    throw new Error("spoke has not received the authenticated Solomon result");
  }
  const expectedStatus = validated.succeeded ? 3 : 4;
  if (depositStatus !== expectedStatus || deposit.succeeded !== validated.succeeded) {
    throw new Error("spoke terminal state differs from authorization");
  }
  validateSettlementReceipt(spoke, receipt, {
    globalPaymentId,
    deposit,
    succeeded: validated.succeeded,
    activation: config.activation,
  });
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block) throw new Error("settlement block is unavailable");
  const evidence = {
    warpMessageId: requiredHex(gatewayRecord.warpNonce, 32, "warp nonce"),
    baseTransactionHash: requiredHex(receipt.hash, 32, "settlement transaction hash"),
    confirmedBlockNumber: exactInteger(receipt.blockNumber, "settlement block", 1),
    confirmedAt: exactInteger(block.timestamp, "settlement block timestamp", 1),
  };
  await acknowledgeAuthorization(
    config,
    envelope,
    evidence,
    fetchImplementation,
  );
  return {
    authorizationId: envelope.authorizationId,
    status: validated.succeeded ? "SETTLED_SUCCESS" : "SETTLED_REFUND",
    evidence,
  };
}

async function runBaseSettlements(
  config,
  provider,
  signer,
  fetchImplementation = fetch,
  contractFactory,
) {
  await verifySettlementProvider(config, provider);
  const authorizations = await pendingAuthorizations(config, fetchImplementation);
  const results = [];
  for (const authorization of authorizations) {
    results.push(
      await settleAuthorization(
        config,
        authorization,
        provider,
        signer,
        fetchImplementation,
        contractFactory,
      ),
    );
  }
  return results;
}

module.exports = {
  AUTHORIZATION_SCHEMA,
  GATEWAY_ABI,
  acknowledgeAuthorization,
  canonicalJson,
  loadSettlementConfig,
  pendingAuthorizations,
  runBaseSettlements,
  settleAuthorization,
  validateAuthorization,
  validateGatewayRequest,
  validateSettlementReceipt,
  verifySettlementProvider,
};

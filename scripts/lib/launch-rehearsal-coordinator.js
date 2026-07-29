const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const {
  readEvidence,
  sha256,
  stableJson,
} = require("./deployment-evidence");
const {
  normalizePurchaseArtifact,
  tokenAddressFromAssetId,
} = require("./settlement-rehearsal");
const {
  PAYMENT_DEPOSITED_ABI,
  verifyProvider,
} = require("./escrow-relayer");

const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const CONFIG_KIND = "solslot-rc22-launch-rehearsal-config";
const EVIDENCE_KIND = "solslot-rc22-settlement-rehearsal";
const MAX_JSON_BYTES = 256 * 1024;
const HEX32 = /^0x[0-9a-f]{64}$/;
const JOB_ID = /^rehearsal_[0-9a-f]{64}$/;
const PHASES = {
  APPROVE_DELIVERY: { lane: "delivery", action: "approve", completedSteps: 0 },
  PAY_DELIVERY: { lane: "delivery", action: "pay", completedSteps: 0 },
  VERIFY_DELIVERY: { lane: "delivery", action: "verify", completedSteps: 1 },
  APPROVE_REFUND: { lane: "refund", action: "approve", completedSteps: 2 },
  PAY_REFUND: { lane: "refund", action: "pay", completedSteps: 2 },
  VERIFY_REFUND: { lane: "refund", action: "verify", completedSteps: 3 },
  COMPLETE: { lane: null, action: "complete", completedSteps: 4 },
};
const TOKEN_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
];
const SPOKE_ABI = [
  ...PAYMENT_DEPOSITED_ABI,
  "function quoteDepositFee(address token,bytes32 localPaymentId,bytes32 purchaseId,bytes32 artifactHash,bytes32 collectionId,bytes32 deedLauncherId,bytes32 vaultLauncherId,bytes32 destinationPuzzle,uint256 amount,uint256 quantity,uint64 quoteExpiresAt,address depositor) view returns (uint256)",
  "function depositPayment(address token,bytes32 localPaymentId,bytes32 purchaseId,bytes32 artifactHash,bytes32 collectionId,bytes32 deedLauncherId,bytes32 vaultLauncherId,bytes32 destinationPuzzle,uint256 amount,uint256 quantity,uint64 quoteExpiresAt) payable returns (bytes32 globalPaymentId,bytes32 messageId)",
  "function globalPaymentForPurchase(bytes32 purchaseId) view returns (bytes32)",
];

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} fields are invalid`);
  }
  return value;
}

function exactInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an exact integer`);
  }
  return value;
}

function requiredHex(value, bytes, label, allowZero = false) {
  if (
    !ethers.isHexString(value, bytes)
    || (!allowZero && BigInt(value) === 0n)
  ) {
    throw new Error(`${label} must be a ${allowZero ? "" : "non-zero "}${bytes}-byte hex value`);
  }
  return value.toLowerCase();
}

function requiredAddress(value, label) {
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${label} must be a non-zero EVM address`);
  }
  return ethers.getAddress(value);
}

function readBoundedJson(inputPath, label) {
  const resolved = path.resolve(String(inputPath || ""));
  if (!inputPath) throw new Error(`${label} path is required`);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size <= 0
    || stat.size > MAX_JSON_BYTES
  ) {
    throw new Error(`${label} path is invalid`);
  }
  const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function normalizedValidator(value, index) {
  exactKeys(value, ["id", "evidenceHash"], `validator ${index + 1}`);
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(value.id)) {
    throw new Error(`validator ${index + 1} id is invalid`);
  }
  return {
    id: value.id,
    evidenceHash: requiredHex(value.evidenceHash, 32, `validator ${index + 1} evidenceHash`),
  };
}

function normalizedLane(value, name, activation) {
  exactKeys(
    value,
    ["localPaymentId", "expectedOutcome", "purchaseArtifactV2"],
    `${name} lane`,
  );
  const expectedOutcome = name === "delivery" ? "DELIVERED" : "REFUND";
  if (value.expectedOutcome !== expectedOutcome) {
    throw new Error(`${name} lane outcome must be ${expectedOutcome}`);
  }
  const purchaseArtifact = normalizePurchaseArtifact(value.purchaseArtifactV2);
  if (
    purchaseArtifact.railChainId !== BASE_SEPOLIA_CHAIN_ID
    || tokenAddressFromAssetId(purchaseArtifact.railAssetId)
      !== ethers.getAddress(BASE_SEPOLIA_USDC)
  ) {
    throw new Error(`${name} lane must use official Base Sepolia USDC`);
  }
  if (
    purchaseArtifact.collectionId === activation.zero
    || purchaseArtifact.deedLauncherId === activation.zero
  ) {
    throw new Error(`${name} lane must target a governed canary deed`);
  }
  return {
    localPaymentId: requiredHex(value.localPaymentId, 32, `${name} localPaymentId`),
    expectedOutcome,
    purchaseArtifact,
  };
}

function loadCoordinatorConfig(environment = process.env) {
  const activation = readEvidence(
    environment.SOLSLOT_OMNICHAIN_ACTIVATION_EVIDENCE_PATH,
    "activation",
  );
  if (
    activation.kind !== "ccip-warp-escrow-activation"
    || activation.ownershipAccepted !== true
    || activation.chainId !== BASE_SEPOLIA_CHAIN_ID
    || !ethers.isAddress(activation.contracts?.spoke)
    || !ethers.isAddress(activation.contracts?.gateway)
    || !ethers.isHexString(activation.runtimeCodeHashes?.spoke, 32)
  ) {
    throw new Error("activation evidence is not ready for the launch rehearsal");
  }
  const envelope = readBoundedJson(
    environment.SOLSLOT_LAUNCH_REHEARSAL_CONFIG_PATH,
    "launch rehearsal config",
  );
  exactKeys(envelope, ["configHash", "payload"], "launch rehearsal config");
  const configHash = requiredHex(envelope.configHash, 32, "configHash");
  if (sha256(envelope.payload) !== configHash) {
    throw new Error("launch rehearsal config hash mismatches");
  }
  const payload = exactKeys(
    envelope.payload,
    [
      "schemaVersion",
      "kind",
      "releaseTag",
      "releaseEvidenceHash",
      "network",
      "chainId",
      "confirmations",
      "activationArtifactHash",
      "settlementApiUrl",
      "allowedWallets",
      "validatorThreshold",
      "validators",
      "lanes",
    ],
    "launch rehearsal payload",
  );
  if (
    payload.schemaVersion !== 1
    || payload.kind !== CONFIG_KIND
    || payload.network !== "testnet11-base-sepolia"
    || payload.chainId !== BASE_SEPOLIA_CHAIN_ID
    || payload.validatorThreshold !== 2
    || payload.activationArtifactHash !== activation.artifactHash
    || !/^solslot-v2-alpha-rc[0-9]+-[0-9]{8}$/.test(payload.releaseTag)
    || !/^https:\/\/[^/]+\/.+\/presales\/base-settlements$/.test(payload.settlementApiUrl)
  ) {
    throw new Error("launch rehearsal payload is incompatible with RC22");
  }
  const confirmations = exactInteger(payload.confirmations, "confirmations", 12);
  if (!Array.isArray(payload.allowedWallets) || payload.allowedWallets.length !== 3) {
    throw new Error("launch rehearsal requires the three enrolled administrator wallets");
  }
  const allowedWallets = payload.allowedWallets.map((wallet, index) =>
    requiredAddress(wallet, `allowed wallet ${index + 1}`));
  if (new Set(allowedWallets.map((value) => value.toLowerCase())).size !== 3) {
    throw new Error("launch rehearsal administrator wallets must be unique");
  }
  if (!Array.isArray(payload.validators) || payload.validators.length !== 3) {
    throw new Error("launch rehearsal requires three validators");
  }
  const validators = payload.validators.map(normalizedValidator);
  if (new Set(validators.map((item) => stableJson(item))).size !== 3) {
    throw new Error("launch rehearsal validator evidence must be unique");
  }
  exactKeys(payload.lanes, ["delivery", "refund"], "launch rehearsal lanes");
  const laneContext = { zero: `0x${"00".repeat(32)}` };
  const lanes = {
    delivery: normalizedLane(payload.lanes.delivery, "delivery", laneContext),
    refund: normalizedLane(payload.lanes.refund, "refund", laneContext),
  };
  if (lanes.delivery.purchaseArtifact.purchaseId === lanes.refund.purchaseArtifact.purchaseId) {
    throw new Error("delivery and refund lanes require different purchase artifacts");
  }
  return {
    activation,
    configHash,
    releaseTag: payload.releaseTag,
    releaseEvidenceHash: requiredHex(
      payload.releaseEvidenceHash,
      32,
      "releaseEvidenceHash",
    ),
    network: payload.network,
    confirmations,
    settlementApiUrl: payload.settlementApiUrl.replace(/\/$/, ""),
    allowedWallets,
    validatorThreshold: 2,
    validators,
    lanes,
  };
}

function readSecretFile(inputPath, label) {
  const resolved = path.resolve(String(inputPath || ""));
  if (!inputPath) throw new Error(`${label} file is required`);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size < 32
    || stat.size > 4096
    || (stat.mode & 0o077) !== 0
  ) {
    throw new Error(`${label} file must be a private regular file`);
  }
  const value = fs.readFileSync(resolved, "utf8").trim();
  if (value.length < 32 || /[\r\n]/.test(value)) {
    throw new Error(`${label} must contain one secret of at least 32 characters`);
  }
  return value;
}

function loadCoordinatorSecrets(environment = process.env) {
  return {
    serviceToken: readSecretFile(
      environment.SOLSLOT_LAUNCH_REHEARSAL_TOKEN_FILE,
      "service token",
    ),
    evidenceHmacSecret: readSecretFile(
      environment.SOLSLOT_LAUNCH_REHEARSAL_HMAC_FILE,
      "evidence HMAC",
    ),
    settlementApiToken: readSecretFile(
      environment.SOLSLOT_LAUNCH_REHEARSAL_API_TOKEN_FILE,
      "settlement API token",
    ),
  };
}

function transactionShape(to, data) {
  return {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    to: requiredAddress(to, "transaction target"),
    value: "0x0",
    data: String(data).toLowerCase(),
  };
}

function laneDepositArguments(lane) {
  const artifact = lane.purchaseArtifact;
  return [
    tokenAddressFromAssetId(artifact.railAssetId),
    lane.localPaymentId,
    artifact.purchaseId,
    artifact.artifactHash,
    artifact.collectionId,
    artifact.deedLauncherId,
    artifact.vaultLauncherId,
    artifact.vaultP2PuzzleHash,
    artifact.railAmount,
    1,
    artifact.quoteExpiresAt,
  ];
}

function atomicWriteJson(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporary = `${outputPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temporary, outputPath);
}

function exactRequest(value) {
  exactKeys(
    value,
    [
      "ceremonyId",
      "releaseTag",
      "releaseEvidenceHash",
      "configHash",
      "network",
      "requiredLanes",
      "walletAddress",
    ],
    "rehearsal start request",
  );
  if (
    !Array.isArray(value.requiredLanes)
    || stableJson(value.requiredLanes) !== stableJson(["delivery", "refund"])
  ) {
    throw new Error("rehearsal must require delivery and refund lanes");
  }
  return value;
}

function jobIdentifier(request, config) {
  const digest = crypto.createHash("sha256").update(stableJson({
    ceremonyId: request.ceremonyId,
    configHash: config.configHash,
    walletAddress: request.walletAddress.toLowerCase(),
  })).digest("hex");
  return `rehearsal_${digest}`;
}

function uintFromChain(value, label) {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is outside the exact JSON integer range`);
  }
  return Number(parsed);
}

class LaunchRehearsalCoordinator {
  constructor({
    config,
    secrets,
    stateDirectory,
    provider,
    fetchImplementation = fetch,
    now = () => Math.floor(Date.now() / 1000),
    contractFactory = (address, abi, runner) => new ethers.Contract(address, abi, runner),
  }) {
    this.config = config;
    this.secrets = secrets;
    this.stateDirectory = path.resolve(stateDirectory);
    this.provider = provider;
    this.fetchImplementation = fetchImplementation;
    this.now = now;
    this.contractFactory = contractFactory;
  }

  jobPath(jobId) {
    if (!JOB_ID.test(jobId)) throw new Error("rehearsal job id is invalid");
    return path.join(this.stateDirectory, `${jobId}.json`);
  }

  readJob(jobId) {
    const value = readBoundedJson(this.jobPath(jobId), "rehearsal job");
    if (
      value.schemaVersion !== 1
      || value.jobId !== jobId
      || value.configHash !== this.config.configHash
      || !PHASES[value.phase]
    ) {
      throw new Error("stored rehearsal job does not match the active configuration");
    }
    return value;
  }

  writeJob(job) {
    atomicWriteJson(this.jobPath(job.jobId), job);
  }

  async verifyRuntime() {
    await verifyProvider(this.config, this.provider);
  }

  async start(value) {
    const request = exactRequest(value);
    const walletAddress = requiredAddress(request.walletAddress, "walletAddress");
    if (
      request.releaseTag !== this.config.releaseTag
      || String(request.releaseEvidenceHash).toLowerCase() !== this.config.releaseEvidenceHash
      || String(request.configHash).toLowerCase() !== this.config.configHash
      || request.network !== this.config.network
      || !this.config.allowedWallets.some(
        (item) => item.toLowerCase() === walletAddress.toLowerCase(),
      )
    ) {
      throw new Error("rehearsal request differs from the signed release configuration");
    }
    for (const lane of Object.values(this.config.lanes)) {
      if (lane.purchaseArtifact.quoteExpiresAt <= this.now() + 600) {
        throw new Error("rehearsal purchase artifact expires too soon");
      }
    }
    await this.verifyRuntime();
    const jobId = jobIdentifier({ ...request, walletAddress }, this.config);
    if (fs.existsSync(this.jobPath(jobId))) {
      return this.get(jobId);
    }
    const job = {
      schemaVersion: 1,
      jobId,
      configHash: this.config.configHash,
      ceremonyId: request.ceremonyId,
      walletAddress,
      phase: "APPROVE_DELIVERY",
      pendingTransaction: null,
      transactions: {},
      lanes: {},
      createdAt: this.now(),
      updatedAt: this.now(),
      error: null,
    };
    job.walletTransaction = this.approvalTransaction("delivery");
    this.writeJob(job);
    return this.render(job);
  }

  approvalTransaction(laneName) {
    const lane = this.config.lanes[laneName];
    const token = tokenAddressFromAssetId(lane.purchaseArtifact.railAssetId);
    const iface = new ethers.Interface(TOKEN_ABI);
    return transactionShape(
      token,
      iface.encodeFunctionData("approve", [
        this.config.activation.contracts.spoke,
        lane.purchaseArtifact.railAmount,
      ]),
    );
  }

  async paymentTransaction(laneName, walletAddress) {
    const lane = this.config.lanes[laneName];
    const args = laneDepositArguments(lane);
    const spoke = this.contractFactory(
      this.config.activation.contracts.spoke,
      SPOKE_ABI,
      this.provider,
    );
    const fee = await spoke.quoteDepositFee(...args, walletAddress);
    if (BigInt(fee) !== 0n) {
      throw new Error("rehearsal route unexpectedly requires a value-bearing bridge fee");
    }
    return transactionShape(
      this.config.activation.contracts.spoke,
      spoke.interface.encodeFunctionData("depositPayment", args),
    );
  }

  async get(jobId) {
    const job = this.readJob(jobId);
    if (job.pendingTransaction) {
      await this.confirmPending(job);
    }
    if (PHASES[job.phase].action === "verify") {
      await this.verifyLane(job, PHASES[job.phase].lane);
    }
    return this.render(job);
  }

  async submit(jobId, transactionHash) {
    const job = this.readJob(jobId);
    const phase = PHASES[job.phase];
    if (!["approve", "pay"].includes(phase.action) || !job.walletTransaction) {
      throw new Error("the rehearsal is not waiting for a wallet transaction");
    }
    const normalizedHash = requiredHex(transactionHash, 32, "transactionHash");
    if (Object.values(job.transactions).includes(normalizedHash)) {
      throw new Error("rehearsal transaction was already used");
    }
    const transaction = await this.provider.getTransaction(normalizedHash);
    if (!transaction) {
      throw new Error("rehearsal transaction is not visible on Base Sepolia");
    }
    const expected = job.walletTransaction;
    if (
      !transaction.to
      || requiredAddress(transaction.from, "transaction sender").toLowerCase()
        !== job.walletAddress.toLowerCase()
      || requiredAddress(transaction.to, "transaction recipient").toLowerCase()
        !== expected.to.toLowerCase()
      || BigInt(transaction.value || 0) !== 0n
      || String(transaction.data || "").toLowerCase() !== expected.data
      || Number(transaction.chainId ?? BASE_SEPOLIA_CHAIN_ID) !== BASE_SEPOLIA_CHAIN_ID
    ) {
      throw new Error("submitted transaction differs from the reviewed wallet step");
    }
    job.pendingTransaction = {
      hash: normalizedHash,
      phase: job.phase,
      lane: phase.lane,
      action: phase.action,
    };
    job.transactions[job.phase] = normalizedHash;
    job.walletTransaction = null;
    job.updatedAt = this.now();
    this.writeJob(job);
    return this.render(job);
  }

  async confirmPending(job) {
    const pending = job.pendingTransaction;
    const receipt = await this.provider.getTransactionReceipt(pending.hash);
    if (!receipt) return;
    if (receipt.status !== 1) {
      job.pendingTransaction = null;
      job.walletTransaction = pending.action === "approve"
        ? this.approvalTransaction(pending.lane)
        : await this.paymentTransaction(pending.lane, job.walletAddress);
      delete job.transactions[pending.phase];
      job.lastMessage = "That test transaction failed. Review and try the same fixed step again.";
      job.updatedAt = this.now();
      this.writeJob(job);
      return;
    }
    const latest = await this.provider.getBlockNumber();
    if (latest - receipt.blockNumber + 1 < this.config.confirmations) return;
    if (pending.action === "approve") {
      job.phase = pending.lane === "delivery" ? "PAY_DELIVERY" : "PAY_REFUND";
      job.walletTransaction = await this.paymentTransaction(
        pending.lane,
        job.walletAddress,
      );
    } else {
      const lane = this.config.lanes[pending.lane];
      const spoke = this.contractFactory(
        this.config.activation.contracts.spoke,
        SPOKE_ABI,
        this.provider,
      );
      const deposits = receipt.logs
        .filter((log) =>
          ethers.getAddress(log.address)
            === ethers.getAddress(this.config.activation.contracts.spoke))
        .map((log) => {
          try {
            return spoke.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .filter((event) => event?.name === "PaymentDeposited");
      if (deposits.length !== 1) {
        throw new Error("payment transaction did not create exactly one escrow deposit");
      }
      const globalPaymentId = requiredHex(
        deposits[0].args.globalPaymentId,
        32,
        "globalPaymentId",
      );
      const storedPaymentId = await spoke.globalPaymentForPurchase(
        lane.purchaseArtifact.purchaseId,
      );
      if (String(storedPaymentId).toLowerCase() !== globalPaymentId) {
        throw new Error("escrow purchase mapping differs from the submitted payment");
      }
      job.lanes[pending.lane] = {
        globalPaymentId,
        depositTransactionHash: pending.hash,
      };
      job.phase = pending.lane === "delivery" ? "VERIFY_DELIVERY" : "VERIFY_REFUND";
    }
    job.pendingTransaction = null;
    job.updatedAt = this.now();
    this.writeJob(job);
  }

  async settlementAuthorization(globalPaymentId) {
    const response = await this.fetchImplementation(
      `${this.config.settlementApiUrl}/by-payment/${globalPaymentId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.secrets.settlementApiToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20000),
      },
    );
    if (response.status === 404) return null;
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
      throw new Error("settlement API response is oversized");
    }
    const body = JSON.parse(text);
    if (!response.ok) {
      throw new Error(`settlement API rejected the rehearsal with HTTP ${response.status}`);
    }
    return body;
  }

  validateAuthorization(laneName, job, deposit, envelope) {
    const lane = this.config.lanes[laneName];
    const artifact = lane.purchaseArtifact;
    const authorization = envelope?.authorization;
    if (
      envelope?.state !== "RELAYED"
      || !authorization
      || authorization.outcome !== lane.expectedOutcome
      || authorization.globalPaymentId !== job.lanes[laneName].globalPaymentId
      || authorization.purchaseId !== artifact.purchaseId
      || authorization.purchaseArtifactHash !== artifact.artifactHash
      || authorization.collectionId !== artifact.collectionId
      || authorization.deedLauncherId !== artifact.deedLauncherId
      || authorization.vaultLauncherId !== artifact.vaultLauncherId
      || authorization.vaultP2PuzzleHash !== artifact.vaultP2PuzzleHash
      || Number(authorization.payment?.principal) !== artifact.railAmount
      || Number(authorization.payment?.chainId) !== BASE_SEPOLIA_CHAIN_ID
      || String(authorization.originalPayer || "").slice(-40).toLowerCase()
        !== job.walletAddress.slice(2).toLowerCase()
      || uintFromChain(deposit.amount, "deposit amount") !== artifact.railAmount
      || ethers.getAddress(deposit.depositor).toLowerCase()
        !== job.walletAddress.toLowerCase()
    ) {
      throw new Error(`${laneName} settlement evidence changes a purchase commitment`);
    }
    if (
      laneName === "delivery"
      && (
        !authorization.chia?.deedOutputCoinId
        || !authorization.chia?.confirmedHeight
      )
    ) {
      throw new Error("delivery evidence does not include the confirmed SmartDeed");
    }
    if (
      laneName === "refund"
      && authorization.chia?.terminalVoucherCoinId === undefined
    ) {
      throw new Error("refund evidence does not include the terminal voucher");
    }
    return authorization;
  }

  async verifyLane(job, laneName) {
    const lane = this.config.lanes[laneName];
    const laneState = job.lanes[laneName];
    if (!laneState?.globalPaymentId) {
      throw new Error(`${laneName} payment state is missing`);
    }
    const spoke = this.contractFactory(
      this.config.activation.contracts.spoke,
      SPOKE_ABI,
      this.provider,
    );
    const deposit = await spoke.getDeposit(laneState.globalPaymentId);
    const expectedStatus = laneName === "delivery" ? 3 : 4;
    const status = uintFromChain(deposit.status, "deposit status");
    if (status < expectedStatus) return;
    if (
      status !== expectedStatus
      || deposit.succeeded !== (laneName === "delivery")
    ) {
      throw new Error(`${laneName} deposit reached the wrong terminal outcome`);
    }
    const envelope = await this.settlementAuthorization(laneState.globalPaymentId);
    if (!envelope) return;
    const authorization = this.validateAuthorization(
      laneName,
      job,
      deposit,
      envelope,
    );
    laneState.success = true;
    laneState.authorizationHash = requiredHex(
      envelope.authorizationHash,
      32,
      `${laneName} authorizationHash`,
    );
    laneState.chiaEvidenceHash = sha256(authorization.chia);
    laneState.settlementTransactionHash = requiredHex(
      envelope.relayEvidence?.baseTransactionHash,
      32,
      `${laneName} settlement transaction`,
    );
    if (laneName === "refund") {
      laneState.exactRefund = true;
      job.phase = "COMPLETE";
      job.completedAt = this.now();
      job.evidence = this.buildEvidence(job);
      job.evidenceHmac = `0x${crypto.createHmac(
        "sha256",
        this.secrets.evidenceHmacSecret,
      ).update(stableJson(job.evidence)).digest("hex")}`;
    } else {
      job.phase = "APPROVE_REFUND";
      job.walletTransaction = this.approvalTransaction("refund");
    }
    job.updatedAt = this.now();
    this.writeJob(job);
  }

  buildEvidence(job) {
    return {
      schemaVersion: 2,
      kind: EVIDENCE_KIND,
      releaseTag: this.config.releaseTag,
      configHash: this.config.configHash,
      network: this.config.network,
      success: true,
      validatorThreshold: this.config.validatorThreshold,
      validators: this.config.validators,
      ceremonyId: job.ceremonyId,
      walletAddress: job.walletAddress,
      lanes: {
        delivery: {
          success: true,
          globalPaymentId: job.lanes.delivery.globalPaymentId,
          depositTransactionHash: job.lanes.delivery.depositTransactionHash,
          settlementTransactionHash: job.lanes.delivery.settlementTransactionHash,
          authorizationHash: job.lanes.delivery.authorizationHash,
          chiaEvidenceHash: job.lanes.delivery.chiaEvidenceHash,
        },
        refund: {
          success: true,
          exactRefund: true,
          globalPaymentId: job.lanes.refund.globalPaymentId,
          depositTransactionHash: job.lanes.refund.depositTransactionHash,
          settlementTransactionHash: job.lanes.refund.settlementTransactionHash,
          authorizationHash: job.lanes.refund.authorizationHash,
          chiaEvidenceHash: job.lanes.refund.chiaEvidenceHash,
        },
      },
      completedAt: new Date(job.completedAt * 1000).toISOString(),
    };
  }

  render(job) {
    const phase = PHASES[job.phase];
    const waitingAfterDelivery = [
      "VERIFY_DELIVERY",
      "APPROVE_REFUND",
      "PAY_REFUND",
      "VERIFY_REFUND",
      "COMPLETE",
    ].includes(job.phase);
    let state;
    if (job.error) state = "FAILED";
    else if (job.phase === "COMPLETE") state = "SUCCEEDED";
    else if (phase.action === "verify" || waitingAfterDelivery) state = "VALIDATING";
    else state = "AWAITING_WALLET";
    const labels = {
      APPROVE_DELIVERY: ["Approve faucet USDC", "Allows only the fixed delivery-test amount."],
      PAY_DELIVERY: ["Send the delivery test", "The deed and approved test vault are fixed."],
      VERIFY_DELIVERY: ["Confirming SmartDeed delivery", "You can leave this page while the validators finish."],
      APPROVE_REFUND: ["Approve faucet USDC", "Allows only the fixed refund-test amount."],
      PAY_REFUND: ["Send the refund test", "The same payment route must return the exact amount."],
      VERIFY_REFUND: ["Confirming the exact refund", "The page will update when both networks agree."],
      COMPLETE: ["Customer payment path ready", "Delivery and exact refund evidence are sealed."],
    };
    const [step, message] = labels[job.phase];
    const lane = phase.lane ? this.config.lanes[phase.lane] : null;
    const result = {
      jobId: job.jobId,
      state,
      configHash: this.config.configHash,
      phase: job.phase,
      completedSteps: phase.completedSteps,
      step,
      message: job.lastMessage || job.error || message,
      walletTransaction: job.pendingTransaction ? null : (job.walletTransaction || null),
      review: lane ? {
        action: phase.action,
        lane: phase.lane,
        asset: "USDC",
        amountMinor: String(lane.purchaseArtifact.railAmount),
        amountLabel: `${(lane.purchaseArtifact.railAmount / 1_000_000).toFixed(2)} test USDC`,
        escrow: ethers.getAddress(this.config.activation.contracts.spoke),
        destinationVault: lane.purchaseArtifact.vaultLauncherId,
        deedLauncherId: lane.purchaseArtifact.deedLauncherId,
        expectedOutcome: lane.expectedOutcome,
      } : null,
    };
    if (state === "SUCCEEDED") {
      result.evidence = job.evidence;
      result.evidenceHmac = job.evidenceHmac;
    }
    return result;
  }
}

module.exports = {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  CONFIG_KIND,
  EVIDENCE_KIND,
  JOB_ID,
  LaunchRehearsalCoordinator,
  PHASES,
  SPOKE_ABI,
  TOKEN_ABI,
  exactRequest,
  jobIdentifier,
  loadCoordinatorConfig,
  loadCoordinatorSecrets,
  readSecretFile,
  transactionShape,
};

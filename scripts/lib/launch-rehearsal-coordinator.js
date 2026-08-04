const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { sha256, stableJson } = require("./deployment-evidence");

const CONFIG_KIND = "solslot-rc27-stripe-voucher-rehearsal-config";
const EVIDENCE_KIND = "solslot-rc27-stripe-voucher-rehearsal";
const CANDIDATES_SCHEMA = "solslot.stripe-voucher-rehearsal-candidates.v1";
const MAX_JSON_BYTES = 256 * 1024;
const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const JOB_ID = /^rehearsal_[0-9a-f]{64}$/;
const PHASES = {
  PREPARE: { completedSteps: 0 },
  WAITING_DELIVERY_PURCHASE: { completedSteps: 0 },
  VERIFY_DELIVERY: { completedSteps: 1 },
  WAITING_REFUND_PURCHASE: { completedSteps: 2 },
  VERIFY_REFUND: { completedSteps: 3 },
  COMPLETE: { completedSteps: 4 },
};

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields are invalid`);
  }
  return value;
}

function requiredHex32(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!HEX32.test(normalized) || /^0x0{64}$/.test(normalized)) {
    throw new Error(`${label} must be a non-zero bytes32 value`);
  }
  return normalized;
}

function requiredDecimal(value, label, allowZero = true) {
  const text = String(value);
  const pattern = allowZero ? /^(?:0|[1-9][0-9]{0,15})$/ : /^[1-9][0-9]{0,15}$/;
  if (!pattern.test(text)) throw new Error(`${label} is invalid`);
  return Number(text);
}

function signerIndices(value, label) {
  if (!Array.isArray(value)
      || value.length < 2
      || value.length > 3
      || value.some((item) => !Number.isSafeInteger(item) || item < 0 || item > 2)
      || value.some((item, index) => index > 0 && item <= value[index - 1])) {
    throw new Error(`${label} must be a unique ordered 2-of-3 quorum`);
  }
  return [...value];
}

function boundedJsonFile(inputPath, label) {
  const resolved = path.resolve(String(inputPath || ""));
  if (!inputPath) throw new Error(`${label} path is required`);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_JSON_BYTES) {
    throw new Error(`${label} path is invalid`);
  }
  const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain one JSON object`);
  }
  return value;
}

function readSecretFile(inputPath, label) {
  const resolved = path.resolve(String(inputPath || ""));
  if (!inputPath) throw new Error(`${label} file is required`);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 32
      || stat.size > 4096 || (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} file must be a private regular file`);
  }
  const value = fs.readFileSync(resolved, "utf8").trim();
  if (value.length < 32 || /[\r\n]/.test(value)) {
    throw new Error(`${label} must contain one secret of at least 32 characters`);
  }
  return value;
}

function normalizedValidator(value, index) {
  exactKeys(value, ["id"], `validator ${index + 1}`);
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(String(value.id))) {
    throw new Error(`validator ${index + 1} id is invalid`);
  }
  return { id: String(value.id) };
}

function loadCoordinatorConfig(environment = process.env) {
  const envelope = boundedJsonFile(
    environment.SOLSLOT_LAUNCH_REHEARSAL_CONFIG_PATH,
    "launch rehearsal config",
  );
  exactKeys(envelope, ["configHash", "payload"], "launch rehearsal config");
  const configHash = requiredHex32(envelope.configHash, "configHash");
  if (sha256(envelope.payload) !== configHash) {
    throw new Error("launch rehearsal config hash mismatches");
  }
  const payload = exactKeys(envelope.payload, [
    "schemaVersion",
    "kind",
    "releaseTag",
    "releaseEvidenceHash",
    "network",
    "candidatesApiUrl",
    "approvedVaultLauncherId",
    "collectionId",
    "stripe",
    "validatorThreshold",
    "validators",
  ], "launch rehearsal payload");
  if (payload.schemaVersion !== 3
      || payload.kind !== CONFIG_KIND
      || payload.network !== "testnet11"
      || payload.validatorThreshold !== 2
      || !/^solslot-v2-alpha-rc[0-9]+-[0-9]{8}$/.test(String(payload.releaseTag))) {
    throw new Error("launch rehearsal payload is incompatible with RC27");
  }
  const apiUrl = String(payload.candidatesApiUrl || "").replace(/\/$/, "");
  if (!/^https:\/\/[^/]+\/.+\/presales\/stripe-rehearsal\/candidates$/.test(apiUrl)
      && !/^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):[0-9]+\/.+/.test(apiUrl)) {
    throw new Error("candidate API URL must use HTTPS or loopback HTTP");
  }
  const stripe = exactKeys(payload.stripe, ["accountId", "mode", "livemode", "apiVersion"], "Stripe config");
  if (!/^acct_[A-Za-z0-9_]{6,120}$/.test(String(stripe.accountId))
      || stripe.mode !== "test"
      || stripe.livemode !== false
      || !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}(?:\.[a-z]+)?$/.test(String(stripe.apiVersion))) {
    throw new Error("Stripe rehearsal must use one pinned test account and API version");
  }
  if (!Array.isArray(payload.validators) || payload.validators.length !== 3) {
    throw new Error("launch rehearsal requires exactly three validators");
  }
  const validators = payload.validators.map(normalizedValidator);
  if (new Set(validators.map((item) => item.id)).size !== 3) {
    throw new Error("launch rehearsal validator identities must be unique");
  }
  return {
    configHash,
    releaseTag: String(payload.releaseTag),
    releaseEvidenceHash: requiredHex32(payload.releaseEvidenceHash, "releaseEvidenceHash"),
    network: "testnet11",
    candidatesApiUrl: apiUrl,
    approvedVaultLauncherId: requiredHex32(payload.approvedVaultLauncherId, "approvedVaultLauncherId"),
    collectionId: requiredHex32(payload.collectionId, "collectionId"),
    stripe: { ...stripe },
    validatorThreshold: 2,
    validators,
  };
}

function loadCoordinatorSecrets(environment = process.env) {
  return {
    serviceToken: readSecretFile(environment.SOLSLOT_LAUNCH_REHEARSAL_TOKEN_FILE, "service token"),
    evidenceHmacSecret: readSecretFile(environment.SOLSLOT_LAUNCH_REHEARSAL_HMAC_FILE, "evidence HMAC"),
    candidatesApiToken: readSecretFile(environment.SOLSLOT_LAUNCH_REHEARSAL_API_TOKEN_FILE, "candidate API token"),
  };
}

function exactRequest(value) {
  exactKeys(value, [
    "ceremonyId",
    "releaseTag",
    "releaseEvidenceHash",
    "configHash",
    "network",
    "rehearsalKind",
    "requiredLanes",
    "walletAddress",
  ], "rehearsal start request");
  if (value.rehearsalKind !== EVIDENCE_KIND
      || stableJson(value.requiredLanes) !== stableJson([
        "stripe-voucher-delivery",
        "stripe-voucher-refund",
      ])) {
    throw new Error("rehearsal must require Stripe voucher delivery and refund");
  }
  const wallet = String(value.walletAddress || "").toLowerCase();
  if (!ADDRESS.test(wallet) || /^0x0{40}$/.test(wallet)) {
    throw new Error("rehearsal wallet address is invalid");
  }
  return { ...value, walletAddress: wallet };
}

function jobIdentifier(request, config) {
  return `rehearsal_${crypto.createHash("sha256").update(stableJson({
    ceremonyId: request.ceremonyId,
    configHash: config.configHash,
    walletAddress: request.walletAddress,
  })).digest("hex")}`;
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

function normalizedLane(value, lane, config) {
  const expected = [
    "stripeAccountId", "livemode", "success", "purchaseId", "artifactHash",
    "paymentIntentId", "eventId", "baseAmountMinor", "technologyFeeMinor",
    "processingChargeMinor", "amountMinor", "approvedVaultLauncherId",
    "deedLauncherId", "zkPassportRoot", "settlementReceiptHash", "signerIndices",
    "voucher", "execution", "chain",
  ];
  if (lane === "refund") expected.push("exactRefund", "stripeRefund");
  exactKeys(value, expected, `${lane} candidate`);
  if (value.stripeAccountId !== config.stripe.accountId
      || value.livemode !== false
      || value.success !== true
      || value.approvedVaultLauncherId !== config.approvedVaultLauncherId) {
    throw new Error(`${lane} candidate differs from the fixed Stripe rehearsal`);
  }
  ["purchaseId", "artifactHash", "approvedVaultLauncherId", "deedLauncherId",
    "zkPassportRoot", "settlementReceiptHash"].forEach((field) => requiredHex32(value[field], `${lane} ${field}`));
  if (!/^pi_[A-Za-z0-9_]{8,120}$/.test(String(value.paymentIntentId))
      || !/^evt_[A-Za-z0-9_]{8,120}$/.test(String(value.eventId))) {
    throw new Error(`${lane} Stripe provider IDs are invalid`);
  }
  const base = requiredDecimal(value.baseAmountMinor, `${lane} base`, false);
  const fee = requiredDecimal(value.technologyFeeMinor, `${lane} technology fee`);
  const processing = requiredDecimal(value.processingChargeMinor, `${lane} processing charge`);
  const amount = requiredDecimal(value.amountMinor, `${lane} amount`, false);
  if (amount !== base + fee + processing) throw new Error(`${lane} payment arithmetic changed`);
  signerIndices(value.signerIndices, `${lane} terminal quorum`);

  const voucher = exactKeys(value.voucher, [
    "serial", "signerIndices", "issuanceBundleId", "voucherCoinId",
    "paymentCommitmentCoinId", "issuanceConfirmedHeight",
  ], `${lane} voucher`);
  if (!Number.isSafeInteger(voucher.serial) || voucher.serial < 0
      || !Number.isSafeInteger(voucher.issuanceConfirmedHeight)
      || voucher.issuanceConfirmedHeight < 1) {
    throw new Error(`${lane} voucher confirmation is invalid`);
  }
  signerIndices(voucher.signerIndices, `${lane} issuance quorum`);
  ["issuanceBundleId", "voucherCoinId", "paymentCommitmentCoinId"]
    .forEach((field) => requiredHex32(voucher[field], `${lane} voucher ${field}`));

  const execution = exactKeys(value.execution, [
    "schema", "mode", "action", "spendBundleId", "feeCoinId", "feeMojos",
    "mempoolObservedAt", "outputRoles",
  ], `${lane} execution`);
  const expectedMode = lane === "delivery" ? "REDEEM" : "REFUND_OWNER";
  const expectedRoles = lane === "delivery"
    ? ["coordination", "deed", "series", "terminalVoucher"]
    : ["series", "terminalVoucher", "vault"];
  if (execution.schema !== "solslot.stripe-voucher-terminal-execution.v1"
      || execution.mode !== expectedMode
      || execution.action !== 7
      || !Number.isSafeInteger(execution.mempoolObservedAt)
      || execution.mempoolObservedAt < 1) {
    throw new Error(`${lane} exact KoS execution is invalid`);
  }
  requiredHex32(execution.spendBundleId, `${lane} spend bundle`);
  requiredHex32(execution.feeCoinId, `${lane} fee coin`);
  requiredDecimal(execution.feeMojos, `${lane} medium fee`, false);
  exactKeys(execution.outputRoles, expectedRoles, `${lane} output roles`);
  expectedRoles.forEach((field) => requiredHex32(execution.outputRoles[field], `${lane} ${field}`));

  const chainFields = lane === "delivery"
    ? ["confirmationHeight", "deedOutputCoinId", "seriesOutputCoinId", "terminalVoucherCoinId", "coordinationCoinId"]
    : ["confirmationHeight", "seriesOutputCoinId", "terminalVoucherCoinId", "vaultOutputCoinId"];
  const chain = exactKeys(value.chain, chainFields, `${lane} chain evidence`);
  if (!Number.isSafeInteger(chain.confirmationHeight) || chain.confirmationHeight < 1) {
    throw new Error(`${lane} chain confirmation is invalid`);
  }
  const roleMap = {
    deedOutputCoinId: "deed",
    seriesOutputCoinId: "series",
    terminalVoucherCoinId: "terminalVoucher",
    coordinationCoinId: "coordination",
    vaultOutputCoinId: "vault",
  };
  Object.entries(roleMap).forEach(([field, role]) => {
    if (Object.hasOwn(chain, field)
        && requiredHex32(chain[field], `${lane} ${field}`) !== execution.outputRoles[role]) {
      throw new Error(`${lane} confirmed output differs from KoS execution`);
    }
  });
  if (lane === "refund") {
    const refund = exactKeys(value.stripeRefund, [
      "refundId", "refundedMinor", "currency", "livemode", "observedAt",
    ], "Stripe refund");
    if (value.exactRefund !== true
        || !/^re_[A-Za-z0-9_]{8,120}$/.test(String(refund.refundId))
        || requiredDecimal(refund.refundedMinor, "refunded amount", false) !== amount
        || refund.currency !== "usd"
        || refund.livemode !== false
        || !Number.isSafeInteger(refund.observedAt)
        || refund.observedAt < 1) {
      throw new Error("Stripe rehearsal refund is not exact");
    }
  }
  const result = { ...value };
  delete result.stripeAccountId;
  delete result.livemode;
  return result;
}

class LaunchRehearsalCoordinator {
  constructor({ config, secrets, stateDirectory, fetchImplementation = fetch, now = () => Math.floor(Date.now() / 1000) }) {
    this.config = config;
    this.secrets = secrets;
    this.stateDirectory = path.resolve(stateDirectory);
    this.fetchImplementation = fetchImplementation;
    this.now = now;
    this.jobLocks = new Map();
  }

  jobPath(jobId) {
    if (!JOB_ID.test(jobId)) throw new Error("rehearsal job id is invalid");
    return path.join(this.stateDirectory, `${jobId}.json`);
  }

  readJob(jobId) {
    const value = boundedJsonFile(this.jobPath(jobId), "rehearsal job");
    if (value.schemaVersion !== 3 || value.jobId !== jobId
        || value.configHash !== this.config.configHash || !PHASES[value.phase]) {
      throw new Error("stored rehearsal job differs from the active release");
    }
    return value;
  }

  writeJob(job) { atomicWriteJson(this.jobPath(job.jobId), job); }

  async withJobLock(jobId, operation) {
    const previous = this.jobLocks.get(jobId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.jobLocks.set(jobId, tail);
    await previous;
    try { return await operation(); } finally {
      release();
      if (this.jobLocks.get(jobId) === tail) this.jobLocks.delete(jobId);
    }
  }

  async candidates(createdAfter) {
    const url = new URL(this.config.candidatesApiUrl);
    url.searchParams.set("created_after", String(createdAfter));
    url.searchParams.set("vault_launcher_id", this.config.approvedVaultLauncherId);
    url.searchParams.set("collection_id", this.config.collectionId);
    const response = await this.fetchImplementation(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.secrets.candidatesApiToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
      throw new Error("Stripe voucher candidate response is oversized");
    }
    if (!response.ok) throw new Error(`candidate API returned HTTP ${response.status}`);
    const value = JSON.parse(text);
    exactKeys(value, [
      "schema", "createdAfter", "vaultLauncherId", "collectionId", "delivery", "refund",
    ], "Stripe voucher candidates");
    if (value.schema !== CANDIDATES_SCHEMA
        || value.createdAfter !== createdAfter
        || value.vaultLauncherId !== this.config.approvedVaultLauncherId
        || value.collectionId !== this.config.collectionId
        || !Array.isArray(value.delivery)
        || !Array.isArray(value.refund)
        || value.delivery.length > 5
        || value.refund.length > 5) {
      throw new Error("Stripe voucher candidate context changed");
    }
    return {
      delivery: value.delivery.map((item) => normalizedLane(item, "delivery", this.config)),
      refund: value.refund.map((item) => normalizedLane(item, "refund", this.config)),
    };
  }

  async verifyRuntime() { await this.candidates(this.now()); }

  async start(input) {
    const request = exactRequest(input);
    if (request.releaseTag !== this.config.releaseTag
        || String(request.releaseEvidenceHash).toLowerCase() !== this.config.releaseEvidenceHash
        || String(request.configHash).toLowerCase() !== this.config.configHash
        || request.network !== this.config.network) {
      throw new Error("rehearsal request differs from the signed release configuration");
    }
    const jobId = jobIdentifier(request, this.config);
    return this.withJobLock(jobId, async () => {
      if (fs.existsSync(this.jobPath(jobId))) return this.getUnlocked(jobId);
      const job = {
        schemaVersion: 3,
        jobId,
        configHash: this.config.configHash,
        ceremonyId: request.ceremonyId,
        walletAddress: request.walletAddress,
        phase: "WAITING_DELIVERY_PURCHASE",
        startedAt: this.now(),
        updatedAt: this.now(),
        lanes: {},
        evidence: null,
        evidenceHmac: null,
        error: null,
      };
      this.writeJob(job);
      return this.advance(job);
    });
  }

  async get(jobId) { return this.withJobLock(jobId, () => this.getUnlocked(jobId)); }

  async getUnlocked(jobId) { return this.advance(this.readJob(jobId)); }

  async advance(job) {
    try {
      const candidates = await this.candidates(job.startedAt);
      if (!job.lanes.delivery && candidates.delivery.length) {
        job.phase = "VERIFY_DELIVERY";
        job.lanes.delivery = candidates.delivery[0];
        job.updatedAt = this.now();
        this.writeJob(job);
        job.phase = "WAITING_REFUND_PURCHASE";
      }
      if (job.lanes.delivery && !job.lanes.refund) {
        const refund = candidates.refund.find((candidate) => (
          candidate.purchaseId !== job.lanes.delivery.purchaseId
          && candidate.paymentIntentId !== job.lanes.delivery.paymentIntentId
          && candidate.voucher.voucherCoinId !== job.lanes.delivery.voucher.voucherCoinId
        ));
        if (refund) {
          job.phase = "VERIFY_REFUND";
          job.lanes.refund = refund;
          job.updatedAt = this.now();
          this.writeJob(job);
          job.phase = "COMPLETE";
          job.completedAt = this.now();
          job.evidence = this.buildEvidence(job);
          job.evidenceHmac = `0x${crypto.createHmac("sha256", this.secrets.evidenceHmacSecret)
            .update(stableJson(job.evidence)).digest("hex")}`;
        }
      }
      job.error = null;
      job.updatedAt = this.now();
      this.writeJob(job);
    } catch (error) {
      job.error = String(error.message || error);
      job.updatedAt = this.now();
      this.writeJob(job);
    }
    return this.render(job);
  }

  buildEvidence(job) {
    return {
      schemaVersion: 3,
      kind: EVIDENCE_KIND,
      releaseTag: this.config.releaseTag,
      configHash: this.config.configHash,
      network: "testnet11",
      stripe: { ...this.config.stripe },
      success: true,
      validatorThreshold: 2,
      validators: this.config.validators,
      lanes: {
        delivery: job.lanes.delivery,
        refund: job.lanes.refund,
      },
    };
  }

  render(job) {
    const labels = {
      PREPARE: ["Preparing payment check", "Checking the fixed release and test account."],
      WAITING_DELIVERY_PURCHASE: ["Complete one test purchase", "Use the normal customer checkout. This page will recognize delivery automatically."],
      VERIFY_DELIVERY: ["Checking SmartDeed delivery", "Confirming the voucher, fee-funded bundle, and vault output."],
      WAITING_REFUND_PURCHASE: ["Complete one cancellation test", "Use a second Stripe voucher, request cancellation, and wait for the full refund."],
      VERIFY_REFUND: ["Checking the exact refund", "Confirming the terminal voucher and full Stripe refund."],
      COMPLETE: ["Stripe voucher path ready", "Delivery and full-refund evidence are sealed."],
    };
    const [step, message] = labels[job.phase];
    const result = {
      jobId: job.jobId,
      state: job.error ? "FAILED" : (job.phase === "COMPLETE" ? "SUCCEEDED" : "VALIDATING"),
      configHash: this.config.configHash,
      phase: job.phase,
      completedSteps: PHASES[job.phase].completedSteps,
      step,
      message: job.error || message,
      walletTransaction: null,
      review: null,
    };
    if (job.phase === "COMPLETE" && !job.error) {
      result.evidence = job.evidence;
      result.evidenceHmac = job.evidenceHmac;
    }
    return result;
  }
}

module.exports = {
  CANDIDATES_SCHEMA,
  CONFIG_KIND,
  EVIDENCE_KIND,
  JOB_ID,
  LaunchRehearsalCoordinator,
  PHASES,
  exactRequest,
  jobIdentifier,
  loadCoordinatorConfig,
  loadCoordinatorSecrets,
  normalizedLane,
  readSecretFile,
};

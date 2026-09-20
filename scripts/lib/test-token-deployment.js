// Exact, single-transaction deployment of the valueless Base alpha token.
// Public inspection never unlocks a key. Retry only the journaled bytes.
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { sha256, stableJson } = require("./deployment-evidence");

const CONTRACT = "SolslotAlphaTestToken";
const SCHEMA = "solslot.alpha-test-token-deployment.v1";
const ORACLE = "0x420000000000000000000000000000000000000F";
const ORACLE_ABI = ["function getL1FeeUpperBound(uint256) view returns (uint256)"];
const TOKEN = Object.freeze({name: "Solslot Alpha Test Token", symbol: "TEST-SOLS", decimals: 6,
  initialSupply: "10000000000000", faucetAmount: "1000000000000", cooldownSeconds: 86400,
  hasMonetaryValue: false, assetNetwork: "testnet11"});
const FIELDS = ["schema", "network", "chainId", "sourceSha", "actionEnvelopeId", "deployer",
  "initialRecipient", "tokenAddress", "token", "nonce", "initCodeHash", "runtimeCodeHash",
  "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "l1FeeBudgetWei", "planHash"];
function check(ok, message) { if (!ok) throw new Error(message); }
function exact(value, fields, label) {
  check(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...fields].sort().join(), `${label}: unsupported fields`);
}
function hex(value, bytes, label) {
  check(typeof value === "string" && new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(value) &&
    BigInt(value) !== 0n, `${label}: canonical nonzero hex required`);
}
function seal(value) { return {...value, planHash: sha256(value)}; }
function validatePlan(plan) {
  exact(plan, FIELDS, "plan");
  const {planHash, ...body} = plan;
  check(planHash === sha256(body), "plan hash differs");
  check(plan.schema === SCHEMA && plan.network === "baseMainnet" && plan.chainId === 8453,
    "test token requires explicit Base mainnet/8453");
  check(typeof plan.sourceSha === "string" && /^[0-9a-f]{40}$/.test(plan.sourceSha) && plan.sourceSha !== "0".repeat(40), "source SHA required");
  check(typeof plan.actionEnvelopeId === "string" && /^AE-SOLSLOT-[A-Z0-9-]{1,128}$/.test(plan.actionEnvelopeId), "ActionEnvelope required");
  for (const k of ["deployer", "initialRecipient", "tokenAddress"]) hex(plan[k], 20, k);
  for (const k of ["initCodeHash", "runtimeCodeHash"]) hex(plan[k], 32, k);
  check(stableJson(plan.token) === stableJson(TOKEN), "test token identity differs");
  check(Number.isSafeInteger(plan.nonce) && plan.nonce >= 0, "invalid nonce");
  check(plan.tokenAddress === ethers.getCreateAddress({from: plan.deployer, nonce: plan.nonce}).toLowerCase(), "CREATE address differs");
  check(plan.initialRecipient === plan.deployer, "initial test supply must go to the deploying operator");
  for (const k of ["gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "l1FeeBudgetWei"])
    check(typeof plan[k] === "string" && /^[1-9][0-9]{0,24}$/.test(plan[k]), `invalid ${k}`);
  check(BigInt(plan.maxPriorityFeePerGas) <= BigInt(plan.maxFeePerGas), "priority fee exceeds maximum");
  return plan;
}
function requestFor(plan, artifact) {
  validatePlan(plan);
  check(artifact.contractName === CONTRACT, "wrong compiled contract");
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode);
  const data = ethers.concat([factory.bytecode, factory.interface.encodeDeploy([plan.initialRecipient])]);
  check(ethers.keccak256(data) === plan.initCodeHash, "compiled init code differs");
  check(ethers.keccak256(artifact.deployedBytecode) === plan.runtimeCodeHash, "compiled runtime differs");
  return {type: 2, chainId: 8453n, nonce: plan.nonce, to: null, value: 0n, data,
    gasLimit: BigInt(plan.gasLimit), maxFeePerGas: BigInt(plan.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGas), accessList: []};
}
function preparePlan(input, artifact) {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode);
  const deployer = ethers.getAddress(input.deployer).toLowerCase();
  const data = ethers.concat([factory.bytecode, factory.interface.encodeDeploy([deployer])]);
  const plan = seal({...input, schema: SCHEMA, network: "baseMainnet", chainId: 8453,
    deployer, initialRecipient: deployer, token: TOKEN,
    tokenAddress: ethers.getCreateAddress({from: deployer, nonce: input.nonce}).toLowerCase(),
    initCodeHash: ethers.keccak256(data), runtimeCodeHash: ethers.keccak256(artifact.deployedBytecode)});
  requestFor(plan, artifact);
  return plan;
}
function readCanonical(file, checksum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.size > 0 && stat.size < 128 * 1024, "invalid plan file");
    const raw = fs.readFileSync(fd);
    const value = JSON.parse(raw.toString("utf8"));
    check(raw.toString("utf8") === stableJson(value) + "\n", "canonical JSON required");
    if (checksum !== undefined) {
      check(/^[0-9a-f]{64}$/.test(checksum), "plan checksum required");
      check(ethers.sha256(raw) === "0x" + checksum, "plan file checksum differs");
    }
    return value;
  } finally { fs.closeSync(fd); }
}
function writeOnce(file, value) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, stableJson(value) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function protectedDirectory(directory) {
  check(typeof directory === "string" && directory.length > 0, "journal directory required");
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, {mode: 0o700});
    const s = fs.lstatSync(current);
    check(s.isDirectory() && !s.isSymbolicLink(), "journal path cannot contain symlinks");
  }
  const s = fs.statSync(absolute);
  check(s.uid === process.getuid() && (s.mode & 0o077) === 0, "journal must be owner-only");
  return absolute;
}
async function boundary(providers) {
  check(Array.isArray(providers) && providers.length === 2 && providers[0] !== providers[1], "two independent RPC providers required");
  const nets = await Promise.all(providers.map(p => p.getNetwork()));
  check(nets.every(n => n.chainId === 8453n), "RPC is not Base mainnet");
  const peaks = await Promise.all(providers.map(p => p.getBlock("latest")));
  check(peaks.every(p => p && p.hash), "RPC block unavailable");
  const height = Math.min(...peaks.map(p => p.number));
  const blocks = await Promise.all(providers.map(p => p.getBlock(height)));
  check(blocks[0]?.hash && blocks[0].hash === blocks[1]?.hash, "RPC block disagreement");
  return blocks[0];
}
async function l1UpperBound(provider, request) {
  const serialized = ethers.Transaction.from(request).unsignedSerialized;
  // Include the signature and RLP length growth conservatively.
  const bytes = ethers.getBytes(serialized).length + 80;
  return new ethers.Contract(ORACLE, ORACLE_ABI, provider).getL1FeeUpperBound(bytes);
}
async function inspectFresh(plan, request, providers, estimateL1 = l1UpperBound) {
  const block = await boundary(providers);
  const budget = request.gasLimit * request.maxFeePerGas + BigInt(plan.l1FeeBudgetWei);
  const observations = await Promise.all(providers.map(async p => {
    const [latest, pending, code, balance, gas, l1] = await Promise.all([
      p.getTransactionCount(plan.deployer, "latest"), p.getTransactionCount(plan.deployer, "pending"),
      p.getCode(plan.tokenAddress), p.getBalance(plan.deployer),
      p.estimateGas({...request, from: plan.deployer}), estimateL1(p, request),
    ]);
    check(latest === plan.nonce && pending === plan.nonce, "operator nonce differs from plan");
    check(code === "0x", "predicted token address is occupied");
    check(balance >= budget, "operator balance below execution and L1 fee budget");
    check(gas <= request.gasLimit, "gas estimate exceeds fixed gas limit");
    check(l1 <= BigInt(plan.l1FeeBudgetWei), "L1 fee estimate exceeds budget");
    check(block.baseFeePerGas != null && block.baseFeePerGas + request.maxPriorityFeePerGas <= request.maxFeePerGas,
      "fixed fee cap is below current Base fee");
    return {latestNonce: latest, pendingNonce: pending, balanceWei: balance.toString(), estimatedGas: gas.toString(), l1FeeUpperBoundWei: l1.toString()};
  }));
  return {blockNumber: block.number, blockHash: block.hash, observations,
    executionFeeCapWei: (request.gasLimit * request.maxFeePerGas).toString(),
    l1FeeBudgetWei: plan.l1FeeBudgetWei, totalBudgetWei: budget.toString()};
}
function signedHash(raw, request, deployer) {
  const tx = ethers.Transaction.from(raw);
  check(tx.isSigned() && tx.serialized === raw && tx.from.toLowerCase() === deployer, "journal signer differs");
  for (const field of ["type", "chainId", "nonce", "to", "value", "data", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas"])
    check(tx[field] === request[field], `journal transaction ${field} differs`);
  check(stableJson(tx.accessList) === "[]", "journal access list differs");
  return tx.hash;
}
async function inspectMined(plan, request, hash, providers) {
  const block = await boundary(providers);
  const receipts = await Promise.all(providers.map(p => p.getTransactionReceipt(hash)));
  if (receipts.every(r => !r)) return null;
  if (receipts.some(r => !r)) return {status: "confirming", transactionHash: hash, reason: "RPC receipt agreement pending"};
  check(receipts[0].blockHash === receipts[1].blockHash, "RPC receipt disagreement");
  for (const [i, r] of receipts.entries()) {
    const p = providers[i];
    const [minedBlock, tx, code] = await Promise.all([p.getBlock(r.blockNumber), p.getTransaction(hash), p.getCode(plan.tokenAddress)]);
    check(r.status === 1 && r.hash === hash && r.blockHash === minedBlock?.hash &&
      r.contractAddress?.toLowerCase() === plan.tokenAddress, "failed or noncanonical deployment receipt");
    check(tx && tx.hash === hash && tx.blockHash === r.blockHash && tx.blockNumber === r.blockNumber &&
      tx.from.toLowerCase() === plan.deployer, "mined transaction differs");
    for (const field of ["type", "chainId", "nonce", "to", "value", "data", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas"])
      check(tx[field] === request[field], `mined transaction ${field} differs`);
    check(code !== "0x" && ethers.keccak256(code) === plan.runtimeCodeHash, "deployed token runtime differs");
  }
  const confirmations = block.number - receipts[0].blockNumber + 1;
  return {status: confirmations >= 12 ? "confirmed" : "confirming", transactionHash: hash,
    tokenAddress: plan.tokenAddress, blockNumber: receipts[0].blockNumber, blockHash: receipts[0].blockHash,
    confirmations, requiredConfirmations: 12, runtimeCodeHash: plan.runtimeCodeHash};
}
async function runDeployment({plan, artifact, providers, signerFactory, journalDirectory, execute = false,
  resubmitOriginal = false, estimateL1 = l1UpperBound}) {
  const request = requestFor(plan, artifact);
  await boundary(providers);
  if (!execute) return {status: "ready_to_sign", planHash: plan.planHash, tokenAddress: plan.tokenAddress,
    inspection: await inspectFresh(plan, request, providers, estimateL1)};
  const dir = protectedDirectory(journalDirectory);
  const file = path.join(dir, "signed-test-token.json");
  let journal;
  let newlySigned = false;
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, "journal is not owner-only");
    journal = readCanonical(file);
  } else {
    await inspectFresh(plan, request, providers, estimateL1);
    const lock = path.join(dir, "signing.lock");
    writeOnce(lock, {planHash: plan.planHash});
    // A crash before the signed journal is persisted leaves the lock for manual
    // reconciliation. Never delete it to automatically create a replacement.
    const signer = await signerFactory();
    check((await signer.getAddress()).toLowerCase() === plan.deployer, "keystore address differs");
    const raw = await signer.signTransaction(request);
    signedHash(raw, request, plan.deployer);
    journal = {schema: "solslot.signed-test-token.v1", planHash: plan.planHash, actionEnvelopeId: plan.actionEnvelopeId, raw};
    writeOnce(file, journal);
    fs.unlinkSync(lock);
    newlySigned = true;
  }
  exact(journal, ["schema", "planHash", "actionEnvelopeId", "raw"], "journal");
  check(journal.schema === "solslot.signed-test-token.v1" && journal.planHash === plan.planHash &&
    journal.actionEnvelopeId === plan.actionEnvelopeId, "journal belongs to another plan");
  const hash = signedHash(journal.raw, request, plan.deployer);
  const mined = await inspectMined(plan, request, hash, providers);
  if (mined) return {...mined, planHash: plan.planHash};
  const known = await Promise.all(providers.map(p => p.getTransaction(hash)));
  if (known.some(Boolean)) return {status: "pending", transactionHash: hash, planHash: plan.planHash};
  if (!newlySigned && !resubmitOriginal) return {status: "reconciliation_required", transactionHash: hash,
    reason: "No receipt or pending transaction found; original bytes are preserved. Do not replace the nonce."};
  await inspectFresh(plan, request, providers, estimateL1);
  // No retry or fee bump here. An uncertain RPC outcome retains the exact bytes.
  const sent = await providers[0].broadcastTransaction(journal.raw);
  check(sent.hash === hash, "broadcast returned a different transaction hash");
  return {status: "broadcast", transactionHash: hash, tokenAddress: plan.tokenAddress, planHash: plan.planHash};
}
module.exports = {CONTRACT, TOKEN, seal, validatePlan, preparePlan, requestFor, readCanonical,
  writeOnce, boundary, l1UpperBound, inspectFresh, signedHash, runDeployment};

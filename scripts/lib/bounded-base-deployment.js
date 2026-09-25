// Exact Base deployment sequences. Signed bytes are durable before any RPC send.
// A missing response is never permission to replace a transaction or its nonce.
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { sha256, stableJson } = require("./deployment-evidence");
const { boundary, l1UpperBound, writeOnce, readCanonical, signedHash } = require("./test-token-deployment");
async function baseAuxiliaryFee(provider, request) {
  const oracle = new ethers.Contract("0x420000000000000000000000000000000000000F",
    ["function getOperatorFee(uint256) view returns (uint256)"], provider);
  const [l1, operator] = await Promise.all([l1UpperBound(provider, request), oracle.getOperatorFee(request.gasLimit)]);
  return l1 + operator;
}
const check = (ok, message) => { if (!ok) throw new Error(message); };
const seal = body => ({...body, planHash: sha256(body)});
function exact(value, fields, label) {
  check(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...fields].sort().join(), `${label}: unsupported fields`);
}
function validatePlan(plan) {
  exact(plan, ["schema", "sourceSha", "actionEnvelopeId", "chainId", "chiaNetwork", "testOnly", "deployer",
    "startNonce", "binding", "dependencies", "transactions", "totalBudgetWei", "planHash"], "plan");
  const {planHash, ...body} = plan;
  check(planHash === sha256(body), "plan hash differs");
  const withPostconditions = plan.schema === "solslot.bounded-base-deployment.v2";
  check((withPostconditions || plan.schema === "solslot.bounded-base-deployment.v1") && plan.chainId === 8453 &&
    plan.chiaNetwork === "testnet11" && plan.testOnly === true, "explicit Base/Testnet11 scope required");
  check(/^[0-9a-f]{40}$/.test(plan.sourceSha) && plan.sourceSha !== "0".repeat(40), "source SHA required");
  check(/^AE-SOLSLOT-[A-Z0-9-]{1,128}$/.test(plan.actionEnvelopeId), "ActionEnvelope required");
  check(/^0x[0-9a-f]{40}$/.test(plan.deployer) && BigInt(plan.deployer) !== 0n, "canonical deployer required");
  check(Number.isSafeInteger(plan.startNonce) && plan.startNonce >= 0 && plan.startNonce < Number.MAX_SAFE_INTEGER - 32, "invalid start nonce");
  check(Array.isArray(plan.transactions) && plan.transactions.length > 0 && plan.transactions.length <= 32, "bounded sequence required");
  check(Array.isArray(plan.dependencies) && plan.dependencies.length <= 32, "bounded dependencies required");
  for (const dep of plan.dependencies) {
    exact(dep, ["address", "runtimeCodeHash"], "dependency");
    check(ethers.isAddress(dep.address) && ethers.isHexString(dep.runtimeCodeHash, 32), "invalid dependency");
  }
  let total = 0n;
  for (const [index, tx] of plan.transactions.entries()) {
    exact(tx, ["name", "nonce", "to", "data", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "auxiliaryFeeBudgetWei", "created",
      ...(withPostconditions ? ["postconditions"] : [])], "transaction");
    check(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(tx.name) && tx.nonce === plan.startNonce + index, "invalid transaction order");
    check(tx.to === null || ethers.isAddress(tx.to), "invalid target");
    check(ethers.isHexString(tx.data) && ethers.dataLength(tx.data) > 0 && ethers.dataLength(tx.data) <= 100000, "invalid calldata");
    for (const k of ["gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "auxiliaryFeeBudgetWei"])
      check(typeof tx[k] === "string" && /^[1-9][0-9]{0,24}$/.test(tx[k]), `invalid ${k}`);
    check(BigInt(tx.gasLimit) <= 30000000n && BigInt(tx.maxPriorityFeePerGas) <= BigInt(tx.maxFeePerGas), "invalid gas bounds");
    check(Array.isArray(tx.created) && tx.created.length <= 16 &&
      (tx.created.length > 0 || (withPostconditions && tx.to !== null)), "created contract checks required");
    if (withPostconditions) {
      check(Array.isArray(tx.postconditions) && tx.postconditions.length > 0 && tx.postconditions.length <= 32, "postconditions required");
      for (const condition of tx.postconditions) {
        exact(condition, ["to", "data", "result"], "postcondition");
        check(ethers.isAddress(condition.to) && ethers.isHexString(condition.data) &&
          ethers.dataLength(condition.data) >= 4 && ethers.dataLength(condition.data) <= 4096 &&
          ethers.isHexString(condition.result) && ethers.dataLength(condition.result) > 0 &&
          ethers.dataLength(condition.result) <= 8192, "invalid postcondition");
      }
    }
    for (const created of tx.created) {
      exact(created, ["address", "runtimeCodeHash"], "created contract");
      check(ethers.isAddress(created.address) && ethers.isHexString(created.runtimeCodeHash, 32) &&
        BigInt(created.runtimeCodeHash) !== 0n, "invalid created contract");
    }
    if (tx.to === null) check(tx.created[0].address.toLowerCase() ===
      ethers.getCreateAddress({from: plan.deployer, nonce: tx.nonce}).toLowerCase(), "CREATE address differs");
    total += BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGas) + BigInt(tx.auxiliaryFeeBudgetWei);
  }
  check(new Set(plan.transactions.map(tx => tx.name)).size === plan.transactions.length, "duplicate operation name");
  check(total.toString() === plan.totalBudgetWei && total <= ethers.parseEther("0.001"), "sequence fee budget differs or exceeds hard ceiling");
  return plan;
}
function requestFor(plan, index) {
  const tx = plan.transactions[index];
  return {type: 2, chainId: 8453n, nonce: tx.nonce, to: tx.to === null ? null : ethers.getAddress(tx.to),
    value: 0n, data: tx.data, gasLimit: BigInt(tx.gasLimit), maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), accessList: []};
}
async function inspectDependencies(plan, providers) {
  for (const p of providers) for (const dep of plan.dependencies)
    check(ethers.keccak256(await p.getCode(dep.address)) === dep.runtimeCodeHash, "dependency runtime differs");
}
async function inspectStep(plan, index, providers, estimateFees = baseAuxiliaryFee) {
  const block = await boundary(providers);
  await inspectDependencies(plan, providers);
  const tx = plan.transactions[index], request = requestFor(plan, index);
  const remaining = plan.transactions.slice(index).reduce((sum, t) => sum + BigInt(t.gasLimit) * BigInt(t.maxFeePerGas) + BigInt(t.auxiliaryFeeBudgetWei), 0n);
  const observations = [];
  for (const p of providers) {
    const [latest, pending, balance, gas, l1] = await Promise.all([
      p.getTransactionCount(plan.deployer, "latest"), p.getTransactionCount(plan.deployer, "pending"),
      p.getBalance(plan.deployer), p.estimateGas({...request, from: plan.deployer}), estimateFees(p, request),
    ]);
    check(latest === tx.nonce && pending === tx.nonce, "operator nonce differs from next operation");
    check(balance >= remaining, "operator balance below remaining fee budget");
    check(gas <= request.gasLimit && l1 <= BigInt(tx.auxiliaryFeeBudgetWei), "fee estimate exceeds reviewed bound");
    check(block.baseFeePerGas != null && block.baseFeePerGas + request.maxPriorityFeePerGas <= request.maxFeePerGas, "fixed fee cap too low");
    for (const item of plan.transactions.slice(index).flatMap(t => t.created))
      check(await p.getCode(item.address) === "0x", "future deployment address occupied");
    observations.push({nonce: latest, estimatedGas: gas.toString(), auxiliaryFeeUpperBoundWei: l1.toString(), balanceWei: balance.toString()});
  }
  return {blockNumber: block.number, blockHash: block.hash, observations, remainingBudgetWei: remaining.toString()};
}
async function inspectMined(plan, index, hash, providers) {
  const block = await boundary(providers), request = requestFor(plan, index);
  const receipts = await Promise.all(providers.map(p => p.getTransactionReceipt(hash)));
  if (receipts.every(r => !r)) return null;
  if (receipts.some(r => !r)) return {status: "confirming", name: plan.transactions[index].name, transactionHash: hash};
  check(receipts[0].blockHash === receipts[1].blockHash, "RPC receipts disagree");
  for (const [i, r] of receipts.entries()) {
    const p = providers[i], minedBlock = await p.getBlock(r.blockNumber), tx = await p.getTransaction(hash);
    check(r.status === 1 && r.hash === hash && minedBlock?.hash === r.blockHash && tx &&
      tx.blockHash === r.blockHash && tx.blockNumber === r.blockNumber && tx.hash === hash &&
      tx.from.toLowerCase() === plan.deployer, "failed or noncanonical receipt");
    for (const field of Object.keys(request)) {
      if (field === "accessList") check(stableJson(tx.accessList) === "[]", "mined access list differs");
      else check(tx[field] === request[field], `mined ${field} differs`);
    }
    if (request.to === null) check(r.contractAddress?.toLowerCase() === plan.transactions[index].created[0].address.toLowerCase(), "receipt contract differs");
    for (const c of plan.transactions[index].created)
      check(ethers.keccak256(await p.getCode(c.address)) === c.runtimeCodeHash, "deployed runtime differs");
    // Historical state matters on resume: a later reviewed binding may have
    // legitimately changed an earlier step's initial state. Use the canonical
    // receipt block, never an unpinned latest-state read.
    for (const condition of plan.transactions[index].postconditions || []) {
      const result = await p.call({to: condition.to, data: condition.data, blockTag: r.blockNumber});
      check(result.toLowerCase() === condition.result.toLowerCase(), "deployment postcondition differs");
    }
  }
  const confirmations = block.number - receipts[0].blockNumber + 1;
  return {status: confirmations >= 12 ? "confirmed" : "confirming", name: plan.transactions[index].name,
    transactionHash: hash, blockNumber: receipts[0].blockNumber, blockHash: receipts[0].blockHash, confirmations};
}
function journalDirectory(directory) {
  const absolute = path.resolve(directory); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, {mode: 0o700});
    const s = fs.lstatSync(current); check(s.isDirectory() && !s.isSymbolicLink(), "journal path cannot contain symlinks");
  }
  const s = fs.statSync(absolute);
  check(s.uid === process.getuid() && (s.mode & 0o077) === 0, "journal must be owner-only");
  return absolute;
}
async function runSequence({plan, providers, verifyPlan, verifyStep, execute = false, signerFactory,
  journal, resubmitOriginal = false, estimateFees = baseAuxiliaryFee}) {
  validatePlan(plan);
  await verifyPlan(plan);
  await boundary(providers);
  await inspectDependencies(plan, providers);
  if (!execute) return {status: "ready_to_sign", planHash: plan.planHash, totalBudgetWei: plan.totalBudgetWei,
    inspection: await inspectStep(plan, 0, providers, estimateFees)};
  const dir = journalDirectory(journal), file = path.join(dir, "signed-sequence.json");
  let saved;
  if (fs.existsSync(file)) {
    const s = fs.lstatSync(file);
    check(s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o077) === 0, "signed journal must be owner-only");
    saved = readCanonical(file);
  } else {
    await inspectStep(plan, 0, providers, estimateFees);
    // Leave a failed signing lock intact: operators must reconcile it explicitly.
    const lock = path.join(dir, "signing.lock"); writeOnce(lock, {planHash: plan.planHash});
    const signer = await signerFactory();
    check((await signer.getAddress()).toLowerCase() === plan.deployer, "keystore address differs");
    const transactions = [];
    for (let i = 0; i < plan.transactions.length; i++) {
      const request = requestFor(plan, i), raw = await signer.signTransaction(request);
      signedHash(raw, request, plan.deployer); transactions.push(raw);
    }
    saved = {schema: "solslot.signed-base-sequence.v1", planHash: plan.planHash, transactions};
    writeOnce(file, saved); fs.unlinkSync(lock);
  }
  exact(saved, ["schema", "planHash", "transactions"], "journal");
  check(saved.schema === "solslot.signed-base-sequence.v1" && saved.planHash === plan.planHash &&
    saved.transactions.length === plan.transactions.length, "journal belongs to another plan");
  const hashes = saved.transactions.map((raw, i) => signedHash(raw, requestFor(plan, i), plan.deployer));
  const completed = [];
  for (let i = 0; i < hashes.length; i++) {
    const hash = hashes[i], mined = await inspectMined(plan, i, hash, providers);
    if (mined?.status === "confirmed") { await verifyStep(plan, i, providers); completed.push(mined); continue; }
    if (mined) return {...mined, completed};
    const known = await Promise.all(providers.map(p => p.getTransaction(hash)));
    if (known.some(Boolean)) return {status: "pending", name: plan.transactions[i].name, transactionHash: hash, completed};
    const attempt = path.join(dir, `broadcast-${i}.json`);
    if (fs.existsSync(attempt) && !resubmitOriginal)
      return {status: "reconciliation_required", name: plan.transactions[i].name, transactionHash: hash, completed};
    await inspectStep(plan, i, providers, estimateFees);
    if (!fs.existsSync(attempt)) writeOnce(attempt, {planHash: plan.planHash, transactionHash: hash});
    const response = await providers[0].broadcastTransaction(saved.transactions[i]);
    check(response.hash === hash, "broadcast hash differs");
    return {status: "broadcast", name: plan.transactions[i].name, transactionHash: hash, completed};
  }
  return {status: "confirmed", planHash: plan.planHash, completed};
}
module.exports = {check, seal, validatePlan, requestFor, inspectStep, inspectMined, runSequence, baseAuxiliaryFee};

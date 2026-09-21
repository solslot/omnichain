const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { preparePlan, requestFor, seal, validatePlan, readCanonical, writeOnce, runDeployment } = require("../scripts/lib/test-token-deployment");

describe("Exact Base mainnet test-token deployment", function () {
  let artifact, signer, plan, directory, providers, state, keyReads;
  const estimateL1 = async () => 100n;
  beforeEach(async function () {
    artifact = await artifacts.readArtifact("SolslotAlphaTestToken");
    signer = ethers.Wallet.createRandom();
    plan = preparePlan({sourceSha: "a".repeat(40), actionEnvelopeId: "AE-SOLSLOT-TEST-TOKEN-TEST",
      deployer: signer.address, nonce: 0, gasLimit: "1500000", maxFeePerGas: "20000000",
      maxPriorityFeePerGas: "1000000", l1FeeBudgetWei: "100000000000000"}, artifact);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-token-test-"));
    state = {nonce: 0, balance: 10n ** 18n, gas: 600000n, code: "0x", broadcasts: 0,
      known: null, receipt: null, lostResponse: false, rejectBroadcast: false};
    keyReads = 0;
    providers = [0, 1].map(() => ({
      getNetwork: async () => ({chainId: 8453n}),
      getBlock: async number => ({number: number === "latest" ? 100 : number, hash: ethers.id("block"), baseFeePerGas: 5000000n}),
      getTransactionCount: async () => state.nonce,
      getCode: async () => state.code,
      getBalance: async () => state.balance,
      estimateGas: async () => state.gas,
      getTransaction: async () => state.known,
      getTransactionReceipt: async () => state.receipt,
      broadcastTransaction: async raw => {
        state.broadcasts++;
        if (state.rejectBroadcast) throw new Error("uncertain broadcaster");
        const tx = ethers.Transaction.from(raw);
        state.known = tx;
        if (state.lostResponse) throw new Error("response lost after sending");
        return {hash: tx.hash};
      },
    }));
  });
  afterEach(function () { fs.rmSync(directory, {recursive: true, force: true}); });
  function run(options = {}) {
    return runDeployment({plan, artifact, providers, journalDirectory: directory, estimateL1,
      signerFactory: async () => { keyReads++; return signer; }, ...options});
  }
  function mutated(fields) { const {planHash, ...rest} = plan; return seal({...rest, ...fields}); }
  it("previews both RPCs and exact code without touching a signer or journal", async function () {
    const result = await run();
    expect(result.status).to.equal("ready_to_sign");
    expect(result.inspection.observations).to.have.length(2);
    expect(keyReads).to.equal(0);
    expect(fs.readdirSync(directory)).to.deep.equal([]);
  });
  it("rejects a relabeled network, token, recipient, and compiled code", function () {
    expect(() => validatePlan(mutated({chainId: 84532}))).to.throw("Base mainnet");
    expect(() => validatePlan(mutated({token: {...plan.token, symbol: "USDC"}}))).to.throw("identity");
    expect(() => validatePlan(mutated({initialRecipient: "0x" + "12".repeat(20)}))).to.throw("operator");
    expect(() => requestFor(plan, {...artifact, deployedBytecode: "0x6000"})).to.throw("runtime");
    expect(() => requestFor(plan, {...artifact, bytecode: "0x6000"})).to.throw("init code");
  });
  for (const problem of ["nonce", "balance", "gas", "occupied", "chain", "block", "l1", "fee"]) {
    it(`rejects ${problem} mismatch before secret access`, async function () {
      let options = {execute: true};
      if (problem === "nonce") state.nonce = 1;
      if (problem === "balance") state.balance = 1n;
      if (problem === "gas") state.gas = 1500001n;
      if (problem === "occupied") state.code = "0x6000";
      if (problem === "chain") providers[1].getNetwork = async () => ({chainId: 84532n});
      if (problem === "block") providers[1].getBlock = async () => ({number: 100, hash: ethers.id("wrong")});
      if (problem === "l1") options.estimateL1 = async () => BigInt(plan.l1FeeBudgetWei) + 1n;
      if (problem === "fee") options.plan = mutated({maxFeePerGas: "1000000"});
      await expect(run(options)).to.be.rejected;
      expect(keyReads).to.equal(0);
      expect(state.broadcasts).to.equal(0);
    });
  }
  it("persists exact signed bytes before broadcasting and resumes without signing twice", async function () {
    const result = await run({execute: true});
    expect(result.status).to.equal("broadcast");
    const file = path.join(directory, "signed-test-token.json");
    expect(fs.statSync(file).mode & 0o777).to.equal(0o600);
    expect(ethers.Transaction.from(readCanonical(file).raw).hash).to.equal(result.transactionHash);
    expect((await run({execute: true})).status).to.equal("pending");
    expect(keyReads).to.equal(1);
    expect(state.broadcasts).to.equal(1);
  });
  it("reconciles a lost broadcast response without repeating the transaction", async function () {
    state.lostResponse = true;
    await expect(run({execute: true})).to.be.rejectedWith("response lost");
    expect((await run({execute: true})).status).to.equal("pending");
    expect(keyReads).to.equal(1);
    expect(state.broadcasts).to.equal(1);
  });
  it("requires explicit original-byte resubmission when both RPCs lost the transaction", async function () {
    state.rejectBroadcast = true;
    await expect(run({execute: true})).to.be.rejected;
    const original = readCanonical(path.join(directory, "signed-test-token.json")).raw;
    expect((await run({execute: true})).status).to.equal("reconciliation_required");
    expect(state.broadcasts).to.equal(1);
    state.rejectBroadcast = false;
    expect((await run({execute: true, resubmitOriginal: true})).status).to.equal("broadcast");
    expect(state.known.serialized).to.equal(original);
    expect(keyReads).to.equal(1);
  });
  it("rejects changed signed transaction fees even with a matching plan label", async function () {
    const raw = await signer.signTransaction({...requestFor(plan, artifact), maxFeePerGas: 30000000n});
    writeOnce(path.join(directory, "signed-test-token.json"), {schema: "solslot.signed-test-token.v1", planHash: plan.planHash, actionEnvelopeId: plan.actionEnvelopeId, raw});
    await expect(run({execute: true})).to.be.rejectedWith("maxFeePerGas");
    expect(keyReads).to.equal(0);
    expect(state.broadcasts).to.equal(0);
  });
  it("confirms only canonical receipts with the compiled runtime on both RPCs", async function () {
    const result = await run({execute: true});
    const raw = readCanonical(path.join(directory, "signed-test-token.json")).raw;
    const parsed = ethers.Transaction.from(raw);
    state.known = {...requestFor(plan, artifact), from: signer.address, hash: parsed.hash,
      blockHash: ethers.id("block"), blockNumber: 80};
    state.receipt = {status: 1, hash: result.transactionHash, blockHash: ethers.id("block"),
      blockNumber: 80, contractAddress: plan.tokenAddress};
    state.code = artifact.deployedBytecode;
    state.nonce = 1;
    expect((await run({execute: true})).status).to.equal("confirmed");
    expect(keyReads).to.equal(1);
    state.code = "0x6000";
    await expect(run({execute: true})).to.be.rejectedWith("runtime");
  });
  it("refuses to overwrite evidence or follow a plan symlink", function () {
    const file = path.join(directory, "plan.json");
    writeOnce(file, plan);
    expect(() => writeOnce(file, plan)).to.throw();
    const checksum = ethers.sha256(fs.readFileSync(file)).slice(2);
    expect(readCanonical(file, checksum)).to.deep.equal(plan);
    expect(() => readCanonical(file, "0".repeat(64))).to.throw("checksum");
    fs.symlinkSync(file, path.join(directory, "link.json"));
    expect(() => readCanonical(path.join(directory, "link.json"))).to.throw();
  });
  it("keeps a crash lock instead of signing a second possible deployment", async function () {
    writeOnce(path.join(directory, "signing.lock"), {planHash: plan.planHash});
    await expect(run({execute: true})).to.be.rejected;
    expect(keyReads).to.equal(0);
  });
});

const { expect } = require("chai");
const { ethers } = require("ethers");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { seal, validatePlan, requestFor, runSequence } = require("../scripts/lib/bounded-base-deployment");
const { readCanonical } = require("../scripts/lib/test-token-deployment");

describe("Bounded Base deployment sequence recovery", function () {
  let plan, state, providers, signer, journal, keyReads, verifySteps;
  beforeEach(function () {
    signer = ethers.Wallet.createRandom(); keyReads = 0; verifySteps = [];
    journal = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-sequence-"));
    plan = seal({schema: "solslot.bounded-base-deployment.v1", sourceSha: "a".repeat(40),
      actionEnvelopeId: "AE-SOLSLOT-SEQUENCE-TEST", chainId: 8453, chiaNetwork: "testnet11", testOnly: true,
      deployer: signer.address.toLowerCase(), startNonce: 0, binding: {}, dependencies: [],
      transactions: [0, 1, 2].map(nonce => ({name: `operation${nonce}`, nonce, to: null,
        data: "0x6001600c60003960016000f300", gasLimit: "100000", maxFeePerGas: "20000000",
        maxPriorityFeePerGas: "1000000", auxiliaryFeeBudgetWei: "1000", created: [{
          address: ethers.getCreateAddress({from: signer.address, nonce}).toLowerCase(), runtimeCodeHash: ethers.keccak256("0x00"),
        }]})), totalBudgetWei: "6000000003000"});
    state = {nonce: 0, gas: 60000n, balance: 10n ** 18n, broadcasts: [], known: {}, receipts: {}, code: {}, lose: false, reject: false, confirmations: 20};
    providers = [0, 1].map(() => ({
      getNetwork: async () => ({chainId: 8453n}),
      getBlock: async n => ({number: n === "latest" ? 100 : n, hash: ethers.id("block"), baseFeePerGas: 5000000n}),
      getTransactionCount: async () => state.nonce,
      getBalance: async () => state.balance,
      estimateGas: async () => state.gas,
      getCode: async address => state.code[address.toLowerCase()] || "0x",
      getTransaction: async hash => state.known[hash] || null,
      getTransactionReceipt: async hash => state.receipts[hash] || null,
      broadcastTransaction: async raw => {
        const tx = ethers.Transaction.from(raw); state.broadcasts.push(raw);
        expect(fs.existsSync(path.join(journal, "signed-sequence.json"))).to.equal(true);
        if (state.reject) throw new Error("transport unavailable");
        state.known[tx.hash] = tx;
        if (state.lose) throw new Error("response lost");
        return {hash: tx.hash};
      },
    }));
  });
  afterEach(function () { fs.rmSync(journal, {recursive: true, force: true}); });
  const estimateFees = async () => 500n;
  function run(options = {}) {
    return runSequence({plan, providers, journal, estimateFees,
      verifyPlan: async p => expect(p.binding).to.deep.equal({}),
      verifyStep: async (_, i) => { verifySteps.push(i); },
      signerFactory: async () => { keyReads++; return signer; }, ...options});
  }
  function mine(index) {
    const raw = readCanonical(path.join(journal, "signed-sequence.json")).transactions[index];
    const tx = ethers.Transaction.from(raw), blockNumber = 101 - state.confirmations;
    state.known[tx.hash] = {...requestFor(plan, index), hash: tx.hash, from: signer.address,
      blockNumber, blockHash: ethers.id("block")};
    state.receipts[tx.hash] = {status: 1, hash: tx.hash, blockHash: ethers.id("block"), blockNumber,
      contractAddress: plan.transactions[index].created[0].address};
    state.code[plan.transactions[index].created[0].address] = "0x00"; state.nonce = index + 1;
  }
  it("previews exact calls without key access or writes", async function () {
    expect((await run()).status).to.equal("ready_to_sign");
    expect(keyReads).to.equal(0); expect(fs.readdirSync(journal)).to.deep.equal([]);
  });
  for (const failure of ["network", "nonce", "balance", "gas", "l1", "occupied", "dependency", "binding"]) {
    it(`fails ${failure} before signing`, async function () {
      const options = {execute: true};
      if (failure === "network") providers[1].getNetwork = async () => ({chainId: 1n});
      if (failure === "nonce") state.nonce = 1;
      if (failure === "balance") state.balance = 1n;
      if (failure === "gas") state.gas = 100001n;
      if (failure === "l1") options.estimateFees = async () => 1001n;
      if (failure === "occupied") state.code[plan.transactions[2].created[0].address] = "0x00";
      if (failure === "dependency") { const {planHash, ...body} = plan; plan = seal({...body, dependencies: [{address: signer.address, runtimeCodeHash: ethers.id("expected")} ]}); }
      if (failure === "binding") options.verifyPlan = async () => { throw new Error("wrong roster"); };
      await expect(run(options)).to.be.rejected;
      expect(keyReads).to.equal(0); expect(state.broadcasts).to.have.length(0);
    });
  }
  it("signs once, persists all bytes, and requires each prior confirmed result before advancing", async function () {
    expect((await run({execute: true})).name).to.equal("operation0");
    const original = readCanonical(path.join(journal, "signed-sequence.json"));
    expect(original.transactions).to.have.length(3);
    expect((await run({execute: true})).status).to.equal("pending");
    expect(state.broadcasts).to.have.length(1);
    state.confirmations = 1; mine(0);
    expect((await run({execute: true})).status).to.equal("confirming");
    state.confirmations = 20; mine(0);
    expect((await run({execute: true})).name).to.equal("operation1"); mine(1);
    expect((await run({execute: true})).name).to.equal("operation2"); mine(2);
    expect((await run({execute: true})).status).to.equal("confirmed");
    expect(keyReads).to.equal(1); expect(state.broadcasts).to.deep.equal(original.transactions);
    expect(verifySteps).to.include(2);
  });
  it("recovers a lost response without re-signing or advancing past pending", async function () {
    state.lose = true;
    await expect(run({execute: true})).to.be.rejectedWith("response lost");
    expect((await run({execute: true})).status).to.equal("pending");
    expect(state.broadcasts).to.have.length(1); expect(keyReads).to.equal(1);
  });
  it("reconciles an absent transaction and resends only the original bytes explicitly", async function () {
    state.reject = true;
    await expect(run({execute: true})).to.be.rejected;
    expect((await run({execute: true})).status).to.equal("reconciliation_required");
    state.reject = false;
    expect((await run({execute: true, resubmitOriginal: true})).status).to.equal("broadcast");
    expect(state.broadcasts[0]).to.equal(state.broadcasts[1]); expect(keyReads).to.equal(1);
  });
  it("blocks an altered journal before any further broadcast", async function () {
    await run({execute: true});
    const file = path.join(journal, "signed-sequence.json"), saved = readCanonical(file);
    saved.transactions[2] = await signer.signTransaction({...requestFor(plan, 2), value: 1n});
    const {stableJson} = require("../scripts/lib/deployment-evidence");
    fs.writeFileSync(file, stableJson(saved) + "\n");
    await expect(run({execute: true})).to.be.rejectedWith("value differs");
    expect(state.broadcasts).to.have.length(1);
  });
  it("blocks a reverted receipt or changed deployed runtime", async function () {
    await run({execute: true}); mine(0);
    const hash = Object.keys(state.receipts)[0]; state.receipts[hash].status = 0;
    await expect(run({execute: true})).to.be.rejectedWith("failed or noncanonical");
    state.receipts[hash].status = 1; state.code[plan.transactions[0].created[0].address] = "0x01";
    await expect(run({execute: true})).to.be.rejectedWith("runtime differs");
    expect(state.broadcasts).to.have.length(1);
  });
  it("refuses a changed budget or real asset scope", function () {
    const {planHash, ...body} = plan;
    expect(() => validatePlan(seal({...body, totalBudgetWei: "1"}))).to.throw("budget");
    expect(() => validatePlan(seal({...body, testOnly: false}))).to.throw("scope");
  });
});

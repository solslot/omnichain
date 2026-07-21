const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { withArtifactHash, writeEvidence } = require("../scripts/lib/deployment-evidence");
const {
  readSafeOwnerRoster,
  safeSaltNonce,
  validateGovernanceEvidence,
} = require("../scripts/lib/governance-deployment");

function roster(overrides = {}) {
  return withArtifactHash({
    schemaVersion: 1,
    kind: "solslot-alpha-safe-owner-roster",
    ceremonyId: `0x${"11".repeat(32)}`,
    network: "testnet11",
    ceremonyState: "abandoned",
    threshold: 2,
    owners: [1, 2, 3].map((slot) => ({
      slot,
      address: `0x${String(slot).padStart(2, "0").repeat(20)}`,
      compressedPubkey: `0x02${String(slot).padStart(2, "0").repeat(32)}`,
    })),
    ...overrides,
  });
}

describe("alpha Safe and timelock deployment inputs", function () {
  async function governanceEvidence({ safe, timelock, owners }) {
    return withArtifactHash({
      schemaVersion: 1,
      kind: "solslot-alpha-safe-timelock-deployment",
      sourceSha: "a".repeat(40),
      network: "baseSepolia",
      chainId: 84532,
      rosterArtifactHash: `0x${"31".repeat(32)}`,
      safe: { address: safe.target, owners, threshold: 2 },
      timelock: {
        address: timelock.target,
        minimumDelaySeconds: "86400",
        proposer: safe.target,
        executor: safe.target,
        externalAdmin: ethers.ZeroAddress,
      },
      payoutAddress: safe.target,
      deploymentTransactions: {},
      runtimeCodeHashes: {
        safe: ethers.keccak256(await ethers.provider.getCode(safe.target)),
        timelock: ethers.keccak256(await ethers.provider.getCode(timelock.target)),
      },
      createdAt: "2026-07-20T00:00:00.000Z",
    });
  }

  it("requires the exact three genesis owner slots", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "safe-roster-"));
    const file = path.join(directory, "roster.json");
    writeEvidence(file, roster());
    const selected = readSafeOwnerRoster(file);
    expect(selected.owners).to.have.length(3);
    expect(BigInt(safeSaltNonce(selected.roster))).to.be.greaterThan(0n);
  });

  it("rejects duplicate or malformed owners", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "safe-roster-invalid-"));
    const duplicate = roster();
    duplicate.owners[1].address = duplicate.owners[0].address;
    const withoutHash = { ...duplicate };
    delete withoutHash.artifactHash;
    const record = withArtifactHash(withoutHash);
    const file = path.join(directory, "roster.json");
    writeEvidence(file, record);
    expect(() => readSafeOwnerRoster(file)).to.throw("three unique ordered slots");
  });

  it("deploys a self-administered 24-hour timelock for one Safe", async function () {
    const [safe] = await ethers.getSigners();
    const timelock = await ethers.deployContract("SolslotAlphaTimelock", [86400, [safe.address], [safe.address]]);
    const proposerRole = await timelock.PROPOSER_ROLE();
    const executorRole = await timelock.EXECUTOR_ROLE();
    const adminRole = await timelock.TIMELOCK_ADMIN_ROLE();
    expect(await timelock.getMinDelay()).to.equal(86400);
    expect(await timelock.hasRole(proposerRole, safe.address)).to.equal(true);
    expect(await timelock.hasRole(executorRole, safe.address)).to.equal(true);
    expect(await timelock.hasRole(adminRole, safe.address)).to.equal(false);
    expect(await timelock.hasRole(adminRole, timelock.target)).to.equal(true);
  });

  it("verifies live Safe owners, threshold, timelock roles, and bytecode", async function () {
    const signers = await ethers.getSigners();
    const owners = signers.slice(0, 3).map((signer) => signer.address);
    const safe = await ethers.deployContract("MockSafe", [owners, 2]);
    const timelock = await ethers.deployContract("SolslotAlphaTimelock", [86400, [safe.target], [safe.target]]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "governance-evidence-"));
    const file = path.join(directory, "governance.json");
    const evidence = await governanceEvidence({ safe, timelock, owners });
    writeEvidence(file, evidence);
    expect((await validateGovernanceEvidence({
      path: file,
      provider: ethers.provider,
      safe: safe.target,
      timelock: timelock.target,
    })).artifactHash).to.equal(evidence.artifactHash);
  });

  it("rejects evidence whose owner roster differs from the deployed Safe", async function () {
    const signers = await ethers.getSigners();
    const owners = signers.slice(0, 3).map((signer) => signer.address);
    const safe = await ethers.deployContract("MockSafe", [owners, 2]);
    const timelock = await ethers.deployContract("SolslotAlphaTimelock", [86400, [safe.target], [safe.target]]);
    const claimedOwners = [owners[0], owners[1], signers[4].address];
    const evidence = await governanceEvidence({ safe, timelock, owners: claimedOwners });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wrong-safe-owners-"));
    const file = path.join(directory, "governance.json");
    writeEvidence(file, evidence);
    await expect(validateGovernanceEvidence({
      path: file,
      provider: ethers.provider,
      safe: safe.target,
      timelock: timelock.target,
    })).to.be.rejectedWith("governance Safe or timelock roles do not match evidence");
  });

  it("rejects a timelock whose roles are assigned outside the Safe", async function () {
    const signers = await ethers.getSigners();
    const owners = signers.slice(0, 3).map((signer) => signer.address);
    const safe = await ethers.deployContract("MockSafe", [owners, 2]);
    const timelock = await ethers.deployContract("SolslotAlphaTimelock", [86400, [signers[4].address], [signers[4].address]]);
    const evidence = await governanceEvidence({ safe, timelock, owners });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wrong-timelock-roles-"));
    const file = path.join(directory, "governance.json");
    writeEvidence(file, evidence);
    await expect(validateGovernanceEvidence({
      path: file,
      provider: ethers.provider,
      safe: safe.target,
      timelock: timelock.target,
    })).to.be.rejectedWith("governance Safe or timelock roles do not match evidence");
  });

  it("accepts two-step ownership only after the Safe's 24-hour timelock operation", async function () {
    const signers = await ethers.getSigners();
    const owners = signers.slice(0, 3).map((signer) => signer.address);
    const safe = await ethers.deployContract("MockSafe", [owners, 2]);
    const timelock = await ethers.deployContract("SolslotAlphaTimelock", [86400, [safe.target], [safe.target]]);
    const gateway = await ethers.deployContract("MockOwnable2Step");
    const spoke = await ethers.deployContract("MockOwnable2Step");
    await gateway.transferOwnership(timelock.target);
    await spoke.transferOwnership(timelock.target);

    const ownable = new ethers.Interface(["function acceptOwnership()"]);
    const targets = [gateway.target, spoke.target];
    const values = [0n, 0n];
    const payloads = targets.map(() => ownable.encodeFunctionData("acceptOwnership"));
    const predecessor = ethers.ZeroHash;
    const salt = ethers.keccak256(ethers.toUtf8Bytes("alpha ownership activation test"));
    const schedule = timelock.interface.encodeFunctionData("scheduleBatch", [
      targets, values, payloads, predecessor, salt, 86400n,
    ]);
    const execute = timelock.interface.encodeFunctionData("executeBatch", [
      targets, values, payloads, predecessor, salt,
    ]);
    await safe.execute(timelock.target, schedule);
    await expect(safe.execute(timelock.target, execute)).to.be.revertedWith("mock Safe call failed");
    await time.increase(86400);
    await safe.execute(timelock.target, execute);
    expect(await gateway.owner()).to.equal(timelock.target);
    expect(await spoke.owner()).to.equal(timelock.target);
  });
});

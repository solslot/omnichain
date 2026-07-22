const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { withArtifactHash, writeEvidence } = require("../scripts/lib/deployment-evidence");
const {
  readSafeOwnerRoster,
  recoveryConfiguration,
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

async function runtimeCodeHash(address) {
  return ethers.keccak256(await ethers.provider.getCode(address));
}

async function hierarchyFixture() {
  const signers = await ethers.getSigners();
  const [owner, coadminOne, coadminTwo, guardian, replacement] = signers;
  const blsGuardianPubkey = `0x${"44".repeat(48)}`;
  const blsGuardianCommitment = ethers.keccak256(blsGuardianPubkey);
  const fallbackHandler = await ethers.deployContract("MockOwnable2Step");
  const signMessageLibrary = await ethers.deployContract("MockOwnable2Step");
  const ownerSetup = await ethers.deployContract("SolslotOwnerIdentitySetup");
  const recovery = await ethers.deployContract("SolslotOwnerRecovery", [
    owner.address,
    guardian.address,
    coadminOne.address,
    coadminTwo.address,
    blsGuardianCommitment,
  ]);
  const ownerGuard = await ethers.deployContract("SolslotAuthorityGuard", [
    owner.address,
    signMessageLibrary.target,
  ]);
  const coadminGuard = await ethers.deployContract("SolslotAuthorityGuard", [
    owner.address,
    signMessageLibrary.target,
  ]);
  const rootGuard = await ethers.deployContract("SolslotAuthorityGuard", [
    owner.address,
    signMessageLibrary.target,
  ]);
  const ownerIdentitySafe = await ethers.deployContract("MockSafe", [[owner.address], 1]);
  const coadminSafe = await ethers.deployContract("MockSafe", [[coadminOne.address, coadminTwo.address], 1]);
  const rootSafe = await ethers.deployContract("MockSafe", [[ownerIdentitySafe.target, coadminSafe.target], 2]);
  for (const safe of [ownerIdentitySafe, coadminSafe, rootSafe]) {
    await safe.setFallbackHandler(fallbackHandler.target);
  }
  await ownerIdentitySafe.enableModule(recovery.target);
  await ownerIdentitySafe.setGuard(ownerGuard.target);
  await coadminSafe.setGuard(coadminGuard.target);
  await rootSafe.setGuard(rootGuard.target);
  await recovery.connect(owner).bindOwnerIdentitySafe(ownerIdentitySafe.target);
  await ownerGuard.connect(owner).bindAuthoritySafe(ownerIdentitySafe.target);
  await coadminGuard.connect(owner).bindAuthoritySafe(coadminSafe.target);
  await rootGuard.connect(owner).bindAuthoritySafe(rootSafe.target);
  const timelock = await ethers.deployContract("SolslotAlphaTimelock", [
    86400,
    [rootSafe.target],
    [rootSafe.target],
  ]);
  const evidence = withArtifactHash({
    schemaVersion: 2,
    kind: "solslot-alpha-owner-required-governance-deployment",
    authorityRule: "slot0_and_one_of_slot1_slot2",
    sourceSha: "a".repeat(40),
    network: "baseSepolia",
    chainId: 84532,
    rosterArtifactHash: `0x${"31".repeat(32)}`,
    administrators: [
      { slot: 1, address: owner.address },
      { slot: 2, address: coadminOne.address },
      { slot: 3, address: coadminTwo.address },
    ],
    safes: {
      ownerIdentity: { address: ownerIdentitySafe.target, owners: [owner.address], threshold: 1, guard: ownerGuard.target },
      coadmin: { address: coadminSafe.target, owners: [coadminOne.address, coadminTwo.address], threshold: 1, guard: coadminGuard.target },
      root: { address: rootSafe.target, owners: [ownerIdentitySafe.target, coadminSafe.target], threshold: 2, guard: rootGuard.target },
    },
    timelock: {
      address: timelock.target,
      minimumDelaySeconds: "86400",
      proposer: rootSafe.target,
      executor: rootSafe.target,
      canceller: rootSafe.target,
      externalAdmin: ethers.ZeroAddress,
    },
    payoutAddress: rootSafe.target,
    recovery: {
      address: recovery.target,
      ownerGuard: ownerGuard.target,
      secp256k1Guardian: guardian.address,
      blsGuardianPubkey,
      blsGuardianCommitment,
      coadmins: [coadminOne.address, coadminTwo.address],
      delaySeconds: "604800",
      replacementAcceptanceRequired: true,
    },
    safeInfrastructure: {
      safeVersion: "1.4.1",
      compatibilityFallbackHandler: fallbackHandler.target,
      signMessageLibrary: signMessageLibrary.target,
      ownerSetup: ownerSetup.target,
    },
    deploymentTransactions: {},
    runtimeCodeHashes: {
      ownerIdentitySafe: await runtimeCodeHash(ownerIdentitySafe.target),
      coadminSafe: await runtimeCodeHash(coadminSafe.target),
      rootSafe: await runtimeCodeHash(rootSafe.target),
      timelock: await runtimeCodeHash(timelock.target),
      recovery: await runtimeCodeHash(recovery.target),
      ownerGuard: await runtimeCodeHash(ownerGuard.target),
      coadminGuard: await runtimeCodeHash(coadminGuard.target),
      rootGuard: await runtimeCodeHash(rootGuard.target),
      ownerSetup: await runtimeCodeHash(ownerSetup.target),
      compatibilityFallbackHandler: await runtimeCodeHash(fallbackHandler.target),
      signMessageLibrary: await runtimeCodeHash(signMessageLibrary.target),
    },
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  return {
    signers,
    owner,
    coadminOne,
    coadminTwo,
    guardian,
    replacement,
    fallbackHandler,
    signMessageLibrary,
    ownerSetup,
    recovery,
    ownerGuard,
    coadminGuard,
    rootGuard,
    ownerIdentitySafe,
    coadminSafe,
    rootSafe,
    timelock,
    evidence,
  };
}

function writeTemporaryEvidence(prefix, evidence) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(directory, "evidence.json");
  writeEvidence(file, evidence);
  return file;
}

describe("owner-required EVM governance", function () {
  it("requires the exact three genesis owner slots and domain-separated Safe salts", function () {
    const file = writeTemporaryEvidence("safe-roster-", roster());
    const selected = readSafeOwnerRoster(file);
    expect(selected.owner).to.equal(selected.owners[0]);
    expect(selected.coadmins).to.deep.equal(selected.owners.slice(1));
    expect(safeSaltNonce(selected.roster, "owner_identity"))
      .not.to.equal(safeSaltNonce(selected.roster, "coadmin"));
  });

  it("rejects duplicate administrators and reused recovery keys", function () {
    const duplicate = roster();
    duplicate.owners[1].address = duplicate.owners[0].address;
    delete duplicate.artifactHash;
    expect(() => readSafeOwnerRoster(writeTemporaryEvidence("safe-roster-invalid-", withArtifactHash(duplicate))))
      .to.throw("three unique ordered slots");
    const admins = roster().owners.map((record) => record.address);
    expect(() => recoveryConfiguration({
      SOLSLOT_SECP256K1_RECOVERY_GUARDIAN: admins[0],
      SOLSLOT_BLS_RECOVERY_GUARDIAN_PUBKEY: `0x${"77".repeat(48)}`,
    }, admins)).to.throw("separate from all administrator keys");
  });

  it("rejects the legacy flat 2-of-3 Safe evidence", async function () {
    const signers = await ethers.getSigners();
    const safe = await ethers.deployContract("MockSafe", [signers.slice(0, 3).map((signer) => signer.address), 2]);
    const timelock = await ethers.deployContract("SolslotAlphaTimelock", [86400, [safe.target], [safe.target]]);
    const legacy = withArtifactHash({
      schemaVersion: 1,
      kind: "solslot-alpha-safe-timelock-deployment",
      network: "baseSepolia",
      chainId: 84532,
      safe: { address: safe.target, owners: await safe.getOwners(), threshold: 2 },
      timelock: { address: timelock.target, minimumDelaySeconds: "86400" },
    });
    await expect(validateGovernanceEvidence({
      path: writeTemporaryEvidence("legacy-flat-safe-", legacy),
      provider: ethers.provider,
      rootSafe: safe.target,
      timelock: timelock.target,
    })).to.be.rejectedWith("governance deployment evidence is unsupported");
  });

  it("validates the live owner Safe, coadmin Safe, 2-of-2 root, recovery, and timelock", async function () {
    const fixture = await hierarchyFixture();
    const observed = await validateGovernanceEvidence({
      path: writeTemporaryEvidence("governance-v2-", fixture.evidence),
      provider: ethers.provider,
      rootSafe: fixture.rootSafe.target,
      timelock: fixture.timelock.target,
    });
    expect(observed.artifactHash).to.equal(fixture.evidence.artifactHash);
  });

  it("atomically enables the recovery module and owner guard through the Safe setup helper", async function () {
    const fixture = await hierarchyFixture();
    const freshSafe = await ethers.deployContract("MockSafe", [[fixture.owner.address], 1]);
    await freshSafe.delegateSetup(
      fixture.ownerSetup.target,
      fixture.ownerSetup.interface.encodeFunctionData("configureOwner", [
        fixture.recovery.target,
        fixture.ownerGuard.target,
      ]),
    );
    expect(await freshSafe.isModuleEnabled(fixture.recovery.target)).to.equal(true);
    const guardSlot = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
    const storedGuard = await ethers.provider.getStorage(freshSafe.target, guardSlot);
    expect(ethers.getAddress(`0x${storedGuard.slice(-40)}`)).to.equal(fixture.ownerGuard.target);

    const staticSafe = await ethers.deployContract("MockSafe", [[fixture.coadminOne.address], 1]);
    await staticSafe.delegateSetup(
      fixture.ownerSetup.target,
      fixture.ownerSetup.interface.encodeFunctionData("configureStatic", [fixture.coadminGuard.target]),
    );
    const staticGuard = await ethers.provider.getStorage(staticSafe.target, guardSlot);
    expect(ethers.getAddress(`0x${staticGuard.slice(-40)}`)).to.equal(fixture.coadminGuard.target);
  });

  it("rejects hierarchy evidence that substitutes a coadmin or bypasses the root Safe", async function () {
    const fixture = await hierarchyFixture();
    const altered = structuredClone(fixture.evidence);
    delete altered.artifactHash;
    altered.safes.coadmin.owners[1] = fixture.signers[8].address;
    await expect(validateGovernanceEvidence({
      path: writeTemporaryEvidence("wrong-coadmin-", withArtifactHash(altered)),
      provider: ethers.provider,
      rootSafe: fixture.rootSafe.target,
      timelock: fixture.timelock.target,
    })).to.be.rejectedWith("governance deployment evidence addresses mismatch");

    const bypass = structuredClone(fixture.evidence);
    delete bypass.artifactHash;
    bypass.timelock.proposer = fixture.coadminSafe.target;
    await expect(validateGovernanceEvidence({
      path: writeTemporaryEvidence("coadmin-bypass-", withArtifactHash(bypass)),
      provider: ethers.provider,
      rootSafe: fixture.rootSafe.target,
      timelock: fixture.timelock.target,
    })).to.be.rejectedWith("governance deployment evidence addresses mismatch");
  });

  it("keeps operational ownership behind the root Safe's 24-hour timelock", async function () {
    const fixture = await hierarchyFixture();
    const gateway = await ethers.deployContract("MockOwnable2Step");
    const spoke = await ethers.deployContract("MockOwnable2Step");
    await gateway.transferOwnership(fixture.timelock.target);
    await spoke.transferOwnership(fixture.timelock.target);
    const ownable = new ethers.Interface(["function acceptOwnership()"]);
    const targets = [gateway.target, spoke.target];
    const values = [0n, 0n];
    const payloads = targets.map(() => ownable.encodeFunctionData("acceptOwnership"));
    const predecessor = ethers.ZeroHash;
    const salt = ethers.keccak256(ethers.toUtf8Bytes("owner-required activation"));
    await fixture.rootSafe.execute(fixture.timelock.target, fixture.timelock.interface.encodeFunctionData("scheduleBatch", [
      targets, values, payloads, predecessor, salt, 86400n,
    ]));
    await expect(fixture.rootSafe.execute(
      fixture.timelock.target,
      fixture.timelock.interface.encodeFunctionData("executeBatch", [targets, values, payloads, predecessor, salt]),
    )).to.be.revertedWith("mock Safe call failed");
    await time.increase(86400);
    await fixture.rootSafe.execute(
      fixture.timelock.target,
      fixture.timelock.interface.encodeFunctionData("executeBatch", [targets, values, payloads, predecessor, salt]),
    );
    expect(await gateway.owner()).to.equal(fixture.timelock.target);
    expect(await spoke.owner()).to.equal(fixture.timelock.target);
  });

  it("cannot grant a bypass role or reduce the immutable 24-hour delay", async function () {
    const fixture = await hierarchyFixture();
    const proposerRole = await fixture.timelock.PROPOSER_ROLE();
    const attempts = [
      fixture.timelock.interface.encodeFunctionData("grantRole", [
        proposerRole,
        fixture.coadminSafe.target,
      ]),
      fixture.timelock.interface.encodeFunctionData("updateDelay", [0]),
    ];
    for (const [index, payload] of attempts.entries()) {
      const salt = ethers.keccak256(ethers.toUtf8Bytes(`frozen-authority-${index}`));
      await fixture.rootSafe.execute(
        fixture.timelock.target,
        fixture.timelock.interface.encodeFunctionData("schedule", [
          fixture.timelock.target,
          0,
          payload,
          ethers.ZeroHash,
          salt,
          86400,
        ]),
      );
      await time.increase(86400);
      await expect(fixture.rootSafe.execute(
        fixture.timelock.target,
        fixture.timelock.interface.encodeFunctionData("execute", [
          fixture.timelock.target,
          0,
          payload,
          ethers.ZeroHash,
          salt,
        ]),
      )).to.be.revertedWith("mock Safe call failed");
    }
    expect(await fixture.timelock.getMinDelay()).to.equal(86400);
    expect(await fixture.timelock.hasRole(proposerRole, fixture.coadminSafe.target)).to.equal(false);
  });

  it("requires guardian initiation, both coadmins, replacement acceptance, and seven days", async function () {
    const fixture = await hierarchyFixture();
    await expect(fixture.recovery.connect(fixture.coadminOne).initiateRecovery(fixture.replacement.address))
      .to.be.revertedWithCustomError(fixture.recovery, "UnauthorizedRecoveryActor");
    await fixture.recovery.connect(fixture.guardian).initiateRecovery(fixture.replacement.address);
    const request = await fixture.recovery.recovery();
    await fixture.recovery.connect(fixture.coadminOne).approveRecovery(request.id);
    await fixture.recovery.connect(fixture.coadminTwo).approveRecovery(request.id);
    await expect(fixture.recovery.executeRecovery(request.id))
      .to.be.revertedWithCustomError(fixture.recovery, "RecoveryNotApproved");
    await fixture.recovery.connect(fixture.replacement).acceptRecovery(request.id);
    await expect(fixture.recovery.executeRecovery(request.id))
      .to.be.revertedWithCustomError(fixture.recovery, "RecoveryDelayActive");
    await time.increase(604800);
    await fixture.recovery.executeRecovery(request.id);
    expect(await fixture.ownerIdentitySafe.getOwners()).to.deep.equal([fixture.replacement.address]);
  });

  it("blocks direct owner reconfiguration and arbitrary delegatecalls", async function () {
    const fixture = await hierarchyFixture();
    expect(await fixture.ownerGuard.supportsInterface("0xe6d7a83a")).to.equal(true);
    const safeConfiguration = new ethers.Interface([
      "function disableModule(address,address)",
      "function swapOwner(address,address,address)",
      "function setGuard(address)",
    ]);
    for (const data of [
      safeConfiguration.encodeFunctionData("disableModule", [ethers.ZeroAddress, fixture.recovery.target]),
      safeConfiguration.encodeFunctionData("swapOwner", [ethers.ZeroAddress, fixture.owner.address, fixture.replacement.address]),
      safeConfiguration.encodeFunctionData("setGuard", [ethers.ZeroAddress]),
    ]) {
      await expect(fixture.ownerIdentitySafe.checkGuard(
        fixture.ownerGuard.target,
        fixture.ownerIdentitySafe.target,
        data,
        0,
      )).to.be.revertedWithCustomError(fixture.ownerGuard, "SafeConfigurationBlocked");
    }
    for (const [safe, guard] of [
      [fixture.coadminSafe, fixture.coadminGuard],
      [fixture.rootSafe, fixture.rootGuard],
    ]) {
      await expect(safe.checkGuard(
        guard.target,
        safe.target,
        safeConfiguration.encodeFunctionData("setGuard", [ethers.ZeroAddress]),
        0,
      )).to.be.revertedWithCustomError(guard, "SafeConfigurationBlocked");
    }
    await expect(fixture.ownerIdentitySafe.checkGuard(
      fixture.ownerGuard.target,
      fixture.signers[9].address,
      "0x12345678",
      1,
    )).to.be.revertedWithCustomError(fixture.ownerGuard, "DelegateCallBlocked");
    const signMessage = new ethers.Interface(["function signMessage(bytes)"]);
    await expect(fixture.ownerIdentitySafe.checkGuard(
      fixture.ownerGuard.target,
      fixture.signMessageLibrary.target,
      signMessage.encodeFunctionData("signMessage", ["0x1234"]),
      1,
    )).not.to.be.reverted;
  });
});

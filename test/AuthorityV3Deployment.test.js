const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("hardhat");

const {
  readAuthorityV3Roster,
  validateAuthorityV3GovernanceEvidence,
} = require("../scripts/lib/authority-v3-deployment");
const {
  withArtifactHash,
  writeEvidence,
} = require("../scripts/lib/deployment-evidence");

const SOURCE_MANIFEST_HASH = `0x${"90".repeat(32)}`;
const AUTHORITY_LAUNCHER_ID = `0x${"80".repeat(32)}`;
const IDENTITY_LAUNCHER_IDS = [
  `0x${"81".repeat(32)}`,
  `0x${"82".repeat(32)}`,
  `0x${"83".repeat(32)}`,
];
const BLS_KEYS = [
  `0x${"31".repeat(48)}`,
  `0x${"32".repeat(48)}`,
  `0x${"33".repeat(48)}`,
];

function writeTemporaryEvidence(prefix, evidence) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(directory, "evidence.json");
  writeEvidence(file, evidence);
  return file;
}

function authorityRoster(overrides = {}) {
  const dailyWallets = [0, 1, 2].map(() => ethers.Wallet.createRandom());
  const recoveryWallets = [0, 1, 2].map(() => ethers.Wallet.createRandom());
  return {
    dailyWallets,
    recoveryWallets,
    evidence: withArtifactHash({
      schemaVersion: 2,
      kind: "solslot-alpha-authority-v3-roster",
      ceremonyId: `0x${"71".repeat(32)}`,
      network: "testnet11",
      ceremonyState: "roster_frozen",
      authorityRule: "slot0_and_one_of_slot1_slot2",
      sourceManifestHash: SOURCE_MANIFEST_HASH,
      authorityLauncherId: AUTHORITY_LAUNCHER_ID,
      identityLauncherIds: IDENTITY_LAUNCHER_IDS,
      administrators: dailyWallets.map((wallet, slot) => ({
        slot,
        address: wallet.address,
        compressedPubkey: wallet.signingKey.compressedPublicKey,
        recovery: {
          evmGuardian: recoveryWallets[slot].address,
          blsPubkey: BLS_KEYS[slot],
          blsCommitment: ethers.keccak256(BLS_KEYS[slot]),
          revision: 1,
          drillVerifiedAt: "2026-07-28T12:00:00.000Z",
        },
      })),
      ...overrides,
    }),
  };
}

async function runtimeCodeHash(address) {
  return ethers.keccak256(await ethers.provider.getCode(address));
}

// The local contracts are exercised through a provider that simulates the
// selected public RPC chain identity; contract reads still run on Hardhat.
function authorityProvider(chainId = 84532) {
  return new Proxy(ethers.provider, {
    get(target, property) {
      if (property === "getNetwork") return async () => ({ chainId: BigInt(chainId) });
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function governanceFixture(network = "baseSepolia", chainId = 84532) {
  const roster = authorityRoster();
  const [initializer] = await ethers.getSigners();
  const fallbackHandler = await ethers.deployContract("MockOwnable2Step");
  const signMessageLibrary = await ethers.deployContract("MockOwnable2Step");
  const identitySetup = await ethers.deployContract("SolslotOwnerIdentitySetup");
  const recovery = await ethers.deployContract("SolslotAdminRecoveryV3", [
    initializer.address,
    AUTHORITY_LAUNCHER_ID,
    IDENTITY_LAUNCHER_IDS,
    "testnet11",
    SOURCE_MANIFEST_HASH,
    roster.dailyWallets.map(({ signingKey }) =>
      ethers.keccak256(signingKey.compressedPublicKey)),
    roster.recoveryWallets.map(({ address }) => address),
    BLS_KEYS.map((key) => ethers.keccak256(key)),
  ]);
  const guards = [];
  for (let index = 0; index < 5; index += 1) {
    guards.push(await ethers.deployContract("SolslotAuthorityGuardV3", [
      initializer.address,
      signMessageLibrary.target,
      recovery.target,
    ]));
  }
  const identitySafes = [];
  for (let slot = 0; slot < 3; slot += 1) {
    const safe = await ethers.deployContract("MockSafe", [[
      roster.dailyWallets[slot].address,
    ], 1]);
    await safe.setFallbackHandler(fallbackHandler.target);
    await safe.enableModule(recovery.target);
    await safe.setGuard(guards[slot].target);
    identitySafes.push(safe);
  }
  const coadminSafe = await ethers.deployContract("MockSafe", [[
    identitySafes[1].target,
    identitySafes[2].target,
  ], 1]);
  const rootSafe = await ethers.deployContract("MockSafe", [[
    identitySafes[0].target,
    coadminSafe.target,
  ], 2]);
  for (const [safe, guard] of [
    [coadminSafe, guards[3]],
    [rootSafe, guards[4]],
  ]) {
    await safe.setFallbackHandler(fallbackHandler.target);
    await safe.setGuard(guard.target);
  }
  await recovery.bindAuthorityTopology(
    identitySafes.map(({ target }) => target),
    coadminSafe.target,
    rootSafe.target,
  );
  for (let slot = 0; slot < 3; slot += 1) {
    await guards[slot].bindAuthoritySafe(identitySafes[slot].target);
  }
  await guards[3].bindAuthoritySafe(coadminSafe.target);
  await guards[4].bindAuthoritySafe(rootSafe.target);
  const timelock = await ethers.deployContract("SolslotAlphaTimelock", [
    86400,
    [rootSafe.target],
    [rootSafe.target],
  ]);

  const administrators = roster.dailyWallets.map((wallet, slot) => ({
    slot,
    address: wallet.address,
    compressedPubkey: wallet.signingKey.compressedPublicKey,
  }));
  const evidence = withArtifactHash({
    schemaVersion: 3,
    kind: "solslot-alpha-authority-v3-governance-deployment",
    authorityRule: "slot0_and_one_of_slot1_slot2",
    sourceSha: "a".repeat(40),
    network,
    chainId,
    rosterArtifactHash: roster.evidence.artifactHash,
    chiaAuthority: {
      network: "testnet11",
      sourceManifestHash: SOURCE_MANIFEST_HASH,
      authorityLauncherId: AUTHORITY_LAUNCHER_ID,
      identityLauncherIds: IDENTITY_LAUNCHER_IDS,
    },
    administrators,
    safes: {
      identities: identitySafes.map((safe, slot) => ({
        slot,
        address: safe.target,
        owners: [administrators[slot].address],
        threshold: 1,
        guard: guards[slot].target,
        recoveryModule: recovery.target,
      })),
      coadmin: {
        address: coadminSafe.target,
        owners: [identitySafes[1].target, identitySafes[2].target],
        threshold: 1,
        guard: guards[3].target,
      },
      root: {
        address: rootSafe.target,
        owners: [identitySafes[0].target, coadminSafe.target],
        threshold: 2,
        guard: guards[4].target,
      },
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
      routineDelaySeconds: "86400",
      lostKeyDelaySeconds: "604800",
      replacementAcceptanceRequired: true,
      globalFreezeRequired: true,
      crossChainConvergenceRequired: true,
      recoveryKitRotationSupported: true,
      rollbackRequiresChiaCancellationReceipt: true,
      identities: roster.recoveryWallets.map((wallet, slot) => ({
        slot,
        evmGuardian: wallet.address,
        blsPubkey: BLS_KEYS[slot],
        blsCommitment: ethers.keccak256(BLS_KEYS[slot]),
        revision: 1,
        drillVerifiedAt: "2026-07-28T12:00:00.000Z",
      })),
    },
    safeInfrastructure: {
      safeVersion: "1.4.1",
      compatibilityFallbackHandler: fallbackHandler.target,
      signMessageLibrary: signMessageLibrary.target,
      identitySetup: identitySetup.target,
    },
    deploymentTransactions: {},
    runtimeCodeHashes: {
      identitySafe0: await runtimeCodeHash(identitySafes[0].target),
      identitySafe1: await runtimeCodeHash(identitySafes[1].target),
      identitySafe2: await runtimeCodeHash(identitySafes[2].target),
      coadminSafe: await runtimeCodeHash(coadminSafe.target),
      rootSafe: await runtimeCodeHash(rootSafe.target),
      timelock: await runtimeCodeHash(timelock.target),
      recovery: await runtimeCodeHash(recovery.target),
      identityGuard0: await runtimeCodeHash(guards[0].target),
      identityGuard1: await runtimeCodeHash(guards[1].target),
      identityGuard2: await runtimeCodeHash(guards[2].target),
      coadminGuard: await runtimeCodeHash(guards[3].target),
      rootGuard: await runtimeCodeHash(guards[4].target),
      identitySetup: await runtimeCodeHash(identitySetup.target),
      compatibilityFallbackHandler: await runtimeCodeHash(fallbackHandler.target),
      signMessageLibrary: await runtimeCodeHash(signMessageLibrary.target),
    },
    createdAt: "2026-07-28T12:00:00.000Z",
  });
  return { ...roster, evidence, recovery, rootSafe, timelock };
}

describe("Authority V3 deployment evidence", function () {
  it("accepts only drilled, separate recovery identities bound to daily keys", function () {
    const roster = authorityRoster();
    const parsed = readAuthorityV3Roster(
      writeTemporaryEvidence("authority-v3-roster-", roster.evidence),
    );
    expect(parsed.owners).to.deep.equal(
      roster.dailyWallets.map(({ address }) => address),
    );
    expect(parsed.guardians).to.deep.equal(
      roster.recoveryWallets.map(({ address }) => address),
    );

    const missingDrill = structuredClone(roster.evidence);
    delete missingDrill.artifactHash;
    delete missingDrill.administrators[1].recovery.drillVerifiedAt;
    expect(() => readAuthorityV3Roster(writeTemporaryEvidence(
      "authority-v3-no-drill-",
      withArtifactHash(missingDrill),
    ))).to.throw("recovery drill is not verified");

    const overlap = structuredClone(roster.evidence);
    delete overlap.artifactHash;
    overlap.administrators[1].recovery.evmGuardian =
      overlap.administrators[0].address;
    expect(() => readAuthorityV3Roster(writeTemporaryEvidence(
      "authority-v3-overlap-",
      withArtifactHash(overlap),
    ))).to.throw("must be separate and unique");
  });

  it("validates the live three-identity hierarchy, recovery module, guards, and timelock", async function () {
    const fixture = await governanceFixture();
    const observed = await validateAuthorityV3GovernanceEvidence({
      path: writeTemporaryEvidence("authority-v3-governance-", fixture.evidence),
      provider: authorityProvider(),
      rootSafe: fixture.rootSafe.target,
      timelock: fixture.timelock.target,
    });
    expect(observed.artifactHash).to.equal(fixture.evidence.artifactHash);
  });

  it("validates Base mainnet governance independently of Chia Testnet11", async function () {
    const fixture = await governanceFixture("baseMainnet", 8453);
    const file = writeTemporaryEvidence("authority-v3-base-mainnet-", fixture.evidence);
    const observed = await validateAuthorityV3GovernanceEvidence({
      path: file,
      provider: authorityProvider(8453),
      rootSafe: fixture.rootSafe.target,
      timelock: fixture.timelock.target,
    });
    expect(observed.chainId).to.equal(8453);
    expect(observed.chiaAuthority.network).to.equal("testnet11");
    await expect(validateAuthorityV3GovernanceEvidence({
      path: file,
      provider: authorityProvider(84532),
      rootSafe: fixture.rootSafe.target,
      timelock: fixture.timelock.target,
    })).to.be.rejectedWith("RPC chain differs");
  });

  it("rejects V2 evidence and altered recovery or topology evidence", async function () {
    const fixture = await governanceFixture();
    const v2 = structuredClone(fixture.evidence);
    delete v2.artifactHash;
    v2.schemaVersion = 2;
    await expect(validateAuthorityV3GovernanceEvidence({
      path: writeTemporaryEvidence("authority-v3-v2-", withArtifactHash(v2)),
      provider: authorityProvider(),
      rootSafe: fixture.rootSafe.target,
      timelock: fixture.timelock.target,
    })).to.be.rejectedWith("Authority V3 governance evidence is unsupported");

    const altered = structuredClone(fixture.evidence);
    delete altered.artifactHash;
    altered.recovery.identities[1].revision = 2;
    await expect(validateAuthorityV3GovernanceEvidence({
      path: writeTemporaryEvidence(
        "authority-v3-altered-",
        withArtifactHash(altered),
      ),
      provider: authorityProvider(),
      rootSafe: fixture.rootSafe.target,
      timelock: fixture.timelock.target,
    })).to.be.rejectedWith(
      "Authority V3 recovery coordinator differs from evidence",
    );

    const bypass = structuredClone(fixture.evidence);
    delete bypass.artifactHash;
    bypass.safes.root.owners = [
      bypass.safes.identities[1].address,
      bypass.safes.coadmin.address,
    ];
    await expect(validateAuthorityV3GovernanceEvidence({
      path: writeTemporaryEvidence(
        "authority-v3-bypass-",
        withArtifactHash(bypass),
      ),
      provider: authorityProvider(),
      rootSafe: fixture.rootSafe.target,
      timelock: fixture.timelock.target,
    })).to.be.rejectedWith("Authority V3 governance topology evidence mismatches");

    const missingKitRotation = structuredClone(fixture.evidence);
    delete missingKitRotation.artifactHash;
    delete missingKitRotation.recovery.recoveryKitRotationSupported;
    await expect(validateAuthorityV3GovernanceEvidence({
      path: writeTemporaryEvidence(
        "authority-v3-no-kit-rotation-",
        withArtifactHash(missingKitRotation),
      ),
      provider: authorityProvider(),
      rootSafe: fixture.rootSafe.target,
      timelock: fixture.timelock.target,
    })).to.be.rejectedWith("Authority V3 governance evidence is unsupported");

    const unboundRollback = structuredClone(fixture.evidence);
    delete unboundRollback.artifactHash;
    unboundRollback.recovery.rollbackRequiresChiaCancellationReceipt = false;
    await expect(validateAuthorityV3GovernanceEvidence({
      path: writeTemporaryEvidence(
        "authority-v3-unbound-rollback-",
        withArtifactHash(unboundRollback),
      ),
      provider: authorityProvider(),
      rootSafe: fixture.rootSafe.target,
      timelock: fixture.timelock.target,
    })).to.be.rejectedWith("Authority V3 governance evidence is unsupported");
  });
});

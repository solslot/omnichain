const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;
const SOURCE_MANIFEST_HASH = `0x${"90".repeat(32)}`;
const AUTHORITY_LAUNCHER_ID = `0x${"80".repeat(32)}`;
const IDENTITY_LAUNCHER_IDS = [
  `0x${"81".repeat(32)}`,
  `0x${"82".repeat(32)}`,
  `0x${"83".repeat(32)}`,
];
const OLD_CHIA_KEYS = [
  `0x02${"11".repeat(32)}`,
  `0x02${"12".repeat(32)}`,
  `0x02${"13".repeat(32)}`,
];
const NEW_CHIA_KEYS = [
  `0x03${"21".repeat(32)}`,
  `0x03${"22".repeat(32)}`,
  `0x03${"23".repeat(32)}`,
];
const RECOVERY_BLS_KEYS = [
  `0x${"31".repeat(48)}`,
  `0x${"32".repeat(48)}`,
  `0x${"33".repeat(48)}`,
];
const NEW_RECOVERY_BLS_KEYS = [
  `0x${"41".repeat(48)}`,
  `0x${"42".repeat(48)}`,
  `0x${"43".repeat(48)}`,
];

async function executeFromSafe(safe, target, data) {
  return safe.execute(target, data);
}

async function authorityV3Fixture() {
  const signers = await ethers.getSigners();
  const [
    initializer,
    daily0,
    daily1,
    daily2,
    guardian0,
    guardian1,
    guardian2,
    replacement0,
    replacement1,
    replacement2,
    outsider,
    newGuardian0,
    newGuardian1,
    newGuardian2,
  ] = signers;
  const signMessageLibrary = await ethers.deployContract("MockOwnable2Step");
  const recovery = await ethers.deployContract("SolslotAdminRecoveryV3", [
    initializer.address,
    AUTHORITY_LAUNCHER_ID,
    IDENTITY_LAUNCHER_IDS,
    "testnet11",
    SOURCE_MANIFEST_HASH,
    OLD_CHIA_KEYS.map((key) => ethers.keccak256(key)),
    [guardian0.address, guardian1.address, guardian2.address],
    RECOVERY_BLS_KEYS.map((key) => ethers.keccak256(key)),
  ]);

  const daily = [daily0, daily1, daily2];
  const identitySafes = [];
  const identityGuards = [];
  for (const signer of daily) {
    const safe = await ethers.deployContract("MockSafe", [[signer.address], 1]);
    const guard = await ethers.deployContract("SolslotAuthorityGuardV3", [
      initializer.address,
      signMessageLibrary.target,
      recovery.target,
    ]);
    await safe.enableModule(recovery.target);
    await safe.setGuard(guard.target);
    identitySafes.push(safe);
    identityGuards.push(guard);
  }
  const coadminSafe = await ethers.deployContract("MockSafe", [[
    identitySafes[1].target,
    identitySafes[2].target,
  ], 1]);
  const rootSafe = await ethers.deployContract("MockSafe", [[
    identitySafes[0].target,
    coadminSafe.target,
  ], 2]);
  const coadminGuard = await ethers.deployContract("SolslotAuthorityGuardV3", [
    initializer.address,
    signMessageLibrary.target,
    recovery.target,
  ]);
  const rootGuard = await ethers.deployContract("SolslotAuthorityGuardV3", [
    initializer.address,
    signMessageLibrary.target,
    recovery.target,
  ]);
  await coadminSafe.setGuard(coadminGuard.target);
  await rootSafe.setGuard(rootGuard.target);

  await recovery.bindAuthorityTopology(
    identitySafes.map((safe) => safe.target),
    coadminSafe.target,
    rootSafe.target,
  );
  for (let slot = 0; slot < 3; slot += 1) {
    await identityGuards[slot].bindAuthoritySafe(identitySafes[slot].target);
  }
  await coadminGuard.bindAuthoritySafe(coadminSafe.target);
  await rootGuard.bindAuthoritySafe(rootSafe.target);

  const chainId = (await ethers.provider.getNetwork()).chainId;
  const replacements = [replacement0, replacement1, replacement2];
  const guardians = [guardian0, guardian1, guardian2];
  const newGuardians = [newGuardian0, newGuardian1, newGuardian2];
  async function intent(slot, kind, overrides = {}) {
    return {
      slot,
      kind,
      oldDailyEvmKey: daily[slot].address,
      newDailyEvmKey: replacements[slot].address,
      oldDailyChiaKey: OLD_CHIA_KEYS[slot],
      newDailyChiaKey: NEW_CHIA_KEYS[slot],
      oldRecoveryGuardian: guardians[slot].address,
      newRecoveryGuardian: guardians[slot].address,
      oldRecoveryBlsKey: RECOVERY_BLS_KEYS[slot],
      newRecoveryBlsKey: RECOVERY_BLS_KEYS[slot],
      identityLauncherIds: IDENTITY_LAUNCHER_IDS,
      identitySafes: identitySafes.map((safe) => safe.target),
      authorityLauncherId: AUTHORITY_LAUNCHER_ID,
      coadminSafe: coadminSafe.target,
      rootSafe: rootSafe.target,
      chiaNetwork: "testnet11",
      evmChainId: chainId,
      sourceManifestHash: SOURCE_MANIFEST_HASH,
      nonce: 1,
      expiresAt: (await time.latest())
        + (kind === 2 ? WEEK : DAY)
        + WEEK,
      recoveryKeyRevision: 1,
      ...overrides,
    };
  }

  return {
    signers,
    initializer,
    daily,
    guardians,
    newGuardians,
    replacements,
    outsider,
    signMessageLibrary,
    recovery,
    identitySafes,
    identityGuards,
    coadminSafe,
    coadminGuard,
    rootSafe,
    rootGuard,
    intent,
  };
}

async function recoveryKitIntent(fixture, slot = 1, overrides = {}) {
  return fixture.intent(slot, 3, {
    newDailyEvmKey: fixture.daily[slot].address,
    newDailyChiaKey: OLD_CHIA_KEYS[slot],
    newRecoveryGuardian: fixture.newGuardians[slot].address,
    newRecoveryBlsKey: NEW_RECOVERY_BLS_KEYS[slot],
    ...overrides,
  });
}

async function prepareRoutine(fixture, slot = 1) {
  const changeIntent = await fixture.intent(slot, 1);
  const intentHash = await fixture.recovery.hashIntent(changeIntent);
  await fixture.recovery.connect(fixture.daily[slot]).prepareRoutine(changeIntent);
  return { changeIntent, intentHash };
}

async function approveRoutine(fixture, intentHash) {
  await executeFromSafe(
    fixture.rootSafe,
    fixture.recovery.target,
    fixture.recovery.interface.encodeFunctionData(
      "approveRoutineByRoot",
      [intentHash],
    ),
  );
}

async function prepareLost(fixture, slot = 0) {
  const changeIntent = await fixture.intent(slot, 2);
  const intentHash = await fixture.recovery.hashIntent(changeIntent);
  await fixture.recovery.connect(fixture.guardians[slot]).prepareLostKey(changeIntent);
  return { changeIntent, intentHash };
}

async function lostAuthorization(fixture, changeIntent, slot = 0) {
  const intentHash = await fixture.recovery.hashIntent(changeIntent);
  const { chainId } = await ethers.provider.getNetwork();
  const guardianSignature = await fixture.guardians[slot].signTypedData(
    {
      name: "Solslot Admin Recovery",
      version: "1",
      chainId,
      verifyingContract: fixture.recovery.target,
    },
    {
      SolslotLostKeyPrepare: [
        { name: "intentHash", type: "bytes32" },
      ],
    },
    { intentHash },
  );
  return { intentHash, guardianSignature };
}

async function recoveryGuardianAcceptance(fixture, intentHash, slot = 0) {
  const { chainId } = await ethers.provider.getNetwork();
  const guardianSignature = await fixture.newGuardians[slot].signTypedData(
    {
      name: "Solslot Admin Recovery",
      version: "1",
      chainId,
      verifyingContract: fixture.recovery.target,
    },
    {
      SolslotRecoveryGuardianAccept: [
        { name: "intentHash", type: "bytes32" },
      ],
    },
    { intentHash },
  );
  return guardianSignature;
}

async function recoveryGuardianVeto(fixture, intentHash, slot = 0) {
  const { chainId } = await ethers.provider.getNetwork();
  return fixture.guardians[slot].signTypedData(
    {
      name: "Solslot Admin Recovery",
      version: "1",
      chainId,
      verifyingContract: fixture.recovery.target,
    },
    {
      SolslotRecoveryGuardianVeto: [
        { name: "intentHash", type: "bytes32" },
      ],
    },
    { intentHash },
  );
}

describe("Authority V3 administrator recovery", function () {
  it("binds only the fixed identity0 AND (identity1 OR identity2) Safe topology", async function () {
    const fixture = await authorityV3Fixture();
    expect(await fixture.recovery.identitySafes()).to.deep.equal(
      fixture.identitySafes.map((safe) => safe.target),
    );
    expect(await fixture.recovery.coadminSafe()).to.equal(fixture.coadminSafe.target);
    expect(await fixture.recovery.rootSafe()).to.equal(fixture.rootSafe.target);

    const fresh = await ethers.deployContract("SolslotAdminRecoveryV3", [
      fixture.initializer.address,
      AUTHORITY_LAUNCHER_ID,
      IDENTITY_LAUNCHER_IDS,
      "testnet11",
      SOURCE_MANIFEST_HASH,
      OLD_CHIA_KEYS.map((key) => ethers.keccak256(key)),
      fixture.guardians.map((guardian) => guardian.address),
      RECOVERY_BLS_KEYS.map((key) => ethers.keccak256(key)),
    ]);
    const wrongCoadmin = await ethers.deployContract("MockSafe", [[
      fixture.daily[1].address,
      fixture.daily[2].address,
    ], 1]);
    await expect(fresh.bindAuthorityTopology(
      fixture.identitySafes.map((safe) => safe.target),
      wrongCoadmin.target,
      fixture.rootSafe.target,
    )).to.be.revertedWithCustomError(fresh, "InvalidBinding");
  });

  it("requires the current slot wallet, owner-plus-one root, replacement acceptance, and 24 hours", async function () {
    const fixture = await authorityV3Fixture();
    const changeIntent = await fixture.intent(1, 1);
    await expect(fixture.recovery.connect(fixture.outsider).prepareRoutine(changeIntent))
      .to.be.revertedWithCustomError(fixture.recovery, "UnauthorizedActor");
    const { intentHash } = await prepareRoutine(fixture, 1);

    for (const coadminIdentity of fixture.identitySafes.slice(1)) {
      await expect(executeFromSafe(
        coadminIdentity,
        fixture.recovery.target,
        fixture.recovery.interface.encodeFunctionData(
          "approveRoutineByRoot",
          [intentHash],
        ),
      )).to.be.revertedWith("mock Safe call failed");
    }
    await approveRoutine(fixture, intentHash);
    await expect(fixture.recovery.executeEvmKeyChange(intentHash))
      .to.be.revertedWithCustomError(fixture.recovery, "ChangeDelayActive");
    const executeAfter = (await fixture.recovery.activeChange()).executeAfter;
    await time.setNextBlockTimestamp(executeAfter);
    await expect(fixture.recovery.executeEvmKeyChange(intentHash))
      .to.be.revertedWithCustomError(fixture.recovery, "ChangeNotReady");
    await fixture.recovery.connect(fixture.replacements[1]).acceptReplacement(intentHash);
    await fixture.recovery.connect(fixture.outsider).executeEvmKeyChange(intentHash);

    expect(await fixture.identitySafes[1].getOwners()).to.deep.equal([
      fixture.replacements[1].address,
    ]);
    expect(await fixture.recovery.isChangeActive()).to.equal(true);
    expect((await fixture.recovery.activeChange()).phase).to.equal(2);
  });

  it("requires a recovery key, both other identities, replacement acceptance, and seven days", async function () {
    const fixture = await authorityV3Fixture();
    const changeIntent = await fixture.intent(0, 2);
    await expect(fixture.recovery.connect(fixture.daily[0]).prepareLostKey(changeIntent))
      .to.be.revertedWithCustomError(fixture.recovery, "UnauthorizedActor");
    const { intentHash } = await prepareLost(fixture, 0);

    for (const slot of [1, 2]) {
      await executeFromSafe(
        fixture.identitySafes[slot],
        fixture.recovery.target,
        fixture.recovery.interface.encodeFunctionData(
          "approveLostKeyByPeer",
          [intentHash],
        ),
      );
    }
    await fixture.recovery.connect(fixture.replacements[0]).acceptReplacement(intentHash);
    const executeAfter = (await fixture.recovery.activeChange()).executeAfter;
    await time.setNextBlockTimestamp(executeAfter - 1n);
    await expect(fixture.recovery.executeEvmKeyChange(intentHash))
      .to.be.revertedWithCustomError(fixture.recovery, "ChangeDelayActive");
    await time.setNextBlockTimestamp(executeAfter);
    await fixture.recovery.executeEvmKeyChange(intentHash);
    expect(await fixture.identitySafes[0].getOwners()).to.deep.equal([
      fixture.replacements[0].address,
    ]);
  });

  it("allows a gas-paying relayer to submit only the exact guardian-authorized lost-key intent", async function () {
    const fixture = await authorityV3Fixture();
    const changeIntent = await fixture.intent(0, 2);
    const { intentHash, guardianSignature } = await lostAuthorization(
      fixture,
      changeIntent,
      0,
    );

    await fixture.recovery
      .connect(fixture.outsider)
      .prepareLostKeyWithSignature(changeIntent, guardianSignature);
    expect((await fixture.recovery.activeChange()).intentHash).to.equal(intentHash);

    await expect(
      fixture.recovery
        .connect(fixture.outsider)
        .prepareLostKeyWithSignature(changeIntent, guardianSignature),
    ).to.be.revertedWithCustomError(fixture.recovery, "ActiveChangeExists");
  });

  it("rejects a guardian authorization attached to an altered lost-key intent", async function () {
    const fixture = await authorityV3Fixture();
    const changeIntent = await fixture.intent(0, 2);
    const { guardianSignature } = await lostAuthorization(fixture, changeIntent, 0);
    const altered = {
      ...changeIntent,
      newDailyEvmKey: fixture.replacements[1].address,
    };

    await expect(
      fixture.recovery
        .connect(fixture.outsider)
        .prepareLostKeyWithSignature(altered, guardianSignature),
    ).to.be.revertedWithCustomError(fixture.recovery, "UnauthorizedActor");
  });

  it("lets the old key veto either path and rejects simultaneous or replayed changes", async function () {
    const fixture = await authorityV3Fixture();
    const { changeIntent, intentHash } = await prepareLost(fixture, 2);
    const simultaneous = await fixture.intent(1, 1, { nonce: 2 });
    await expect(fixture.recovery.connect(fixture.daily[1]).prepareRoutine(simultaneous))
      .to.be.revertedWithCustomError(fixture.recovery, "ActiveChangeExists");
    await fixture.recovery.connect(fixture.daily[2]).vetoByOldKey(intentHash);
    expect(await fixture.recovery.isChangeActive()).to.equal(false);
    await expect(fixture.recovery.connect(fixture.guardians[2]).prepareLostKey(changeIntent))
      .to.be.revertedWithCustomError(fixture.recovery, "InvalidIntent");
  });

  it("binds every intent field and rejects wrong network, manifest, slot state, and expiry", async function () {
    const fixture = await authorityV3Fixture();
    const invalid = [
      await fixture.intent(1, 1, { chiaNetwork: "mainnet" }),
      await fixture.intent(1, 1, { sourceManifestHash: `0x${"ff".repeat(32)}` }),
      await fixture.intent(1, 1, { recoveryKeyRevision: 2 }),
      await fixture.intent(1, 1, { identityLauncherIds: [
        IDENTITY_LAUNCHER_IDS[0],
        IDENTITY_LAUNCHER_IDS[1],
        `0x${"ff".repeat(32)}`,
      ] }),
      await fixture.intent(1, 1, { expiresAt: (await time.latest()) + DAY }),
      await fixture.intent(1, 1, { expiresAt: (await time.latest()) + (30 * DAY) }),
    ];
    for (const changeIntent of invalid) {
      await expect(fixture.recovery.connect(fixture.daily[1]).prepareRoutine(changeIntent))
        .to.be.revertedWithCustomError(fixture.recovery, "InvalidIntent");
    }
  });

  it("rejects a replacement daily wallet already assigned to any administrator role", async function () {
    const fixture = await authorityV3Fixture();
    const routine = await fixture.intent(1, 1, {
      newDailyEvmKey: fixture.daily[2].address,
    });
    await expect(
      fixture.recovery.connect(fixture.daily[1]).prepareRoutine(routine),
    ).to.be.revertedWithCustomError(fixture.recovery, "InvalidIntent");

    const lost = await fixture.intent(0, 2, {
      newDailyEvmKey: fixture.guardians[2].address,
    });
    await expect(
      fixture.recovery.connect(fixture.guardians[0]).prepareLostKey(lost),
    ).to.be.revertedWithCustomError(fixture.recovery, "InvalidIntent");
  });

  it("allows anyone to clear an expired lost-key prepare after one peer goes silent", async function () {
    const fixture = await authorityV3Fixture();
    const { intentHash } = await prepareLost(fixture, 0);
    await executeFromSafe(
      fixture.identitySafes[1],
      fixture.recovery.target,
      fixture.recovery.interface.encodeFunctionData(
        "cancelLostKeyByPeer",
        [intentHash],
      ),
    );

    await expect(
      fixture.recovery.connect(fixture.outsider).cancelExpired(intentHash),
    ).to.be.revertedWithCustomError(fixture.recovery, "ChangeNotExpired");
    const expiresAt = (await fixture.recovery.activeChange()).expiresAt;
    await time.setNextBlockTimestamp(expiresAt + 1n);
    await fixture.recovery.connect(fixture.outsider).cancelExpired(intentHash);

    expect(await fixture.recovery.isChangeActive()).to.equal(false);
    expect(await fixture.recovery.consumedIntent(intentHash)).to.equal(true);
  });

  it("freezes all privileged Safes while a change is pending", async function () {
    const fixture = await authorityV3Fixture();
    const arbitraryTarget = fixture.outsider.address;
    await expect(fixture.identitySafes[0].checkGuard(
      fixture.identityGuards[0].target,
      arbitraryTarget,
      "0x12345678",
      0,
    )).not.to.be.reverted;

    const { intentHash } = await prepareLost(fixture, 0);
    const guards = [
      ...fixture.identityGuards,
      fixture.coadminGuard,
      fixture.rootGuard,
    ];
    const safes = [
      ...fixture.identitySafes,
      fixture.coadminSafe,
      fixture.rootSafe,
    ];
    for (let index = 0; index < safes.length; index += 1) {
      await expect(safes[index].checkGuard(
        guards[index].target,
        arbitraryTarget,
        "0x12345678",
        0,
      )).to.be.revertedWithCustomError(guards[index], "RecoveryFreezeActive");
    }
    await expect(fixture.identitySafes[1].checkGuard(
      fixture.identityGuards[1].target,
      fixture.recovery.target,
      fixture.recovery.interface.encodeFunctionData(
        "approveLostKeyByPeer",
        [intentHash],
      ),
      0,
    )).not.to.be.reverted;
    const signMessage = new ethers.Interface(["function signMessage(bytes)"]);
    await expect(fixture.rootSafe.checkGuard(
      fixture.rootGuard.target,
      fixture.signMessageLibrary.target,
      signMessage.encodeFunctionData("signMessage", ["0x1234"]),
      1,
    )).to.be.revertedWithCustomError(fixture.rootGuard, "RecoveryFreezeActive");
  });

  it("keeps the hierarchy frozen after EVM execution until owner-plus-one records Chia convergence", async function () {
    const fixture = await authorityV3Fixture();
    const { intentHash } = await prepareRoutine(fixture, 1);
    await approveRoutine(fixture, intentHash);
    await fixture.recovery.connect(fixture.replacements[1]).acceptReplacement(intentHash);
    await time.increase(DAY);
    await fixture.recovery.executeEvmKeyChange(intentHash);

    const chiaReceiptHash = `0x${"51".repeat(32)}`;
    await expect(fixture.recovery.connect(fixture.outsider).confirmCrossChainConvergence(
      intentHash,
      chiaReceiptHash,
    )).to.be.revertedWithCustomError(fixture.recovery, "UnauthorizedActor");
    await executeFromSafe(
      fixture.rootSafe,
      fixture.recovery.target,
      fixture.recovery.interface.encodeFunctionData(
        "confirmCrossChainConvergence",
        [intentHash, chiaReceiptHash],
      ),
    );
    expect(await fixture.recovery.isChangeActive()).to.equal(false);
    expect(await fixture.recovery.consumedIntent(intentHash)).to.equal(true);
    expect(await fixture.recovery.consumedChiaReceipt(chiaReceiptHash)).to.equal(true);
    expect((await fixture.recovery.dailyChiaKeyHashes())[1]).to.equal(
      ethers.keccak256(NEW_CHIA_KEYS[1]),
    );
  });

  it("rolls an EVM-first partial transition back after root records the exact Chia cancellation", async function () {
    const fixture = await authorityV3Fixture();
    const { intentHash } = await prepareRoutine(fixture, 1);
    await approveRoutine(fixture, intentHash);
    await fixture.recovery.connect(fixture.replacements[1]).acceptReplacement(intentHash);
    await time.increase(DAY);
    await fixture.recovery.executeEvmKeyChange(intentHash);

    await expect(fixture.recovery.executeRollback(intentHash))
      .to.be.revertedWithCustomError(fixture.recovery, "ChangeNotReady");
    await executeFromSafe(
      fixture.rootSafe,
      fixture.recovery.target,
      fixture.recovery.interface.encodeFunctionData(
        "approveRollbackByRoot",
        [intentHash, `0x${"61".repeat(32)}`],
      ),
    );
    await fixture.recovery.connect(fixture.outsider).executeRollback(intentHash);
    expect(await fixture.identitySafes[1].getOwners()).to.deep.equal([
      fixture.daily[1].address,
    ]);
    expect(await fixture.recovery.isChangeActive()).to.equal(false);
  });

  it("rotates only the selected recovery kit with daily key, root, and new-guardian approval", async function () {
    const fixture = await authorityV3Fixture();
    const changeIntent = await recoveryKitIntent(fixture, 2);
    const intentHash = await fixture.recovery.hashIntent(changeIntent);

    await expect(
      fixture.recovery.connect(fixture.guardians[2]).prepareRecoveryKit(changeIntent),
    ).to.be.revertedWithCustomError(fixture.recovery, "UnauthorizedActor");
    await fixture.recovery.connect(fixture.daily[2]).prepareRecoveryKit(changeIntent);
    await executeFromSafe(
      fixture.rootSafe,
      fixture.recovery.target,
      fixture.recovery.interface.encodeFunctionData(
        "approveRecoveryKitByRoot",
        [intentHash],
      ),
    );
    const guardianSignature = await recoveryGuardianAcceptance(
      fixture,
      intentHash,
      2,
    );
    await fixture.recovery.connect(fixture.outsider)
      .acceptRecoveryGuardianWithSignature(intentHash, guardianSignature);

    await time.increase(DAY);
    await fixture.recovery.executeEvmKeyChange(intentHash);
    expect((await fixture.recovery.recoveryGuardians())[2]).to.equal(
      fixture.newGuardians[2].address,
    );
    expect((await fixture.recovery.recoveryBlsCommitments())[2]).to.equal(
      ethers.keccak256(NEW_RECOVERY_BLS_KEYS[2]),
    );
    expect((await fixture.recovery.recoveryKeyRevisions())[2]).to.equal(1);

    const receipt = `0x${"62".repeat(32)}`;
    await executeFromSafe(
      fixture.rootSafe,
      fixture.recovery.target,
      fixture.recovery.interface.encodeFunctionData(
        "confirmCrossChainConvergence",
        [intentHash, receipt],
      ),
    );
    expect((await fixture.recovery.recoveryKeyRevisions())[2]).to.equal(2);
    expect(await fixture.identitySafes[2].getOwners()).to.deep.equal([
      fixture.daily[2].address,
    ]);
  });

  it("binds gasless recovery-guardian acceptance to the active intent and coordinator", async function () {
    const fixture = await authorityV3Fixture();
    const changeIntent = await recoveryKitIntent(fixture, 1);
    const intentHash = await fixture.recovery.hashIntent(changeIntent);
    await fixture.recovery.connect(fixture.daily[1]).prepareRecoveryKit(changeIntent);

    const signature = await recoveryGuardianAcceptance(fixture, intentHash, 1);
    const alteredHash = ethers.keccak256(ethers.toUtf8Bytes("altered intent"));
    await expect(
      fixture.recovery.connect(fixture.outsider)
        .acceptRecoveryGuardianWithSignature(alteredHash, signature),
    ).to.be.revertedWithCustomError(fixture.recovery, "InvalidIntent");

    const wrongDomainSignature = await fixture.newGuardians[1].signTypedData(
      {
        name: "Solslot Admin Recovery",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: fixture.identitySafes[1].target,
      },
      {
        SolslotRecoveryGuardianAccept: [
          { name: "intentHash", type: "bytes32" },
        ],
      },
      { intentHash },
    );
    await expect(
      fixture.recovery.connect(fixture.outsider)
        .acceptRecoveryGuardianWithSignature(intentHash, wrongDomainSignature),
    ).to.be.revertedWithCustomError(fixture.recovery, "UnauthorizedActor");

    await fixture.recovery.connect(fixture.outsider)
      .acceptRecoveryGuardianWithSignature(intentHash, signature);
    await expect(
      fixture.recovery.connect(fixture.outsider)
        .acceptRecoveryGuardianWithSignature(intentHash, signature),
    ).to.be.revertedWithCustomError(
      fixture.recovery,
      "ApprovalAlreadyRecorded",
    );
  });

  it("lets either old recovery authority veto a kit rotation and rejects substitutions", async function () {
    const fixture = await authorityV3Fixture();
    const invalid = [
      await recoveryKitIntent(fixture, 1, {
        newRecoveryGuardian: fixture.guardians[0].address,
      }),
      await recoveryKitIntent(fixture, 1, {
        newRecoveryGuardian: fixture.daily[0].address,
      }),
      await recoveryKitIntent(fixture, 1, {
        newRecoveryBlsKey: RECOVERY_BLS_KEYS[0],
      }),
      await recoveryKitIntent(fixture, 1, {
        newDailyEvmKey: fixture.replacements[1].address,
      }),
    ];
    for (const changeIntent of invalid) {
      await expect(
        fixture.recovery.connect(fixture.daily[1]).prepareRecoveryKit(changeIntent),
      ).to.be.revertedWithCustomError(fixture.recovery, "InvalidIntent");
    }

    const changeIntent = await recoveryKitIntent(fixture, 1);
    const intentHash = await fixture.recovery.hashIntent(changeIntent);
    await fixture.recovery.connect(fixture.daily[1]).prepareRecoveryKit(changeIntent);
    const vetoSignature = await recoveryGuardianVeto(fixture, intentHash, 1);
    await fixture.recovery.connect(fixture.outsider)
      .vetoByOldRecoveryGuardianWithSignature(intentHash, vetoSignature);
    expect(await fixture.recovery.isChangeActive()).to.equal(false);
  });

  it("binds gasless old-guardian veto to the active recovery-kit intent", async function () {
    const fixture = await authorityV3Fixture();
    const changeIntent = await recoveryKitIntent(fixture, 1);
    const intentHash = await fixture.recovery.hashIntent(changeIntent);
    await fixture.recovery.connect(fixture.daily[1]).prepareRecoveryKit(changeIntent);

    const wrongGuardianSignature = await fixture.guardians[0].signTypedData(
      {
        name: "Solslot Admin Recovery",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: fixture.recovery.target,
      },
      {
        SolslotRecoveryGuardianVeto: [
          { name: "intentHash", type: "bytes32" },
        ],
      },
      { intentHash },
    );
    await expect(
      fixture.recovery.connect(fixture.outsider)
        .vetoByOldRecoveryGuardianWithSignature(
          intentHash,
          wrongGuardianSignature,
        ),
    ).to.be.revertedWithCustomError(fixture.recovery, "UnauthorizedActor");

    const vetoSignature = await recoveryGuardianVeto(fixture, intentHash, 1);
    await fixture.recovery.connect(fixture.outsider)
      .vetoByOldRecoveryGuardianWithSignature(intentHash, vetoSignature);
    expect(await fixture.recovery.isChangeActive()).to.equal(false);
  });

  it("requires a unique Chia cancellation receipt before rollback", async function () {
    const fixture = await authorityV3Fixture();
    const { intentHash } = await prepareRoutine(fixture, 1);
    await approveRoutine(fixture, intentHash);
    await fixture.recovery.connect(fixture.replacements[1]).acceptReplacement(intentHash);
    await time.increase(DAY);
    await fixture.recovery.executeEvmKeyChange(intentHash);
    await expect(fixture.recovery.executeRollback(intentHash))
      .to.be.revertedWithCustomError(fixture.recovery, "ChangeNotReady");
    await expect(executeFromSafe(
      fixture.rootSafe,
      fixture.recovery.target,
      fixture.recovery.interface.encodeFunctionData(
        "approveRollbackByRoot",
        [intentHash, ethers.ZeroHash],
      ),
    )).to.be.revertedWith("mock Safe call failed");

    const cancellationReceipt = `0x${"63".repeat(32)}`;
    await executeFromSafe(
      fixture.rootSafe,
      fixture.recovery.target,
      fixture.recovery.interface.encodeFunctionData(
        "approveRollbackByRoot",
        [intentHash, cancellationReceipt],
      ),
    );
    await fixture.recovery.executeRollback(intentHash);
    expect(await fixture.recovery.consumedChiaReceipt(cancellationReceipt)).to.equal(true);
  });

  it("rolls back an EVM-first recovery-kit change without touching the daily wallet", async function () {
    const fixture = await authorityV3Fixture();
    const changeIntent = await recoveryKitIntent(fixture, 1);
    const intentHash = await fixture.recovery.hashIntent(changeIntent);
    await fixture.recovery.connect(fixture.daily[1]).prepareRecoveryKit(changeIntent);
    await executeFromSafe(
      fixture.rootSafe,
      fixture.recovery.target,
      fixture.recovery.interface.encodeFunctionData(
        "approveRecoveryKitByRoot",
        [intentHash],
      ),
    );
    await fixture.recovery.connect(fixture.newGuardians[1])
      .acceptRecoveryGuardian(intentHash);
    await time.increase(DAY);
    await fixture.recovery.executeEvmKeyChange(intentHash);

    const cancellationReceipt = `0x${"64".repeat(32)}`;
    await executeFromSafe(
      fixture.rootSafe,
      fixture.recovery.target,
      fixture.recovery.interface.encodeFunctionData(
        "approveRollbackByRoot",
        [intentHash, cancellationReceipt],
      ),
    );
    await fixture.recovery.executeRollback(intentHash);

    expect((await fixture.recovery.recoveryGuardians())[1]).to.equal(
      fixture.guardians[1].address,
    );
    expect((await fixture.recovery.recoveryBlsCommitments())[1]).to.equal(
      ethers.keccak256(RECOVERY_BLS_KEYS[1]),
    );
    expect((await fixture.recovery.recoveryKeyRevisions())[1]).to.equal(1);
    expect(await fixture.identitySafes[1].getOwners()).to.deep.equal([
      fixture.daily[1].address,
    ]);
  });
});

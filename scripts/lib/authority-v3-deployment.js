const { ethers } = require("ethers");
const { readEvidence } = require("./deployment-evidence");
const { verifyAuthorityNetwork } = require("./authority-network");

const ROSTER_KIND = "solslot-alpha-authority-v3-roster";
const GOVERNANCE_KIND = "solslot-alpha-authority-v3-governance-deployment";
const AUTHORITY_RULE = "slot0_and_one_of_slot1_slot2";
const COMPRESSED_SECP256K1_KEY = /^0x(?:02|03)[0-9a-f]{64}$/;
const BLS_KEY = /^0x[0-9a-f]{96}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const ALLOWED_ROSTER_STATES = new Set([
  "roster_frozen",
  "planned",
  "prepared",
  "approved",
  "broadcast",
  "confirmed",
  "artifact_pending",
  "artifact_signed",
  "locked",
]);
const FALLBACK_HANDLER_SLOT =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
const GUARD_SLOT =
  "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";

function normalizedAddress(value, label) {
  if (!ethers.isAddress(value) || ethers.getAddress(value) === ethers.ZeroAddress) {
    throw new Error(`${label} is invalid`);
  }
  return ethers.getAddress(value);
}

function normalizedBytes32(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!BYTES32.test(normalized) || BigInt(normalized) === 0n) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function readAuthorityV3Roster(path) {
  const roster = readEvidence(path, "authority_v3_roster");
  if (
    roster.schemaVersion !== 2
      || roster.kind !== ROSTER_KIND
      || roster.authorityRule !== AUTHORITY_RULE
      || roster.network !== "testnet11"
      || !ALLOWED_ROSTER_STATES.has(roster.ceremonyState)
      || !Array.isArray(roster.administrators)
      || roster.administrators.length !== 3
      || !Array.isArray(roster.identityLauncherIds)
      || roster.identityLauncherIds.length !== 3
  ) {
    throw new Error("Authority V3 roster evidence is unsupported");
  }
  const sourceManifestHash = normalizedBytes32(
    roster.sourceManifestHash,
    "Authority V3 source manifest hash",
  );
  const authorityLauncherId = normalizedBytes32(
    roster.authorityLauncherId,
    "Authority V3 launcher ID",
  );
  const identityLauncherIds = roster.identityLauncherIds.map((value) =>
    normalizedBytes32(value, "Authority V3 identity launcher ID"));
  if (new Set(identityLauncherIds).size !== 3) {
    throw new Error("Authority V3 identity launcher IDs must be unique");
  }

  const expectedSlots = "0,1,2";
  if (roster.administrators.map(({ slot }) => slot).join(",") !== expectedSlots) {
    throw new Error("Authority V3 administrators must use ordered slots 0, 1, and 2");
  }
  const administrators = roster.administrators.map((record, slot) => {
    const compressedPubkey = String(record.compressedPubkey || "").toLowerCase();
    if (!COMPRESSED_SECP256K1_KEY.test(compressedPubkey)) {
      throw new Error(`Authority V3 slot ${slot} daily public key is invalid`);
    }
    const address = normalizedAddress(
      record.address,
      `Authority V3 slot ${slot} daily address`,
    );
    if (ethers.computeAddress(compressedPubkey) !== address) {
      throw new Error(`Authority V3 slot ${slot} daily key does not match its address`);
    }
    const recovery = record.recovery;
    const evmGuardian = normalizedAddress(
      recovery?.evmGuardian,
      `Authority V3 slot ${slot} recovery guardian`,
    );
    const blsPubkey = String(recovery?.blsPubkey || "").toLowerCase();
    if (!BLS_KEY.test(blsPubkey) || BigInt(blsPubkey) === 0n) {
      throw new Error(`Authority V3 slot ${slot} recovery BLS key is invalid`);
    }
    if (ethers.keccak256(blsPubkey) !== recovery?.blsCommitment) {
      throw new Error(`Authority V3 slot ${slot} recovery BLS commitment mismatches`);
    }
    if (!Number.isSafeInteger(recovery?.revision) || recovery.revision < 1) {
      throw new Error(`Authority V3 slot ${slot} recovery revision is invalid`);
    }
    const drillTime = Date.parse(String(recovery?.drillVerifiedAt || ""));
    if (!Number.isFinite(drillTime) || drillTime > Date.now()) {
      throw new Error(`Authority V3 slot ${slot} recovery drill is not verified`);
    }
    return {
      slot,
      address,
      compressedPubkey,
      recovery: {
        evmGuardian,
        blsPubkey,
        blsCommitment: recovery.blsCommitment,
        revision: recovery.revision,
        drillVerifiedAt: new Date(drillTime).toISOString(),
      },
    };
  });
  const dailyAddresses = administrators.map(({ address }) => address.toLowerCase());
  const guardians = administrators.map(
    ({ recovery }) => recovery.evmGuardian.toLowerCase(),
  );
  if (
    new Set(dailyAddresses).size !== 3
      || new Set(guardians).size !== 3
      || guardians.some((guardian) => dailyAddresses.includes(guardian))
  ) {
    throw new Error("Authority V3 daily and recovery identities must be separate and unique");
  }
  return {
    roster,
    sourceManifestHash,
    authorityLauncherId,
    identityLauncherIds,
    administrators,
    owners: administrators.map(({ address }) => address),
    guardians: administrators.map(({ recovery }) => recovery.evmGuardian),
    recoveryBlsPubkeys: administrators.map(({ recovery }) => recovery.blsPubkey),
    recoveryBlsCommitments: administrators.map(
      ({ recovery }) => recovery.blsCommitment,
    ),
    recoveryKeyRevisions: administrators.map(({ recovery }) => recovery.revision),
  };
}

function storageAddress(value) {
  if (!ethers.isHexString(value, 32)) {
    throw new Error("Safe storage address is malformed");
  }
  return ethers.getAddress(`0x${value.slice(-40)}`);
}

function sameOwners(observed, expected) {
  return observed.map((value) => ethers.getAddress(value).toLowerCase()).sort().join(",")
    === expected.map((value) => ethers.getAddress(value).toLowerCase()).sort().join(",");
}

async function validateSafe(
  provider,
  record,
  expectedOwners,
  expectedThreshold,
  fallbackHandler,
  recoveryCoordinator,
  moduleExpected,
) {
  const address = normalizedAddress(record.address, "Authority V3 Safe");
  const guard = normalizedAddress(record.guard, "Authority V3 Safe guard");
  const safe = new ethers.Contract(address, [
    "function getOwners() view returns (address[])",
    "function getThreshold() view returns (uint256)",
    "function isModuleEnabled(address) view returns (bool)",
  ], provider);
  const [owners, threshold, moduleEnabled, fallbackStorage, guardStorage] =
    await Promise.all([
      safe.getOwners(),
      safe.getThreshold(),
      safe.isModuleEnabled(recoveryCoordinator),
      provider.getStorage(address, FALLBACK_HANDLER_SLOT),
      provider.getStorage(address, GUARD_SLOT),
    ]);
  if (
    Number(threshold) !== expectedThreshold
      || !sameOwners(owners, expectedOwners)
      || moduleEnabled !== moduleExpected
      || storageAddress(fallbackStorage) !== fallbackHandler
      || storageAddress(guardStorage) !== guard
  ) {
    throw new Error("Authority V3 Safe hierarchy does not match evidence");
  }
  return { address, guard, safe };
}

async function validateAuthorityV3GovernanceEvidence({
  path,
  provider,
  rootSafe,
  timelock,
}) {
  const evidence = readEvidence(path, "authority_v3_governance");
  await verifyAuthorityNetwork(provider, evidence.network, evidence.chainId);
  if (
    evidence.schemaVersion !== 3
      || evidence.kind !== GOVERNANCE_KIND
      || evidence.authorityRule !== AUTHORITY_RULE
      || evidence.safeInfrastructure?.safeVersion !== "1.4.1"
      || evidence.recovery?.routineDelaySeconds !== "86400"
      || evidence.recovery?.lostKeyDelaySeconds !== "604800"
      || evidence.recovery?.replacementAcceptanceRequired !== true
      || evidence.recovery?.globalFreezeRequired !== true
      || evidence.recovery?.crossChainConvergenceRequired !== true
      || evidence.recovery?.recoveryKitRotationSupported !== true
      || evidence.recovery?.rollbackRequiresChiaCancellationReceipt !== true
      || !Array.isArray(evidence.administrators)
      || evidence.administrators.length !== 3
      || !Array.isArray(evidence.safes?.identities)
      || evidence.safes.identities.length !== 3
      || !Array.isArray(evidence.recovery?.identities)
      || evidence.recovery.identities.length !== 3
      || !Array.isArray(evidence.chiaAuthority?.identityLauncherIds)
      || evidence.chiaAuthority.identityLauncherIds.length !== 3
      || evidence.chiaAuthority.network !== "testnet11"
  ) {
    throw new Error("Authority V3 governance evidence is unsupported");
  }
  normalizedBytes32(
    evidence.chiaAuthority.sourceManifestHash,
    "Authority V3 source manifest hash",
  );
  normalizedBytes32(
    evidence.chiaAuthority.authorityLauncherId,
    "Authority V3 authority launcher ID",
  );
  const evidenceIdentityLaunchers =
    evidence.chiaAuthority.identityLauncherIds.map((value) =>
      normalizedBytes32(value, "Authority V3 identity launcher ID"));
  if (new Set(evidenceIdentityLaunchers).size !== 3) {
    throw new Error("Authority V3 identity launcher IDs must be unique");
  }

  const rootSafeAddress = normalizedAddress(rootSafe, "Authority V3 root Safe");
  const timelockAddress = normalizedAddress(timelock, "Authority V3 timelock");
  const coordinatorAddress = normalizedAddress(
    evidence.recovery.address,
    "Authority V3 recovery coordinator",
  );
  const fallbackHandler = normalizedAddress(
    evidence.safeInfrastructure.compatibilityFallbackHandler,
    "Safe fallback handler",
  );
  const signMessageLibrary = normalizedAddress(
    evidence.safeInfrastructure.signMessageLibrary,
    "Safe SignMessageLib",
  );
  const identityRecords = evidence.safes.identities;
  const identitySafeAddresses = identityRecords.map((record) =>
    normalizedAddress(record.address, "Authority V3 Identity Safe"));
  const coadminSafeAddress = normalizedAddress(
    evidence.safes.coadmin.address,
    "Authority V3 coadmin Safe",
  );
  if (
    normalizedAddress(evidence.safes.root.address, "Authority V3 root Safe")
      !== rootSafeAddress
      || normalizedAddress(evidence.timelock.address, "Authority V3 timelock")
        !== timelockAddress
      || normalizedAddress(evidence.payoutAddress, "Authority V3 payout")
        !== rootSafeAddress
      || evidence.administrators.map(({ slot }) => slot).join(",") !== "0,1,2"
      || evidence.safes.identities.map(({ slot }) => slot).join(",") !== "0,1,2"
      || !sameOwners(
        evidence.safes.coadmin.owners,
        [identitySafeAddresses[1], identitySafeAddresses[2]],
      )
      || evidence.safes.coadmin.threshold !== 1
      || !sameOwners(
        evidence.safes.root.owners,
        [identitySafeAddresses[0], coadminSafeAddress],
      )
      || evidence.safes.root.threshold !== 2
      || evidence.timelock.minimumDelaySeconds !== "86400"
      || normalizedAddress(
        evidence.timelock.proposer,
        "Authority V3 timelock proposer",
      ) !== rootSafeAddress
      || normalizedAddress(
        evidence.timelock.executor,
        "Authority V3 timelock executor",
      ) !== rootSafeAddress
      || normalizedAddress(
        evidence.timelock.canceller,
        "Authority V3 timelock canceller",
      ) !== rootSafeAddress
      || evidence.timelock.externalAdmin !== ethers.ZeroAddress
  ) {
    throw new Error("Authority V3 governance topology evidence mismatches");
  }

  const administratorAddresses = evidence.administrators.map(({ address }) =>
    normalizedAddress(address, "Authority V3 administrator"));
  const expectedRecovery = evidence.recovery.identities;
  if (
    evidence.administrators.map(({ slot }) => slot).join(",") !== "0,1,2"
      || expectedRecovery.map(({ slot }) => slot).join(",") !== "0,1,2"
  ) {
    throw new Error("Authority V3 governance identity slots are invalid");
  }
  const dailyKeys = evidence.administrators.map(
    ({ compressedPubkey, address }, slot) => {
      const key = String(compressedPubkey || "").toLowerCase();
      if (
        !COMPRESSED_SECP256K1_KEY.test(key)
          || ethers.computeAddress(key)
            !== normalizedAddress(address, `Authority V3 slot ${slot} address`)
      ) {
        throw new Error(`Authority V3 slot ${slot} daily key mismatches`);
      }
      return key;
    },
  );
  const guardianAddresses = expectedRecovery.map(
    ({ evmGuardian, blsPubkey, blsCommitment, revision }, slot) => {
      const guardian = normalizedAddress(
        evmGuardian,
        `Authority V3 slot ${slot} recovery guardian`,
      );
      const key = String(blsPubkey || "").toLowerCase();
      if (
        !BLS_KEY.test(key) || BigInt(key) === 0n
          || ethers.keccak256(key) !== blsCommitment
          || !Number.isSafeInteger(revision) || revision < 1
      ) {
        throw new Error(`Authority V3 slot ${slot} recovery evidence mismatches`);
      }
      return guardian;
    },
  );
  if (
    new Set(administratorAddresses.map((value) => value.toLowerCase())).size !== 3
      || new Set(guardianAddresses.map((value) => value.toLowerCase())).size !== 3
      || guardianAddresses.some((guardian) =>
        administratorAddresses.some((daily) =>
          daily.toLowerCase() === guardian.toLowerCase()))
  ) {
    throw new Error("Authority V3 daily and recovery identities overlap");
  }
  const identitySafes = [];
  for (let slot = 0; slot < 3; slot += 1) {
    identitySafes.push(await validateSafe(
      provider,
      identityRecords[slot],
      [administratorAddresses[slot]],
      1,
      fallbackHandler,
      coordinatorAddress,
      true,
    ));
  }
  const coadmin = await validateSafe(
    provider,
    evidence.safes.coadmin,
    [identitySafeAddresses[1], identitySafeAddresses[2]],
    1,
    fallbackHandler,
    coordinatorAddress,
    false,
  );
  const root = await validateSafe(
    provider,
    evidence.safes.root,
    [identitySafeAddresses[0], coadminSafeAddress],
    2,
    fallbackHandler,
    coordinatorAddress,
    false,
  );

  const codeAddresses = {
    identitySafe0: identitySafeAddresses[0],
    identitySafe1: identitySafeAddresses[1],
    identitySafe2: identitySafeAddresses[2],
    coadminSafe: coadmin.address,
    rootSafe: root.address,
    timelock: timelockAddress,
    recovery: coordinatorAddress,
    identityGuard0: identitySafes[0].guard,
    identityGuard1: identitySafes[1].guard,
    identityGuard2: identitySafes[2].guard,
    coadminGuard: coadmin.guard,
    rootGuard: root.guard,
    identitySetup: normalizedAddress(
      evidence.safeInfrastructure.identitySetup,
      "Authority V3 identity setup",
    ),
    compatibilityFallbackHandler: fallbackHandler,
    signMessageLibrary,
  };
  for (const [label, address] of Object.entries(codeAddresses)) {
    const code = await provider.getCode(address);
    if (code === "0x" || ethers.keccak256(code) !== evidence.runtimeCodeHashes?.[label]) {
      throw new Error(`Authority V3 ${label} runtime code differs from evidence`);
    }
  }

  const coordinator = new ethers.Contract(coordinatorAddress, [
    "function authorityLauncherId() view returns (bytes32)",
    "function chiaNetworkHash() view returns (bytes32)",
    "function sourceManifestHash() view returns (bytes32)",
    "function identityLauncherIds() view returns (bytes32[3])",
    "function identitySafes() view returns (address[3])",
    "function dailyChiaKeyHashes() view returns (bytes32[3])",
    "function recoveryGuardians() view returns (address[3])",
    "function recoveryBlsCommitments() view returns (bytes32[3])",
    "function recoveryKeyRevisions() view returns (uint64[3])",
    "function coadminSafe() view returns (address)",
    "function rootSafe() view returns (address)",
    "function topologyBound() view returns (bool)",
    "function isChangeActive() view returns (bool)",
    "function ROUTINE_DELAY_SECONDS() view returns (uint64)",
    "function LOST_KEY_DELAY_SECONDS() view returns (uint64)",
  ], provider);
  const [
    authorityLauncherId,
    chiaNetworkHash,
    sourceManifestHash,
    identityLauncherIds,
    boundIdentitySafes,
    dailyChiaKeyHashes,
    recoveryGuardians,
    recoveryBlsCommitments,
    recoveryKeyRevisions,
    boundCoadmin,
    boundRoot,
    topologyBound,
    changeActive,
    routineDelay,
    lostDelay,
  ] = await Promise.all([
    coordinator.authorityLauncherId(),
    coordinator.chiaNetworkHash(),
    coordinator.sourceManifestHash(),
    coordinator.identityLauncherIds(),
    coordinator.identitySafes(),
    coordinator.dailyChiaKeyHashes(),
    coordinator.recoveryGuardians(),
    coordinator.recoveryBlsCommitments(),
    coordinator.recoveryKeyRevisions(),
    coordinator.coadminSafe(),
    coordinator.rootSafe(),
    coordinator.topologyBound(),
    coordinator.isChangeActive(),
    coordinator.ROUTINE_DELAY_SECONDS(),
    coordinator.LOST_KEY_DELAY_SECONDS(),
  ]);
  if (
    authorityLauncherId !== evidence.chiaAuthority.authorityLauncherId
      || chiaNetworkHash !== ethers.keccak256(ethers.toUtf8Bytes("testnet11"))
      || sourceManifestHash !== evidence.chiaAuthority.sourceManifestHash
      || identityLauncherIds.join(",").toLowerCase()
        !== evidence.chiaAuthority.identityLauncherIds.join(",").toLowerCase()
      || boundIdentitySafes.join(",").toLowerCase()
        !== identitySafeAddresses.join(",").toLowerCase()
      || dailyChiaKeyHashes.join(",").toLowerCase()
        !== dailyKeys.map((key) => ethers.keccak256(key)).join(",").toLowerCase()
      || recoveryGuardians.join(",").toLowerCase()
        !== expectedRecovery.map(({ evmGuardian }) =>
          normalizedAddress(evmGuardian, "Authority V3 recovery guardian"))
          .join(",").toLowerCase()
      || recoveryBlsCommitments.join(",").toLowerCase()
        !== expectedRecovery.map(({ blsCommitment }) => blsCommitment)
          .join(",").toLowerCase()
      || recoveryKeyRevisions.map(Number).join(",")
        !== expectedRecovery.map(({ revision }) => revision).join(",")
      || normalizedAddress(boundCoadmin, "bound coadmin Safe") !== coadminSafeAddress
      || normalizedAddress(boundRoot, "bound root Safe") !== rootSafeAddress
      || !topologyBound
      || changeActive
      || routineDelay !== 86400n
      || lostDelay !== 604800n
  ) {
    throw new Error("Authority V3 recovery coordinator differs from evidence");
  }

  const guardAbi = [
    "function authoritySafe() view returns (address)",
    "function signMessageLibrary() view returns (address)",
    "function recoveryCoordinator() view returns (address)",
    "function supportsInterface(bytes4) view returns (bool)",
  ];
  const guardedSafes = [
    ...identitySafes.map(({ guard, address }) => [guard, address]),
    [coadmin.guard, coadmin.address],
    [root.guard, root.address],
  ];
  for (const [guardAddress, safeAddress] of guardedSafes) {
    const guard = new ethers.Contract(guardAddress, guardAbi, provider);
    const [boundSafe, library, boundCoordinator, compatible] = await Promise.all([
      guard.authoritySafe(),
      guard.signMessageLibrary(),
      guard.recoveryCoordinator(),
      guard.supportsInterface("0xe6d7a83a"),
    ]);
    if (
      normalizedAddress(boundSafe, "Authority V3 bound Safe") !== safeAddress
        || normalizedAddress(library, "Authority V3 SignMessageLib") !== signMessageLibrary
        || normalizedAddress(boundCoordinator, "Authority V3 coordinator")
          !== coordinatorAddress
        || !compatible
    ) {
      throw new Error("Authority V3 guard differs from evidence");
    }
  }

  const timelockContract = new ethers.Contract(timelockAddress, [
    "function getMinDelay() view returns (uint256)",
    "function PROPOSER_ROLE() view returns (bytes32)",
    "function EXECUTOR_ROLE() view returns (bytes32)",
    "function CANCELLER_ROLE() view returns (bytes32)",
    "function TIMELOCK_ADMIN_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
  ], provider);
  const [minimumDelay, proposerRole, executorRole, cancellerRole, adminRole] =
    await Promise.all([
      timelockContract.getMinDelay(),
      timelockContract.PROPOSER_ROLE(),
      timelockContract.EXECUTOR_ROLE(),
      timelockContract.CANCELLER_ROLE(),
      timelockContract.TIMELOCK_ADMIN_ROLE(),
    ]);
  if (
    minimumDelay !== 86400n
      || !(await timelockContract.hasRole(proposerRole, rootSafeAddress))
      || !(await timelockContract.hasRole(executorRole, rootSafeAddress))
      || !(await timelockContract.hasRole(cancellerRole, rootSafeAddress))
      || !(await timelockContract.hasRole(adminRole, timelockAddress))
      || await timelockContract.hasRole(adminRole, rootSafeAddress)
  ) {
    throw new Error("Authority V3 timelock roles differ from evidence");
  }
  return evidence;
}

module.exports = {
  AUTHORITY_RULE,
  GOVERNANCE_KIND,
  ROSTER_KIND,
  readAuthorityV3Roster,
  validateAuthorityV3GovernanceEvidence,
};

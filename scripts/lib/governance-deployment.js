const { ethers } = require("ethers");
const { readEvidence } = require("./deployment-evidence");

const ROSTER_KIND = "solslot-alpha-safe-owner-roster";
const GOVERNANCE_KIND = "solslot-alpha-owner-required-governance-deployment";
const OWNER_KEY = /^0x(?:02|03)[0-9a-f]{64}$/;
const BLS_KEY = /^0x[0-9a-f]{96}$/i;
const FALLBACK_HANDLER_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";

function readSafeOwnerRoster(path) {
  const roster = readEvidence(path, "safe_owner_roster");
  if (
    roster.schemaVersion !== 1 ||
    roster.kind !== ROSTER_KIND ||
    roster.network !== "testnet11" ||
    roster.threshold !== 2 ||
    !Array.isArray(roster.owners) ||
    roster.owners.length !== 3
  ) {
    throw new Error("Safe owner roster evidence is unsupported");
  }
  const slots = roster.owners.map((owner) => owner.slot);
  const owners = roster.owners.map((owner) => {
    if (!OWNER_KEY.test(String(owner.compressedPubkey || ""))) {
      throw new Error("Safe owner roster compressed public key is invalid");
    }
    if (!ethers.isAddress(owner.address)) {
      throw new Error("Safe owner roster address is invalid");
    }
    return ethers.getAddress(owner.address);
  });
  if (slots.join(",") !== "1,2,3" || new Set(owners.map((owner) => owner.toLowerCase())).size !== 3) {
    throw new Error("Safe owner roster must contain three unique ordered slots");
  }
  return {
    roster,
    owners,
    owner: owners[0],
    coadmins: owners.slice(1),
  };
}

function safeSaltNonce(roster, label) {
  if (!ethers.isHexString(roster.artifactHash, 32) || !/^[a-z_]{3,32}$/.test(label)) {
    throw new Error("Safe salt inputs are invalid");
  }
  return BigInt(ethers.keccak256(ethers.solidityPacked(
    ["bytes32", "string"],
    [roster.artifactHash, label],
  ))).toString();
}

function recoveryConfiguration(environment, administratorAddresses) {
  const secpGuardianValue = environment.SOLSLOT_SECP256K1_RECOVERY_GUARDIAN;
  const blsGuardianPubkey = String(environment.SOLSLOT_BLS_RECOVERY_GUARDIAN_PUBKEY || "");
  if (!ethers.isAddress(secpGuardianValue) || ethers.getAddress(secpGuardianValue) === ethers.ZeroAddress) {
    throw new Error("SOLSLOT_SECP256K1_RECOVERY_GUARDIAN is missing or invalid");
  }
  if (!BLS_KEY.test(blsGuardianPubkey) || BigInt(blsGuardianPubkey) === 0n) {
    throw new Error("SOLSLOT_BLS_RECOVERY_GUARDIAN_PUBKEY must be a non-zero 48-byte key");
  }
  const secp256k1Guardian = ethers.getAddress(secpGuardianValue);
  if (administratorAddresses.some((address) => address.toLowerCase() === secp256k1Guardian.toLowerCase())) {
    throw new Error("recovery guardian must be separate from all administrator keys");
  }
  return {
    secp256k1Guardian,
    blsGuardianPubkey: blsGuardianPubkey.toLowerCase(),
    blsGuardianCommitment: ethers.keccak256(blsGuardianPubkey),
  };
}

function storageAddress(value) {
  if (!ethers.isHexString(value, 32)) throw new Error("Safe storage address is malformed");
  return ethers.getAddress(`0x${value.slice(-40)}`);
}

function sameOwners(observed, expected) {
  return observed.map((value) => ethers.getAddress(value).toLowerCase()).sort().join(",") ===
    expected.map((value) => ethers.getAddress(value).toLowerCase()).sort().join(",");
}

async function liveSafe(provider, address, expectedOwners, expectedThreshold, fallbackHandler, guardAddress) {
  const safe = new ethers.Contract(address, [
    "function getOwners() view returns (address[])",
    "function getThreshold() view returns (uint256)",
    "function isModuleEnabled(address) view returns (bool)",
  ], provider);
  const [owners, threshold, fallbackStorage, guardStorage] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold(),
    provider.getStorage(address, FALLBACK_HANDLER_SLOT),
    provider.getStorage(address, GUARD_SLOT),
  ]);
  if (
    Number(threshold) !== expectedThreshold ||
    !sameOwners(owners, expectedOwners) ||
    storageAddress(fallbackStorage) !== ethers.getAddress(fallbackHandler) ||
    storageAddress(guardStorage) !== ethers.getAddress(guardAddress)
  ) {
    throw new Error("governance Safe hierarchy does not match evidence");
  }
  return safe;
}

async function validateGovernanceEvidence({ path, provider, rootSafe, timelock }) {
  const evidence = readEvidence(path, "governance");
  const ownerSafeEvidence = evidence.safes?.ownerIdentity;
  const coadminSafeEvidence = evidence.safes?.coadmin;
  const rootSafeEvidence = evidence.safes?.root;
  if (
    evidence.schemaVersion !== 2 ||
    evidence.kind !== GOVERNANCE_KIND ||
    evidence.authorityRule !== "slot0_and_one_of_slot1_slot2" ||
    evidence.network !== "baseSepolia" ||
    evidence.chainId !== 84532 ||
    ownerSafeEvidence?.threshold !== 1 ||
    !Array.isArray(ownerSafeEvidence?.owners) || ownerSafeEvidence.owners.length !== 1 ||
    coadminSafeEvidence?.threshold !== 1 ||
    !Array.isArray(coadminSafeEvidence?.owners) || coadminSafeEvidence.owners.length !== 2 ||
    rootSafeEvidence?.threshold !== 2 ||
    !Array.isArray(rootSafeEvidence?.owners) || rootSafeEvidence.owners.length !== 2 ||
    evidence.timelock?.minimumDelaySeconds !== "86400" ||
    evidence.recovery?.delaySeconds !== "604800" ||
    evidence.recovery?.replacementAcceptanceRequired !== true ||
    evidence.safeInfrastructure?.safeVersion !== "1.4.1" ||
    !Array.isArray(evidence.administrators) || evidence.administrators.length !== 3
  ) {
    throw new Error("governance deployment evidence is unsupported");
  }

  const rootSafeAddress = ethers.getAddress(rootSafe);
  const timelockAddress = ethers.getAddress(timelock);
  const ownerSafeAddress = ethers.getAddress(ownerSafeEvidence.address);
  const coadminSafeAddress = ethers.getAddress(coadminSafeEvidence.address);
  const ownerGuardAddress = ethers.getAddress(ownerSafeEvidence.guard);
  const coadminGuardAddress = ethers.getAddress(coadminSafeEvidence.guard);
  const rootGuardAddress = ethers.getAddress(rootSafeEvidence.guard);
  const recoveryAddress = ethers.getAddress(evidence.recovery.address);
  const fallbackHandler = ethers.getAddress(evidence.safeInfrastructure.compatibilityFallbackHandler);
  const signMessageLibrary = ethers.getAddress(evidence.safeInfrastructure.signMessageLibrary);
  const administratorAddresses = evidence.administrators.map((record) => ethers.getAddress(record.address));
  const secpGuardianAddress = ethers.getAddress(evidence.recovery.secp256k1Guardian);
  if (
    ethers.getAddress(rootSafeEvidence.address) !== rootSafeAddress ||
    ethers.getAddress(evidence.timelock.address) !== timelockAddress ||
    ethers.getAddress(evidence.payoutAddress) !== rootSafeAddress ||
    ethers.getAddress(evidence.timelock.proposer) !== rootSafeAddress ||
    ethers.getAddress(evidence.timelock.executor) !== rootSafeAddress ||
    ethers.getAddress(evidence.timelock.canceller) !== rootSafeAddress ||
    evidence.timelock.externalAdmin !== ethers.ZeroAddress ||
    !sameOwners(rootSafeEvidence.owners, [ownerSafeAddress, coadminSafeAddress]) ||
    evidence.administrators.map((record) => record.slot).join(",") !== "1,2,3" ||
    administratorAddresses.map((address) => address.toLowerCase()).join(",") !==
      [...ownerSafeEvidence.owners, ...coadminSafeEvidence.owners]
        .map((address) => ethers.getAddress(address).toLowerCase()).join(",") ||
    new Set([ownerGuardAddress, coadminGuardAddress, rootGuardAddress].map((address) => address.toLowerCase())).size !== 3 ||
    administratorAddresses.some((address) => address.toLowerCase() === secpGuardianAddress.toLowerCase()) ||
    !ethers.isHexString(evidence.recovery.blsGuardianPubkey, 48) ||
    BigInt(evidence.recovery.blsGuardianPubkey) === 0n ||
    ethers.keccak256(evidence.recovery.blsGuardianPubkey) !== evidence.recovery.blsGuardianCommitment ||
    !sameOwners(evidence.recovery.coadmins, coadminSafeEvidence.owners)
  ) {
    throw new Error("governance deployment evidence addresses mismatch");
  }

  const codeAddresses = {
    ownerIdentitySafe: ownerSafeAddress,
    coadminSafe: coadminSafeAddress,
    rootSafe: rootSafeAddress,
    timelock: timelockAddress,
    recovery: recoveryAddress,
    ownerGuard: ownerGuardAddress,
    coadminGuard: coadminGuardAddress,
    rootGuard: rootGuardAddress,
    ownerSetup: ethers.getAddress(evidence.safeInfrastructure.ownerSetup),
    compatibilityFallbackHandler: fallbackHandler,
    signMessageLibrary,
  };
  for (const [label, address] of Object.entries(codeAddresses)) {
    const code = await provider.getCode(address);
    if (code === "0x" || ethers.keccak256(code) !== evidence.runtimeCodeHashes?.[label]) {
      throw new Error(`governance ${label} runtime code differs from evidence`);
    }
  }
  if (
    Object.values(codeAddresses).some(
      (address) => address.toLowerCase() === secpGuardianAddress.toLowerCase(),
    ) ||
    await provider.getCode(secpGuardianAddress) !== "0x"
  ) {
    throw new Error("recovery guardian must be a separate code-less address");
  }

  const [ownerSafe] = await Promise.all([
    liveSafe(provider, ownerSafeAddress, ownerSafeEvidence.owners, 1, fallbackHandler, ownerGuardAddress),
    liveSafe(provider, coadminSafeAddress, coadminSafeEvidence.owners, 1, fallbackHandler, coadminGuardAddress),
    liveSafe(provider, rootSafeAddress, [ownerSafeAddress, coadminSafeAddress], 2, fallbackHandler, rootGuardAddress),
  ]);
  if (
    ethers.getAddress(evidence.recovery.ownerGuard) !== ownerGuardAddress ||
    !(await ownerSafe.isModuleEnabled(recoveryAddress))
  ) {
    throw new Error("owner identity Safe recovery controls do not match evidence");
  }

  const recovery = new ethers.Contract(recoveryAddress, [
    "function ownerIdentitySafe() view returns (address)",
    "function secp256k1Guardian() view returns (address)",
    "function coadminOne() view returns (address)",
    "function coadminTwo() view returns (address)",
    "function blsGuardianCommitment() view returns (bytes32)",
    "function RECOVERY_DELAY_SECONDS() view returns (uint256)",
  ], provider);
  const guardAbi = [
    "function authoritySafe() view returns (address)",
    "function signMessageLibrary() view returns (address)",
    "function supportsInterface(bytes4) view returns (bool)",
  ];
  const guards = [
    [new ethers.Contract(ownerGuardAddress, guardAbi, provider), ownerSafeAddress],
    [new ethers.Contract(coadminGuardAddress, guardAbi, provider), coadminSafeAddress],
    [new ethers.Contract(rootGuardAddress, guardAbi, provider), rootSafeAddress],
  ];
  const [
    recoverySafe, secpGuardian, coadminOne, coadminTwo, blsCommitment, recoveryDelay,
  ] = await Promise.all([
    recovery.ownerIdentitySafe(), recovery.secp256k1Guardian(), recovery.coadminOne(),
    recovery.coadminTwo(), recovery.blsGuardianCommitment(), recovery.RECOVERY_DELAY_SECONDS(),
  ]);
  if (
    ethers.getAddress(recoverySafe) !== ownerSafeAddress ||
    ethers.getAddress(secpGuardian) !== secpGuardianAddress ||
    !sameOwners([coadminOne, coadminTwo], coadminSafeEvidence.owners) ||
    blsCommitment !== evidence.recovery.blsGuardianCommitment ||
    recoveryDelay !== 604800n
  ) {
    throw new Error("governance recovery controls do not match evidence");
  }
  for (const [guard, safeAddress] of guards) {
    const [guardSafe, observedSignMessageLibrary, compatible] = await Promise.all([
      guard.authoritySafe(), guard.signMessageLibrary(), guard.supportsInterface("0xe6d7a83a"),
    ]);
    if (
      ethers.getAddress(guardSafe) !== safeAddress ||
      ethers.getAddress(observedSignMessageLibrary) !== signMessageLibrary ||
      !compatible
    ) {
      throw new Error("governance Safe guards do not match evidence");
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
  const [minimumDelay, proposerRole, executorRole, cancellerRole, adminRole] = await Promise.all([
    timelockContract.getMinDelay(), timelockContract.PROPOSER_ROLE(),
    timelockContract.EXECUTOR_ROLE(), timelockContract.CANCELLER_ROLE(),
    timelockContract.TIMELOCK_ADMIN_ROLE(),
  ]);
  const forbiddenRoleHolders = [
    ownerSafeAddress,
    coadminSafeAddress,
    ...ownerSafeEvidence.owners,
    ...coadminSafeEvidence.owners,
    ethers.getAddress(evidence.recovery.secp256k1Guardian),
    ethers.ZeroAddress,
  ];
  if (
    minimumDelay !== 86400n ||
    !(await timelockContract.hasRole(proposerRole, rootSafeAddress)) ||
    !(await timelockContract.hasRole(executorRole, rootSafeAddress)) ||
    !(await timelockContract.hasRole(cancellerRole, rootSafeAddress)) ||
    !(await timelockContract.hasRole(adminRole, timelockAddress)) ||
    (await timelockContract.hasRole(adminRole, rootSafeAddress))
  ) {
    throw new Error("governance root Safe or timelock roles do not match evidence");
  }
  for (const holder of forbiddenRoleHolders) {
    if (
      await timelockContract.hasRole(proposerRole, holder) ||
      await timelockContract.hasRole(executorRole, holder) ||
      await timelockContract.hasRole(cancellerRole, holder) ||
      (holder !== timelockAddress && await timelockContract.hasRole(adminRole, holder))
    ) {
      throw new Error("governance timelock grants authority outside the root Safe");
    }
  }
  return evidence;
}

module.exports = {
  readSafeOwnerRoster,
  recoveryConfiguration,
  safeSaltNonce,
  validateGovernanceEvidence,
};

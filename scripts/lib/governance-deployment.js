const { ethers } = require("ethers");
const { readEvidence } = require("./deployment-evidence");

const ROSTER_KIND = "solslot-alpha-safe-owner-roster";
const OWNER_KEY = /^0x(?:02|03)[0-9a-f]{64}$/;

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
  return { roster, owners };
}

function safeSaltNonce(roster) {
  if (!ethers.isHexString(roster.artifactHash, 32)) {
    throw new Error("Safe owner roster artifact hash is invalid");
  }
  return BigInt(roster.artifactHash).toString();
}

async function validateGovernanceEvidence({ path, provider, safe, timelock }) {
  const evidence = readEvidence(path, "governance");
  if (
    evidence.schemaVersion !== 1 ||
    evidence.kind !== "solslot-alpha-safe-timelock-deployment" ||
    evidence.network !== "baseSepolia" ||
    evidence.chainId !== 84532 ||
    evidence.safe?.threshold !== 2 ||
    !Array.isArray(evidence.safe?.owners) ||
    evidence.safe.owners.length !== 3 ||
    evidence.timelock?.minimumDelaySeconds !== "86400"
  ) {
    throw new Error("governance deployment evidence is unsupported");
  }
  const safeAddress = ethers.getAddress(safe);
  const timelockAddress = ethers.getAddress(timelock);
  if (
    ethers.getAddress(evidence.safe.address) !== safeAddress ||
    ethers.getAddress(evidence.timelock.address) !== timelockAddress ||
    ethers.getAddress(evidence.payoutAddress) !== safeAddress ||
    ethers.getAddress(evidence.timelock.proposer) !== safeAddress ||
    ethers.getAddress(evidence.timelock.executor) !== safeAddress ||
    evidence.timelock.externalAdmin !== ethers.ZeroAddress
  ) {
    throw new Error("governance deployment evidence addresses mismatch");
  }
  const safeCode = await provider.getCode(safeAddress);
  const timelockCode = await provider.getCode(timelockAddress);
  if (
    safeCode === "0x" ||
    timelockCode === "0x" ||
    ethers.keccak256(safeCode) !== evidence.runtimeCodeHashes?.safe ||
    ethers.keccak256(timelockCode) !== evidence.runtimeCodeHashes?.timelock
  ) {
    throw new Error("governance runtime code differs from evidence");
  }
  const safeContract = new ethers.Contract(safeAddress, [
    "function getOwners() view returns (address[])",
    "function getThreshold() view returns (uint256)",
  ], provider);
  const timelockContract = new ethers.Contract(timelockAddress, [
    "function getMinDelay() view returns (uint256)",
    "function PROPOSER_ROLE() view returns (bytes32)",
    "function EXECUTOR_ROLE() view returns (bytes32)",
    "function CANCELLER_ROLE() view returns (bytes32)",
    "function TIMELOCK_ADMIN_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
  ], provider);
  const [owners, threshold, minimumDelay, proposerRole, executorRole, cancellerRole, adminRole] = await Promise.all([
    safeContract.getOwners(),
    safeContract.getThreshold(),
    timelockContract.getMinDelay(),
    timelockContract.PROPOSER_ROLE(),
    timelockContract.EXECUTOR_ROLE(),
    timelockContract.CANCELLER_ROLE(),
    timelockContract.TIMELOCK_ADMIN_ROLE(),
  ]);
  const expectedOwners = evidence.safe.owners.map((owner) => ethers.getAddress(owner)).sort();
  if (
    Number(threshold) !== 2 ||
    owners.map((owner) => ethers.getAddress(owner)).sort().join(",") !== expectedOwners.join(",") ||
    minimumDelay !== 86400n ||
    !(await timelockContract.hasRole(proposerRole, safeAddress)) ||
    !(await timelockContract.hasRole(executorRole, safeAddress)) ||
    !(await timelockContract.hasRole(cancellerRole, safeAddress)) ||
    !(await timelockContract.hasRole(adminRole, timelockAddress)) ||
    (await timelockContract.hasRole(adminRole, safeAddress))
  ) {
    throw new Error("governance Safe or timelock roles do not match evidence");
  }
  return evidence;
}

module.exports = { readSafeOwnerRoster, safeSaltNonce, validateGovernanceEvidence };

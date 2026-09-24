const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ethers } = require("ethers");
const { readEvidence } = require("./deployment-evidence");

const WARP_SOURCE_SHA = "425a69650ccdf0b28e9f4fccb91d736b05b20512";
const WARP_SOURCE_TREE = "51ffdf9f4daf34ba367310485a7f3a0b07cff5fe";
const WARP_PACKAGE_LOCK_SHA256 =
  "d6e0b057890e7d8d4c689346a47d804e5ff4fd0ce077d65831a1aa842f917433";
const WARP_PORTAL_SOURCE_SHA256 =
  "870e7c9e40d670385a743ddcbfeb4688c0cf5fb05a108b586c9dc409be312d71";
const WARP_PORTAL_ARTIFACT_SHA256 =
  "7861745845966573fbc36073fbc5b2cc1335df50658b5129f4e174bad4f16c89";
const WARP_PROXY_ARTIFACT_SHA256 =
  "c214a67827df9a1af03099702b9a60ce083849ea216453b4eb1475122aca3969";
const WARP_PROXY_ADMIN_ARTIFACT_SHA256 =
  "8b6d43070da7fd6666cdf3283be7253781adf1d3d031352b7bac15eac4dfe11b";
const WARP_BUILD_INFO_SHA256 =
  "fb94d2a69f2f37466dee79e0e6c17fd2759cb9eed958bb957e100a80a57903cd";
const ROSTER_KIND = "solslot-samuel-validator-roster";
const ROSTER_DOMAIN = "solslot-alpha-warp-testnet11-base-sepolia";
const PORTAL_KIND = "solslot-warp-base-sepolia-portal-deployment";
const PORTAL_CHAIN = "0x786368";
const ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

function portalNetworkProfile(chainId = 84532) {
  if (chainId === 84532) return {
    schemaVersion: 1,
    kind: PORTAL_KIND,
    network: "baseSepolia",
    chainId,
    identityDomain: ROSTER_DOMAIN,
    rpcVariable: "BASE_SEPOLIA_RPC_URL",
  };
  if (chainId === 8453) return {
    schemaVersion: 2,
    kind: "solslot-native-bridge-base-mainnet-portal-deployment",
    network: "baseMainnet",
    chainId,
    identityDomain: "solslot-alpha-native-bridge-testnet11-base-mainnet",
    rpcVariable: "BASE_MAINNET_RPC_URL",
  };
  throw new Error("Unsupported bridge portal payment chain");
}

function portalDeploymentSettings(environment, networkName, chainId) {
  const profile = portalNetworkProfile(chainId);
  if (networkName !== profile.network || environment.SOLSLOT_WARP_TESTNET_DEPLOYMENT !== "true") {
    throw new Error("Portal deployment requires the selected Base network and explicit test deployment");
  }
  if (chainId === 8453 && (
    environment.SOLSLOT_CHIA_NETWORK !== "testnet11" ||
    environment.SOLSLOT_BRIDGE_TEST_ONLY !== "true"
  )) {
    throw new Error("Base mainnet bridge deployment requires explicit Testnet11 and test-only assets");
  }
  const rpcUrl = environment[profile.rpcVariable];
  if (typeof rpcUrl !== "string" || !rpcUrl.trim()) {
    throw new Error(`${profile.rpcVariable} is required for the selected portal network`);
  }
  return { ...profile, rpcUrl };
}

function fileSha256(file, expected, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  const observed = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (observed !== expected) throw new Error(`${label} hash does not match the pinned Warp build`);
  return observed;
}

function gitValue(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim().toLowerCase();
}

function readJsonArtifact(file, expectedHash, contractName, sourceName) {
  fileSha256(file, expectedHash, `${contractName} artifact`);
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    artifact.contractName !== contractName ||
    artifact.sourceName !== sourceName ||
    !Array.isArray(artifact.abi) ||
    !ethers.isHexString(artifact.bytecode) ||
    artifact.bytecode === "0x" ||
    !ethers.isHexString(artifact.deployedBytecode) ||
    artifact.deployedBytecode === "0x"
  ) {
    throw new Error(`${contractName} artifact is malformed`);
  }
  return artifact;
}

function readPinnedWarpArtifacts(sourceRoot) {
  if (!sourceRoot) throw new Error("SOLSLOT_WARP_SOURCE_ROOT is required");
  const root = fs.realpathSync(path.resolve(sourceRoot));
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("SOLSLOT_WARP_SOURCE_ROOT must be a real directory");
  }
  if (
    gitValue(root, ["rev-parse", "HEAD"]) !== WARP_SOURCE_SHA ||
    gitValue(root, ["rev-parse", "HEAD^{tree}"]) !== WARP_SOURCE_TREE ||
    gitValue(root, ["status", "--porcelain", "--untracked-files=no"]) !== ""
  ) {
    throw new Error("Warp source checkout is not the exact clean pinned revision");
  }

  fileSha256(
    path.join(root, "package-lock.json"),
    WARP_PACKAGE_LOCK_SHA256,
    "Warp package lock",
  );
  fileSha256(
    path.join(root, "contracts", "Portal.sol"),
    WARP_PORTAL_SOURCE_SHA256,
    "Warp Portal source",
  );
  const portalPath = path.join(
    root,
    "artifacts",
    "contracts",
    "Portal.sol",
    "Portal.json",
  );
  const proxyPath = path.join(
    root,
    "artifacts",
    "@openzeppelin",
    "contracts",
    "proxy",
    "transparent",
    "TransparentUpgradeableProxy.sol",
    "TransparentUpgradeableProxy.json",
  );
  const proxyAdminPath = path.join(
    root,
    "artifacts",
    "@openzeppelin",
    "contracts",
    "proxy",
    "transparent",
    "ProxyAdmin.sol",
    "ProxyAdmin.json",
  );
  const buildInfoDirectory = path.join(root, "artifacts", "build-info");
  const buildInfoFiles = fs.readdirSync(buildInfoDirectory)
    .filter((name) => name.endsWith(".json"));
  if (buildInfoFiles.length !== 1) throw new Error("Warp build must contain one pinned build-info file");
  const buildInfoPath = path.join(buildInfoDirectory, buildInfoFiles[0]);
  fileSha256(buildInfoPath, WARP_BUILD_INFO_SHA256, "Warp build info");
  const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  if (
    buildInfo.solcLongVersion !== "0.8.23+commit.f704f362" ||
    buildInfo.input?.settings?.optimizer?.enabled !== true ||
    buildInfo.input?.settings?.optimizer?.runs !== 200 ||
    buildInfo.input?.settings?.evmVersion !== "paris"
  ) {
    throw new Error("Warp compiler settings differ from the pinned build");
  }

  return {
    root,
    portal: readJsonArtifact(
      portalPath,
      WARP_PORTAL_ARTIFACT_SHA256,
      "Portal",
      "contracts/Portal.sol",
    ),
    proxy: readJsonArtifact(
      proxyPath,
      WARP_PROXY_ARTIFACT_SHA256,
      "TransparentUpgradeableProxy",
      "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol",
    ),
    proxyAdmin: readJsonArtifact(
      proxyAdminPath,
      WARP_PROXY_ADMIN_ARTIFACT_SHA256,
      "ProxyAdmin",
      "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol",
    ),
  };
}

function readWarpValidatorRoster(rosterPath, expectedArtifactHash, expectedChainId = 84532) {
  const profile = portalNetworkProfile(expectedChainId);
  const roster = readEvidence(rosterPath, "warp_validator_roster");
  const validators = roster.validators;
  if (
    roster.schemaVersion !== 2 ||
    roster.kind !== ROSTER_KIND ||
    roster.domain !== profile.identityDomain ||
    roster.threshold !== 2 ||
    !Array.isArray(validators) ||
    validators.length !== 3 ||
    !ethers.isHexString(expectedArtifactHash, 32) ||
    roster.artifactHash.toLowerCase() !== expectedArtifactHash.toLowerCase()
  ) {
    throw new Error("Warp validator roster is unsupported or not explicitly pinned");
  }
  const addresses = validators.map((validator, index) => {
    if (
      validator.schemaVersion !== 2 ||
      validator.kind !== "solslot-samuel-validator-public-identity" ||
      validator.validatorId !== `validator-${index + 1}` ||
      validator.domain !== profile.identityDomain ||
      !ethers.isHexString(validator.blsPublicKey, 48) ||
      !ethers.isAddress(validator.evmAddress)
    ) {
      throw new Error("Warp validator identity is malformed");
    }
    return ethers.getAddress(validator.evmAddress);
  });
  if (new Set(addresses.map((address) => address.toLowerCase())).size !== 3) {
    throw new Error("Warp validator EVM addresses must be unique");
  }
  if (new Set(validators.map((validator) => validator.blsPublicKey.toLowerCase())).size !== 3) {
    throw new Error("Warp validator BLS keys must be unique");
  }
  return { roster, addresses };
}

function storageAddress(value, label) {
  if (!ethers.isHexString(value, 32)) throw new Error(`${label} storage slot is malformed`);
  return ethers.getAddress(`0x${value.slice(-40)}`);
}

function sameAddresses(left, right) {
  return left.map((value) => ethers.getAddress(value).toLowerCase()).sort().join(",") ===
    right.map((value) => ethers.getAddress(value).toLowerCase()).sort().join(",");
}

async function validateConfirmedCreation(provider, evidence, label, expectedAddress, minimumConfirmations) {
  const transaction = evidence.deploymentTransactions?.[label];
  if (
    !transaction ||
    !ethers.isHexString(transaction.hash, 32) ||
    !ethers.isHexString(transaction.dataHash, 32) ||
    !ethers.isAddress(transaction.from) ||
    !Number.isSafeInteger(transaction.blockNumber)
  ) {
    throw new Error(`Warp ${label} deployment transaction evidence is malformed`);
  }
  const [receipt, observed, blockNumber] = await Promise.all([
    provider.getTransactionReceipt(transaction.hash),
    provider.getTransaction(transaction.hash),
    provider.getBlockNumber(),
  ]);
  if (
    !receipt ||
    receipt.status !== 1 ||
    !observed ||
    ethers.getAddress(observed.from) !== ethers.getAddress(transaction.from) ||
    ethers.keccak256(observed.data) !== transaction.dataHash ||
    receipt.blockNumber !== transaction.blockNumber ||
    receipt.contractAddress === null ||
    ethers.getAddress(receipt.contractAddress) !== ethers.getAddress(expectedAddress) ||
    blockNumber - receipt.blockNumber + 1 < minimumConfirmations
  ) {
    throw new Error(`Warp ${label} deployment transaction is not sufficiently confirmed`);
  }
}

async function validateWarpPortalEvidence({
  path: evidencePath,
  provider,
  expectedPortal,
  expectedOmnichainSourceSha,
  expectedRosterArtifactHash,
  expectedValidatorAddresses,
  expectedChainId = 84532,
  minimumConfirmations = 12,
}) {
  const profile = portalNetworkProfile(expectedChainId);
  const evidence = readEvidence(evidencePath, "warp_portal");
  if (
    evidence.schemaVersion !== profile.schemaVersion ||
    evidence.kind !== profile.kind ||
    evidence.sourceSha !== expectedOmnichainSourceSha ||
    evidence.network !== profile.network ||
    evidence.chainId !== expectedChainId ||
    (expectedChainId === 8453 && (
      evidence.chiaNetwork !== "testnet11" ||
      evidence.testOnly !== true ||
      evidence.validatorIdentityDomain !== profile.identityDomain
    )) ||
    evidence.confirmations < minimumConfirmations ||
    evidence.warpSource?.commit !== WARP_SOURCE_SHA ||
    evidence.warpSource?.tree !== WARP_SOURCE_TREE ||
    evidence.warpSource?.packageLockSha256 !== `0x${WARP_PACKAGE_LOCK_SHA256}` ||
    evidence.warpSource?.portalSourceSha256 !== `0x${WARP_PORTAL_SOURCE_SHA256}` ||
    evidence.warpSource?.buildInfoSha256 !== `0x${WARP_BUILD_INFO_SHA256}` ||
    evidence.artifacts?.portal !== `0x${WARP_PORTAL_ARTIFACT_SHA256}` ||
    evidence.artifacts?.transparentProxy !== `0x${WARP_PROXY_ARTIFACT_SHA256}` ||
    evidence.artifacts?.proxyAdmin !== `0x${WARP_PROXY_ADMIN_ARTIFACT_SHA256}` ||
    evidence.validatorRosterArtifactHash !== expectedRosterArtifactHash ||
    evidence.safe?.version !== "1.4.1" ||
    evidence.safe?.threshold !== 2 ||
    !Array.isArray(evidence.safe?.owners) ||
    evidence.safe.owners.length !== 3 ||
    !Array.isArray(evidence.portal?.signers) ||
    evidence.portal.signers.length !== 3 ||
    evidence.portal?.signatureThreshold !== 2 ||
    evidence.portal?.messageTollWei !== "0" ||
    evidence.portal?.supportedChains?.join(",") !== PORTAL_CHAIN
  ) {
    throw new Error("Warp portal deployment evidence is unsupported");
  }
  const observedChain = await provider.getNetwork();
  if (observedChain.chainId !== BigInt(expectedChainId)) {
    throw new Error("Warp portal RPC chain differs from the selected payment chain");
  }
  const portalAddress = ethers.getAddress(evidence.portal.address);
  const implementationAddress = ethers.getAddress(evidence.proxy.implementation);
  const proxyAdminAddress = ethers.getAddress(evidence.proxy.admin);
  const safeAddress = ethers.getAddress(evidence.safe.address);
  const owners = evidence.safe.owners.map(ethers.getAddress);
  const signers = evidence.portal.signers.map(ethers.getAddress);
  if (
    !Array.isArray(expectedValidatorAddresses) ||
    expectedValidatorAddresses.length !== 3
  ) {
    throw new Error("expected Warp validator addresses are missing");
  }
  if (
    portalAddress !== ethers.getAddress(expectedPortal) ||
    !sameAddresses(owners, signers) ||
    !sameAddresses(owners, expectedValidatorAddresses) ||
    new Set(owners.map((owner) => owner.toLowerCase())).size !== 3 ||
    ethers.getAddress(evidence.portal.owner) !== safeAddress ||
    ethers.getAddress(evidence.proxy.adminOwner) !== safeAddress
  ) {
    throw new Error("Warp portal addresses do not match the frozen validator authority");
  }

  const codeAddresses = {
    safe: safeAddress,
    portal: portalAddress,
    implementation: implementationAddress,
    proxyAdmin: proxyAdminAddress,
  };
  for (const [label, address] of Object.entries(codeAddresses)) {
    const code = await provider.getCode(address);
    if (code === "0x" || ethers.keccak256(code) !== evidence.runtimeCodeHashes?.[label]) {
      throw new Error(`Warp ${label} runtime code differs from evidence`);
    }
  }
  if (
    evidence.runtimeCodeHashes.implementation !== evidence.artifactRuntimeCodeHashes?.portal
  ) {
    throw new Error("Warp implementation runtime does not match the pinned Portal artifact");
  }

  const safe = new ethers.Contract(safeAddress, [
    "function getOwners() view returns (address[])",
    "function getThreshold() view returns (uint256)",
  ], provider);
  const portal = new ethers.Contract(portalAddress, [
    "function owner() view returns (address)",
    "function messageToll() view returns (uint256)",
    "function signatureThreshold() view returns (uint256)",
    "function isSigner(address) view returns (bool)",
    "function supportedChains(bytes3) view returns (bool)",
  ], provider);
  const proxyAdmin = new ethers.Contract(proxyAdminAddress, [
    "function owner() view returns (address)",
  ], provider);
  const [observedOwners, safeThreshold, portalOwner, toll, portalThreshold, supportsChia, adminOwner] =
    await Promise.all([
      safe.getOwners(),
      safe.getThreshold(),
      portal.owner(),
      portal.messageToll(),
      portal.signatureThreshold(),
      portal.supportedChains(PORTAL_CHAIN),
      proxyAdmin.owner(),
    ]);
  const signerChecks = await Promise.all(owners.map((owner) => portal.isSigner(owner)));
  if (
    !sameAddresses(observedOwners, owners) ||
    safeThreshold !== 2n ||
    ethers.getAddress(portalOwner) !== safeAddress ||
    toll !== 0n ||
    portalThreshold !== 2n ||
    !supportsChia ||
    signerChecks.some((allowed) => !allowed) ||
    ethers.getAddress(adminOwner) !== safeAddress
  ) {
    throw new Error("Warp live portal authority does not match deployment evidence");
  }

  const [adminSlot, implementationSlot] = await Promise.all([
    provider.getStorage(portalAddress, ADMIN_SLOT),
    provider.getStorage(portalAddress, IMPLEMENTATION_SLOT),
  ]);
  if (
    storageAddress(adminSlot, "admin") !== proxyAdminAddress ||
    storageAddress(implementationSlot, "implementation") !== implementationAddress
  ) {
    throw new Error("Warp proxy slots do not match deployment evidence");
  }
  await Promise.all([
    validateConfirmedCreation(
      provider,
      evidence,
      "portalImplementation",
      implementationAddress,
      minimumConfirmations,
    ),
    validateConfirmedCreation(
      provider,
      evidence,
      "portalProxy",
      portalAddress,
      minimumConfirmations,
    ),
  ]);
  return evidence;
}

module.exports = {
  ADMIN_SLOT,
  IMPLEMENTATION_SLOT,
  PORTAL_CHAIN,
  WARP_BUILD_INFO_SHA256,
  WARP_PACKAGE_LOCK_SHA256,
  WARP_PORTAL_ARTIFACT_SHA256,
  WARP_PORTAL_SOURCE_SHA256,
  WARP_PROXY_ADMIN_ARTIFACT_SHA256,
  WARP_PROXY_ARTIFACT_SHA256,
  WARP_SOURCE_SHA,
  WARP_SOURCE_TREE,
  portalNetworkProfile,
  portalDeploymentSettings,
  readPinnedWarpArtifacts,
  readWarpValidatorRoster,
  validateWarpPortalEvidence,
};

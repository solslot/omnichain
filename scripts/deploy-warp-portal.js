const { ethers, network } = require("hardhat");
const { assertChain, currentNetworkConfig } = require("./lib/config");
const {
  requiredSourceSha,
  requireNewEvidencePath,
  withArtifactHash,
  writeEvidence,
} = require("./lib/deployment-evidence");
const { safeSaltNonce } = require("./lib/governance-deployment");
const { requiredUint } = require("./lib/deployment-preflight");
const {
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
  portalDeploymentSettings,
  readPinnedWarpArtifacts,
  readWarpValidatorRoster,
} = require("./lib/warp-portal-deployment");

const SAFE_VERSION = "1.4.1";

function transactionEvidence(transaction, receipt) {
  return {
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    from: ethers.getAddress(transaction.from),
    dataHash: ethers.keccak256(transaction.data),
  };
}

async function confirmedDeployment(contract, confirmations, label) {
  await contract.waitForDeployment();
  const transaction = contract.deploymentTransaction();
  if (!transaction) throw new Error(`${label} has no deployment transaction`);
  const receipt = await transaction.wait(confirmations);
  if (!receipt || receipt.status !== 1 || receipt.contractAddress === null) {
    throw new Error(`${label} deployment failed`);
  }
  if (ethers.getAddress(receipt.contractAddress) !== ethers.getAddress(await contract.getAddress())) {
    throw new Error(`${label} receipt address mismatch`);
  }
  return transactionEvidence(transaction, receipt);
}

async function runtimeCodeHash(address, label) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${label} has no runtime bytecode`);
  return ethers.keccak256(code);
}

function storageAddress(value, label) {
  if (!ethers.isHexString(value, 32)) throw new Error(`${label} storage slot is malformed`);
  return ethers.getAddress(`0x${value.slice(-40)}`);
}

function sameAddresses(left, right) {
  return left.map((value) => ethers.getAddress(value).toLowerCase()).sort().join(",") ===
    right.map((value) => ethers.getAddress(value).toLowerCase()).sort().join(",");
}

async function main() {
  const config = currentNetworkConfig();
  const portalSettings = portalDeploymentSettings(process.env, network.name, config.chainId);
  const sourceSha = requiredSourceSha();
  const output = requireNewEvidencePath(
    process.env.SOLSLOT_WARP_PORTAL_DEPLOYMENT_OUTPUT,
    "SOLSLOT_WARP_PORTAL_DEPLOYMENT_OUTPUT",
  );
  await assertChain(config);
  const confirmations = Number(requiredUint(
    process.env,
    "SOLSLOT_WARP_CONFIRMATIONS",
    "12",
    12n,
  ));
  if (!Number.isSafeInteger(confirmations)) {
    throw new Error("SOLSLOT_WARP_CONFIRMATIONS must be a safe integer");
  }
  const expectedRosterHash = String(
    process.env.SOLSLOT_WARP_VALIDATOR_ROSTER_HASH || "",
  ).toLowerCase();
  const { roster, addresses: validatorAddresses } = readWarpValidatorRoster(
    process.env.SOLSLOT_WARP_VALIDATOR_ROSTER_PATH,
    expectedRosterHash,
    config.chainId,
  );
  const artifacts = readPinnedWarpArtifacts(process.env.SOLSLOT_WARP_SOURCE_ROOT);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is required");
  const deployerAddress = await deployer.getAddress();
  const minimumBalance = requiredUint(
    process.env,
    "SOLSLOT_WARP_MIN_DEPLOYER_WEI",
    undefined,
    1n,
  );
  if (await ethers.provider.getBalance(deployerAddress) < minimumBalance) {
    throw new Error("Warp deployer balance is below SOLSLOT_WARP_MIN_DEPLOYER_WEI");
  }

  const protocol = await import("@safe-global/protocol-kit");
  const Safe = protocol.default;
  const protocolKit = await Safe.init({
    provider: portalSettings.rpcUrl,
    signer: process.env.DEPLOYER_PRIVATE_KEY,
    predictedSafe: {
      safeAccountConfig: {
        owners: validatorAddresses,
        threshold: 2,
      },
      safeDeploymentConfig: {
        safeVersion: SAFE_VERSION,
        saltNonce: safeSaltNonce(roster, "warp_portal"),
      },
    },
  });
  const validatorSafeAddress = ethers.getAddress(await protocolKit.getAddress());
  let safeDeployment = null;
  if (await ethers.provider.getCode(validatorSafeAddress) === "0x") {
    const deployment = await protocolKit.createSafeDeploymentTransaction();
    const transaction = await deployer.sendTransaction({
      to: deployment.to,
      value: BigInt(deployment.value),
      data: deployment.data,
    });
    const receipt = await transaction.wait(confirmations);
    if (!receipt || receipt.status !== 1) throw new Error("validator Safe deployment failed");
    safeDeployment = transactionEvidence(transaction, receipt);
  }
  const connectedSafe = await protocolKit.connect({ safeAddress: validatorSafeAddress });
  const [observedOwners, observedThreshold, fallbackHandler] = await Promise.all([
    connectedSafe.getOwners(),
    connectedSafe.getThreshold(),
    connectedSafe.getFallbackHandler(),
  ]);
  if (
    Number(observedThreshold) !== 2 ||
    !sameAddresses(observedOwners, validatorAddresses)
  ) {
    throw new Error("validator Safe configuration does not match the frozen roster");
  }

  const portalFactory = new ethers.ContractFactory(
    artifacts.portal.abi,
    artifacts.portal.bytecode,
    deployer,
  );
  const implementation = await portalFactory.deploy();
  const implementationDeployment = await confirmedDeployment(
    implementation,
    confirmations,
    "Warp Portal implementation",
  );
  const implementationAddress = ethers.getAddress(await implementation.getAddress());
  const portalInterface = new ethers.Interface(artifacts.portal.abi);
  const initializer = portalInterface.encodeFunctionData("initialize", [
    validatorSafeAddress,
    0n,
    validatorAddresses,
    2n,
    [PORTAL_CHAIN],
  ]);
  const proxyFactory = new ethers.ContractFactory(
    artifacts.proxy.abi,
    artifacts.proxy.bytecode,
    deployer,
  );
  const proxy = await proxyFactory.deploy(
    implementationAddress,
    validatorSafeAddress,
    initializer,
  );
  const proxyDeployment = await confirmedDeployment(
    proxy,
    confirmations,
    "Warp Portal proxy",
  );
  const portalAddress = ethers.getAddress(await proxy.getAddress());
  const [adminStorage, implementationStorage] = await Promise.all([
    ethers.provider.getStorage(portalAddress, ADMIN_SLOT),
    ethers.provider.getStorage(portalAddress, IMPLEMENTATION_SLOT),
  ]);
  const proxyAdminAddress = storageAddress(adminStorage, "proxy admin");
  if (
    storageAddress(implementationStorage, "proxy implementation") !== implementationAddress
  ) {
    throw new Error("Warp proxy implementation slot does not match the deployment");
  }

  const portal = new ethers.Contract(portalAddress, artifacts.portal.abi, ethers.provider);
  const proxyAdmin = new ethers.Contract(
    proxyAdminAddress,
    artifacts.proxyAdmin.abi,
    ethers.provider,
  );
  const [
    portalOwner,
    messageToll,
    signatureThreshold,
    supportsChia,
    proxyAdminOwner,
  ] = await Promise.all([
    portal.owner(),
    portal.messageToll(),
    portal.signatureThreshold(),
    portal.supportedChains(PORTAL_CHAIN),
    proxyAdmin.owner(),
  ]);
  const signerChecks = await Promise.all(
    validatorAddresses.map((address) => portal.isSigner(address)),
  );
  if (
    ethers.getAddress(portalOwner) !== validatorSafeAddress ||
    messageToll !== 0n ||
    signatureThreshold !== 2n ||
    !supportsChia ||
    signerChecks.some((allowed) => !allowed) ||
    ethers.getAddress(proxyAdminOwner) !== validatorSafeAddress
  ) {
    throw new Error("Warp Portal was not atomically initialized with the frozen authority");
  }

  const evidence = withArtifactHash({
    schemaVersion: portalSettings.schemaVersion,
    kind: portalSettings.kind,
    sourceSha,
    network: network.name,
    chainId: config.chainId,
    ...(config.chainId === 8453 ? {
      chiaNetwork: "testnet11",
      testOnly: true,
      validatorIdentityDomain: portalSettings.identityDomain,
    } : {}),
    confirmations,
    validatorRosterArtifactHash: roster.artifactHash,
    warpSource: {
      repository: "https://github.com/warpdotgreen/cli.git",
      commit: WARP_SOURCE_SHA,
      tree: WARP_SOURCE_TREE,
      packageLockSha256: `0x${WARP_PACKAGE_LOCK_SHA256}`,
      portalSourceSha256: `0x${WARP_PORTAL_SOURCE_SHA256}`,
      buildInfoSha256: `0x${WARP_BUILD_INFO_SHA256}`,
      compiler: "0.8.23+commit.f704f362",
      optimizerRuns: 200,
      evmVersion: "paris",
    },
    artifacts: {
      portal: `0x${WARP_PORTAL_ARTIFACT_SHA256}`,
      transparentProxy: `0x${WARP_PROXY_ARTIFACT_SHA256}`,
      proxyAdmin: `0x${WARP_PROXY_ADMIN_ARTIFACT_SHA256}`,
    },
    deployer: deployerAddress,
    safe: {
      address: validatorSafeAddress,
      owners: validatorAddresses,
      threshold: 2,
      version: SAFE_VERSION,
      fallbackHandler: ethers.getAddress(fallbackHandler),
    },
    portal: {
      address: portalAddress,
      owner: validatorSafeAddress,
      signers: validatorAddresses,
      signatureThreshold: 2,
      messageTollWei: "0",
      supportedChains: [PORTAL_CHAIN],
      initializedAtomically: true,
    },
    proxy: {
      implementation: implementationAddress,
      admin: proxyAdminAddress,
      adminOwner: validatorSafeAddress,
      standard: "openzeppelin-transparent-proxy-5.0.2",
    },
    deploymentTransactions: {
      validatorSafe: safeDeployment,
      portalImplementation: implementationDeployment,
      portalProxy: proxyDeployment,
    },
    runtimeCodeHashes: {
      safe: await runtimeCodeHash(validatorSafeAddress, "validator Safe"),
      portal: await runtimeCodeHash(portalAddress, "Warp Portal proxy"),
      implementation: await runtimeCodeHash(
        implementationAddress,
        "Warp Portal implementation",
      ),
      proxyAdmin: await runtimeCodeHash(proxyAdminAddress, "Warp ProxyAdmin"),
    },
    artifactRuntimeCodeHashes: {
      portal: ethers.keccak256(artifacts.portal.deployedBytecode),
      transparentProxyTemplate: ethers.keccak256(artifacts.proxy.deployedBytecode),
      proxyAdmin: ethers.keccak256(artifacts.proxyAdmin.deployedBytecode),
    },
    createdAt: new Date().toISOString(),
  });
  if (
    evidence.runtimeCodeHashes.implementation !== evidence.artifactRuntimeCodeHashes.portal
  ) {
    throw new Error("deployed Warp Portal implementation differs from the pinned artifact");
  }
  const evidencePath = writeEvidence(
    output,
    evidence,
    "SOLSLOT_WARP_PORTAL_DEPLOYMENT_OUTPUT",
  );
  console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

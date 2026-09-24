const { ethers, network, run } = require("hardhat");
const networks = require("../config/networks.json");
const {
  requiredSourceSha,
  requireNewEvidencePath,
  withArtifactHash,
  writeEvidence,
} = require("./lib/deployment-evidence");
const {
  assertChain,
  currentNetworkConfig,
} = require("./lib/config");
const {
  deploymentSettings,
  requireTestAssetScope,
  inspectDeploymentReadiness,
  validatePreflightEvidence,
  requiredUint,
} = require("./lib/deployment-preflight");
const { validatePaymentGovernance } = require("./lib/payment-governance");
const { validateSamuelCoordinates, selectedSamuelBase } = require("./lib/samuel-coordinates");
const { validateWarpPortalEvidence } = require("./lib/warp-portal-deployment");

async function verify(address, constructorArguments) {
  if (process.env.VERIFY_CONTRACTS !== "true") return;
  await run("verify:verify", { address, constructorArguments });
}

async function runtimeCodeHash(address, label) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`No runtime bytecode at ${label} ${address}`);
  return ethers.keccak256(code);
}

async function confirmedReceipt(contract, confirmations, label) {
  const transaction = contract.deploymentTransaction();
  if (!transaction) throw new Error(`Missing deployment transaction for ${label}`);
  const receipt = await transaction.wait(confirmations);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} deployment failed`);
  return { hash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function confirmedCall(transaction, confirmations, label) {
  const receipt = await transaction.wait(confirmations);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
  return { hash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function main() {
  requireTestAssetScope(process.env, network.name);
  const sourceSha = requiredSourceSha();
  const evidenceOutput = requireNewEvidencePath(
    process.env.SOLSLOT_OMNICHAIN_DEPLOYMENT_OUTPUT,
  );
  const config = currentNetworkConfig();
  await assertChain(config);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is required");
  const settings = deploymentSettings(process.env, config, network.name, networks);
  const inspection = await inspectDeploymentReadiness({
    provider: ethers.provider,
    config,
    settings,
    deployer: await deployer.getAddress(),
  });
  const governanceEvidence = await validatePaymentGovernance({
    path: process.env.SOLSLOT_GOVERNANCE_EVIDENCE_PATH,
    provider: ethers.provider,
    rootSafe: settings.rootSafe,
    timelock: settings.governance,
  });
  if (!settings.gatewaySettings) throw new Error("alpha deployment must create a dedicated gateway");
  const samuelEvidence = validateSamuelCoordinates(
    process.env.SOLSLOT_SAMUEL_COORDINATE_EVIDENCE_PATH,
    {
      ...settings.gatewaySettings,
      predictedGatewayAddress: inspection.predictedGatewayAddress,
    },
    config.chainId,
  );
  const warpPortalEvidence = await validateWarpPortalEvidence({
    path: process.env.SOLSLOT_WARP_PORTAL_EVIDENCE_PATH,
    provider: ethers.provider,
    expectedPortal: settings.gatewaySettings.warpPortal,
    expectedOmnichainSourceSha: sourceSha,
    expectedRosterArtifactHash: samuelEvidence.validatorRosterArtifactHash,
    expectedValidatorAddresses: samuelEvidence.validatorEvmAddresses,
    expectedChainId: config.chainId,
    minimumConfirmations: settings.confirmations,
  });
  const preflight = validatePreflightEvidence({
    evidencePath: process.env.SOLSLOT_OMNICHAIN_PREFLIGHT_EVIDENCE_PATH,
    sourceSha,
    networkName: network.name,
    config,
    settings,
    inspection,
    maximumAgeSeconds: Number(requiredUint(
      process.env,
      "SOLSLOT_OMNICHAIN_PREFLIGHT_MAX_AGE_SECONDS",
      "3600",
      60n,
    )),
  });
  if (preflight.governanceArtifactHash !== governanceEvidence.artifactHash) {
    throw new Error("preflight governance evidence does not match this deployment");
  }
  if (preflight.samuelCoordinateArtifactHash !== samuelEvidence.artifactHash) {
    throw new Error("preflight Samuel evidence does not match this deployment");
  }
  if (preflight.warpPortalArtifactHash !== warpPortalEvidence.artifactHash) {
    throw new Error("preflight Warp portal evidence does not match this deployment");
  }
  const {
    payout,
    usdc,
    governance,
    rootSafe,
    callbackGas,
    emergencyDelay,
    confirmations,
    deployGateway,
  } = settings;
  let gatewayAddress;
  let gatewayDeployment = null;
  let gatewayContract = null;
  let gatewayOwnershipTransfer = null;

  if (deployGateway) {
    if (config.hub !== "base" && config.hub !== "ethereum") {
      throw new Error("Gateways may only be deployed on Base or Ethereum profiles");
    }
    const gatewayArgs = [
      config.router,
      BigInt(config.selector),
      settings.gatewaySettings.warpPortal,
      settings.gatewaySettings.warpChiaChain,
      settings.gatewaySettings.samuelBridgingPuzzle,
      settings.gatewaySettings.samuelReturnPuzzle,
      callbackGas,
      settings.gatewaySettings.maxWarpTollWei,
      settings.gatewaySettings.maxCcipFeeWei,
    ];
    gatewayContract = await ethers.deployContract("SolomonWarpGateway", gatewayArgs);
    await gatewayContract.waitForDeployment();
    gatewayAddress = await gatewayContract.getAddress();
    if (
      ethers.getAddress(gatewayAddress) !==
      ethers.getAddress(inspection.predictedGatewayAddress) ||
      ethers.getAddress(gatewayAddress) !==
      ethers.getAddress(selectedSamuelBase(samuelEvidence, config.chainId).solomonGatewayAddress)
    ) {
      throw new Error(
        "deployed gateway address does not match Samuel coordinate evidence",
      );
    }
    gatewayDeployment = await confirmedReceipt(gatewayContract, confirmations, "gateway");
    await verify(gatewayAddress, gatewayArgs);
    gatewayOwnershipTransfer = await confirmedCall(
      await gatewayContract.transferOwnership(governance),
      confirmations,
      "gateway ownership transfer",
    );
  } else {
    gatewayAddress = settings.gateway;
  }

  const hubSelector = settings.hubChainSelector;
  const spokeArgs = [
    config.router,
    BigInt(config.selector),
    usdc,
    payout,
    hubSelector,
    gatewayAddress,
    callbackGas,
    emergencyDelay,
  ];
  const spoke = await ethers.deployContract("OmnichainEscrowSpoke", spokeArgs);
  await spoke.waitForDeployment();
  const spokeAddress = await spoke.getAddress();
  const spokeDeployment = await confirmedReceipt(spoke, confirmations, "spoke");
  await verify(spokeAddress, spokeArgs);
  let trustedSpokeUpdate = null;
  if (gatewayContract) {
    trustedSpokeUpdate = await confirmedCall(
      await gatewayContract.setTrustedSpoke(BigInt(config.selector), spokeAddress),
      confirmations,
      "trusted spoke configuration",
    );
    if (await gatewayContract.trustedSpokes(BigInt(config.selector)) !== spokeAddress) {
      throw new Error("gateway trusted spoke configuration did not persist");
    }
  }
  const spokeOwnershipTransfer = await confirmedCall(
    await spoke.transferOwnership(governance),
    confirmations,
    "spoke ownership transfer",
  );
  if (
    await spoke.pendingOwner() !== governance ||
    (gatewayContract && await gatewayContract.pendingOwner() !== governance)
  ) {
    throw new Error("timelock is not the pending owner of both contracts");
  }

  const evidence = withArtifactHash({
    schemaVersion: 5,
    protocolVersion: "solslot-v2",
    rail: "ccip-warp-escrow",
    sourceSha,
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    chainSelector: config.selector,
    confirmations,
    preflightArtifactHash: preflight.artifactHash,
    governanceArtifactHash: governanceEvidence.artifactHash,
    samuelCoordinateArtifactHash: samuelEvidence.artifactHash,
    warpPortalArtifactHash: warpPortalEvidence.artifactHash,
    contracts: {
      ccipRouter: config.router,
      gateway: gatewayAddress,
      spoke: spokeAddress,
      usdc,
    },
    configuration: {
      hubChainSelector: hubSelector.toString(),
      callbackGas: callbackGas.toString(),
      emergencyDelay: emergencyDelay.toString(),
      payoutAddress: payout,
      governanceRootSafe: rootSafe,
      governanceTimelock: governance,
      samuelSourceSha: settings.gatewaySettings.samuelSourceSha,
      predictedGatewayAddress: inspection.predictedGatewayAddress,
      ownershipAccepted: false,
    },
    deploymentTransactions: {
      spoke: spokeDeployment,
      ...(gatewayDeployment ? { gateway: gatewayDeployment } : {}),
      gatewayOwnershipTransfer,
      spokeOwnershipTransfer,
      trustedSpokeUpdate,
    },
    runtimeCodeHashes: {
      ccipRouter: await runtimeCodeHash(config.router, "CCIP router"),
      gateway: await runtimeCodeHash(gatewayAddress, "gateway"),
      spoke: await runtimeCodeHash(spokeAddress, "spoke"),
      usdc: await runtimeCodeHash(usdc, "USDC"),
      governanceRootSafe: await runtimeCodeHash(rootSafe, "root Safe"),
      governanceTimelock: await runtimeCodeHash(governance, "governance timelock"),
    },
    createdAt: new Date().toISOString(),
  });
  const output = writeEvidence(evidenceOutput, evidence);
  console.log(JSON.stringify({ ...evidence, evidencePath: output }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

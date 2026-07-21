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
  inspectDeploymentReadiness,
  validatePreflightEvidence,
  requiredUint,
} = require("./lib/deployment-preflight");

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

async function main() {
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
  const {
    payout,
    usdc,
    usdt,
    governance,
    callbackGas,
    emergencyDelay,
    confirmations,
    deployGateway,
  } = settings;
  let gatewayAddress;
  let gatewayDeployment = null;

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
    const gateway = await ethers.deployContract("SolomonWarpGateway", gatewayArgs);
    await gateway.waitForDeployment();
    gatewayAddress = await gateway.getAddress();
    gatewayDeployment = await confirmedReceipt(gateway, confirmations, "gateway");
    await verify(gatewayAddress, gatewayArgs);
    await (await gateway.transferOwnership(governance)).wait();
  } else {
    gatewayAddress = settings.gateway;
  }

  const hubSelector = settings.hubChainSelector;
  const spokeArgs = [
    config.router,
    BigInt(config.selector),
    usdc,
    usdt,
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
  await (await spoke.transferOwnership(governance)).wait();

  const evidence = withArtifactHash({
    schemaVersion: 1,
    protocolVersion: "solslot-v2",
    rail: "ccip-warp-escrow",
    sourceSha,
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    chainSelector: config.selector,
    confirmations,
    preflightArtifactHash: preflight.artifactHash,
    contracts: {
      ccipRouter: config.router,
      gateway: gatewayAddress,
      spoke: spokeAddress,
      usdc,
      usdt,
    },
    configuration: {
      hubChainSelector: hubSelector.toString(),
      callbackGas: callbackGas.toString(),
      emergencyDelay: emergencyDelay.toString(),
      payoutAddress: payout,
      governance,
      ownershipAccepted: false,
    },
    deploymentTransactions: {
      spoke: spokeDeployment,
      ...(gatewayDeployment ? { gateway: gatewayDeployment } : {}),
    },
    runtimeCodeHashes: {
      ccipRouter: await runtimeCodeHash(config.router, "CCIP router"),
      gateway: await runtimeCodeHash(gatewayAddress, "gateway"),
      spoke: await runtimeCodeHash(spokeAddress, "spoke"),
      usdc: await runtimeCodeHash(usdc, "USDC"),
      usdt: await runtimeCodeHash(usdt, "USDT"),
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

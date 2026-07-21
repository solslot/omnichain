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
  requiredAddress,
  requiredBytes,
  requiredUint,
} = require("./lib/config");

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

  const payout = requiredAddress("PAYOUT_ADDRESS");
  const usdc = requiredAddress("USDC_ADDRESS", config.stablecoins?.usdc);
  const usdt = requiredAddress("USDT_ADDRESS", config.stablecoins?.usdt);
  if (usdc.toLowerCase() === usdt.toLowerCase()) throw new Error("USDC_ADDRESS and USDT_ADDRESS must differ");
  const callbackGas = requiredUint("CCIP_CALLBACK_GAS", "500000");
  const emergencyDelay = requiredUint("EMERGENCY_REFUND_DELAY_SECONDS", "604800");
  const governance = requiredAddress("GOVERNANCE_ADDRESS");
  const deployGateway = process.env.DEPLOY_GATEWAY === "true";
  const confirmations = network.name === "hardhat"
    ? 1
    : Number(requiredUint("SOLSLOT_OMNICHAIN_CONFIRMATIONS", "12"));
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) {
    throw new Error("SOLSLOT_OMNICHAIN_CONFIRMATIONS must be a positive integer");
  }
  if (network.name !== "hardhat" && confirmations < 12) {
    throw new Error("SOLSLOT_OMNICHAIN_CONFIRMATIONS must be at least 12 outside Hardhat");
  }
  let gatewayAddress;
  let gatewayDeployment = null;

  if (deployGateway) {
    if (config.hub !== "base" && config.hub !== "ethereum") {
      throw new Error("Gateways may only be deployed on Base or Ethereum profiles");
    }
    const gatewayArgs = [
      config.router,
      BigInt(config.selector),
      requiredAddress("WARP_PORTAL_ADDRESS"),
      requiredBytes("WARP_CHIA_CHAIN", 3),
      requiredBytes("SAMUEL_BRIDGING_PUZZLE", 32),
      requiredBytes("SAMUEL_RETURN_PUZZLE", 32),
      callbackGas,
      requiredUint("MAX_WARP_TOLL_WEI"),
      requiredUint("MAX_CCIP_FEE_WEI"),
    ];
    const gateway = await ethers.deployContract("SolomonWarpGateway", gatewayArgs);
    await gateway.waitForDeployment();
    gatewayAddress = await gateway.getAddress();
    gatewayDeployment = await confirmedReceipt(gateway, confirmations, "gateway");
    await verify(gatewayAddress, gatewayArgs);
    await (await gateway.transferOwnership(governance)).wait();
  } else {
    gatewayAddress = requiredAddress("HUB_GATEWAY_ADDRESS");
  }

  const isTestnet = [
    "baseSepolia",
    "ethereumSepolia",
    "polygonAmoy",
    "optimismSepolia",
    "avalancheFuji",
    "robinhoodTestnet",
  ].includes(network.name);
  const defaultHubName = config.hub === "ethereum"
    ? (isTestnet ? "ethereumSepolia" : "ethereumMainnet")
    : (isTestnet ? "baseSepolia" : "baseMainnet");
  const hubSelector = BigInt(
    process.env.HUB_CHAIN_SELECTOR || networks[defaultHubName].selector,
  );
  if (hubSelector === 0n) throw new Error("HUB_CHAIN_SELECTOR must be non-zero");
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

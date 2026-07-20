const { ethers, network, run } = require("hardhat");
const networks = require("../config/networks.json");
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

async function main() {
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
  let gatewayAddress;

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
  await verify(spokeAddress, spokeArgs);
  await (await spoke.transferOwnership(governance)).wait();

  console.log(JSON.stringify({
    network: network.name,
    chainId: config.chainId,
    selector: config.selector,
    router: config.router,
    gateway: gatewayAddress,
    spoke: spokeAddress,
    stablecoins: { usdc, usdt },
    pendingOwner: governance,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

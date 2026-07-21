const { ethers, network } = require("hardhat");
const networks = require("../config/networks.json");
const { assertChain, currentNetworkConfig } = require("./lib/config");

async function main() {
  const config = currentNetworkConfig();
  await assertChain(config);
  const isTestnet = network.name.endsWith("Sepolia") || [
    "polygonAmoy",
    "avalancheFuji",
    "robinhoodTestnet",
  ].includes(network.name);
  const hubName = config.hub === "ethereum"
    ? (isTestnet ? "ethereumSepolia" : "ethereumMainnet")
    : (isTestnet ? "baseSepolia" : "baseMainnet");
  const hub = networks[hubName];
  const router = new ethers.Contract(
    config.router,
    ["function isChainSupported(uint64) view returns (bool)"],
    ethers.provider,
  );
  if (config.selector !== hub.selector && !(await router.isChainSupported(hub.selector))) {
    throw new Error(`${network.name} router does not report support for ${hubName}`);
  }
  console.log(JSON.stringify({ network: network.name, ...config, selectedHub: hubName }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");
require("hardhat-preprocessor");

function configuredNetwork(urlName, chainId) {
  const url = process.env[urlName];
  if (!url) return undefined;
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  return {
    url,
    chainId,
    accounts: privateKey ? [privateKey] : [],
  };
}

const networks = Object.fromEntries(
  Object.entries({
    baseMainnet: configuredNetwork("BASE_MAINNET_RPC_URL", 8453),
    ethereumMainnet: configuredNetwork("ETHEREUM_MAINNET_RPC_URL", 1),
    polygonMainnet: configuredNetwork("POLYGON_MAINNET_RPC_URL", 137),
    optimismMainnet: configuredNetwork("OPTIMISM_MAINNET_RPC_URL", 10),
    avalancheMainnet: configuredNetwork("AVALANCHE_MAINNET_RPC_URL", 43114),
    robinhoodMainnet: configuredNetwork("ROBINHOOD_MAINNET_RPC_URL", 4663),
    baseSepolia: configuredNetwork("BASE_SEPOLIA_RPC_URL", 84532),
    ethereumSepolia: configuredNetwork("ETHEREUM_SEPOLIA_RPC_URL", 11155111),
    polygonAmoy: configuredNetwork("POLYGON_AMOY_RPC_URL", 80002),
    optimismSepolia: configuredNetwork("OPTIMISM_SEPOLIA_RPC_URL", 11155420),
    avalancheFuji: configuredNetwork("AVALANCHE_FUJI_RPC_URL", 43113),
    robinhoodTestnet: configuredNetwork("ROBINHOOD_TESTNET_RPC_URL", 46630),
  }).filter(([, value]) => value),
);

module.exports = {
  solidity: {
    version: "0.8.22",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks,
  preprocess: {
    eachLine: () => ({
      transform: (line) =>
        line
          .replace("@openzeppelin/contracts@4.8.3/", "@openzeppelin/contracts-4.8.3/")
          .replace("@openzeppelin/contracts@5.0.2/", "@openzeppelin/contracts-5.0.2/"),
      settings: { chainlinkOpenZeppelinAliases: "4.8.3,5.0.2" },
    }),
  },
};

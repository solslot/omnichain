const { ethers, network } = require("hardhat");
const networks = require("../../config/networks.json");

const PLACEHOLDERS = new Set([
  ethers.ZeroAddress.toLowerCase(),
  "0xsomeusdc",
  "0xportal",
  "0xpayout",
]);

function currentNetworkConfig() {
  const config = networks[network.name];
  if (!config) throw new Error(`No omnichain metadata for Hardhat network ${network.name}`);
  return config;
}

function requiredAddress(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!raw || PLACEHOLDERS.has(String(raw).toLowerCase()) || !ethers.isAddress(raw)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return ethers.getAddress(raw);
}

function requiredBytes(name, length) {
  const raw = process.env[name];
  if (!raw || !ethers.isHexString(raw, length) || BigInt(raw) === 0n) {
    throw new Error(`${name} must be a non-zero ${length}-byte hex value`);
  }
  return raw;
}

function requiredUint(name, fallback) {
  const raw = process.env[name] || fallback;
  if (raw === undefined || raw === "") throw new Error(`${name} is required`);
  const value = BigInt(raw);
  if (value < 0n) throw new Error(`${name} cannot be negative`);
  return value;
}

async function assertChain(config) {
  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== BigInt(config.chainId)) {
    throw new Error(`RPC chain ID ${chain.chainId} does not match configured ${config.chainId}`);
  }
  const code = await ethers.provider.getCode(config.router);
  if (code === "0x") throw new Error(`No CCIP router code at ${config.router}`);
}

module.exports = {
  assertChain,
  currentNetworkConfig,
  requiredAddress,
  requiredBytes,
  requiredUint,
};

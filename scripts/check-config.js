const { ethers } = require("ethers");
const networks = require("../config/networks.json");

const selectors = new Set();
const chainIds = new Set();
for (const [name, config] of Object.entries(networks)) {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new Error(`${name}: invalid chainId`);
  if (!/^\d+$/.test(config.selector) || BigInt(config.selector) === 0n) throw new Error(`${name}: invalid selector`);
  if (!ethers.isAddress(config.router) || config.router === ethers.ZeroAddress) throw new Error(`${name}: invalid router`);
  if (!new Set(["base", "ethereum"]).has(config.hub)) throw new Error(`${name}: invalid hub`);
  if (chainIds.has(config.chainId)) throw new Error(`${name}: duplicate chainId`);
  if (selectors.has(config.selector)) throw new Error(`${name}: duplicate selector`);
  const usdc = config.stablecoins?.usdc;
  const usdt = config.stablecoins?.usdt;
  if (config.enabled && (!usdc || !usdt)) throw new Error(`${name}: enabled without both USDC and USDT`);
  for (const [symbol, address] of Object.entries({ usdc, usdt })) {
    if (address !== null && address !== undefined && !ethers.isAddress(address)) {
      throw new Error(`${name}: invalid ${symbol.toUpperCase()} address`);
    }
  }
  if (usdc && usdt && usdc.toLowerCase() === usdt.toLowerCase()) {
    throw new Error(`${name}: USDC and USDT addresses must differ`);
  }
  chainIds.add(config.chainId);
  selectors.add(config.selector);
}

if (networks.robinhoodMainnet.chainId !== 4663) throw new Error("Robinhood mainnet chain ID must be 4663");
console.log(`Validated ${Object.keys(networks).length} omnichain network profiles.`);

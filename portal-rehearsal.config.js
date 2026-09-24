// Explicit local EVM rules avoid unsupported Osaka storage overrides on forks.
const base = require("./hardhat.config");
module.exports = {...base, networks: {...base.networks, hardhat: {chainId: 31337, hardfork: "cancun",
  ...(process.env.SOLSLOT_REHEARSAL_FORK_BLOCK ? {forking: {url: process.env.BASE_MAINNET_RPC_URL,
    blockNumber: Number(process.env.SOLSLOT_REHEARSAL_FORK_BLOCK)}} : {}),
}}};

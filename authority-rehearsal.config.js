// An in-process fork with the target chain ID: EIP-712 constructors cache the
// chain ID in immutable runtime bytecode. A 31337 rehearsal would hash differently.
const base = require('./hardhat.config');
module.exports = {...base, networks: {...base.networks, hardhat: {chainId: 8453, hardfork: 'cancun',
  ...(process.env.SOLSLOT_REHEARSAL_FORK_BLOCK ? {forking: {url: process.env.BASE_MAINNET_RPC_URL,
    blockNumber: Number(process.env.SOLSLOT_REHEARSAL_FORK_BLOCK)}} : {}),
}}};

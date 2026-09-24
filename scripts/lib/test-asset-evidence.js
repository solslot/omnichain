const { ethers } = require('ethers');
const { readEvidence } = require('./deployment-evidence');

async function validateTestAssetEvidence({ provider, path, expectedToken, minimumConfirmations = 12, artifact }) {
  const record = readEvidence(path, 'test_asset');
  return validateTestAssetRecord({provider,record,expectedToken,minimumConfirmations,artifact});
}

async function validateTestAssetRecord({ provider, record, expectedToken, minimumConfirmations = 12, artifact,
    allowedFixtures = ['TEST-USDC', 'TEST-SOLS'] }) {
  if (record.schemaVersion !== 1 || record.kind !== 'solslot-test-asset-deployment' ||
      record.chainId !== 8453 || record.network !== 'baseMainnet' ||
      record.chiaNetwork !== 'testnet11' || record.testOnly !== true ||
      !allowedFixtures.includes(record.fixture) || !['TEST-USDC','TEST-USDT','TEST-SOLS'].includes(record.fixture) || record.decimals !== 6 ||
      !ethers.isAddress(record.address) ||
      record.address.toLowerCase() !== expectedToken.toLowerCase() ||
      !/^[0-9a-f]{40}$/.test(record.sourceSha) ||
      !Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < 12) {
    throw new Error('test payment asset evidence is unsupported or mismatched');
  }
  if ((await provider.getNetwork()).chainId !== 8453n) throw new Error('test asset RPC chain differs');
  const existing = record.fixture === 'TEST-SOLS';
  const compiled = artifact || (existing
    ? require('../../artifacts/contracts/SolslotAlphaTestToken.sol/SolslotAlphaTestToken.json')
    : require('../../artifacts/contracts/SolslotTestToken.sol/SolslotTestToken.json'));
  const [tx, receipt, peak, code] = await Promise.all([
    provider.getTransaction(record.transactionHash), provider.getTransactionReceipt(record.transactionHash),
    provider.getBlock('latest'), provider.getCode(expectedToken),
  ]);
  if (existing && (record.address.toLowerCase() !== '0xd48548a2dccb9b05f31a3f342f7bfd14b72c29c3' ||
      record.runtimeCodeHash !== '0xd9b0429c4c62d4e8f698a683d13ed521acd286fc9b94de1ea15d1017a5764869' || !tx))
    throw new Error('existing test payment token differs from the pinned alpha profile');
  const expectedInit = ethers.concat([compiled.bytecode, existing
    ? ethers.AbiCoder.defaultAbiCoder().encode(['address'], [tx.from])
    : ethers.AbiCoder.defaultAbiCoder().encode(['bool'], [record.fixture === 'TEST-USDT'])]);
  if (!tx || !receipt || !peak || receipt.status !== 1 || tx.to !== null ||
      tx.chainId !== 8453n || tx.value !== 0n || tx.data !== expectedInit ||
      receipt.hash !== record.transactionHash || tx.hash !== receipt.hash ||
      receipt.contractAddress?.toLowerCase() !== expectedToken.toLowerCase() ||
      receipt.blockHash !== tx.blockHash || receipt.blockNumber !== tx.blockNumber ||
      receipt.blockNumber !== record.blockNumber || receipt.blockHash !== record.blockHash ||
      peak.number - receipt.blockNumber + 1 < minimumConfirmations || code === '0x' || code !== compiled.deployedBytecode ||
      ethers.keccak256(code) !== record.runtimeCodeHash) {
    throw new Error('test asset must match the reviewed faucet bytecode and a confirmed creation receipt');
  }
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block || block.hash !== receipt.blockHash || (await provider.getBlock(peak.number))?.hash !== peak.hash) {
    throw new Error('test asset creation is not canonical');
  }
  return record;
}

module.exports = { validateTestAssetEvidence, validateTestAssetRecord };

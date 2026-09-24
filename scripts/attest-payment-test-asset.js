// Read-only: attest an already deployed valueless token using two independent RPCs.
const { ethers } = require('ethers');
const { requiredSourceSha, withArtifactHash, writeEvidence } = require('./lib/deployment-evidence');
const { requireTestAssetScope } = require('./lib/deployment-preflight');
const { validateTestAssetRecord } = require('./lib/test-asset-evidence');

async function main() {
  requireTestAssetScope(process.env, 'baseMainnet');
  const sourceSha = requiredSourceSha();
  const urls = [process.env.BASE_MAINNET_RPC_URL, process.env.BASE_MAINNET_SECONDARY_RPC_URL];
  if (urls.some(url => !url || new URL(url).protocol !== 'https:') || new URL(urls[0]).hostname === new URL(urls[1]).hostname)
    throw new Error('Two independent HTTPS Base RPC hosts are required');
  const txHash = process.env.SOLSLOT_TEST_ASSET_CREATION_TX;
  const fixture = process.env.SOLSLOT_TEST_ASSET_FIXTURE;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '') || !['TEST-SOLS','TEST-USDC','TEST-USDT'].includes(fixture))
    throw new Error('An exact creation transaction and test fixture are required');
  const providers = urls.map(url => new ethers.JsonRpcProvider(url));
  try {
    const receipt = await providers[0].getTransactionReceipt(txHash);
    if (!receipt?.contractAddress) throw new Error('Creation receipt is unavailable');
    const code = await providers[0].getCode(receipt.contractAddress);
    const record = withArtifactHash({schemaVersion:1,kind:'solslot-test-asset-deployment',network:'baseMainnet',
      chainId:8453,chiaNetwork:'testnet11',testOnly:true,fixture,decimals:6,sourceSha,
      address:receipt.contractAddress.toLowerCase(),transactionHash:receipt.hash,
      blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,runtimeCodeHash:ethers.keccak256(code)});
    await Promise.all(providers.map(provider => validateTestAssetRecord({provider,record,expectedToken:record.address,
      allowedFixtures:['TEST-SOLS','TEST-USDC','TEST-USDT']})));
    writeEvidence(process.env.SOLSLOT_TEST_ASSET_EVIDENCE_OUTPUT,record,'SOLSLOT_TEST_ASSET_EVIDENCE_OUTPUT');
    console.log(JSON.stringify({artifactHash:record.artifactHash,address:record.address,fixture}));
  } finally { providers.forEach(provider => provider.destroy()); }
}
if (require.main === module) main().catch(() => { console.error('Test asset attestation failed; no deployment was attempted.'); process.exitCode=1; });

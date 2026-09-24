// Read-only Base inspection. Never loads a key or sends a transaction.
const { ethers, artifacts, network } = require('hardhat');
const { requiredSourceSha } = require('./lib/deployment-evidence');
const { requireTestAssetScope } = require('./lib/deployment-preflight');
const { FIXTURE_CONTRACT, prepareFixturePlan, runDeployment, boundary, writeOnce } = require('./lib/test-token-deployment');

function required(key) { if (!process.env[key]) throw new Error(`${key} required`); return process.env[key]; }
async function main() {
  if (network.name !== 'baseMainnet') throw new Error('explicit Base mainnet network required');
  // Base gas is real ETH; every issued asset in this plan is valueless.
  requireTestAssetScope(process.env, network.name);
  const urls = [required('BASE_MAINNET_RPC_URL'), required('BASE_MAINNET_SECONDARY_RPC_URL')];
  if (new URL(urls[0]).hostname === new URL(urls[1]).hostname) throw new Error('independent RPC hosts required');
  const providers = urls.map(url => new ethers.JsonRpcProvider(url));
  try {
    await boundary(providers);
    const deployer = ethers.getAddress(required('SOLSLOT_TEST_ASSET_DEPLOYER'));
    const nonces = await Promise.all(providers.map(p => p.getTransactionCount(deployer, 'pending')));
    if (nonces[0] !== nonces[1]) throw new Error('RPC nonce disagreement');
    const artifact = await artifacts.readArtifact(FIXTURE_CONTRACT);
    const plan = prepareFixturePlan({sourceSha:requiredSourceSha(),
      actionEnvelopeId:required('SOLSLOT_ACTION_ENVELOPE_ID'), deployer, nonce:nonces[0],
      gasLimit:required('SOLSLOT_TEST_ASSET_GAS_LIMIT'),
      maxFeePerGas:required('SOLSLOT_TEST_ASSET_MAX_FEE_WEI'),
      maxPriorityFeePerGas:required('SOLSLOT_TEST_ASSET_PRIORITY_FEE_WEI'),
      l1FeeBudgetWei:required('SOLSLOT_TEST_ASSET_L1_BUDGET_WEI')}, artifact, required('SOLSLOT_TEST_ASSET_FIXTURE'));
    const inspection = await runDeployment({plan, artifact, providers, execute:false});
    writeOnce(required('SOLSLOT_TEST_TOKEN_PLAN'), plan);
    console.log(JSON.stringify({plan,inspection}, null, 2));
  } finally { providers.forEach(p => p.destroy()); }
}
main().catch(() => { console.error('Test-asset plan preparation failed. Check the public deployment inputs and RPC health; no transaction was signed.'); process.exitCode=1; });

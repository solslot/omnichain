// Derive and rehearse a paused escrow; never open a keystore.
const path = require('node:path');
const {ethers} = require('ethers');
const {boundary, readCanonical, writeOnce} = require('./lib/test-token-deployment');
const {requiredSourceSha} = require('./lib/deployment-evidence');
const {seal, validatePlan, inspectStep, baseAuxiliaryFee} = require('./lib/bounded-base-deployment');
const {loadAssetContext} = require('./lib/native-asset-context');
const {verifyAssetBridgePlan, verifyPausedBridge} = require('./lib/native-asset-deployment');
const required = name => {if (!process.env[name]) throw new Error(`${name} required`); return process.env[name];};

async function main() {
  const urls = [required('BASE_MAINNET_RPC_URL'), required('BASE_MAINNET_SECONDARY_RPC_URL')];
  if (new URL(urls[0]).hostname === new URL(urls[1]).hostname) throw new Error('independent RPC hosts required');
  const providers = urls.map(url => new ethers.JsonRpcProvider(url, undefined, {batchMaxCount: 1}));
  try {
    const block = await boundary(providers);
    const sourceSha = requiredSourceSha();
    const deployer = ethers.getAddress(required('SOLSLOT_DEPLOYER_ADDRESS')).toLowerCase();
    const nonces = await Promise.all(providers.flatMap(p => [p.getTransactionCount(deployer, 'latest'), p.getTransactionCount(deployer, 'pending')]));
    if (new Set(nonces).size !== 1) throw new Error('operator nonce pending or disagrees');
    const settings = readCanonical(required('SOLSLOT_ASSET_INPUTS'), required('SOLSLOT_ASSET_INPUTS_SHA256'));
    const spec = await loadAssetContext({settings, providers, deployer, nonce: nonces[0]});
    process.env.SOLSLOT_REHEARSAL_FORK_BLOCK = String(block.number);
    process.env.HARDHAT_CONFIG = path.resolve(__dirname, '../portal-rehearsal.config.js');
    process.env.HARDHAT_NETWORK = 'hardhat';
    const hre = require('hardhat'), local = hre.ethers;
    if (hre.network.name !== 'hardhat' || (await local.provider.getNetwork()).chainId !== 31337n)
      throw new Error('rehearsal requires the in-process fork');
    await hre.network.provider.send('hardhat_impersonateAccount', [deployer]);
    const signer = await local.getSigner(deployer), op = spec.operation;
    const estimate = await local.provider.estimateGas({from: deployer, to: null, data: op.data, value: 0n});
    const gasLimit = (estimate * 125n + 99n) / 100n, maxPriorityFeePerGas = 1000000n;
    const dynamic = block.baseFeePerGas * 3n + maxPriorityFeePerGas;
    const maxFeePerGas = dynamic > 20000000n ? dynamic : 20000000n;
    const req = {type: 2, chainId: 8453n, to: null, data: op.data, value: 0n, nonce: nonces[0],
      gasLimit, maxFeePerGas, maxPriorityFeePerGas, accessList: []};
    const auxiliary = await Promise.all(providers.map(p => baseAuxiliaryFee(p, req)));
    const auxiliaryFeeBudgetWei = auxiliary.reduce((a,b) => a > b ? a : b) * 3n + 100000000000n;
    const receipt = await (await signer.sendTransaction({...req, chainId: 31337})).wait();
    if (receipt.status !== 1 || receipt.contractAddress.toLowerCase() !== spec.binding.bridge)
      throw new Error('fork deployment failed');
    const created = [{address: spec.binding.bridge, runtimeCodeHash: ethers.keccak256(await local.provider.getCode(spec.binding.bridge))}];
    const state = await verifyPausedBridge(local.provider, spec.binding, spec.artifact, spec.tokenRuntimeHash);
    const plan = validatePlan(seal({schema: 'solslot.bounded-base-deployment.v1', sourceSha,
      actionEnvelopeId: required('SOLSLOT_ACTION_ENVELOPE_ID'), chainId: 8453, chiaNetwork: 'testnet11', testOnly: true,
      deployer, startNonce: nonces[0], binding: spec.binding, dependencies: spec.dependencies,
      transactions: [{name: op.name, nonce: nonces[0], to: null, data: op.data, gasLimit: String(gasLimit),
        maxFeePerGas: String(maxFeePerGas), maxPriorityFeePerGas: String(maxPriorityFeePerGas),
        auxiliaryFeeBudgetWei: String(auxiliaryFeeBudgetWei), created}],
      totalBudgetWei: String(gasLimit * maxFeePerGas + auxiliaryFeeBudgetWei)}));
    verifyAssetBridgePlan(plan, spec);
    const publicPreflight = await inspectStep(plan, 0, providers);
    writeOnce(required('SOLSLOT_ASSET_PLAN'), plan);
    writeOnce(required('SOLSLOT_ASSET_REHEARSAL'), {schema: 'solslot.native-asset-fork-rehearsal.v1',
      planHash: plan.planHash, forkBlock: block.number, forkBlockHash: block.hash, localChainId: 31337,
      gasUsed: String(receipt.gasUsed), created, state, routes: spec.routes,
      chiaObservation: spec.chiaObservation, publicPreflight});
    console.log(JSON.stringify({status: 'rehearsed_paused', planHash: plan.planHash,
      bridge: spec.binding.bridge, catTailHashes: spec.binding.catTailHashes, totalBudgetWei: plan.totalBudgetWei}));
  } finally {providers.forEach(p => p.destroy());}
}
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});

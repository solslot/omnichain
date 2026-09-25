// Read-only public RPC preflight and in-process fork rehearsal. No keystore.
const path = require('node:path');
const {ethers} = require('ethers');
const {requiredSourceSha, writeEvidence} = require('./lib/deployment-evidence');
const {boundary, writeOnce} = require('./lib/test-token-deployment');
const {seal, validatePlan, inspectStep, baseAuxiliaryFee} = require('./lib/bounded-base-deployment');
const {readAuthorityV3Roster, validateAuthorityV3GovernanceEvidence} = require('./lib/authority-v3-deployment');
const {authoritySpec, verifyAuthorityPlan, authorityEvidence} = require('./lib/bounded-authority-plan');
const required = name => {if (!process.env[name]) throw new Error(`${name} required`); return process.env[name];};

async function rehearseAuthority({spec, signer, local, deployer, startNonce, sourceSha, actionEnvelopeId,
  publicBlock, auxiliaryFee}) {
  const maxPriorityFeePerGas = 1000000n;
  const dynamic = publicBlock.baseFeePerGas * 3n + maxPriorityFeePerGas;
  const maxFeePerGas = dynamic > 20000000n ? dynamic : 20000000n;
  const transactions = [], completed = [];
  const localChainId = (await local.getNetwork()).chainId;
  for (const [index, op] of spec.operations.entries()) {
    const estimate = await local.estimateGas({from: deployer, to: op.to, data: op.data, value: 0n});
    const gasLimit = (estimate * 125n + 99n) / 100n;
    const req = {type: 2, chainId: 8453n, to: op.to, data: op.data, value: 0n, nonce: startNonce + index,
      gasLimit, maxFeePerGas, maxPriorityFeePerGas, accessList: []};
    const auxiliaryFeeBudgetWei = await auxiliaryFee(req) * 3n + 100000000000n;
    const receipt = await (await signer.sendTransaction({...req, chainId: localChainId})).wait();
    if (receipt.status !== 1) throw new Error(`Fork operation ${op.name} failed`);
    if (op.to === null && receipt.contractAddress.toLowerCase() !== op.addresses[0]) throw new Error('Fork CREATE address differs');
    const created = [];
    for (const address of op.addresses) {
      const code = await local.getCode(address);
      if (code === '0x') throw new Error('Fork contract missing');
      created.push({address, runtimeCodeHash: ethers.keccak256(code)});
    }
    for (const c of op.postconditions)
      if ((await local.call({to: c.to, data: c.data, blockTag: receipt.blockNumber})).toLowerCase() !== c.result.toLowerCase())
        throw new Error(`Fork ${op.name} postcondition differs`);
    transactions.push({name: op.name, nonce: req.nonce, to: op.to, data: op.data, gasLimit: String(gasLimit),
      maxFeePerGas: String(maxFeePerGas), maxPriorityFeePerGas: String(maxPriorityFeePerGas),
      auxiliaryFeeBudgetWei: String(auxiliaryFeeBudgetWei), created, postconditions: op.postconditions});
    completed.push({name: op.name, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: String(receipt.gasUsed)});
  }
  const plan = validatePlan(seal({schema: 'solslot.bounded-base-deployment.v2', sourceSha, actionEnvelopeId,
    chainId: 8453, chiaNetwork: 'testnet11', testOnly: true, deployer: deployer.toLowerCase(), startNonce,
    binding: spec.binding, dependencies: spec.dependencies, transactions,
    totalBudgetWei: String(transactions.reduce((sum, t) => sum + BigInt(t.gasLimit) * BigInt(t.maxFeePerGas) + BigInt(t.auxiliaryFeeBudgetWei), 0n))}));
  verifyAuthorityPlan(plan, spec);
  return {plan, completed, evidence: authorityEvidence(plan, spec, completed)};
}

async function main() {
  const urls = [required('BASE_MAINNET_RPC_URL'), required('BASE_MAINNET_SECONDARY_RPC_URL')];
  if (new URL(urls[0]).hostname === new URL(urls[1]).hostname) throw new Error('Independent RPC hosts required');
  const providers = urls.map(u => new ethers.JsonRpcProvider(u, undefined, {batchMaxCount: 1}));
  try {
    const sourceSha = requiredSourceSha(), deployer = ethers.getAddress(required('SOLSLOT_DEPLOYER_ADDRESS')).toLowerCase();
    const block = await boundary(providers);
    const nonces = await Promise.all(providers.flatMap(p => [p.getTransactionCount(deployer, 'latest'), p.getTransactionCount(deployer, 'pending')]));
    if (new Set(nonces).size !== 1) throw new Error('Pending or inconsistent deployer nonce');
    const authority = readAuthorityV3Roster(required('SOLSLOT_AUTHORITY_V3_ROSTER_PATH'), 8453);
    if (authority.roster.artifactHash !== required('SOLSLOT_AUTHORITY_V3_ROSTER_HASH')) throw new Error('Reviewed authority roster differs');
    const spec = await authoritySpec({authority, providers, sourceRoot: process.cwd(), deployer, startNonce: nonces[0]});
    process.env.SOLSLOT_REHEARSAL_FORK_BLOCK = String(block.number);
    process.env.HARDHAT_CONFIG = path.resolve(__dirname, '../authority-rehearsal.config.js');
    process.env.HARDHAT_NETWORK = 'hardhat';
    const hre = require('hardhat'), local = hre.ethers.provider;
    if (hre.network.name !== 'hardhat' || (await local.getNetwork()).chainId !== 8453n) throw new Error('Rehearsal requires in-process Base fork');
    await hre.network.provider.send('hardhat_impersonateAccount', [deployer]);
    const result = await rehearseAuthority({spec, signer: await hre.ethers.getSigner(deployer), local, deployer,
      startNonce: nonces[0], sourceSha, actionEnvelopeId: required('SOLSLOT_ACTION_ENVELOPE_ID'), publicBlock: block,
      auxiliaryFee: async req => (await Promise.all(providers.map(p => baseAuxiliaryFee(p, req)))).reduce((a, b) => a > b ? a : b)});
    const draftPath = required('SOLSLOT_AUTHORITY_REHEARSAL_EVIDENCE');
    writeEvidence(draftPath, result.evidence);
    await validateAuthorityV3GovernanceEvidence({path: draftPath, provider: local, rootSafe: spec.binding.root, timelock: spec.binding.timelock});
    const publicPreflight = await inspectStep(result.plan, 0, providers);
    writeOnce(required('SOLSLOT_AUTHORITY_PLAN'), result.plan);
    writeOnce(required('SOLSLOT_AUTHORITY_REHEARSAL'), {schema: 'solslot.authority-v3-fork-rehearsal.v1',
      planHash: result.plan.planHash, forkBlock: block.number, forkBlockHash: block.hash, localChainId: 8453,
      operations: result.completed, publicPreflight, evidencePath: draftPath, simulated: true});
    console.log(JSON.stringify({status: 'rehearsed', planHash: result.plan.planHash, operations: result.plan.transactions.length,
      totalBudgetWei: result.plan.totalBudgetWei, rootSafe: spec.binding.root}));
  } finally {providers.forEach(p => p.destroy());}
}
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
module.exports = {rehearseAuthority};

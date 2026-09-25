// Read-only public RPC preflight and in-process fork rehearsal. No keystore.
const path = require('node:path');
const {ethers} = require('ethers');
const {requiredSourceSha, writeEvidence} = require('./lib/deployment-evidence');
const {boundary, writeOnce} = require('./lib/test-token-deployment');
const {inspectStep, baseAuxiliaryFee} = require('./lib/bounded-base-deployment');
const {readAuthorityV3Roster, validateAuthorityV3GovernanceEvidence} = require('./lib/authority-v3-deployment');
const {authoritySpec, verifyAuthorityPlan, authorityEvidence} = require('./lib/bounded-authority-plan');
const required = name => {if (!process.env[name]) throw new Error(`${name} required`); return process.env[name];};

async function rehearseAuthority(options) {
  const {rehearseSequence} = require('./lib/bounded-rehearsal');
  const result = await rehearseSequence(options);
  verifyAuthorityPlan(result.plan, options.spec);
  return {...result, evidence: authorityEvidence(result.plan, options.spec, result.completed)};
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

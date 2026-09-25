// Only public RPC reads and an in-process fork. Never opens the keystore.
const path = require('node:path');
const {ethers} = require('ethers');
const {requiredSourceSha, writeEvidence} = require('./lib/deployment-evidence');
const {boundary, readCanonical, writeOnce} = require('./lib/test-token-deployment');
const {inspectStep, baseAuxiliaryFee} = require('./lib/bounded-base-deployment');
const {rehearseSequence} = require('./lib/bounded-rehearsal');
const {solsContext, solsSpec, verifySolsState, solsEvidence} = require('./lib/bounded-sols-plan');
const required = name => {if (!process.env[name]) throw new Error(`${name} required`); return process.env[name];};
async function main() {
  const urls = [required('BASE_MAINNET_RPC_URL'), required('BASE_MAINNET_SECONDARY_RPC_URL')];
  if (new URL(urls[0]).hostname === new URL(urls[1]).hostname) throw new Error('Independent RPC hosts required');
  const providers = urls.map(u => new ethers.JsonRpcProvider(u, undefined, {batchMaxCount: 1}));
  try {
    const sourceSha = requiredSourceSha(), deployer = ethers.getAddress(required('SOLSLOT_DEPLOYER_ADDRESS')).toLowerCase();
    const input = readCanonical(required('SOLSLOT_SOLS_INPUTS'), required('SOLSLOT_SOLS_INPUTS_SHA256'));
    if (sourceSha !== input.omnichainSourceSha) throw new Error('SOLS genesis tooling source differs');
    const block = await boundary(providers);
    const nonces = await Promise.all(providers.flatMap(p => [p.getTransactionCount(deployer, 'latest'), p.getTransactionCount(deployer, 'pending')]));
    if (new Set(nonces).size !== 1) throw new Error('Pending or inconsistent deployer nonce');
    const context = await solsContext({input, providers, deployer, startNonce: nonces[0]});
    const spec = await solsSpec({context, sourceRoot: process.cwd(), deployer, startNonce: nonces[0]});
    process.env.SOLSLOT_REHEARSAL_FORK_BLOCK = String(block.number);
    process.env.HARDHAT_CONFIG = path.resolve(__dirname, '../authority-rehearsal.config.js');
    process.env.HARDHAT_NETWORK = 'hardhat';
    const hre = require('hardhat'), local = hre.ethers.provider;
    if (hre.network.name !== 'hardhat' || (await local.getNetwork()).chainId !== 8453n) throw new Error('In-process Base fork required');
    await hre.network.provider.send('hardhat_impersonateAccount', [deployer]);
    const {plan, completed} = await rehearseSequence({spec, signer: await hre.ethers.getSigner(deployer), local, deployer,
      startNonce: nonces[0], sourceSha, actionEnvelopeId: required('SOLSLOT_ACTION_ENVELOPE_ID'), publicBlock: block,
      auxiliaryFee: async req => (await Promise.all(providers.map(p => baseAuxiliaryFee(p, req)))).reduce((a, b) => a > b ? a : b)});
    await verifySolsState(plan, spec, [local]);
    const publicPreflight = await inspectStep(plan, 0, providers);
    // Simulated evidence stays in the rehearsal record; it is never emitted as
    // a deployment receipt that a route-activation tool could consume.
    writeEvidence(required('SOLSLOT_SOLS_REHEARSAL'), {schema: 'solslot.paused-native-sols-fork-rehearsal.v1',
      planHash: plan.planHash, forkBlock: block.number, forkBlockHash: block.hash, localChainId: 8453,
      simulated: true, operations: completed, publicPreflight, simulatedEvidence: solsEvidence(plan, spec, completed)});
    writeOnce(required('SOLSLOT_SOLS_PLAN'), plan);
    console.log(JSON.stringify({status: 'rehearsed', planHash: plan.planHash, operations: completed.length,
      totalBudgetWei: plan.totalBudgetWei, wrappedSols: spec.binding.wrappedSols}));
  } finally {providers.forEach(p => p.destroy());}
}
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});

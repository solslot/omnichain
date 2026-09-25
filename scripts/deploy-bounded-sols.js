const fs = require('node:fs');
const path = require('node:path');
const {ethers} = require('ethers');
const {requiredSourceSha, readEvidence, writeEvidence} = require('./lib/deployment-evidence');
const {readCanonical, writeOnce} = require('./lib/test-token-deployment');
const {validatePlan, runSequence} = require('./lib/bounded-base-deployment');
const {loadSigner} = require('./deploy-bounded-portal');
const {solsContext, solsSpec, verifySolsPlan, verifySolsState, solsEvidence} = require('./lib/bounded-sols-plan');
const required = name => {if (!process.env[name]) throw new Error(`${name} required`); return process.env[name];};
async function main() {
  const plan = validatePlan(readCanonical(required('SOLSLOT_SOLS_PLAN'), required('SOLSLOT_SOLS_PLAN_SHA256')));
  if (requiredSourceSha() !== plan.sourceSha) throw new Error('Deployment source differs');
  const execute = process.env.SOLSLOT_SOLS_EXECUTE === 'approved';
  if (execute && required('SOLSLOT_ACTION_ENVELOPE_ID') !== plan.actionEnvelopeId) throw new Error('ActionEnvelope differs');
  const input = readCanonical(required('SOLSLOT_SOLS_INPUTS'), required('SOLSLOT_SOLS_INPUTS_SHA256'));
  const urls = [required('BASE_MAINNET_RPC_URL'), required('BASE_MAINNET_SECONDARY_RPC_URL')];
  if (new URL(urls[0]).hostname === new URL(urls[1]).hostname) throw new Error('Independent RPC hosts required');
  const providers = urls.map(u => new ethers.JsonRpcProvider(u, undefined, {batchMaxCount: 1}));
  try {
    const context = await solsContext({input, providers, deployer: plan.deployer, startNonce: plan.startNonce});
    const spec = await solsSpec({context, sourceRoot: process.cwd(), deployer: plan.deployer, startNonce: plan.startNonce});
    for (let i = 0; i < 240; i++) {
      const result = await runSequence({plan, providers, execute, signerFactory: loadSigner,
        journal: execute ? required('SOLSLOT_SOLS_JOURNAL') : undefined,
        resubmitOriginal: process.env.SOLSLOT_SOLS_RESUBMIT_ORIGINAL === 'true',
        verifyPlan: p => verifySolsPlan(p, spec), verifyStep: async () => {}});
      console.log(JSON.stringify(result));
      if (!execute) return;
      const journal = required('SOLSLOT_SOLS_JOURNAL');
      writeOnce(path.join(journal, `observation-${Date.now()}-${i}.json`), result);
      if (result.status === 'confirmed') {
        // Recheck signed genesis, both portals and paused token state after confirmation.
        await solsContext({input, providers, deployer: plan.deployer, startNonce: plan.startNonce});
        await verifySolsState(plan, spec, providers);
        const candidate = path.join(journal, 'candidate-evidence.json');
        if (fs.existsSync(candidate)) {
          if (readEvidence(candidate).planHash !== plan.planHash) throw new Error('Existing candidate differs');
        } else writeEvidence(candidate, solsEvidence(plan, spec, result.completed));
        const output = required('SOLSLOT_SOLS_DEPLOYMENT_OUTPUT');
        if (fs.existsSync(output)) {
          if (readEvidence(output).artifactHash !== readEvidence(candidate).artifactHash) throw new Error('Existing deployment evidence differs');
        } else writeEvidence(output, readEvidence(candidate));
        const acceptance = `${output}.acceptance.json`;
        if (!fs.existsSync(acceptance)) writeOnce(acceptance, {schema: 'solslot.paused-native-sols-deployment-acceptance.v1',
          planHash: plan.planHash, artifactHash: readEvidence(output).artifactHash, chainId: 8453, providerCount: 2,
          minimumConfirmations: 12, paused: true, activationRequired: true, status: 'accepted', createdAt: new Date().toISOString()});
        return;
      }
      if (!['broadcast', 'pending', 'confirming'].includes(result.status)) return;
      await new Promise(resolve => setTimeout(resolve, 8000));
    }
    console.log(JSON.stringify({status: 'wait_limit_reached', message: 'Exact signed sequence saved; rerun to reconcile.'}));
  } finally {providers.forEach(p => p.destroy());}
}
if (require.main === module) main().catch(() => {
  console.error('SOLS deployment stopped. Preserve the plan and signed journal; reconcile before retrying.');
  process.exitCode = 1;
});

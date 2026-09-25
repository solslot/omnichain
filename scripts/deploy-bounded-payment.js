const fs = require('node:fs');
const path = require('node:path');
const {ethers} = require('ethers');
const {requiredSourceSha, readEvidence, writeEvidence} = require('./lib/deployment-evidence');
const {readCanonical, writeOnce} = require('./lib/test-token-deployment');
const {validatePlan, runSequence} = require('./lib/bounded-base-deployment');
const {loadSigner} = require('./deploy-bounded-portal');
const {paymentContext, paymentSpec, verifyPaymentPlan, verifyPaymentState, paymentEvidence} = require('./lib/bounded-payment-plan');
const required = name => {if (!process.env[name]) throw new Error(`${name} required`); return process.env[name];};
async function main() {
  const plan = validatePlan(readCanonical(required('SOLSLOT_PAYMENT_PLAN'), required('SOLSLOT_PAYMENT_PLAN_SHA256')));
  if (requiredSourceSha() !== plan.sourceSha) throw new Error('Deployment source differs');
  const execute = process.env.SOLSLOT_PAYMENT_EXECUTE === 'approved';
  if (execute && required('SOLSLOT_ACTION_ENVELOPE_ID') !== plan.actionEnvelopeId) throw new Error('ActionEnvelope differs');
  const input = readCanonical(required('SOLSLOT_PAYMENT_INPUTS'), required('SOLSLOT_PAYMENT_INPUTS_SHA256'));
  const urls = [required('BASE_MAINNET_RPC_URL'), required('BASE_MAINNET_SECONDARY_RPC_URL')];
  if (new URL(urls[0]).hostname === new URL(urls[1]).hostname) throw new Error('Independent RPC hosts required');
  const providers = urls.map(u => new ethers.JsonRpcProvider(u, undefined, {batchMaxCount: 1}));
  try {
    const context = await paymentContext({input, providers, deployer: plan.deployer, startNonce: plan.startNonce});
    const spec = await paymentSpec({context, sourceRoot: process.cwd(), deployer: plan.deployer, startNonce: plan.startNonce});
    for (let i = 0; i < 240; i++) {
      const result = await runSequence({plan, providers, execute, signerFactory: loadSigner,
        journal: execute ? required('SOLSLOT_PAYMENT_JOURNAL') : undefined,
        resubmitOriginal: process.env.SOLSLOT_PAYMENT_RESUBMIT_ORIGINAL === 'true',
        verifyPlan: p => verifyPaymentPlan(p, spec), verifyStep: async () => {}});
      console.log(JSON.stringify(result));
      if (!execute) return;
      const journal = required('SOLSLOT_PAYMENT_JOURNAL');
      writeOnce(path.join(journal, `observation-${Date.now()}-${i}.json`), result);
      if (result.status === 'confirmed') {
        // Recheck mutable governance and portal configuration after the final
        // receipt, as well as both new contracts' paused ownership state.
        await paymentContext({input, providers, deployer: plan.deployer, startNonce: plan.startNonce});
        await verifyPaymentState(plan, spec, providers);
        const candidate = path.join(journal, 'candidate-evidence.json');
        if (fs.existsSync(candidate)) {
          if (readEvidence(candidate).planHash !== plan.planHash) throw new Error('Existing candidate differs');
        } else writeEvidence(candidate, paymentEvidence(plan, spec, result.completed));
        const output = required('SOLSLOT_PAYMENT_DEPLOYMENT_OUTPUT');
        if (fs.existsSync(output)) {
          if (readEvidence(output).artifactHash !== readEvidence(candidate).artifactHash) throw new Error('Existing deployment evidence differs');
        } else writeEvidence(output, readEvidence(candidate));
        const acceptance = `${output}.acceptance.json`;
        if (!fs.existsSync(acceptance)) writeOnce(acceptance, {schema: 'solslot.paused-payment-deployment-acceptance.v1',
          planHash: plan.planHash, artifactHash: readEvidence(output).artifactHash, chainId: 8453, providerCount: 2,
          minimumConfirmations: 12, paused: true, ownershipAccepted: false, status: 'accepted', createdAt: new Date().toISOString()});
        return;
      }
      if (!['broadcast', 'pending', 'confirming'].includes(result.status)) return;
      await new Promise(resolve => setTimeout(resolve, 8000));
    }
    console.log(JSON.stringify({status: 'wait_limit_reached', message: 'Exact signed sequence saved; rerun to reconcile.'}));
  } finally {providers.forEach(p => p.destroy());}
}
if (require.main === module) main().catch(() => {
  console.error('Payment deployment stopped. Preserve the plan and signed journal; reconcile before retrying.');
  process.exitCode = 1;
});

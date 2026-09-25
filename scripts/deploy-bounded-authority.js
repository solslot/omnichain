const fs = require('node:fs');
const path = require('node:path');
const {ethers} = require('ethers');
const {requiredSourceSha, writeEvidence, readEvidence} = require('./lib/deployment-evidence');
const {readCanonical, writeOnce} = require('./lib/test-token-deployment');
const {validatePlan, runSequence} = require('./lib/bounded-base-deployment');
const {loadSigner} = require('./deploy-bounded-portal');
const {readAuthorityV3Roster, validateAuthorityV3GovernanceEvidence} = require('./lib/authority-v3-deployment');
const {authoritySpec, verifyAuthorityPlan, authorityEvidence} = require('./lib/bounded-authority-plan');
const required = name => {if (!process.env[name]) throw new Error(`${name} required`); return process.env[name];};

async function main() {
  const plan = validatePlan(readCanonical(required('SOLSLOT_AUTHORITY_PLAN'), required('SOLSLOT_AUTHORITY_PLAN_SHA256')));
  if (requiredSourceSha() !== plan.sourceSha) throw new Error('Deployment source differs');
  const execute = process.env.SOLSLOT_AUTHORITY_EXECUTE === 'approved';
  if (execute && required('SOLSLOT_ACTION_ENVELOPE_ID') !== plan.actionEnvelopeId) throw new Error('ActionEnvelope differs');
  const authority = readAuthorityV3Roster(required('SOLSLOT_AUTHORITY_V3_ROSTER_PATH'), 8453);
  if (authority.roster.artifactHash !== plan.binding.rosterArtifactHash) throw new Error('Authority roster differs');
  const urls = [required('BASE_MAINNET_RPC_URL'), required('BASE_MAINNET_SECONDARY_RPC_URL')];
  if (new URL(urls[0]).hostname === new URL(urls[1]).hostname) throw new Error('Independent RPC hosts required');
  const providers = urls.map(u => new ethers.JsonRpcProvider(u, undefined, {batchMaxCount: 1}));
  try {
    const spec = await authoritySpec({authority, providers, sourceRoot: process.cwd(), deployer: plan.deployer, startNonce: plan.startNonce});
    for (let i = 0; i < 240; i++) {
      const result = await runSequence({plan, providers, execute, signerFactory: loadSigner,
        journal: execute ? required('SOLSLOT_AUTHORITY_JOURNAL') : undefined,
        resubmitOriginal: process.env.SOLSLOT_AUTHORITY_RESUBMIT_ORIGINAL === 'true',
        verifyPlan: p => verifyAuthorityPlan(p, spec),
        // Exact postconditions are checked at each canonical receipt block by
        // runSequence, including all topology and guard binding transactions.
        verifyStep: async () => {},
      });
      console.log(JSON.stringify(result));
      if (!execute) return;
      writeOnce(path.join(required('SOLSLOT_AUTHORITY_JOURNAL'), `observation-${Date.now()}-${i}.json`), result);
      if (result.status === 'confirmed') {
        const output = required('SOLSLOT_AUTHORITY_DEPLOYMENT_OUTPUT');
        // Keep preliminary evidence inside the journal. Publish the deployment
        // receipt only after both public providers verify its complete state.
        const candidate = path.join(required('SOLSLOT_AUTHORITY_JOURNAL'), 'candidate-evidence.json');
        if (fs.existsSync(candidate)) {
          if (readEvidence(candidate).planHash !== plan.planHash) throw new Error('Existing candidate differs');
        } else writeEvidence(candidate, authorityEvidence(plan, spec, result.completed));
        for (const provider of providers) await validateAuthorityV3GovernanceEvidence({path: candidate, provider,
          rootSafe: spec.binding.root, timelock: spec.binding.timelock});
        if (fs.existsSync(output)) {
          if (readEvidence(output).artifactHash !== readEvidence(candidate).artifactHash) throw new Error('Existing evidence differs');
        } else writeEvidence(output, readEvidence(candidate));
        const acceptance = `${output}.acceptance.json`;
        if (!fs.existsSync(acceptance)) writeOnce(acceptance, {schema: 'solslot.authority-v3-deployment-acceptance.v1',
          planHash: plan.planHash, artifactHash: readEvidence(output).artifactHash, chainId: 8453, providerCount: 2,
          minimumConfirmations: 12, status: 'accepted', createdAt: new Date().toISOString()});
        return;
      }
      if (!['broadcast', 'pending', 'confirming'].includes(result.status)) return;
      await new Promise(resolve => setTimeout(resolve, 8000));
    }
    console.log(JSON.stringify({status: 'wait_limit_reached', message: 'Exact signed sequence saved; rerun to reconcile.'}));
  } finally {providers.forEach(p => p.destroy());}
}
if (require.main === module) main().catch(() => {
  console.error('Authority deployment stopped. Preserve the plan and signed journal; reconcile before retrying.');
  process.exitCode = 1;
});

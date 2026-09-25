const fs = require('node:fs');
const path = require('node:path');
const {ethers} = require('ethers');
const {requiredSourceSha, withArtifactHash, writeEvidence, readEvidence, stableJson} = require('./lib/deployment-evidence');
const {readCanonical, writeOnce} = require('./lib/test-token-deployment');
const {validatePlan, runSequence} = require('./lib/bounded-base-deployment');
const {loadSigner} = require('./deploy-bounded-portal');
const {loadAssetContext} = require('./lib/native-asset-context');
const {verifyAssetBridgePlan, verifyPausedBridge} = require('./lib/native-asset-deployment');
const required = name => {if (!process.env[name]) throw new Error(`${name} required`); return process.env[name];};

function deploymentEvidence(plan, result, spec, observations) {
  const receipt = result.completed[0];
  return withArtifactHash({schemaVersion: 1, kind: 'solslot-native-test-asset-escrow-deployment',
    chainId: 8453, network: 'baseMainnet', chiaNetwork: 'testnet11', testOnly: true,
    sourceSha: plan.sourceSha, actionEnvelopeId: plan.actionEnvelopeId, planHash: plan.planHash,
    binding: plan.binding, confirmations: 12, providerCount: 2, startsPaused: true,
    transaction: {...receipt, from: plan.deployer, dataHash: ethers.keccak256(plan.transactions[0].data)},
    runtimeCodeHash: plan.transactions[0].created[0].runtimeCodeHash,
    tokenRuntimeCodeHash: spec.tokenRuntimeHash, routes: spec.routes, observations,
    createdAt: new Date().toISOString()});
}

async function main() {
  const plan = validatePlan(readCanonical(required('SOLSLOT_ASSET_PLAN'), required('SOLSLOT_ASSET_PLAN_SHA256')));
  if (requiredSourceSha() !== plan.sourceSha) throw new Error('deployment source differs');
  const execute = process.env.SOLSLOT_ASSET_EXECUTE === 'approved';
  if (execute && required('SOLSLOT_ACTION_ENVELOPE_ID') !== plan.actionEnvelopeId) throw new Error('ActionEnvelope differs');
  const urls = [required('BASE_MAINNET_RPC_URL'), required('BASE_MAINNET_SECONDARY_RPC_URL')];
  if (new URL(urls[0]).hostname === new URL(urls[1]).hostname) throw new Error('independent RPC hosts required');
  const providers = urls.map(url => new ethers.JsonRpcProvider(url, undefined, {batchMaxCount: 1}));
  try {
    const settings = readCanonical(required('SOLSLOT_ASSET_INPUTS'), required('SOLSLOT_ASSET_INPUTS_SHA256'));
    const spec = await loadAssetContext({settings, providers, deployer: plan.deployer, nonce: plan.startNonce});
    for (let count = 0; count < 120; count++) {
      const result = await runSequence({plan, providers, execute, signerFactory: loadSigner,
        journal: execute ? required('SOLSLOT_ASSET_JOURNAL') : undefined,
        resubmitOriginal: process.env.SOLSLOT_ASSET_RESUBMIT_ORIGINAL === 'true',
        verifyPlan: p => {
          verifyAssetBridgePlan(p, spec);
          if (stableJson(p.dependencies) !== stableJson(spec.dependencies)) throw new Error('escrow dependencies differ');
        },
        verifyStep: async (p, i, ps) => {for (const provider of ps) await verifyPausedBridge(provider, p.binding, spec.artifact, spec.tokenRuntimeHash);},
      });
      console.log(JSON.stringify(result));
      if (!execute) return;
      writeOnce(path.join(required('SOLSLOT_ASSET_JOURNAL'), `observation-${Date.now()}-${count}.json`), result);
      if (result.status === 'confirmed') {
        const observations = [];
        for (const provider of providers) observations.push(await verifyPausedBridge(provider, plan.binding, spec.artifact, spec.tokenRuntimeHash));
        const output = required('SOLSLOT_ASSET_DEPLOYMENT_OUTPUT');
        if (fs.existsSync(output)) {
          if (readEvidence(output).planHash !== plan.planHash) throw new Error('existing deployment evidence differs');
        } else writeEvidence(output, deploymentEvidence(plan, result, spec, observations));
        return;
      }
      if (!['broadcast', 'pending', 'confirming'].includes(result.status)) return;
      await new Promise(resolve => setTimeout(resolve, 8000));
    }
    console.log(JSON.stringify({status: 'wait_limit_reached', message: 'Exact signed transaction saved; rerun to reconcile.'}));
  } finally {providers.forEach(p => p.destroy());}
}
if (require.main === module) main().catch(() => {
  console.error('Escrow deployment stopped. Preserve the plan and signed journal; reconcile before retrying.');
  process.exitCode = 1;
});
module.exports = {deploymentEvidence};

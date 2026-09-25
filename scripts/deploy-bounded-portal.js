const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { requiredSourceSha, withArtifactHash, writeEvidence, readEvidence } = require("./lib/deployment-evidence");
const { readCanonical, writeOnce } = require("./lib/test-token-deployment");
const { validatePlan, runSequence } = require("./lib/bounded-base-deployment");
const { portalSpec, verifyPlanSpec, verifyPortalStep } = require("./lib/bounded-portal-plan");
const warp = require("./lib/warp-portal-deployment");
const required = name => { if (!process.env[name]) throw new Error(`${name} required`); return process.env[name]; };
async function loadSigner() {
  const descriptor = Number(required("SOLSLOT_KEYSTORE_PASSPHRASE_FD"));
  if (!Number.isInteger(descriptor) || descriptor < 3) throw new Error("dedicated passphrase FD required");
  const fd = fs.openSync(required("SOLSLOT_DEPLOYER_KEYSTORE_PATH"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let json;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 128 * 1024)
      throw new Error("keystore must be bounded and owner-only");
    json = fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
  const password = fs.readFileSync(descriptor);
  try { return await ethers.Wallet.fromEncryptedJson(json, password.toString("utf8")); }
  finally { password.fill(0); }
}
function deploymentEvidence(plan, result, artifacts) {
  const b = plan.binding;
  const transactions = Object.fromEntries(result.completed.map((r, i) => [r.name, {
    hash: r.transactionHash, blockNumber: r.blockNumber, from: ethers.getAddress(plan.deployer),
    dataHash: ethers.keccak256(plan.transactions[i].data),
  }]));
  return withArtifactHash({schemaVersion: 2, kind: "solslot-native-bridge-base-mainnet-portal-deployment",
    network: "baseMainnet", chainId: 8453, chiaNetwork: "testnet11", testOnly: true,
    validatorIdentityDomain: "solslot-alpha-native-bridge-testnet11-base-mainnet",
    sourceSha: plan.sourceSha, actionEnvelopeId: plan.actionEnvelopeId, planHash: plan.planHash,
    confirmations: 12, validatorRosterArtifactHash: b.rosterHash,
    warpSource: {repository: "https://github.com/warpdotgreen/cli.git", commit: warp.WARP_SOURCE_SHA,
      tree: warp.WARP_SOURCE_TREE, packageLockSha256: `0x${warp.WARP_PACKAGE_LOCK_SHA256}`,
      portalSourceSha256: `0x${warp.WARP_PORTAL_SOURCE_SHA256}`, buildInfoSha256: `0x${warp.WARP_BUILD_INFO_SHA256}`,
      compiler: "0.8.23+commit.f704f362", optimizerRuns: 200, evmVersion: "paris"},
    artifacts: {portal: `0x${warp.WARP_PORTAL_ARTIFACT_SHA256}`, transparentProxy: `0x${warp.WARP_PROXY_ARTIFACT_SHA256}`, proxyAdmin: `0x${warp.WARP_PROXY_ADMIN_ARTIFACT_SHA256}`},
    deployer: ethers.getAddress(plan.deployer),
    safe: {address: ethers.getAddress(b.safe), owners: b.owners.map(ethers.getAddress), threshold: 2, version: "1.4.1", fallbackHandler: ethers.getAddress(b.fallbackHandler)},
    portal: {address: ethers.getAddress(b.proxy), owner: ethers.getAddress(b.safe), signers: b.owners.map(ethers.getAddress), signatureThreshold: 2,
      messageTollWei: "0", supportedChains: [warp.PORTAL_CHAIN], initializedAtomically: true},
    proxy: {implementation: ethers.getAddress(b.implementation), admin: ethers.getAddress(b.admin), adminOwner: ethers.getAddress(b.safe), standard: "openzeppelin-transparent-proxy-5.0.2"},
    deploymentTransactions: transactions,
    runtimeCodeHashes: {safe: plan.transactions[0].created[0].runtimeCodeHash, implementation: plan.transactions[1].created[0].runtimeCodeHash,
      portal: plan.transactions[2].created[0].runtimeCodeHash, proxyAdmin: plan.transactions[2].created[1].runtimeCodeHash},
    artifactRuntimeCodeHashes: {portal: ethers.keccak256(artifacts.portal.deployedBytecode),
      transparentProxyTemplate: ethers.keccak256(artifacts.proxy.deployedBytecode), proxyAdmin: ethers.keccak256(artifacts.proxyAdmin.deployedBytecode)},
    createdAt: new Date().toISOString(),
  });
}
async function main() {
  const plan = validatePlan(readCanonical(required("SOLSLOT_PORTAL_PLAN"), required("SOLSLOT_PORTAL_PLAN_SHA256")));
  if (requiredSourceSha() !== plan.sourceSha) throw new Error("deployment source differs");
  const execute = process.env.SOLSLOT_PORTAL_EXECUTE === "approved";
  if (execute && required("SOLSLOT_ACTION_ENVELOPE_ID") !== plan.actionEnvelopeId) throw new Error("ActionEnvelope differs");
  const urls = [required("BASE_MAINNET_RPC_URL"), required("BASE_MAINNET_SECONDARY_RPC_URL")];
  if (new URL(urls[0]).hostname === new URL(urls[1]).hostname) throw new Error("independent RPC hosts required");
  const providers = urls.map(url => new ethers.JsonRpcProvider(url, undefined, {batchMaxCount: 1}));
  try {
    const spec = await portalSpec({rpcUrl: urls[0], sourceRoot: required("SOLSLOT_WARP_SOURCE_ROOT"),
      rosterPath: required("SOLSLOT_WARP_VALIDATOR_ROSTER_PATH"), rosterHash: plan.binding.rosterHash,
      deployer: plan.deployer, startNonce: plan.startNonce});
    for (let count = 0; count < 120; count++) {
      const result = await runSequence({plan, providers, execute,
        verifyPlan: p => verifyPlanSpec(p, spec), verifyStep: (p, i, ps) => verifyPortalStep(p, i, ps, spec.artifacts),
        signerFactory: loadSigner, journal: execute ? required("SOLSLOT_PORTAL_JOURNAL") : undefined,
        resubmitOriginal: process.env.SOLSLOT_PORTAL_RESUBMIT_ORIGINAL === "true"});
      console.log(JSON.stringify(result));
      if (!execute) return;
      writeOnce(path.join(required("SOLSLOT_PORTAL_JOURNAL"), `observation-${Date.now()}-${count}.json`), result);
      if (result.status === "confirmed") {
        const candidate = path.join(required("SOLSLOT_PORTAL_JOURNAL"), "portal-evidence-candidate.json");
        if (!fs.existsSync(candidate)) writeEvidence(candidate, deploymentEvidence(plan, result, spec.artifacts));
        const evidence = readEvidence(candidate, "portal_candidate");
        if (evidence.planHash !== plan.planHash) throw new Error("candidate evidence differs from plan");
        for (const provider of providers) await warp.validateWarpPortalEvidence({path: candidate, provider,
          expectedPortal: plan.binding.proxy, expectedOmnichainSourceSha: plan.sourceSha,
          expectedRosterArtifactHash: plan.binding.rosterHash, expectedValidatorAddresses: plan.binding.owners,
          expectedChainId: 8453});
        const output = required("SOLSLOT_PORTAL_DEPLOYMENT_OUTPUT");
        if (fs.existsSync(output)) {
          if (readEvidence(output, "portal").artifactHash !== evidence.artifactHash) throw new Error("existing evidence differs");
        } else writeEvidence(output, evidence);
        return;
      }
      if (!["broadcast", "pending", "confirming"].includes(result.status)) return;
      await new Promise(resolve => setTimeout(resolve, 8000));
    }
    console.log(JSON.stringify({status: "wait_limit_reached", message: "Exact signed transactions are saved. Rerun to reconcile."}));
  } finally { providers.forEach(p => p.destroy()); }
}
if (require.main === module) main().catch(() => {
  // RPC exceptions may include broadcastable signed bytes. Never print them.
  console.error("Portal deployment stopped. The original plan and signed journal are preserved. Reconcile before retrying; no replacement transaction was created.");
  process.exitCode = 1;
});
module.exports = {deploymentEvidence, loadSigner};

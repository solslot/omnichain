const fs = require("node:fs");
const { ethers, artifacts, network } = require("hardhat");
const { requiredSourceSha } = require("./lib/deployment-evidence");
const { contractFor, readCanonical, validatePlan, runDeployment } = require("./lib/test-token-deployment");

function required(key) { if (!process.env[key]) throw new Error(`${key} required`); return process.env[key]; }
async function main() {
  const plan = validatePlan(readCanonical(required("SOLSLOT_TEST_TOKEN_PLAN"), required("SOLSLOT_TEST_TOKEN_PLAN_SHA256")));
  if (requiredSourceSha() !== plan.sourceSha) throw new Error("source differs from plan");
  if (network.name !== plan.network) throw new Error("Hardhat network differs from plan");
  const execute = process.env.SOLSLOT_TEST_TOKEN_EXECUTE === "approved";
  if (execute && required("SOLSLOT_ACTION_ENVELOPE_ID") !== plan.actionEnvelopeId) throw new Error("ActionEnvelope differs");
  const urls = [required("BASE_MAINNET_RPC_URL"), required("BASE_MAINNET_SECONDARY_RPC_URL")];
  if (new URL(urls[0]).hostname === new URL(urls[1]).hostname) throw new Error("two independent RPC hosts required");
  const providers = urls.map(url => new ethers.JsonRpcProvider(url));
  try {
    const result = await runDeployment({plan, artifact: await artifacts.readArtifact(contractFor(plan)), providers,
      execute, journalDirectory: execute ? required("SOLSLOT_TEST_TOKEN_JOURNAL") : undefined,
      resubmitOriginal: process.env.SOLSLOT_TEST_TOKEN_RESUBMIT_ORIGINAL === "true",
      signerFactory: async () => {
        const descriptor = Number(required("SOLSLOT_KEYSTORE_PASSPHRASE_FD"));
        if (!Number.isInteger(descriptor) || descriptor < 3) throw new Error("dedicated passphrase FD required");
        const fd = fs.openSync(required("SOLSLOT_DEPLOYER_KEYSTORE_PATH"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let json;
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 128 * 1024)
            throw new Error("keystore must be a bounded owner-only file");
          json = fs.readFileSync(fd, "utf8");
        } finally { fs.closeSync(fd); }
        const password = fs.readFileSync(descriptor);
        try { return await ethers.Wallet.fromEncryptedJson(json, password.toString("utf8")); }
        finally { password.fill(0); }
      },
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { providers.forEach(p => p.destroy()); }
}
main().catch(() => {
  // Errors from a broadcaster can include signed bytes. Keep the journal local.
  console.error("Test-token deployment stopped. Preserve the plan and journal. Reconcile RPC evidence before retrying; no replacement transaction is authorized.");
  process.exitCode = 1;
});

// Read-only RPC inspection and write-once plan generation. No signer access.
const { ethers, artifacts } = require("hardhat");
const { requiredSourceSha } = require("./lib/deployment-evidence");
const { CONTRACT, preparePlan, requestFor, inspectFresh, boundary, writeOnce } = require("./lib/test-token-deployment");

async function main() {
  const required = key => { if (!process.env[key]) throw new Error(`${key} required`); return process.env[key]; };
  const sourceSha = requiredSourceSha();
  const urls = [required("BASE_MAINNET_RPC_URL"), required("BASE_MAINNET_SECONDARY_RPC_URL")];
  if (new URL(urls[0]).hostname === new URL(urls[1]).hostname) throw new Error("two independent RPC hosts required");
  const providers = urls.map(url => new ethers.JsonRpcProvider(url));
  try {
    await boundary(providers);
    const deployer = ethers.getAddress(required("SOLSLOT_EVM_OPERATOR_ADDRESS")).toLowerCase();
    const nonce = await providers[0].getTransactionCount(deployer, "pending");
    const artifact = await artifacts.readArtifact(CONTRACT);
    const plan = preparePlan({sourceSha, actionEnvelopeId: required("SOLSLOT_ACTION_ENVELOPE_ID"), deployer, nonce,
      gasLimit: required("SOLSLOT_TEST_TOKEN_GAS_LIMIT"), maxFeePerGas: required("SOLSLOT_TEST_TOKEN_MAX_FEE_WEI"),
      maxPriorityFeePerGas: required("SOLSLOT_TEST_TOKEN_PRIORITY_FEE_WEI"),
      l1FeeBudgetWei: required("SOLSLOT_TEST_TOKEN_L1_BUDGET_WEI")}, artifact);
    const inspection = await inspectFresh(plan, requestFor(plan, artifact), providers);
    writeOnce(required("SOLSLOT_TEST_TOKEN_PLAN"), plan);
    writeOnce(required("SOLSLOT_TEST_TOKEN_INSPECTION"), {observedAt: new Date().toISOString(), planHash: plan.planHash, inspection});
    console.log(JSON.stringify({status: "prepared_not_deployed", planHash: plan.planHash, tokenAddress: plan.tokenAddress, inspection}, null, 2));
  } finally { providers.forEach(p => p.destroy()); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

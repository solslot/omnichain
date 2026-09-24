// Public planning + a local fork rehearsal. Never opens a keystore.
const path = require("node:path");
const { ethers } = require("ethers");
const { boundary, writeOnce } = require("./lib/test-token-deployment");
const { requiredSourceSha } = require("./lib/deployment-evidence");
const { seal, validatePlan, inspectStep, baseAuxiliaryFee } = require("./lib/bounded-base-deployment");
const { portalSpec, verifyPlanSpec, verifyPortalStep } = require("./lib/bounded-portal-plan");
const required = name => { if (!process.env[name]) throw new Error(`${name} required`); return process.env[name]; };
async function main() {
  const urls = [required("BASE_MAINNET_RPC_URL"), required("BASE_MAINNET_SECONDARY_RPC_URL")];
  if (new URL(urls[0]).hostname === new URL(urls[1]).hostname) throw new Error("independent RPC hosts required");
  const providers = urls.map(url => new ethers.JsonRpcProvider(url));
  try {
    const block = await boundary(providers);
    const deployer = ethers.getAddress(required("SOLSLOT_DEPLOYER_ADDRESS")).toLowerCase();
    const nonces = await Promise.all(providers.flatMap(p => [p.getTransactionCount(deployer, "latest"), p.getTransactionCount(deployer, "pending")]));
    if (new Set(nonces).size !== 1) throw new Error("operator has pending transactions or RPC disagreement");
    const sourceSha = requiredSourceSha();
    const spec = await portalSpec({rpcUrl: urls[0], sourceRoot: required("SOLSLOT_WARP_SOURCE_ROOT"),
      rosterPath: required("SOLSLOT_WARP_VALIDATOR_ROSTER_PATH"), rosterHash: required("SOLSLOT_WARP_VALIDATOR_ROSTER_HASH"), deployer, startNonce: nonces[0]});
    for (const p of providers) for (const d of spec.dependencies)
      if (ethers.keccak256(await p.getCode(d.address)) !== d.runtimeCodeHash) throw new Error("published Safe dependency hash differs");
    // Start directly in fork mode. Resetting an existing non-fork Hardhat 2.28
    // provider retains incompatible genesis storage overrides (EDR #911).
    process.env.SOLSLOT_REHEARSAL_FORK_BLOCK = String(block.number);
    process.env.HARDHAT_CONFIG = path.resolve(__dirname, "../portal-rehearsal.config.js");
    process.env.HARDHAT_NETWORK = "hardhat";
    const hre = require("hardhat"), local = hre.ethers;
    if (hre.network.name !== "hardhat" || (await local.provider.getNetwork()).chainId !== 31337n)
      throw new Error("rehearsal requires the in-process local fork");
    await hre.network.provider.send("hardhat_impersonateAccount", [deployer]);
    const signer = await local.getSigner(deployer);
    console.log(JSON.stringify({stage: "fork_ready", blockNumber: block.number}));
    const body = {schema: "solslot.bounded-base-deployment.v1", sourceSha, actionEnvelopeId: required("SOLSLOT_ACTION_ENVELOPE_ID"),
      chainId: 8453, chiaNetwork: "testnet11", testOnly: true, deployer, startNonce: nonces[0],
      binding: spec.binding, dependencies: spec.dependencies, transactions: [], totalBudgetWei: "0"};
    const rehearsal = {schema: "solslot.portal-fork-rehearsal.v1", forkBlock: block.number, forkBlockHash: block.hash, localChainId: 31337, operations: []};
    let budget = 0n;
    for (const [i, op] of spec.operations.entries()) {
      console.log(JSON.stringify({stage: "rehearsing", operation: op.name}));
      const nonce = nonces[0] + i;
      const gas = await local.provider.estimateGas({from: deployer, to: op.to, data: op.data, value: 0n});
      const gasLimit = (gas * 125n + 99n) / 100n;
      const maxPriorityFeePerGas = 1000000n;
      const maxFeePerGas = block.baseFeePerGas * 3n + maxPriorityFeePerGas > 20000000n ? block.baseFeePerGas * 3n + maxPriorityFeePerGas : 20000000n;
      const req = {type: 2, chainId: 8453n, to: op.to, data: op.data, value: 0n, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, accessList: []};
      const estimates = await Promise.all(providers.map(p => baseAuxiliaryFee(p, req)));
      const auxiliaryFeeBudgetWei = estimates.reduce((a,b) => a > b ? a : b) * 3n + 100000000000n;
      const tx = await signer.sendTransaction({...req, chainId: 31337});
      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error("local fork deployment failed");
      const created = await Promise.all(op.addresses.map(async address => {
        const code = await local.provider.getCode(address);
        if (code === "0x") throw new Error("local contract missing");
        return {address, runtimeCodeHash: ethers.keccak256(code)};
      }));
      body.transactions.push({name: op.name, nonce, to: op.to, data: op.data, gasLimit: String(gasLimit),
        maxFeePerGas: String(maxFeePerGas), maxPriorityFeePerGas: String(maxPriorityFeePerGas), auxiliaryFeeBudgetWei: String(auxiliaryFeeBudgetWei), created});
      budget += gasLimit * maxFeePerGas + auxiliaryFeeBudgetWei;
      rehearsal.operations.push({name: op.name, gasUsed: String(receipt.gasUsed), dataHash: ethers.keccak256(op.data), created});
      await verifyPortalStep(body, i, [local.provider], spec.artifacts);
    }
    body.totalBudgetWei = String(budget);
    const plan = validatePlan(seal(body)); verifyPlanSpec(plan, spec);
    rehearsal.planHash = plan.planHash;
    rehearsal.publicPreflight = await inspectStep(plan, 0, providers);
    writeOnce(required("SOLSLOT_PORTAL_PLAN"), plan);
    writeOnce(required("SOLSLOT_PORTAL_REHEARSAL"), rehearsal);
    console.log(JSON.stringify({status: "rehearsed", planHash: plan.planHash, safe: spec.binding.safe,
      portal: spec.binding.proxy, totalBudgetWei: body.totalBudgetWei, operations: rehearsal.operations}, null, 2));
  } finally { providers.forEach(p => p.destroy()); }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

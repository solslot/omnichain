const { ethers, network } = require("hardhat");
const {
  assertChain,
  currentNetworkConfig,
  requiredAddress,
} = require("./lib/config");
const {
  readEvidence,
  requiredSourceSha,
  withArtifactHash,
  writeEvidence,
} = require("./lib/deployment-evidence");
const { validateGovernanceEvidence } = require("./lib/governance-deployment");

async function runtimeCodeHash(address, label) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`No runtime bytecode at ${label} ${address}`);
  return ethers.keccak256(code);
}

function sameAddress(left, right, label) {
  if (!ethers.isAddress(left) || !ethers.isAddress(right) || left.toLowerCase() !== right.toLowerCase()) {
    throw new Error(`${label} does not match the deployment evidence`);
  }
}

async function main() {
  const deployment = readEvidence(
    process.env.SOLSLOT_OMNICHAIN_DEPLOYMENT_EVIDENCE_PATH,
    "deployment",
  );
  const sourceSha = requiredSourceSha({
    ...process.env,
    SOLSLOT_OMNICHAIN_SOURCE_SHA: deployment.sourceSha,
  });
  const config = currentNetworkConfig();
  await assertChain(config);
  if (deployment.network !== network.name || deployment.chainId !== config.chainId) {
    throw new Error("deployment evidence network does not match the active RPC network");
  }
  const contracts = deployment.contracts;
  const deploymentConfig = deployment.configuration;
  if (!contracts || !deploymentConfig || deployment.rail !== "ccip-warp-escrow") {
    throw new Error("deployment evidence schema is unsupported");
  }
  if (deployment.schemaVersion !== 3) throw new Error("deployment evidence schema is unsupported");
  const governance = requiredAddress("GOVERNANCE_ADDRESS", deploymentConfig.governanceTimelock);
  sameAddress(governance, deploymentConfig.governanceTimelock, "GOVERNANCE_ADDRESS");
  const rootSafe = requiredAddress("ROOT_SAFE_ADDRESS", deploymentConfig.governanceRootSafe);
  sameAddress(rootSafe, deploymentConfig.governanceRootSafe, "ROOT_SAFE_ADDRESS");
  const governanceEvidence = await validateGovernanceEvidence({
    path: process.env.SOLSLOT_GOVERNANCE_EVIDENCE_PATH,
    provider: ethers.provider,
    rootSafe,
    timelock: governance,
  });
  if (governanceEvidence.artifactHash !== deployment.governanceArtifactHash) {
    throw new Error("governance evidence does not match the deployment evidence");
  }
  const ownershipIntent = readEvidence(
    process.env.SOLSLOT_OWNERSHIP_ACTIVATION_INTENT_PATH,
    "ownership_activation_intent",
  );
  if (
    ownershipIntent.schemaVersion !== 2 ||
    ownershipIntent.kind !== "solslot-omnichain-ownership-activation-intent" ||
    ownershipIntent.deploymentArtifactHash !== deployment.artifactHash ||
    ownershipIntent.rootSafe.toLowerCase() !== rootSafe.toLowerCase() ||
    ownershipIntent.timelock.toLowerCase() !== governance.toLowerCase()
  ) {
    throw new Error("ownership activation intent does not match the deployment");
  }
  const timelock = await ethers.getContractAt("SolslotAlphaTimelock", governance);
  if (!(await timelock.isOperationDone(ownershipIntent.operationId))) {
    throw new Error("ownership acceptance timelock operation is not complete");
  }
  const gateway = await ethers.getContractAt("SolomonWarpGateway", contracts.gateway);
  const spoke = await ethers.getContractAt("OmnichainEscrowSpoke", contracts.spoke);
  const [gatewayOwner, spokeOwner] = await Promise.all([gateway.owner(), spoke.owner()]);
  sameAddress(gatewayOwner, governance, "gateway owner");
  sameAddress(spokeOwner, governance, "spoke owner");

  const runtimeCodeHashes = {
    gateway: await runtimeCodeHash(contracts.gateway, "gateway"),
    spoke: await runtimeCodeHash(contracts.spoke, "spoke"),
  };
  for (const [name, observed] of Object.entries(runtimeCodeHashes)) {
    if (deployment.runtimeCodeHashes?.[name] !== observed) {
      throw new Error(`${name} runtime bytecode differs from deployment evidence`);
    }
  }
  const gatewayProfile = String(process.env.SOLSLOT_OMNICHAIN_GATEWAY_PROFILE || "").trim();
  if (!/^[a-z0-9_-]{1,32}$/.test(gatewayProfile)) {
    throw new Error("SOLSLOT_OMNICHAIN_GATEWAY_PROFILE is required and must be a safe identifier");
  }
  const activation = withArtifactHash({
    schemaVersion: 3,
    kind: "ccip-warp-escrow-activation",
    deploymentArtifactHash: deployment.artifactHash,
    ownershipOperationArtifactHash: ownershipIntent.artifactHash,
    sourceSha,
    network: network.name,
    chainId: config.chainId,
    gatewayProfile,
    contracts: { gateway: contracts.gateway, spoke: contracts.spoke },
    runtimeCodeHashes,
    governance,
    governanceRootSafe: rootSafe,
    observedOwners: { gateway: gatewayOwner, spoke: spokeOwner },
    ownershipAccepted: true,
    activatedAt: new Date().toISOString(),
  });
  const output = writeEvidence(process.env.SOLSLOT_OMNICHAIN_ACTIVATION_EVIDENCE_OUTPUT, activation);
  console.log(JSON.stringify({ ...activation, evidencePath: output }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

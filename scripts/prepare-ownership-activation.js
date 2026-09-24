const { ethers, network } = require("hardhat");
const { execFileSync } = require("node:child_process");
const {
  readEvidence,
  withArtifactHash,
  writeEvidence,
} = require("./lib/deployment-evidence");
const { validatePaymentGovernance } = require("./lib/payment-governance");

const GIT_SHA = /^[0-9a-f]{40}$/;

async function runtimeCodeHash(address, label) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`No runtime bytecode at ${label} ${address}`);
  return ethers.keccak256(code);
}

function currentToolSourceSha() {
  const status = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim();
  if (status) throw new Error("Refusing to prepare ownership from a dirty checkout");
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
}

function sameAddress(left, right, label) {
  if (
    !ethers.isAddress(left) ||
    !ethers.isAddress(right) ||
    ethers.getAddress(left) !== ethers.getAddress(right)
  ) {
    throw new Error(`${label} does not match`);
  }
}

async function main() {
  const deployment = readEvidence(
    process.env.SOLSLOT_OMNICHAIN_DEPLOYMENT_EVIDENCE_PATH,
    "deployment",
  );
  if (
    deployment.schemaVersion !== 5 ||
    deployment.rail !== "ccip-warp-escrow" ||
    deployment.network !== network.name ||
    deployment.chainId !== Number((await ethers.provider.getNetwork()).chainId) ||
    !GIT_SHA.test(String(deployment.sourceSha || ""))
  ) {
    throw new Error("deployment evidence does not match the active network");
  }
  if (deployment.configuration?.ownershipAccepted !== false) {
    throw new Error("deployment evidence does not describe a pending ownership handoff");
  }
  const timelockAddress = deployment.configuration.governanceTimelock;
  const rootSafeAddress = deployment.configuration.governanceRootSafe;
  const governance = await validatePaymentGovernance({
    path: process.env.SOLSLOT_GOVERNANCE_EVIDENCE_PATH,
    provider: ethers.provider,
    rootSafe: rootSafeAddress,
    timelock: timelockAddress,
  });
  if (governance.artifactHash !== deployment.governanceArtifactHash) {
    throw new Error("governance evidence does not match the deployment");
  }
  const timelock = await ethers.getContractAt("SolslotAlphaTimelock", timelockAddress);
  if (await timelock.getMinDelay() !== 86400n) throw new Error("timelock delay is not 24 hours");
  const gateway = await ethers.getContractAt("SolomonWarpGateway", deployment.contracts.gateway);
  const spoke = await ethers.getContractAt("OmnichainEscrowSpoke", deployment.contracts.spoke);
  const [gatewayOwner, gatewayPendingOwner, spokeOwner, spokePendingOwner] = await Promise.all([
    gateway.owner(),
    gateway.pendingOwner(),
    spoke.owner(),
    spoke.pendingOwner(),
  ]);
  sameAddress(gatewayPendingOwner, timelockAddress, "gateway pending owner");
  sameAddress(spokePendingOwner, timelockAddress, "spoke pending owner");
  if (
    ethers.getAddress(gatewayOwner) === ethers.getAddress(timelockAddress) ||
    ethers.getAddress(spokeOwner) === ethers.getAddress(timelockAddress)
  ) {
    throw new Error("ownership has already been accepted");
  }
  const [gatewayTransfer, spokeTransfer] = await Promise.all([
    ethers.provider.getTransaction(deployment.deploymentTransactions?.gatewayOwnershipTransfer?.hash),
    ethers.provider.getTransaction(deployment.deploymentTransactions?.spokeOwnershipTransfer?.hash),
  ]);
  if (!gatewayTransfer || !spokeTransfer) {
    throw new Error("ownership transfer transactions are unavailable");
  }
  sameAddress(gatewayOwner, gatewayTransfer.from, "gateway current owner");
  sameAddress(spokeOwner, spokeTransfer.from, "spoke current owner");
  const observedRuntimeCodeHashes = {
    gateway: await runtimeCodeHash(deployment.contracts.gateway, "gateway"),
    spoke: await runtimeCodeHash(deployment.contracts.spoke, "spoke"),
  };
  for (const [name, observed] of Object.entries(observedRuntimeCodeHashes)) {
    if (deployment.runtimeCodeHashes?.[name] !== observed) {
      throw new Error(`${name} runtime bytecode differs from deployment evidence`);
    }
  }
  const ownable = new ethers.Interface(["function acceptOwnership()"]);
  const targets = [deployment.contracts.gateway, deployment.contracts.spoke];
  const values = [0n, 0n];
  const payloads = [ownable.encodeFunctionData("acceptOwnership"), ownable.encodeFunctionData("acceptOwnership")];
  const predecessor = ethers.ZeroHash;
  const salt = ethers.keccak256(ethers.solidityPacked(
    ["string", "bytes32"],
    ["SOLSLOT_ALPHA_ACCEPT_OWNERSHIP", deployment.artifactHash],
  ));
  const operationId = await timelock.hashOperationBatch(targets, values, payloads, predecessor, salt);
  const scheduleData = timelock.interface.encodeFunctionData("scheduleBatch", [
    targets,
    values,
    payloads,
    predecessor,
    salt,
    86400n,
  ]);
  const executeData = timelock.interface.encodeFunctionData("executeBatch", [
    targets,
    values,
    payloads,
    predecessor,
    salt,
  ]);
  if (await timelock.isOperation(operationId)) {
    throw new Error("ownership operation is already scheduled");
  }
  const evidence = withArtifactHash({
    schemaVersion: 2,
    kind: "solslot-omnichain-ownership-activation-intent",
    deploymentArtifactHash: deployment.artifactHash,
    network: network.name,
    chainId: deployment.chainId,
    rootSafe: rootSafeAddress,
    timelock: timelockAddress,
    operationId,
    minimumDelaySeconds: "86400",
    scheduleTransaction: { to: timelockAddress, value: "0", data: scheduleData },
    executeTransaction: { to: timelockAddress, value: "0", data: executeData },
    targets: [
      {
        label: "gateway",
        address: targets[0],
        currentOwner: gatewayOwner,
        pendingOwner: gatewayPendingOwner,
        runtimeCodeHash: observedRuntimeCodeHashes.gateway,
        ownershipTransferTransactionHash:
          deployment.deploymentTransactions.gatewayOwnershipTransfer.hash,
      },
      {
        label: "spoke",
        address: targets[1],
        currentOwner: spokeOwner,
        pendingOwner: spokePendingOwner,
        runtimeCodeHash: observedRuntimeCodeHashes.spoke,
        ownershipTransferTransactionHash:
          deployment.deploymentTransactions.spokeOwnershipTransfer.hash,
      },
    ],
    governanceArtifactHash: governance.artifactHash,
    preparationSourceSha: currentToolSourceSha(),
    preparationBlockNumber: await ethers.provider.getBlockNumber(),
    createdAt: new Date().toISOString(),
  });
  const output = writeEvidence(
    process.env.SOLSLOT_OWNERSHIP_ACTIVATION_INTENT_OUTPUT,
    evidence,
    "SOLSLOT_OWNERSHIP_ACTIVATION_INTENT_OUTPUT",
  );
  console.log(JSON.stringify({ ...evidence, evidencePath: output }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

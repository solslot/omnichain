const { execFileSync } = require("node:child_process");
const { ethers, network } = require("hardhat");
const {
  readEvidence,
  withArtifactHash,
  writeEvidence,
} = require("./lib/deployment-evidence");
const { validatePaymentGovernance, paymentSigningSafes } = require("./lib/payment-governance");
const { buildSafeAuthorityOperation } = require("./lib/safe-authority-operation");

function toolSourceSha() {
  const status = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim();
  if (status) throw new Error("Refusing to prepare a Safe operation from a dirty checkout");
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
}

function requireMatchingIntent(intent, deployment) {
  if (
    intent.schemaVersion !== 2 ||
    intent.kind !== "solslot-omnichain-ownership-activation-intent" ||
    intent.deploymentArtifactHash !== deployment.artifactHash ||
    intent.network !== deployment.network ||
    intent.chainId !== deployment.chainId ||
    intent.rootSafe.toLowerCase() !==
      deployment.configuration.governanceRootSafe.toLowerCase() ||
    intent.timelock.toLowerCase() !==
      deployment.configuration.governanceTimelock.toLowerCase()
  ) {
    throw new Error("ownership intent does not match the deployment");
  }
}

async function requireCanonicalOperation(intent, deployment, timelock) {
  const ownable = new ethers.Interface(["function acceptOwnership()"]);
  const targets = [deployment.contracts.gateway, deployment.contracts.spoke];
  const values = [0n, 0n];
  const payloads = targets.map(() => ownable.encodeFunctionData("acceptOwnership"));
  const predecessor = ethers.ZeroHash;
  const salt = ethers.keccak256(ethers.solidityPacked(
    ["string", "bytes32"],
    ["SOLSLOT_ALPHA_ACCEPT_OWNERSHIP", deployment.artifactHash],
  ));
  const operationId = await timelock.hashOperationBatch(
    targets,
    values,
    payloads,
    predecessor,
    salt,
  );
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
  if (
    intent.operationId !== operationId ||
    intent.scheduleTransaction?.to.toLowerCase() !==
      deployment.configuration.governanceTimelock.toLowerCase() ||
    intent.scheduleTransaction?.value !== "0" ||
    intent.scheduleTransaction?.data !== scheduleData ||
    intent.executeTransaction?.to.toLowerCase() !==
      deployment.configuration.governanceTimelock.toLowerCase() ||
    intent.executeTransaction?.value !== "0" ||
    intent.executeTransaction?.data !== executeData
  ) {
    throw new Error("ownership intent operation is not canonical for the deployment");
  }
}

async function main() {
  const phase = String(process.env.SOLSLOT_OWNERSHIP_AUTHORITY_PHASE || "").trim();
  if (!["schedule", "execute"].includes(phase)) {
    throw new Error("SOLSLOT_OWNERSHIP_AUTHORITY_PHASE must be schedule or execute");
  }
  const deployment = readEvidence(
    process.env.SOLSLOT_OMNICHAIN_DEPLOYMENT_EVIDENCE_PATH,
    "deployment",
  );
  if (
    deployment.schemaVersion !== 5 ||
    deployment.network !== network.name ||
    deployment.chainId !== Number((await ethers.provider.getNetwork()).chainId)
  ) {
    throw new Error("deployment evidence does not match the active network");
  }
  const intent = readEvidence(
    process.env.SOLSLOT_OWNERSHIP_ACTIVATION_INTENT_PATH,
    "ownership_activation_intent",
  );
  requireMatchingIntent(intent, deployment);
  const governance = await validatePaymentGovernance({
    path: process.env.SOLSLOT_GOVERNANCE_EVIDENCE_PATH,
    provider: ethers.provider,
    rootSafe: deployment.configuration.governanceRootSafe,
    timelock: deployment.configuration.governanceTimelock,
  });
  if (
    governance.artifactHash !== deployment.governanceArtifactHash ||
    governance.artifactHash !== intent.governanceArtifactHash
  ) {
    throw new Error("governance evidence does not match the ownership intent");
  }

  const timelock = await ethers.getContractAt(
    "SolslotAlphaTimelock",
    deployment.configuration.governanceTimelock,
  );
  await requireCanonicalOperation(intent, deployment, timelock);
  const operationExists = await timelock.isOperation(intent.operationId);
  const operationDone = await timelock.isOperationDone(intent.operationId);
  if (phase === "schedule" && operationExists) {
    throw new Error("ownership operation has already been scheduled");
  }
  if (phase === "execute" && (!operationExists || operationDone)) {
    throw new Error("ownership operation is not awaiting execution");
  }
  const transaction = phase === "schedule"
    ? intent.scheduleTransaction
    : intent.executeTransaction;
  const authorityOperation = await buildSafeAuthorityOperation({
    provider: ethers.provider,
    chainId: deployment.chainId,
    phase,
    rootSafeAddress: deployment.configuration.governanceRootSafe,
    rootTransaction: transaction,
    ...paymentSigningSafes(governance, Number(process.env.SOLSLOT_OWNERSHIP_COADMIN_SLOT)),
  });
  const operationTimestamp = await timelock.getTimestamp(intent.operationId);
  const latestBlock = await ethers.provider.getBlock("latest");
  const evidence = withArtifactHash({
    schemaVersion: governance.schemaVersion === 3 ? 2 : 1,
    kind: "solslot-safe-authority-operation",
    deploymentArtifactHash: deployment.artifactHash,
    ownershipIntentArtifactHash: intent.artifactHash,
    governanceArtifactHash: governance.artifactHash,
    sourceSha: toolSourceSha(),
    network: network.name,
    chainId: deployment.chainId,
    operationId: intent.operationId,
    phase,
    rootSafe: deployment.configuration.governanceRootSafe,
    timelock: deployment.configuration.governanceTimelock,
    operationTimestamp: operationTimestamp.toString(),
    operationReady: await timelock.isOperationReady(intent.operationId),
    observedAtBlock: latestBlock.number,
    observedAtTimestamp: latestBlock.timestamp,
    authorityOperation,
    createdAt: new Date().toISOString(),
  });
  const output = writeEvidence(
    process.env.SOLSLOT_OWNERSHIP_SAFE_OPERATION_OUTPUT,
    evidence,
    "SOLSLOT_OWNERSHIP_SAFE_OPERATION_OUTPUT",
  );
  console.log(JSON.stringify({
    artifactHash: evidence.artifactHash,
    phase,
    operationId: intent.operationId,
    rootSafeTransactionHash: authorityOperation.transactionHash,
    approvals: authorityOperation.approvals.map(({ role, safe, allowedSigners, messageHash }) => ({
      role,
      safe,
      allowedSigners,
      messageHash,
    })),
    evidencePath: output,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

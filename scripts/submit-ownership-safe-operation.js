const { ethers, network } = require("hardhat");
const {
  readEvidence,
  withArtifactHash,
  writeEvidence,
} = require("./lib/deployment-evidence");
const {
  encodeContractSignatures,
  safeTransactionArguments,
  validateAuthorityApprovalEvidence,
} = require("./lib/safe-authority-operation");
const { validateGovernanceEvidence } = require("./lib/governance-deployment");

const SAFE_EXEC_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address payable refundReceiver,bytes signatures) returns (bool success)",
];

async function main() {
  const deployment = readEvidence(
    process.env.SOLSLOT_OMNICHAIN_DEPLOYMENT_EVIDENCE_PATH,
    "deployment",
  );
  const packageEvidence = readEvidence(
    process.env.SOLSLOT_OWNERSHIP_SAFE_OPERATION_PATH,
    "ownership_safe_operation",
  );
  const approvals = readEvidence(
    process.env.SOLSLOT_OWNERSHIP_SAFE_APPROVALS_PATH,
    "ownership_safe_approvals",
  );
  if (
    packageEvidence.schemaVersion !== 1 ||
    packageEvidence.kind !== "solslot-safe-authority-operation" ||
    packageEvidence.network !== network.name ||
    packageEvidence.chainId !== Number((await ethers.provider.getNetwork()).chainId)
  ) {
    throw new Error("Safe authority operation does not match the active network");
  }
  if (
    deployment.schemaVersion !== 5 ||
    deployment.artifactHash !== packageEvidence.deploymentArtifactHash ||
    deployment.network !== packageEvidence.network ||
    deployment.chainId !== packageEvidence.chainId ||
    deployment.configuration.governanceRootSafe.toLowerCase() !==
      packageEvidence.rootSafe.toLowerCase() ||
    deployment.configuration.governanceTimelock.toLowerCase() !==
      packageEvidence.timelock.toLowerCase()
  ) {
    throw new Error("Safe authority operation does not match the immutable deployment");
  }
  const ownershipIntent = readEvidence(
    process.env.SOLSLOT_OWNERSHIP_ACTIVATION_INTENT_PATH,
    "ownership_activation_intent",
  );
  if (
    ownershipIntent.artifactHash !== packageEvidence.ownershipIntentArtifactHash ||
    ownershipIntent.deploymentArtifactHash !== deployment.artifactHash ||
    ownershipIntent.operationId !== packageEvidence.operationId
  ) {
    throw new Error("Safe authority operation does not match the ownership intent");
  }
  const governance = await validateGovernanceEvidence({
    path: process.env.SOLSLOT_GOVERNANCE_EVIDENCE_PATH,
    provider: ethers.provider,
    rootSafe: packageEvidence.rootSafe,
    timelock: packageEvidence.timelock,
  });
  if (
    governance.artifactHash !== packageEvidence.governanceArtifactHash ||
    governance.artifactHash !== deployment.governanceArtifactHash
  ) {
    throw new Error("Safe authority operation does not match governance evidence");
  }
  const expectedTransaction = packageEvidence.phase === "schedule"
    ? ownershipIntent.scheduleTransaction
    : ownershipIntent.executeTransaction;
  const operation = packageEvidence.authorityOperation;
  if (
    operation.transaction.to.toLowerCase() !== expectedTransaction.to.toLowerCase() ||
    operation.transaction.value !== expectedTransaction.value ||
    operation.transaction.data !== expectedTransaction.data ||
    operation.rootSafe.toLowerCase() !== packageEvidence.rootSafe.toLowerCase()
  ) {
    throw new Error("root Safe transaction does not match the ownership intent");
  }
  const expectedChildSafes = [
    governance.safes.ownerIdentity.address,
    governance.safes.coadmin.address,
  ].map((address) => address.toLowerCase()).sort();
  const observedChildSafes = operation.approvals
    .map(({ safe }) => safe.toLowerCase())
    .sort();
  if (JSON.stringify(observedChildSafes) !== JSON.stringify(expectedChildSafes)) {
    throw new Error("root Safe approval domains do not match governance evidence");
  }
  const verifiedApprovals = validateAuthorityApprovalEvidence(packageEvidence, approvals);
  const rootSafe = new ethers.Contract(
    packageEvidence.rootSafe,
    SAFE_EXEC_ABI,
    (await ethers.getSigners())[0],
  );
  const transactionArgs = safeTransactionArguments(operation.transaction);
  const [liveNonce, liveHash] = await Promise.all([
    rootSafe.nonce(),
    rootSafe.getTransactionHash(...transactionArgs),
  ]);
  if (
    liveNonce.toString() !== operation.transaction.nonce ||
    liveHash !== operation.transactionHash
  ) {
    throw new Error("root Safe nonce or transaction hash changed after administrator review");
  }
  const timelock = await ethers.getContractAt(
    "SolslotAlphaTimelock",
    packageEvidence.timelock,
  );
  const operationExists = await timelock.isOperation(packageEvidence.operationId);
  const operationDone = await timelock.isOperationDone(packageEvidence.operationId);
  if (packageEvidence.phase === "schedule" && operationExists) {
    throw new Error("ownership operation was already scheduled");
  }
  if (
    packageEvidence.phase === "execute" &&
    (!operationExists || operationDone || !(await timelock.isOperationReady(packageEvidence.operationId)))
  ) {
    throw new Error("ownership operation is not ready for execution");
  }

  const contractSignatures = encodeContractSignatures(
    verifiedApprovals.map(({ safe, signature }) => ({ owner: safe, signature })),
  );
  const executionArgs = [...transactionArgs.slice(0, 9), contractSignatures];
  if (!(await rootSafe.execTransaction.staticCall(...executionArgs))) {
    throw new Error("root Safe rejected the administrator approvals");
  }
  const transaction = await rootSafe.execTransaction(...executionArgs);
  const confirmationCount = Number(process.env.SOLSLOT_OMNICHAIN_CONFIRMATIONS || "12");
  if (!Number.isSafeInteger(confirmationCount) || confirmationCount < 12) {
    throw new Error("SOLSLOT_OMNICHAIN_CONFIRMATIONS must be at least 12");
  }
  const receipt = await transaction.wait(confirmationCount);
  if (!receipt || receipt.status !== 1) throw new Error("root Safe operation failed");

  let operationTimestamp = await timelock.getTimestamp(packageEvidence.operationId);
  if (packageEvidence.phase === "schedule") {
    if (!(await timelock.isOperation(packageEvidence.operationId)) || operationTimestamp === 0n) {
      throw new Error("timelock did not record the scheduled ownership operation");
    }
  } else {
    if (!(await timelock.isOperationDone(packageEvidence.operationId))) {
      throw new Error("timelock ownership operation did not complete");
    }
    const gateway = await ethers.getContractAt(
      "SolomonWarpGateway",
      deployment.contracts.gateway,
    );
    const spoke = await ethers.getContractAt(
      "OmnichainEscrowSpoke",
      deployment.contracts.spoke,
    );
    const [gatewayOwner, spokeOwner] = await Promise.all([gateway.owner(), spoke.owner()]);
    if (
      gatewayOwner.toLowerCase() !== packageEvidence.timelock.toLowerCase() ||
      spokeOwner.toLowerCase() !== packageEvidence.timelock.toLowerCase()
    ) {
      throw new Error("timelock did not become owner of both rail contracts");
    }
  }
  const executionEvidence = withArtifactHash({
    schemaVersion: 1,
    kind: "solslot-safe-authority-operation-execution",
    authorityOperationArtifactHash: packageEvidence.artifactHash,
    approvalArtifactHash: approvals.artifactHash,
    phase: packageEvidence.phase,
    network: network.name,
    chainId: packageEvidence.chainId,
    operationId: packageEvidence.operationId,
    rootSafe: packageEvidence.rootSafe,
    rootSafeTransactionHash: operation.transactionHash,
    administratorSigners: Object.fromEntries(
      verifiedApprovals.map(({ role, signer }) => [role, signer]),
    ),
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    confirmations: confirmationCount,
    operationTimestamp: operationTimestamp.toString(),
    executedAt: new Date().toISOString(),
  });
  const output = writeEvidence(
    process.env.SOLSLOT_OWNERSHIP_SAFE_EXECUTION_OUTPUT,
    executionEvidence,
    "SOLSLOT_OWNERSHIP_SAFE_EXECUTION_OUTPUT",
  );
  console.log(JSON.stringify({ ...executionEvidence, evidencePath: output }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

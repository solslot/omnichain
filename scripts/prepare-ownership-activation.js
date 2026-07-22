const { ethers, network } = require("hardhat");
const { readEvidence, withArtifactHash, writeEvidence } = require("./lib/deployment-evidence");

async function main() {
  const deployment = readEvidence(
    process.env.SOLSLOT_OMNICHAIN_DEPLOYMENT_EVIDENCE_PATH,
    "deployment",
  );
  if (deployment.schemaVersion !== 3 || deployment.network !== network.name) {
    throw new Error("deployment evidence does not match the active network");
  }
  const timelockAddress = deployment.configuration.governanceTimelock;
  const rootSafeAddress = deployment.configuration.governanceRootSafe;
  const timelock = await ethers.getContractAt("SolslotAlphaTimelock", timelockAddress);
  if (await timelock.getMinDelay() !== 86400n) throw new Error("timelock delay is not 24 hours");
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
    targets,
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

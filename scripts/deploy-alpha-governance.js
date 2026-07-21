const { ethers, network } = require("hardhat");
const { currentNetworkConfig, assertChain } = require("./lib/config");
const {
  requiredSourceSha,
  withArtifactHash,
  writeEvidence,
} = require("./lib/deployment-evidence");
const { readSafeOwnerRoster, safeSaltNonce } = require("./lib/governance-deployment");

const TIMELOCK_DELAY_SECONDS = 86_400n;
const CONFIRMATIONS = 12;

async function deployedCodeHash(address, label) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${label} has no runtime bytecode`);
  return ethers.keccak256(code);
}

async function main() {
  if (network.name !== "baseSepolia") throw new Error("Alpha governance may only deploy on Base Sepolia");
  const config = currentNetworkConfig();
  await assertChain(config);
  const sourceSha = requiredSourceSha();
  const { roster, owners } = readSafeOwnerRoster(process.env.SOLSLOT_SAFE_OWNER_ROSTER_PATH);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is required");

  const { default: Safe } = await import("@safe-global/protocol-kit");
  const protocolKit = await Safe.init({
    provider: process.env.BASE_SEPOLIA_RPC_URL,
    signer: process.env.DEPLOYER_PRIVATE_KEY,
    predictedSafe: {
      safeAccountConfig: { owners, threshold: 2 },
      safeDeploymentConfig: { saltNonce: safeSaltNonce(roster) },
    },
  });
  const safeAddress = ethers.getAddress(await protocolKit.getAddress());
  let safeDeploymentTransaction = null;
  if (await ethers.provider.getCode(safeAddress) === "0x") {
    const transaction = await protocolKit.createSafeDeploymentTransaction();
    const submitted = await deployer.sendTransaction({
      to: transaction.to,
      value: BigInt(transaction.value),
      data: transaction.data,
    });
    const receipt = await submitted.wait(CONFIRMATIONS);
    if (!receipt || receipt.status !== 1) throw new Error("Safe deployment failed");
    safeDeploymentTransaction = { hash: receipt.hash, blockNumber: receipt.blockNumber };
  }
  const connectedSafe = await protocolKit.connect({ safeAddress });
  const [observedOwners, observedThreshold] = await Promise.all([
    connectedSafe.getOwners(),
    connectedSafe.getThreshold(),
  ]);
  if (
    Number(observedThreshold) !== 2 ||
    observedOwners.length !== 3 ||
    observedOwners.map((owner) => owner.toLowerCase()).sort().join(",") !==
      owners.map((owner) => owner.toLowerCase()).sort().join(",")
  ) {
    throw new Error("deployed Safe configuration does not match the ceremony roster");
  }

  const timelock = await ethers.deployContract("SolslotAlphaTimelock", [
    TIMELOCK_DELAY_SECONDS,
    [safeAddress],
    [safeAddress],
  ]);
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  const timelockReceipt = await timelock.deploymentTransaction().wait(CONFIRMATIONS);
  if (!timelockReceipt || timelockReceipt.status !== 1) throw new Error("timelock deployment failed");

  const evidence = withArtifactHash({
    schemaVersion: 1,
    kind: "solslot-alpha-safe-timelock-deployment",
    sourceSha,
    network: network.name,
    chainId: config.chainId,
    rosterArtifactHash: roster.artifactHash,
    safe: { address: safeAddress, owners, threshold: 2 },
    timelock: {
      address: timelockAddress,
      minimumDelaySeconds: TIMELOCK_DELAY_SECONDS.toString(),
      proposer: safeAddress,
      executor: safeAddress,
      externalAdmin: ethers.ZeroAddress,
    },
    payoutAddress: safeAddress,
    deploymentTransactions: {
      safe: safeDeploymentTransaction,
      timelock: { hash: timelockReceipt.hash, blockNumber: timelockReceipt.blockNumber },
    },
    runtimeCodeHashes: {
      safe: await deployedCodeHash(safeAddress, "Safe"),
      timelock: await deployedCodeHash(timelockAddress, "timelock"),
    },
    createdAt: new Date().toISOString(),
  });
  const output = writeEvidence(
    process.env.SOLSLOT_GOVERNANCE_DEPLOYMENT_OUTPUT,
    evidence,
    "SOLSLOT_GOVERNANCE_DEPLOYMENT_OUTPUT",
  );
  console.log(JSON.stringify({ ...evidence, evidencePath: output }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

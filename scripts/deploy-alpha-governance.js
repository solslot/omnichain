const { ethers, network } = require("hardhat");
const { currentNetworkConfig, assertChain } = require("./lib/config");
const {
  requiredSourceSha,
  withArtifactHash,
  writeEvidence,
} = require("./lib/deployment-evidence");
const {
  readSafeOwnerRoster,
  recoveryConfiguration,
  safeSaltNonce,
} = require("./lib/governance-deployment");

const TIMELOCK_DELAY_SECONDS = 86_400n;
const RECOVERY_DELAY_SECONDS = 604_800n;
const CONFIRMATIONS = 12;
const SAFE_VERSION = "1.4.1";

async function deployedCodeHash(address, label) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${label} has no runtime bytecode`);
  return ethers.keccak256(code);
}

async function confirmedDeployment(contract, label) {
  await contract.waitForDeployment();
  const receipt = await contract.deploymentTransaction().wait(CONFIRMATIONS);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} deployment failed`);
  return { hash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function confirmedCall(transaction, label) {
  const receipt = await transaction.wait(CONFIRMATIONS);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
  return { hash: receipt.hash, blockNumber: receipt.blockNumber };
}

function sameOwners(observed, expected) {
  return observed.map((owner) => owner.toLowerCase()).sort().join(",") ===
    expected.map((owner) => owner.toLowerCase()).sort().join(",");
}

async function main() {
  if (network.name !== "baseSepolia") throw new Error("Alpha governance may only deploy on Base Sepolia");
  const config = currentNetworkConfig();
  await assertChain(config);
  const sourceSha = requiredSourceSha();
  const { roster, owner, coadmins } = readSafeOwnerRoster(process.env.SOLSLOT_SAFE_OWNER_ROSTER_PATH);
  const guardians = recoveryConfiguration(process.env, [owner, ...coadmins]);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is required");
  const deployerAddress = await deployer.getAddress();

  const protocol = await import("@safe-global/protocol-kit");
  const Safe = protocol.default;
  const safeProvider = new protocol.SafeProvider({
    provider: process.env.BASE_SEPOLIA_RPC_URL,
    signer: process.env.DEPLOYER_PRIVATE_KEY,
  });
  const [fallbackContract, signMessageContract] = await Promise.all([
    protocol.getCompatibilityFallbackHandlerContract({ safeProvider, safeVersion: SAFE_VERSION }),
    protocol.getSignMessageLibContract({ safeProvider, safeVersion: SAFE_VERSION }),
  ]);
  const fallbackHandler = ethers.getAddress(fallbackContract.getAddress());
  const signMessageLibrary = ethers.getAddress(signMessageContract.getAddress());

  const recovery = await ethers.deployContract("SolslotOwnerRecovery", [
    deployerAddress,
    guardians.secp256k1Guardian,
    coadmins[0],
    coadmins[1],
    guardians.blsGuardianCommitment,
  ]);
  const recoveryDeployment = await confirmedDeployment(recovery, "owner recovery");
  const recoveryAddress = await recovery.getAddress();
  if (await recovery.RECOVERY_DELAY_SECONDS() !== RECOVERY_DELAY_SECONDS) {
    throw new Error("owner recovery delay is not seven days");
  }

  async function deployGuard(label) {
    const guard = await ethers.deployContract("SolslotAuthorityGuard", [
      deployerAddress,
      signMessageLibrary,
    ]);
    const deployment = await confirmedDeployment(guard, `${label} authority guard`);
    return { contract: guard, address: await guard.getAddress(), deployment };
  }
  const ownerGuard = await deployGuard("owner identity");
  const coadminGuard = await deployGuard("coadmin");
  const rootGuard = await deployGuard("root");
  const ownerSetup = await ethers.deployContract("SolslotOwnerIdentitySetup");
  const ownerSetupDeployment = await confirmedDeployment(ownerSetup, "owner identity setup helper");
  const ownerSetupAddress = await ownerSetup.getAddress();
  const ownerSetupData = ownerSetup.interface.encodeFunctionData("configureOwner", [
    recoveryAddress,
    ownerGuard.address,
  ]);

  async function deploySafe(label, owners, threshold, extraConfig = {}) {
    const protocolKit = await Safe.init({
      provider: process.env.BASE_SEPOLIA_RPC_URL,
      signer: process.env.DEPLOYER_PRIVATE_KEY,
      predictedSafe: {
        safeAccountConfig: {
          owners,
          threshold,
          fallbackHandler,
          ...extraConfig,
        },
        safeDeploymentConfig: {
          safeVersion: SAFE_VERSION,
          saltNonce: safeSaltNonce(roster, label),
        },
      },
    });
    const address = ethers.getAddress(await protocolKit.getAddress());
    let deploymentTransaction = null;
    if (await ethers.provider.getCode(address) === "0x") {
      const transaction = await protocolKit.createSafeDeploymentTransaction();
      deploymentTransaction = await confirmedCall(await deployer.sendTransaction({
        to: transaction.to,
        value: BigInt(transaction.value),
        data: transaction.data,
      }), `${label} Safe deployment`);
    }
    const connected = await protocolKit.connect({ safeAddress: address });
    const [observedOwners, observedThreshold, observedFallback] = await Promise.all([
      connected.getOwners(), connected.getThreshold(), connected.getFallbackHandler(),
    ]);
    if (
      Number(observedThreshold) !== threshold ||
      !sameOwners(observedOwners, owners) ||
      ethers.getAddress(observedFallback) !== fallbackHandler
    ) {
      throw new Error(`${label} Safe configuration does not match the authority plan`);
    }
    return { address, connected, deploymentTransaction };
  }

  const ownerIdentitySafe = await deploySafe("owner_identity", [owner], 1, {
    to: ownerSetupAddress,
    data: ownerSetupData,
  });
  const [recoveryBinding, ownerGuardBinding] = await Promise.all([
    confirmedCall(await recovery.bindOwnerIdentitySafe(ownerIdentitySafe.address), "recovery Safe binding"),
    confirmedCall(await ownerGuard.contract.bindAuthoritySafe(ownerIdentitySafe.address), "owner guard Safe binding"),
  ]);
  if (
    !(await ownerIdentitySafe.connected.isModuleEnabled(recoveryAddress)) ||
    ethers.getAddress(await ownerIdentitySafe.connected.getGuard()) !== ownerGuard.address
  ) {
    throw new Error("Owner Identity Safe did not enable the immutable recovery controls");
  }

  const coadminSafe = await deploySafe("coadmin", coadmins, 1, {
    to: ownerSetupAddress,
    data: ownerSetup.interface.encodeFunctionData("configureStatic", [coadminGuard.address]),
  });
  const coadminGuardBinding = await confirmedCall(
    await coadminGuard.contract.bindAuthoritySafe(coadminSafe.address),
    "coadmin guard Safe binding",
  );
  if (ethers.getAddress(await coadminSafe.connected.getGuard()) !== coadminGuard.address) {
    throw new Error("Coadmin Safe did not enable its immutable authority guard");
  }
  const rootSafe = await deploySafe(
    "root",
    [ownerIdentitySafe.address, coadminSafe.address],
    2,
    {
      to: ownerSetupAddress,
      data: ownerSetup.interface.encodeFunctionData("configureStatic", [rootGuard.address]),
    },
  );
  const rootGuardBinding = await confirmedCall(
    await rootGuard.contract.bindAuthoritySafe(rootSafe.address),
    "root guard Safe binding",
  );
  if (ethers.getAddress(await rootSafe.connected.getGuard()) !== rootGuard.address) {
    throw new Error("Root Safe did not enable its immutable authority guard");
  }

  const timelock = await ethers.deployContract("SolslotAlphaTimelock", [
    TIMELOCK_DELAY_SECONDS,
    [rootSafe.address],
    [rootSafe.address],
  ]);
  const timelockDeployment = await confirmedDeployment(timelock, "timelock");
  const timelockAddress = await timelock.getAddress();

  const evidence = withArtifactHash({
    schemaVersion: 2,
    kind: "solslot-alpha-owner-required-governance-deployment",
    authorityRule: "slot0_and_one_of_slot1_slot2",
    sourceSha,
    network: network.name,
    chainId: config.chainId,
    rosterArtifactHash: roster.artifactHash,
    administrators: roster.owners,
    safes: {
      ownerIdentity: {
        address: ownerIdentitySafe.address,
        owners: [owner],
        threshold: 1,
        guard: ownerGuard.address,
      },
      coadmin: {
        address: coadminSafe.address,
        owners: coadmins,
        threshold: 1,
        guard: coadminGuard.address,
      },
      root: {
        address: rootSafe.address,
        owners: [ownerIdentitySafe.address, coadminSafe.address],
        threshold: 2,
        guard: rootGuard.address,
      },
    },
    timelock: {
      address: timelockAddress,
      minimumDelaySeconds: TIMELOCK_DELAY_SECONDS.toString(),
      proposer: rootSafe.address,
      executor: rootSafe.address,
      canceller: rootSafe.address,
      externalAdmin: ethers.ZeroAddress,
    },
    payoutAddress: rootSafe.address,
    recovery: {
      address: recoveryAddress,
      ownerGuard: ownerGuard.address,
      secp256k1Guardian: guardians.secp256k1Guardian,
      blsGuardianPubkey: guardians.blsGuardianPubkey,
      blsGuardianCommitment: guardians.blsGuardianCommitment,
      coadmins,
      delaySeconds: RECOVERY_DELAY_SECONDS.toString(),
      replacementAcceptanceRequired: true,
    },
    safeInfrastructure: {
      safeVersion: SAFE_VERSION,
      compatibilityFallbackHandler: fallbackHandler,
      signMessageLibrary,
      ownerSetup: ownerSetupAddress,
    },
    deploymentTransactions: {
      ownerRecovery: recoveryDeployment,
      ownerGuard: ownerGuard.deployment,
      coadminGuard: coadminGuard.deployment,
      rootGuard: rootGuard.deployment,
      ownerSetup: ownerSetupDeployment,
      ownerIdentitySafe: ownerIdentitySafe.deploymentTransaction,
      coadminSafe: coadminSafe.deploymentTransaction,
      rootSafe: rootSafe.deploymentTransaction,
      recoveryBinding,
      ownerGuardBinding,
      coadminGuardBinding,
      rootGuardBinding,
      timelock: timelockDeployment,
    },
    runtimeCodeHashes: {
      ownerIdentitySafe: await deployedCodeHash(ownerIdentitySafe.address, "Owner Identity Safe"),
      coadminSafe: await deployedCodeHash(coadminSafe.address, "Coadmin Safe"),
      rootSafe: await deployedCodeHash(rootSafe.address, "Root Safe"),
      timelock: await deployedCodeHash(timelockAddress, "timelock"),
      recovery: await deployedCodeHash(recoveryAddress, "owner recovery"),
      ownerGuard: await deployedCodeHash(ownerGuard.address, "owner guard"),
      coadminGuard: await deployedCodeHash(coadminGuard.address, "coadmin guard"),
      rootGuard: await deployedCodeHash(rootGuard.address, "root guard"),
      ownerSetup: await deployedCodeHash(ownerSetupAddress, "owner setup"),
      compatibilityFallbackHandler: await deployedCodeHash(fallbackHandler, "Safe fallback handler"),
      signMessageLibrary: await deployedCodeHash(signMessageLibrary, "Safe SignMessageLib"),
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

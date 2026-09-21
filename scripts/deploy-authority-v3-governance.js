const { ethers, network } = require("hardhat");
const { currentNetworkConfig, assertChain } = require("./lib/config");
const {
  requiredSourceSha,
  withArtifactHash,
  writeEvidence,
} = require("./lib/deployment-evidence");
const {
  readAuthorityV3Roster,
} = require("./lib/authority-v3-deployment");
const { safeSaltNonce } = require("./lib/governance-deployment");
const { authorityRpcUrl, verifyAuthorityNetwork } = require("./lib/authority-network");

const TIMELOCK_DELAY_SECONDS = 86_400n;
const ROUTINE_DELAY_SECONDS = 86_400n;
const LOST_KEY_DELAY_SECONDS = 604_800n;
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
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} deployment failed`);
  }
  return { hash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function confirmedCall(transaction, label) {
  const receipt = await transaction.wait(CONFIRMATIONS);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
  return { hash: receipt.hash, blockNumber: receipt.blockNumber };
}

function sameOwners(observed, expected) {
  return observed.map((owner) => owner.toLowerCase()).sort().join(",")
    === expected.map((owner) => owner.toLowerCase()).sort().join(",");
}

async function main() {
  const config = currentNetworkConfig();
  const providerUrl = authorityRpcUrl(network.name, config.chainId, process.env);
  await verifyAuthorityNetwork(ethers.provider, network.name, config.chainId);
  await assertChain(config);
  const sourceSha = requiredSourceSha();
  const authority = readAuthorityV3Roster(
    process.env.SOLSLOT_AUTHORITY_V3_ROSTER_PATH,
  );
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is required");
  const deployerAddress = await deployer.getAddress();

  const protocol = await import("@safe-global/protocol-kit");
  const Safe = protocol.default;
  const safeProvider = new protocol.SafeProvider({
    provider: providerUrl,
    signer: process.env.DEPLOYER_PRIVATE_KEY,
  });
  const [fallbackContract, signMessageContract] = await Promise.all([
    protocol.getCompatibilityFallbackHandlerContract({
      safeProvider,
      safeVersion: SAFE_VERSION,
    }),
    protocol.getSignMessageLibContract({
      safeProvider,
      safeVersion: SAFE_VERSION,
    }),
  ]);
  const fallbackHandler = ethers.getAddress(fallbackContract.getAddress());
  const signMessageLibrary = ethers.getAddress(signMessageContract.getAddress());

  const recovery = await ethers.deployContract("SolslotAdminRecoveryV3", [
    deployerAddress,
    authority.authorityLauncherId,
    authority.identityLauncherIds,
    "testnet11",
    authority.sourceManifestHash,
    authority.administrators.map(({ compressedPubkey }) =>
      ethers.keccak256(compressedPubkey)),
    authority.guardians,
    authority.recoveryBlsCommitments,
  ]);
  const recoveryDeployment = await confirmedDeployment(
    recovery,
    "Authority V3 recovery coordinator",
  );
  const recoveryAddress = await recovery.getAddress();
  if (
    await recovery.ROUTINE_DELAY_SECONDS() !== ROUTINE_DELAY_SECONDS
      || await recovery.LOST_KEY_DELAY_SECONDS() !== LOST_KEY_DELAY_SECONDS
  ) {
    throw new Error("Authority V3 recovery delays are not canonical");
  }

  async function deployGuard(label) {
    const guard = await ethers.deployContract("SolslotAuthorityGuardV3", [
      deployerAddress,
      signMessageLibrary,
      recoveryAddress,
    ]);
    const deployment = await confirmedDeployment(
      guard,
      `${label} Authority V3 guard`,
    );
    return { contract: guard, address: await guard.getAddress(), deployment };
  }

  const identityGuards = [];
  for (let slot = 0; slot < 3; slot += 1) {
    identityGuards.push(await deployGuard(`identity ${slot}`));
  }
  const coadminGuard = await deployGuard("coadmin");
  const rootGuard = await deployGuard("root");
  const identitySetup = await ethers.deployContract("SolslotOwnerIdentitySetup");
  const identitySetupDeployment = await confirmedDeployment(
    identitySetup,
    "Authority V3 identity setup helper",
  );
  const identitySetupAddress = await identitySetup.getAddress();

  async function deploySafe(label, owners, threshold, extraConfig) {
    const protocolKit = await Safe.init({
      provider: providerUrl,
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
          saltNonce: safeSaltNonce(authority.roster, label),
        },
      },
    });
    const address = ethers.getAddress(await protocolKit.getAddress());
    let deploymentTransaction = null;
    if (await ethers.provider.getCode(address) === "0x") {
      const transaction = await protocolKit.createSafeDeploymentTransaction();
      deploymentTransaction = await confirmedCall(
        await deployer.sendTransaction({
          to: transaction.to,
          value: BigInt(transaction.value),
          data: transaction.data,
        }),
        `${label} Safe deployment`,
      );
    }
    const connected = await protocolKit.connect({ safeAddress: address });
    const [observedOwners, observedThreshold, observedFallback] =
      await Promise.all([
        connected.getOwners(),
        connected.getThreshold(),
        connected.getFallbackHandler(),
      ]);
    if (
      Number(observedThreshold) !== threshold
        || !sameOwners(observedOwners, owners)
        || ethers.getAddress(observedFallback) !== fallbackHandler
    ) {
      throw new Error(`${label} Safe configuration differs from Authority V3`);
    }
    return { address, connected, deploymentTransaction };
  }

  const identitySafes = [];
  for (let slot = 0; slot < 3; slot += 1) {
    const setupData = identitySetup.interface.encodeFunctionData(
      "configureIdentity",
      [recoveryAddress, identityGuards[slot].address],
    );
    const safe = await deploySafe(
      `identity_${slot}`,
      [authority.owners[slot]],
      1,
      { to: identitySetupAddress, data: setupData },
    );
    if (
      !(await safe.connected.isModuleEnabled(recoveryAddress))
        || ethers.getAddress(await safe.connected.getGuard())
          !== identityGuards[slot].address
    ) {
      throw new Error(`Identity Safe ${slot} recovery controls are incomplete`);
    }
    identitySafes.push(safe);
  }

  const coadminSafe = await deploySafe(
    "coadmin",
    [identitySafes[1].address, identitySafes[2].address],
    1,
    {
      to: identitySetupAddress,
      data: identitySetup.interface.encodeFunctionData(
        "configureStatic",
        [coadminGuard.address],
      ),
    },
  );
  const rootSafe = await deploySafe(
    "root",
    [identitySafes[0].address, coadminSafe.address],
    2,
    {
      to: identitySetupAddress,
      data: identitySetup.interface.encodeFunctionData(
        "configureStatic",
        [rootGuard.address],
      ),
    },
  );

  const topologyBinding = await confirmedCall(
    await recovery.bindAuthorityTopology(
      identitySafes.map(({ address }) => address),
      coadminSafe.address,
      rootSafe.address,
    ),
    "Authority V3 Safe topology binding",
  );
  const guardBindings = [];
  for (let slot = 0; slot < 3; slot += 1) {
    guardBindings.push(await confirmedCall(
      await identityGuards[slot].contract.bindAuthoritySafe(
        identitySafes[slot].address,
      ),
      `Identity Safe ${slot} guard binding`,
    ));
  }
  guardBindings.push(await confirmedCall(
    await coadminGuard.contract.bindAuthoritySafe(coadminSafe.address),
    "Coadmin Safe guard binding",
  ));
  guardBindings.push(await confirmedCall(
    await rootGuard.contract.bindAuthoritySafe(rootSafe.address),
    "Root Safe guard binding",
  ));

  const timelock = await ethers.deployContract("SolslotAlphaTimelock", [
    TIMELOCK_DELAY_SECONDS,
    [rootSafe.address],
    [rootSafe.address],
  ]);
  const timelockDeployment = await confirmedDeployment(
    timelock,
    "Authority V3 timelock",
  );
  const timelockAddress = await timelock.getAddress();

  const evidence = withArtifactHash({
    schemaVersion: 3,
    kind: "solslot-alpha-authority-v3-governance-deployment",
    authorityRule: "slot0_and_one_of_slot1_slot2",
    sourceSha,
    network: network.name,
    chainId: config.chainId,
    rosterArtifactHash: authority.roster.artifactHash,
    chiaAuthority: {
      network: "testnet11",
      sourceManifestHash: authority.sourceManifestHash,
      authorityLauncherId: authority.authorityLauncherId,
      identityLauncherIds: authority.identityLauncherIds,
    },
    administrators: authority.administrators.map((administrator) => ({
      slot: administrator.slot,
      address: administrator.address,
      compressedPubkey: administrator.compressedPubkey,
    })),
    safes: {
      identities: identitySafes.map((safe, slot) => ({
        slot,
        address: safe.address,
        owners: [authority.owners[slot]],
        threshold: 1,
        guard: identityGuards[slot].address,
        recoveryModule: recoveryAddress,
      })),
      coadmin: {
        address: coadminSafe.address,
        owners: [identitySafes[1].address, identitySafes[2].address],
        threshold: 1,
        guard: coadminGuard.address,
      },
      root: {
        address: rootSafe.address,
        owners: [identitySafes[0].address, coadminSafe.address],
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
      routineDelaySeconds: ROUTINE_DELAY_SECONDS.toString(),
      lostKeyDelaySeconds: LOST_KEY_DELAY_SECONDS.toString(),
      replacementAcceptanceRequired: true,
      globalFreezeRequired: true,
      crossChainConvergenceRequired: true,
      recoveryKitRotationSupported: true,
      rollbackRequiresChiaCancellationReceipt: true,
      identities: authority.administrators.map(({ slot, recovery: kit }) => ({
        slot,
        evmGuardian: kit.evmGuardian,
        blsPubkey: kit.blsPubkey,
        blsCommitment: kit.blsCommitment,
        revision: kit.revision,
        drillVerifiedAt: kit.drillVerifiedAt,
      })),
    },
    safeInfrastructure: {
      safeVersion: SAFE_VERSION,
      compatibilityFallbackHandler: fallbackHandler,
      signMessageLibrary,
      identitySetup: identitySetupAddress,
    },
    deploymentTransactions: {
      recovery: recoveryDeployment,
      identityGuards: identityGuards.map(({ deployment }) => deployment),
      coadminGuard: coadminGuard.deployment,
      rootGuard: rootGuard.deployment,
      identitySetup: identitySetupDeployment,
      identitySafes: identitySafes.map(
        ({ deploymentTransaction }) => deploymentTransaction,
      ),
      coadminSafe: coadminSafe.deploymentTransaction,
      rootSafe: rootSafe.deploymentTransaction,
      topologyBinding,
      guardBindings,
      timelock: timelockDeployment,
    },
    runtimeCodeHashes: {
      identitySafe0: await deployedCodeHash(
        identitySafes[0].address,
        "Identity Safe 0",
      ),
      identitySafe1: await deployedCodeHash(
        identitySafes[1].address,
        "Identity Safe 1",
      ),
      identitySafe2: await deployedCodeHash(
        identitySafes[2].address,
        "Identity Safe 2",
      ),
      coadminSafe: await deployedCodeHash(coadminSafe.address, "Coadmin Safe"),
      rootSafe: await deployedCodeHash(rootSafe.address, "Root Safe"),
      timelock: await deployedCodeHash(timelockAddress, "timelock"),
      recovery: await deployedCodeHash(recoveryAddress, "recovery coordinator"),
      identityGuard0: await deployedCodeHash(
        identityGuards[0].address,
        "Identity guard 0",
      ),
      identityGuard1: await deployedCodeHash(
        identityGuards[1].address,
        "Identity guard 1",
      ),
      identityGuard2: await deployedCodeHash(
        identityGuards[2].address,
        "Identity guard 2",
      ),
      coadminGuard: await deployedCodeHash(coadminGuard.address, "coadmin guard"),
      rootGuard: await deployedCodeHash(rootGuard.address, "root guard"),
      identitySetup: await deployedCodeHash(
        identitySetupAddress,
        "identity setup",
      ),
      compatibilityFallbackHandler: await deployedCodeHash(
        fallbackHandler,
        "Safe fallback handler",
      ),
      signMessageLibrary: await deployedCodeHash(
        signMessageLibrary,
        "Safe SignMessageLib",
      ),
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

const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const { withArtifactHash, writeEvidence } = require("../scripts/lib/deployment-evidence");
const {
  ADMIN_SLOT,
  IMPLEMENTATION_SLOT,
  PORTAL_CHAIN,
  WARP_BUILD_INFO_SHA256,
  WARP_PACKAGE_LOCK_SHA256,
  WARP_PORTAL_ARTIFACT_SHA256,
  WARP_PORTAL_SOURCE_SHA256,
  WARP_PROXY_ADMIN_ARTIFACT_SHA256,
  WARP_PROXY_ARTIFACT_SHA256,
  WARP_SOURCE_SHA,
  WARP_SOURCE_TREE,
  portalNetworkProfile,
  portalDeploymentSettings,
  readWarpValidatorRoster,
  validateWarpPortalEvidence,
} = require("../scripts/lib/warp-portal-deployment");

function temporaryEvidence(prefix, record) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(directory, "evidence.json");
  writeEvidence(file, record);
  return file;
}

function validatorRoster(addresses, chainId = 84532) {
  const domain = portalNetworkProfile(chainId).identityDomain;
  return withArtifactHash({
    schemaVersion: 2,
    kind: "solslot-samuel-validator-roster",
    domain,
    threshold: 2,
    validators: addresses.map((evmAddress, index) => ({
      schemaVersion: 2,
      kind: "solslot-samuel-validator-public-identity",
      validatorId: `validator-${index + 1}`,
      domain,
      blsPublicKey: `0x${String(index + 1).padStart(2, "0").repeat(48)}`,
      evmAddress,
      proof: {},
    })),
  });
}

async function deploymentTransaction(contract) {
  const transaction = contract.deploymentTransaction();
  const receipt = await transaction.wait();
  return {
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    from: transaction.from,
    dataHash: ethers.keccak256(transaction.data),
  };
}

async function codeHash(address) {
  return ethers.keccak256(await ethers.provider.getCode(address));
}

// Exercise local mock contracts with an explicit RPC chain response; no public-chain calls.
function providerOnChain(chainId) {
  return new Proxy(ethers.provider, {
    get(target, property) {
      if (property === "getNetwork") return async () => ({ chainId: BigInt(chainId) });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("pinned Base bridge portal deployment", function () {
  it("selects the matching Safe RPC and requires explicit Base mainnet test scope", function () {
    const environment = {
      SOLSLOT_WARP_TESTNET_DEPLOYMENT: "true",
      SOLSLOT_CHIA_NETWORK: "testnet11",
      SOLSLOT_BRIDGE_TEST_ONLY: "true",
      BASE_MAINNET_RPC_URL: "https://base.example.invalid",
      BASE_SEPOLIA_RPC_URL: "https://sepolia.example.invalid",
    };
    expect(portalDeploymentSettings(environment, "baseMainnet", 8453).rpcUrl)
      .to.equal(environment.BASE_MAINNET_RPC_URL);
    expect(portalDeploymentSettings(environment, "baseSepolia", 84532).rpcUrl)
      .to.equal(environment.BASE_SEPOLIA_RPC_URL);
    for (const change of [
      { SOLSLOT_CHIA_NETWORK: "mainnet" },
      { SOLSLOT_CHIA_NETWORK: undefined },
      { SOLSLOT_BRIDGE_TEST_ONLY: "false" },
      { SOLSLOT_BRIDGE_TEST_ONLY: true },
    ]) {
      expect(() => portalDeploymentSettings({ ...environment, ...change }, "baseMainnet", 8453))
        .to.throw("explicit Testnet11 and test-only assets");
    }
    expect(() => portalDeploymentSettings({ ...environment, BASE_MAINNET_RPC_URL: undefined }, "baseMainnet", 8453))
      .to.throw("BASE_MAINNET_RPC_URL is required");
    expect(() => portalDeploymentSettings(environment, "baseSepolia", 8453))
      .to.throw("selected Base network");
    expect(() => portalDeploymentSettings({ ...environment, SOLSLOT_WARP_TESTNET_DEPLOYMENT: "false" }, "baseMainnet", 8453))
      .to.throw("explicit test deployment");
    for (const chain of [1, 11155111, "8453", undefined, null]) {
      if (chain === undefined) continue; // An omitted reader chain retains the historical Sepolia default.
      expect(() => portalNetworkProfile(chain)).to.throw("Unsupported");
    }
  });

  it("requires the exact hash-sealed 2-of-3 Samuel validator roster", async function () {
    const signers = await ethers.getSigners();
    const addresses = signers.slice(0, 3).map((signer) => signer.address);
    const roster = validatorRoster(addresses);
    const file = temporaryEvidence("warp-roster-", roster);
    expect(readWarpValidatorRoster(file, roster.artifactHash).addresses)
      .to.deep.equal(addresses);
    expect(() => readWarpValidatorRoster(file, `0x${"ff".repeat(32)}`))
      .to.throw("not explicitly pinned");

    const duplicate = validatorRoster([addresses[0], addresses[0], addresses[2]]);
    expect(() => readWarpValidatorRoster(
      temporaryEvidence("warp-roster-duplicate-", duplicate),
      duplicate.artifactHash,
    )).to.throw("must be unique");
  });

  it("rejects a mixed or wrong network roster even when its outer hash is valid", async function () {
    const signers = await ethers.getSigners();
    const addresses = signers.slice(0, 3).map((signer) => signer.address);
    const roster = validatorRoster(addresses, 8453);
    const file = temporaryEvidence("base-roster-", roster);
    expect(readWarpValidatorRoster(file, roster.artifactHash, 8453).addresses).to.deep.equal(addresses);
    expect(() => readWarpValidatorRoster(file, roster.artifactHash))
      .to.throw("not explicitly pinned");
    const legacy = validatorRoster(addresses);
    expect(() => readWarpValidatorRoster(temporaryEvidence("legacy-roster-", legacy), legacy.artifactHash, 8453))
      .to.throw("not explicitly pinned");
    const { artifactHash, ...body } = roster;
    const mixed = structuredClone(body);
    mixed.validators[1].domain = portalNetworkProfile(84532).identityDomain;
    const mixedRecord = withArtifactHash(mixed);
    expect(() => readWarpValidatorRoster(temporaryEvidence("mixed-roster-", mixedRecord), mixedRecord.artifactHash, 8453))
      .to.throw("identity is malformed");
    const duplicate = structuredClone(body);
    duplicate.validators[1].blsPublicKey = duplicate.validators[0].blsPublicKey;
    const duplicateRecord = withArtifactHash(duplicate);
    expect(() => readWarpValidatorRoster(temporaryEvidence("duplicate-bls-", duplicateRecord), duplicateRecord.artifactHash, 8453))
      .to.throw("BLS keys must be unique");
  });

  for (const chainId of [84532, 8453]) {
  it(`rechecks the Safe, signer set, proxy slots, bytecode, and creations for chain ${chainId}`, async function () {
    const profile = portalNetworkProfile(chainId);
    const signers = await ethers.getSigners();
    const owners = signers.slice(1, 4).map((signer) => signer.address);
    const safe = await ethers.deployContract("MockSafe", [owners, 2]);
    const implementation = await ethers.deployContract("MockOwnable2Step");
    const portal = await ethers.deployContract("MockWarpPortal");
    await portal.configureAuthority(safe.target, owners, 2, PORTAL_CHAIN);
    await portal.setMessageToll(0);
    const proxyAdmin = await ethers.deployContract("MockOwnable2Step");
    await proxyAdmin.transferOwnership(safe.target);
    await safe.execute(
      proxyAdmin.target,
      proxyAdmin.interface.encodeFunctionData("acceptOwnership"),
    );
    await network.provider.send("hardhat_setStorageAt", [
      portal.target,
      ADMIN_SLOT,
      ethers.zeroPadValue(proxyAdmin.target, 32),
    ]);
    await network.provider.send("hardhat_setStorageAt", [
      portal.target,
      IMPLEMENTATION_SLOT,
      ethers.zeroPadValue(implementation.target, 32),
    ]);
    const implementationDeployment = await deploymentTransaction(implementation);
    const proxyDeployment = await deploymentTransaction(portal);
    await network.provider.send("hardhat_mine", ["0xc"]);

    const roster = validatorRoster(owners, chainId);
    const evidence = withArtifactHash({
      schemaVersion: profile.schemaVersion,
      kind: profile.kind,
      sourceSha: "a".repeat(40),
      network: profile.network,
      chainId,
      ...(chainId === 8453 ? {
        chiaNetwork: "testnet11",
        testOnly: true,
        validatorIdentityDomain: profile.identityDomain,
      } : {}),
      confirmations: 12,
      validatorRosterArtifactHash: roster.artifactHash,
      warpSource: {
        repository: "https://github.com/warpdotgreen/cli.git",
        commit: WARP_SOURCE_SHA,
        tree: WARP_SOURCE_TREE,
        packageLockSha256: `0x${WARP_PACKAGE_LOCK_SHA256}`,
        portalSourceSha256: `0x${WARP_PORTAL_SOURCE_SHA256}`,
        buildInfoSha256: `0x${WARP_BUILD_INFO_SHA256}`,
        compiler: "0.8.23+commit.f704f362",
        optimizerRuns: 200,
        evmVersion: "paris",
      },
      artifacts: {
        portal: `0x${WARP_PORTAL_ARTIFACT_SHA256}`,
        transparentProxy: `0x${WARP_PROXY_ARTIFACT_SHA256}`,
        proxyAdmin: `0x${WARP_PROXY_ADMIN_ARTIFACT_SHA256}`,
      },
      deployer: signers[0].address,
      safe: {
        address: safe.target,
        owners,
        threshold: 2,
        version: "1.4.1",
        fallbackHandler: ethers.ZeroAddress,
      },
      portal: {
        address: portal.target,
        owner: safe.target,
        signers: owners,
        signatureThreshold: 2,
        messageTollWei: "0",
        supportedChains: [PORTAL_CHAIN],
        initializedAtomically: true,
      },
      proxy: {
        implementation: implementation.target,
        admin: proxyAdmin.target,
        adminOwner: safe.target,
        standard: "openzeppelin-transparent-proxy-5.0.2",
      },
      deploymentTransactions: {
        validatorSafe: null,
        portalImplementation: implementationDeployment,
        portalProxy: proxyDeployment,
      },
      runtimeCodeHashes: {
        safe: await codeHash(safe.target),
        portal: await codeHash(portal.target),
        implementation: await codeHash(implementation.target),
        proxyAdmin: await codeHash(proxyAdmin.target),
      },
      artifactRuntimeCodeHashes: {
        portal: await codeHash(implementation.target),
        transparentProxyTemplate: `0x${"12".repeat(32)}`,
        proxyAdmin: `0x${"13".repeat(32)}`,
      },
      createdAt: new Date().toISOString(),
    });
    const file = temporaryEvidence("warp-portal-", evidence);
    const input = {
      path: file,
      provider: providerOnChain(chainId),
      expectedChainId: chainId,
      expectedPortal: portal.target,
      expectedOmnichainSourceSha: "a".repeat(40),
      expectedRosterArtifactHash: roster.artifactHash,
      expectedValidatorAddresses: owners,
      minimumConfirmations: 12,
    };
    expect((await validateWarpPortalEvidence(input)).artifactHash)
      .to.equal(evidence.artifactHash);

    await expect(validateWarpPortalEvidence({ ...input, provider: providerOnChain(1) }))
      .to.be.rejectedWith("RPC chain differs");
    await expect(validateWarpPortalEvidence({ ...input, expectedChainId: chainId === 8453 ? 84532 : 8453 }))
      .to.be.rejectedWith("evidence is unsupported");
    if (chainId === 8453) {
      const { artifactHash, ...body } = evidence;
      for (const change of [
        { testOnly: false }, { testOnly: "true" },
        { chiaNetwork: "mainnet" }, { chiaNetwork: undefined },
        { validatorIdentityDomain: portalNetworkProfile(84532).identityDomain },
        { schemaVersion: 1 }, { network: "baseSepolia" },
      ]) {
        const changed = JSON.parse(JSON.stringify({ ...body, ...change }));
        const invalid = withArtifactHash(changed);
        await expect(validateWarpPortalEvidence({ ...input, path: temporaryEvidence("wrong-base-scope-", invalid) }))
          .to.be.rejectedWith("evidence is unsupported");
      }
    }

    await network.provider.send("hardhat_setStorageAt", [
      portal.target,
      ADMIN_SLOT,
      ethers.zeroPadValue(signers[8].address, 32),
    ]);
    await expect(validateWarpPortalEvidence(input))
      .to.be.rejectedWith("proxy slots do not match");
  });
  }

  it("rejects an authority record that substitutes one validator", async function () {
    const signers = await ethers.getSigners();
    const owners = signers.slice(0, 3).map((signer) => signer.address);
    const evidence = withArtifactHash({
      schemaVersion: 1,
      kind: "solslot-warp-base-sepolia-portal-deployment",
      sourceSha: "a".repeat(40),
      network: "baseSepolia",
      chainId: 84532,
      confirmations: 12,
      validatorRosterArtifactHash: `0x${"11".repeat(32)}`,
      warpSource: {
        commit: WARP_SOURCE_SHA,
        tree: WARP_SOURCE_TREE,
        packageLockSha256: `0x${WARP_PACKAGE_LOCK_SHA256}`,
        portalSourceSha256: `0x${WARP_PORTAL_SOURCE_SHA256}`,
        buildInfoSha256: `0x${WARP_BUILD_INFO_SHA256}`,
      },
      artifacts: {
        portal: `0x${WARP_PORTAL_ARTIFACT_SHA256}`,
        transparentProxy: `0x${WARP_PROXY_ARTIFACT_SHA256}`,
        proxyAdmin: `0x${WARP_PROXY_ADMIN_ARTIFACT_SHA256}`,
      },
      safe: {
        address: signers[4].address,
        owners,
        threshold: 2,
        version: "1.4.1",
      },
      portal: {
        address: signers[5].address,
        owner: signers[4].address,
        signers: owners,
        signatureThreshold: 2,
        messageTollWei: "0",
        supportedChains: [PORTAL_CHAIN],
      },
      proxy: {
        implementation: signers[6].address,
        admin: signers[7].address,
        adminOwner: signers[4].address,
      },
    });
    await expect(validateWarpPortalEvidence({
      path: temporaryEvidence("warp-substitution-", evidence),
      provider: providerOnChain(84532),
      expectedPortal: signers[5].address,
      expectedOmnichainSourceSha: "a".repeat(40),
      expectedRosterArtifactHash: evidence.validatorRosterArtifactHash,
      expectedValidatorAddresses: [owners[0], owners[1], signers[9].address],
    })).to.be.rejectedWith("frozen validator authority");
  });
});

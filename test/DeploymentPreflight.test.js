const { expect } = require("chai");
const { ethers } = require("ethers");

const {
  deploymentSettings,
  inspectDeploymentReadiness,
  validatePreflightEvidence,
} = require("../scripts/lib/deployment-preflight");
const { withArtifactHash, writeEvidence } = require("../scripts/lib/deployment-evidence");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function address(byte) {
  return `0x${byte.repeat(20)}`;
}

function configuration() {
  return {
    chainId: 84532,
    selector: "10344971235874465080",
    router: address("11"),
    hub: "base",
    stablecoins: { usdc: null },
  };
}

function networks() {
  return {
    baseSepolia: { selector: "10344971235874465080" },
  };
}

function environment(overrides = {}) {
  return {
    PAYOUT_ADDRESS: address("12"),
    ROOT_SAFE_ADDRESS: address("12"),
    USDC_ADDRESS: address("13"),
    GOVERNANCE_ADDRESS: address("15"),
    CCIP_CALLBACK_GAS: "500000",
    EMERGENCY_REFUND_DELAY_SECONDS: "604800",
    SOLSLOT_OMNICHAIN_CONFIRMATIONS: "12",
    DEPLOY_GATEWAY: "true",
    WARP_PORTAL_ADDRESS: address("16"),
    WARP_CHIA_CHAIN: "0x010203",
    SAMUEL_BRIDGING_PUZZLE: `0x${"17".repeat(32)}`,
    SAMUEL_RETURN_PUZZLE: `0x${"18".repeat(32)}`,
    VOUCHER_RESULT_AUTHORIZATION_MOD_HASH: `0x${"19".repeat(32)}`,
    VOUCHER_BURN_INNER_HASH: `0x${"1a".repeat(32)}`,
    SOLSLOT_PROTOCOL_SOURCE_SHA: "a".repeat(40),
    SOLSLOT_SAMUEL_SOURCE_SHA: "b".repeat(40),
    MAX_WARP_TOLL_WEI: "1",
    MAX_CCIP_FEE_WEI: "1",
    ...overrides,
  };
}

function provider(overrides = {}) {
  const decimals = new ethers.Interface(["function decimals() view returns (uint8)"]);
  return {
    getNetwork: async () => ({ chainId: 84532n }),
    getCode: async () => "0x6001600055",
    call: async () => decimals.encodeFunctionResult("decimals", [6]),
    getBalance: async () => 1_000_000_000_000_000_000n,
    getTransactionCount: async () => 7,
    ...overrides,
  };
}

function preflightRecord(settings, inspection, overrides = {}) {
  return withArtifactHash({
    schemaVersion: 4,
    kind: "solslot-omnichain-testnet-deployment-preflight",
    sourceSha: "a".repeat(40),
    network: "baseSepolia",
    chainId: 84532,
    chainSelector: "10344971235874465080",
    hubName: "baseSepolia",
    hubChainSelector: "10344971235874465080",
    deploymentMode: "new_gateway_and_spoke",
    settings: {
      ccipRouter: configuration().router,
      payout: settings.payout,
      governance: settings.governance,
      rootSafe: settings.rootSafe,
      usdc: settings.usdc,
      warpPortal: settings.gatewaySettings.warpPortal,
      predictedGatewayAddress: inspection.predictedGatewayAddress,
      callbackGas: settings.callbackGas.toString(),
      emergencyDelay: settings.emergencyDelay.toString(),
      confirmations: settings.confirmations,
      protocolSourceSha: settings.gatewaySettings.protocolSourceSha,
      samuelSourceSha: settings.gatewaySettings.samuelSourceSha,
      voucherResultAuthorizationMod:
        settings.gatewaySettings.voucherResultAuthorizationMod,
      voucherBurnInner: settings.gatewaySettings.voucherBurnInner,
    },
    inspection,
    checkedAt: new Date().toISOString(),
    ...overrides,
  });
}

describe("testnet deployment preflight", function () {
  it("requires all future constructor inputs before deploying a new gateway and spoke", async function () {
    const settings = deploymentSettings(
      environment(),
      configuration(),
      "baseSepolia",
      networks(),
    );
    const inspected = await inspectDeploymentReadiness({
      provider: provider(),
      config: configuration(),
      settings,
      deployer: address("19"),
      minimumDeployerBalanceWei: 1n,
    });

    expect(inspected).to.deep.include({
      chainId: 84532,
      deployer: ethers.getAddress(address("19")),
      deployerBalanceWei: "1000000000000000000",
      minimumDeployerBalanceWei: "1",
    });
    expect(inspected.tokenDecimals).to.deep.equal({ usdc: 6 });
    expect(inspected.deployerNonce).to.equal(7);
    expect(inspected.predictedGatewayAddress).to.equal(
      ethers.getCreateAddress({ from: address("19"), nonce: 7 }),
    );
    expect(settings.hubChainSelector).to.equal(10344971235874465080n);
  });

  it("rejects a missing fee cap before any deployment transaction", function () {
    expect(() => deploymentSettings(
      environment({ MAX_CCIP_FEE_WEI: "0" }),
      configuration(),
      "baseSepolia",
      networks(),
    )).to.throw("MAX_CCIP_FEE_WEI must be at least 1");
  });

  it("requires the payout Safe and timelock to be distinct", function () {
    expect(() => deploymentSettings(
      environment({ ROOT_SAFE_ADDRESS: address("14") }),
      configuration(),
      "baseSepolia",
      networks(),
    )).to.throw("PAYOUT_ADDRESS must equal ROOT_SAFE_ADDRESS");
    expect(() => deploymentSettings(
      environment({ GOVERNANCE_ADDRESS: address("12") }),
      configuration(),
      "baseSepolia",
      networks(),
    )).to.throw("must be the timelock");
  });

  it("rejects incorrect stablecoin decimals and undeployed governance", async function () {
    const settings = deploymentSettings(
      environment(),
      configuration(),
      "baseSepolia",
      networks(),
    );
    const decimals = new ethers.Interface(["function decimals() view returns (uint8)"]);
    await expect(inspectDeploymentReadiness({
      provider: provider({
        call: async () => decimals.encodeFunctionResult("decimals", [18]),
      }),
      config: configuration(),
      settings,
      deployer: address("19"),
    })).to.be.rejectedWith("exactly six decimals");

    await expect(inspectDeploymentReadiness({
      provider: provider({
        getCode: async (value) => value.toLowerCase() === address("15") ? "0x" : "0x6001600055",
      }),
      config: configuration(),
      settings,
      deployer: address("19"),
    })).to.be.rejectedWith("governance has no runtime bytecode");
  });

  it("requires a fresh immutable preflight receipt with unchanged runtime code", async function () {
    const settings = deploymentSettings(
      environment(),
      configuration(),
      "baseSepolia",
      networks(),
    );
    const inspection = await inspectDeploymentReadiness({
      provider: provider(),
      config: configuration(),
      settings,
      deployer: address("19"),
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-preflight-"));
    const evidencePath = path.join(directory, "preflight.json");
    writeEvidence(evidencePath, preflightRecord(settings, inspection));
    const input = {
      evidencePath,
      sourceSha: "a".repeat(40),
      networkName: "baseSepolia",
      config: configuration(),
      settings,
      inspection,
    };

    expect(validatePreflightEvidence(input).artifactHash).to.match(/^0x[0-9a-f]{64}$/);

    const stale = path.join(directory, "stale.json");
    writeEvidence(stale, preflightRecord(settings, inspection, {
      checkedAt: "2020-01-01T00:00:00.000Z",
    }));
    expect(() => validatePreflightEvidence({ ...input, evidencePath: stale }))
      .to.throw("stale");

    const changedNonce = {
      ...inspection,
      deployerNonce: inspection.deployerNonce + 1,
      predictedGatewayAddress: ethers.getCreateAddress({
        from: inspection.deployer,
        nonce: inspection.deployerNonce + 1,
      }),
    };
    expect(() => validatePreflightEvidence({ ...input, inspection: changedNonce }))
      .to.throw("predicted gateway has changed");

    const changedInspection = {
      ...inspection,
      runtimeCodeHashes: { ...inspection.runtimeCodeHashes },
    };
    changedInspection.runtimeCodeHashes[ethers.getAddress(settings.usdc)] = `0x${"99".repeat(32)}`;
    expect(() => validatePreflightEvidence({ ...input, inspection: changedInspection }))
      .to.throw("usdc runtime code has changed");
  });
});

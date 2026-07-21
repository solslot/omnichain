const { expect } = require("chai");
const { ethers } = require("ethers");

const {
  deploymentSettings,
  inspectDeploymentReadiness,
} = require("../scripts/lib/deployment-preflight");

function address(byte) {
  return `0x${byte.repeat(20)}`;
}

function configuration() {
  return {
    chainId: 84532,
    selector: "10344971235874465080",
    router: address("11"),
    hub: "base",
    stablecoins: { usdc: null, usdt: null },
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
    USDC_ADDRESS: address("13"),
    USDT_ADDRESS: address("14"),
    GOVERNANCE_ADDRESS: address("15"),
    CCIP_CALLBACK_GAS: "500000",
    EMERGENCY_REFUND_DELAY_SECONDS: "604800",
    SOLSLOT_OMNICHAIN_CONFIRMATIONS: "12",
    DEPLOY_GATEWAY: "true",
    WARP_PORTAL_ADDRESS: address("16"),
    WARP_CHIA_CHAIN: "0x010203",
    SAMUEL_BRIDGING_PUZZLE: `0x${"17".repeat(32)}`,
    SAMUEL_RETURN_PUZZLE: `0x${"18".repeat(32)}`,
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
    ...overrides,
  };
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
    expect(inspected.tokenDecimals).to.deep.equal({ usdc: 6, usdt: 6 });
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
});

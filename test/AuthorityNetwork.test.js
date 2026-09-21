const { expect } = require("chai");
const {
  authorityNetwork, authorityRpcUrl, verifyAuthorityNetwork,
} = require("../scripts/lib/authority-network");

describe("Authority V3 EVM network selection", function () {
  it("selects the matching RPC separately for Base mainnet and Sepolia", async function () {
    const environment = {
      BASE_MAINNET_RPC_URL: "https://mainnet.base.org",
      BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org",
    };
    for (const [name, chainId, expectedUrl] of [
      ["baseMainnet", 8453, environment.BASE_MAINNET_RPC_URL],
      ["baseSepolia", 84532, environment.BASE_SEPOLIA_RPC_URL],
    ]) {
      expect(authorityRpcUrl(name, chainId, environment)).to.equal(expectedUrl);
      expect(await verifyAuthorityNetwork({
        getNetwork: async () => ({ chainId: BigInt(chainId) }),
      }, name, chainId)).to.equal(authorityNetwork(name, chainId));
    }
  });

  it("rejects crossed, coerced, prototype and unsupported network identities", function () {
    for (const [name, chainId] of [
      ["baseMainnet", 84532], ["baseSepolia", 8453], ["baseMainnet", "8453"],
      ["ethereumMainnet", 1], ["hardhat", 31337], ["toString", 8453],
      ["baseMainnet", true], ["base", 8453], [["baseMainnet"], 8453], [null, 8453],
    ]) expect(() => authorityNetwork(name, chainId)).to.throw("network and chain ID");
  });

  it("rejects a wrong RPC network and never falls back to the other RPC", async function () {
    await expect(verifyAuthorityNetwork({
      getNetwork: async () => ({ chainId: 84532n }),
    }, "baseMainnet", 8453)).to.be.rejectedWith("RPC chain differs");
    expect(() => authorityRpcUrl("baseMainnet", 8453, {
      BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org",
    })).to.throw("BASE_MAINNET_RPC_URL is required");
    for (const value of ["", "not a url", "file:///tmp/rpc", "wss://rpc.example"])
      expect(() => authorityRpcUrl("baseMainnet", 8453, {
        BASE_MAINNET_RPC_URL: value,
      })).to.throw();
  });
});

const { ethers } = require("hardhat");
const {
  assertChain,
  currentNetworkConfig,
  requiredAddress,
  requiredUint,
} = require("./lib/config");

async function main() {
  const config = currentNetworkConfig();
  await assertChain(config);
  const gatewayAddress = requiredAddress("GATEWAY_ADDRESS");
  const spokeAddress = requiredAddress("TRUSTED_SPOKE_ADDRESS");
  const spokeSelector = requiredUint("TRUSTED_SPOKE_SELECTOR");
  const gateway = await ethers.getContractAt("SolomonWarpGateway", gatewayAddress);

  await (await gateway.setTrustedSpoke(spokeSelector, spokeAddress)).wait();
  console.log(JSON.stringify({ gateway: gatewayAddress, spokeSelector: spokeSelector.toString(), spoke: spokeAddress }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

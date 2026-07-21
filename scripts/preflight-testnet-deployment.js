const { ethers, network } = require("hardhat");
const networks = require("../config/networks.json");
const { assertChain, currentNetworkConfig } = require("./lib/config");
const {
  requiredSourceSha,
  withArtifactHash,
  writeEvidence,
} = require("./lib/deployment-evidence");
const {
  deploymentSettings,
  inspectDeploymentReadiness,
  isTestnet,
  requiredUint,
} = require("./lib/deployment-preflight");

async function main() {
  if (!isTestnet(network.name) || process.env.SOLSLOT_OMNICHAIN_TESTNET_DEPLOYMENT !== "true") {
    throw new Error("preflight requires an explicit SOLSLOT_OMNICHAIN_TESTNET_DEPLOYMENT=true testnet run");
  }
  const sourceSha = requiredSourceSha();
  const config = currentNetworkConfig();
  await assertChain(config);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is required");
  const settings = deploymentSettings(process.env, config, network.name, networks);
  const minimumDeployerBalanceWei = requiredUint(
    process.env,
    "SOLSLOT_OMNICHAIN_MIN_DEPLOYER_WEI",
    undefined,
    1n,
  );
  const inspection = await inspectDeploymentReadiness({
    provider: ethers.provider,
    config,
    settings,
    deployer: await deployer.getAddress(),
    minimumDeployerBalanceWei,
  });
  const evidence = withArtifactHash({
    schemaVersion: 1,
    kind: "solslot-omnichain-testnet-deployment-preflight",
    sourceSha,
    network: network.name,
    chainId: config.chainId,
    chainSelector: config.selector,
    hubName: settings.hubName,
    hubChainSelector: settings.hubChainSelector.toString(),
    deploymentMode: settings.deployGateway ? "new_gateway_and_spoke" : "new_spoke",
    settings: {
      payout: settings.payout,
      governance: settings.governance,
      usdc: settings.usdc,
      usdt: settings.usdt,
      callbackGas: settings.callbackGas.toString(),
      emergencyDelay: settings.emergencyDelay.toString(),
      confirmations: settings.confirmations,
      ...(settings.gatewaySettings
        ? { warpPortal: settings.gatewaySettings.warpPortal }
        : { hubGateway: settings.gateway }),
    },
    inspection,
    checkedAt: new Date().toISOString(),
  });
  const evidencePath = writeEvidence(
    process.env.SOLSLOT_OMNICHAIN_PREFLIGHT_OUTPUT,
    evidence,
    "SOLSLOT_OMNICHAIN_PREFLIGHT_OUTPUT",
  );
  console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

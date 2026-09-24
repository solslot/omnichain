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
  requireTestAssetScope,
  requiredUint,
} = require("./lib/deployment-preflight");
const { validatePaymentGovernance } = require("./lib/payment-governance");
const { validateSamuelCoordinates } = require("./lib/samuel-coordinates");
const { validateWarpPortalEvidence } = require("./lib/warp-portal-deployment");

async function main() {
  requireTestAssetScope(process.env, network.name);
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
  const governance = await validatePaymentGovernance({
    path: process.env.SOLSLOT_GOVERNANCE_EVIDENCE_PATH,
    provider: ethers.provider,
    rootSafe: settings.rootSafe,
    timelock: settings.governance,
  });
  if (!settings.gatewaySettings) throw new Error("alpha preflight must deploy a dedicated gateway");
  const samuel = validateSamuelCoordinates(
    process.env.SOLSLOT_SAMUEL_COORDINATE_EVIDENCE_PATH,
    {
      ...settings.gatewaySettings,
      predictedGatewayAddress: inspection.predictedGatewayAddress,
    },
    config.chainId,
  );
  const warpPortal = await validateWarpPortalEvidence({
    path: process.env.SOLSLOT_WARP_PORTAL_EVIDENCE_PATH,
    provider: ethers.provider,
    expectedPortal: settings.gatewaySettings.warpPortal,
    expectedOmnichainSourceSha: sourceSha,
    expectedRosterArtifactHash: samuel.validatorRosterArtifactHash,
    expectedValidatorAddresses: samuel.validatorEvmAddresses,
    expectedChainId: config.chainId,
    minimumConfirmations: settings.confirmations,
  });
  const evidence = withArtifactHash({
    schemaVersion: 5,
    kind: "solslot-omnichain-testnet-deployment-preflight",
    sourceSha,
    network: network.name,
    chainId: config.chainId,
    chainSelector: config.selector,
    hubName: settings.hubName,
    hubChainSelector: settings.hubChainSelector.toString(),
    deploymentMode: settings.deployGateway ? "new_gateway_and_spoke" : "new_spoke",
    governanceArtifactHash: governance.artifactHash,
    samuelCoordinateArtifactHash: samuel.artifactHash,
    warpPortalArtifactHash: warpPortal.artifactHash,
    settings: {
      payout: settings.payout,
      ccipRouter: config.router,
      governance: settings.governance,
      rootSafe: settings.rootSafe,
      usdc: settings.usdc,
      callbackGas: settings.callbackGas.toString(),
      emergencyDelay: settings.emergencyDelay.toString(),
      confirmations: settings.confirmations,
      ...(settings.gatewaySettings
        ? {
          warpPortal: settings.gatewaySettings.warpPortal,
          predictedGatewayAddress: inspection.predictedGatewayAddress,
          protocolSourceSha: settings.gatewaySettings.protocolSourceSha,
          samuelSourceSha: settings.gatewaySettings.samuelSourceSha,
          voucherResultAuthorizationMod:
            settings.gatewaySettings.voucherResultAuthorizationMod,
          voucherBurnInner: settings.gatewaySettings.voucherBurnInner,
        }
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

const { ethers } = require("ethers");
const { readEvidence } = require("./deployment-evidence");

const BLS_KEY = /^0x[0-9a-f]{96}$/;

function selectedSamuelBase(evidence, expectedChainId = 84532) {
  if (expectedChainId === 84532 && evidence.schemaVersion === 3 &&
      !Object.hasOwn(evidence, "baseMainnet") &&
      !Object.hasOwn(evidence, "paymentChainId")) {
    if (evidence.baseSepolia?.chainId === 84532) return evidence.baseSepolia;
  }
  if (expectedChainId === 8453 && evidence.schemaVersion === 4 &&
      evidence.paymentChainId === 8453 && evidence.testOnly === true &&
      evidence.validatorIdentityDomain === "solslot-alpha-native-bridge-testnet11-base-mainnet" &&
      !Object.hasOwn(evidence, "baseSepolia")) {
    if (evidence.baseMainnet?.chainId === 8453) return evidence.baseMainnet;
  }
  throw new Error("Samuel coordinate evidence is unsupported for the selected payment chain");
}

function validateSamuelCoordinates(path, gatewaySettings, expectedChainId = 84532) {
  const evidence = readEvidence(path, "samuel_coordinates");
  const chia = evidence.testnet11;
  const base = selectedSamuelBase(evidence, expectedChainId);
  if (
    evidence.kind !== "solslot-samuel-testnet-coordinates" ||
    evidence.threshold !== 2 ||
    !/^[0-9a-f]{40}$/.test(String(evidence.sourceSha || "")) ||
    !/^[0-9a-f]{40}$/.test(String(evidence.protocolSourceSha || "")) ||
    !ethers.isHexString(evidence.validatorRosterArtifactHash, 32) ||
    !Array.isArray(evidence.validatorPublicKeys) ||
    evidence.validatorPublicKeys.length !== 3 ||
    evidence.validatorPublicKeys.some((key) => !BLS_KEY.test(String(key))) ||
    new Set(evidence.validatorPublicKeys).size !== 3 ||
    !Array.isArray(evidence.validatorEvmAddresses) ||
    evidence.validatorEvmAddresses.length !== 3 ||
    evidence.validatorEvmAddresses.some((address) => !ethers.isAddress(address)) ||
    new Set(
      evidence.validatorEvmAddresses.map((address) =>
        ethers.getAddress(address).toLowerCase()
      )
    ).size !== 3 ||
    !ethers.isAddress(base?.warpPortalAddress) ||
    !ethers.isAddress(base?.solomonGatewayAddress) ||
    !ethers.isHexString(chia?.portalLauncherId, 32) ||
    !ethers.isHexString(chia?.bridgingPuzzleHash, 32) ||
    !ethers.isHexString(chia?.returnPuzzleModuleHash, 32) ||
    !ethers.isHexString(chia?.returnPuzzleHash, 32) ||
    !ethers.isHexString(chia?.resultAuthorizationModHash, 32) ||
    !ethers.isHexString(chia?.voucherBurnInnerHash, 32) ||
    evidence.returnRoute?.destinationChain !== "bse" ||
    !ethers.isAddress(evidence.returnRoute?.destinationAddress)
  ) {
    throw new Error("Samuel coordinate evidence is unsupported");
  }
  if (
    ethers.getAddress(base.warpPortalAddress) !== gatewaySettings.warpPortal ||
    ethers.getAddress(base.solomonGatewayAddress) !==
      gatewaySettings.predictedGatewayAddress ||
    ethers.getAddress(evidence.returnRoute.destinationAddress) !==
      gatewaySettings.predictedGatewayAddress ||
    chia.bridgingPuzzleHash.toLowerCase() !== gatewaySettings.samuelBridgingPuzzle.toLowerCase() ||
    chia.returnPuzzleHash.toLowerCase() !== gatewaySettings.samuelReturnPuzzle.toLowerCase() ||
    chia.resultAuthorizationModHash.toLowerCase() !== gatewaySettings.voucherResultAuthorizationMod.toLowerCase() ||
    chia.voucherBurnInnerHash.toLowerCase() !== gatewaySettings.voucherBurnInner.toLowerCase() ||
    evidence.protocolSourceSha !== gatewaySettings.protocolSourceSha ||
    evidence.sourceSha !== gatewaySettings.samuelSourceSha ||
    gatewaySettings.warpChiaChain.toLowerCase() !== "0x786368"
  ) {
    throw new Error("Samuel coordinate evidence does not match the gateway configuration");
  }
  return evidence;
}

module.exports = { validateSamuelCoordinates, selectedSamuelBase };

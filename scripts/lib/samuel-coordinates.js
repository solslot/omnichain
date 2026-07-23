const { ethers } = require("ethers");
const { readEvidence } = require("./deployment-evidence");

const BLS_KEY = /^0x[0-9a-f]{96}$/;

function validateSamuelCoordinates(path, gatewaySettings) {
  const evidence = readEvidence(path, "samuel_coordinates");
  const chia = evidence.testnet11;
  const base = evidence.baseSepolia;
  if (
    evidence.schemaVersion !== 2 ||
    evidence.kind !== "solslot-samuel-testnet-coordinates" ||
    evidence.threshold !== 2 ||
    !/^[0-9a-f]{40}$/.test(String(evidence.sourceSha || "")) ||
    !/^[0-9a-f]{40}$/.test(String(evidence.protocolSourceSha || "")) ||
    !ethers.isHexString(evidence.validatorRosterArtifactHash, 32) ||
    !Array.isArray(evidence.validatorPublicKeys) ||
    evidence.validatorPublicKeys.length !== 3 ||
    evidence.validatorPublicKeys.some((key) => !BLS_KEY.test(String(key))) ||
    new Set(evidence.validatorPublicKeys).size !== 3 ||
    base?.chainId !== 84532 ||
    !ethers.isAddress(base?.warpPortalAddress) ||
    !ethers.isHexString(chia?.portalLauncherId, 32) ||
    !ethers.isHexString(chia?.bridgingPuzzleHash, 32) ||
    !ethers.isHexString(chia?.returnPuzzleHash, 32) ||
    !ethers.isHexString(chia?.resultAuthorizationModHash, 32) ||
    !ethers.isHexString(chia?.voucherBurnInnerHash, 32)
  ) {
    throw new Error("Samuel coordinate evidence is unsupported");
  }
  if (
    ethers.getAddress(base.warpPortalAddress) !== gatewaySettings.warpPortal ||
    chia.bridgingPuzzleHash.toLowerCase() !== gatewaySettings.samuelBridgingPuzzle.toLowerCase() ||
    chia.returnPuzzleHash.toLowerCase() !== gatewaySettings.samuelReturnPuzzle.toLowerCase() ||
    chia.resultAuthorizationModHash.toLowerCase() !== gatewaySettings.voucherResultAuthorizationMod.toLowerCase() ||
    chia.voucherBurnInnerHash.toLowerCase() !== gatewaySettings.voucherBurnInner.toLowerCase() ||
    evidence.protocolSourceSha !== gatewaySettings.protocolSourceSha ||
    gatewaySettings.warpChiaChain.toLowerCase() !== "0x786368"
  ) {
    throw new Error("Samuel coordinate evidence does not match the gateway configuration");
  }
  return evidence;
}

module.exports = { validateSamuelCoordinates };

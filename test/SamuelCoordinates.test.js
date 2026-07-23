const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { withArtifactHash, writeEvidence } = require("../scripts/lib/deployment-evidence");
const { validateSamuelCoordinates } = require("../scripts/lib/samuel-coordinates");

function record() {
  return withArtifactHash({
    schemaVersion: 2,
    kind: "solslot-samuel-testnet-coordinates",
    sourceSha: "a".repeat(40),
    protocolSourceSha: "b".repeat(40),
    validatorRosterArtifactHash: `0x${"11".repeat(32)}`,
    testnet11: {
      portalLauncherId: `0x${"12".repeat(32)}`,
      bridgingPuzzleHash: `0x${"13".repeat(32)}`,
      returnPuzzleHash: `0x${"14".repeat(32)}`,
      resultAuthorizationModHash: `0x${"16".repeat(32)}`,
      voucherBurnInnerHash: `0x${"17".repeat(32)}`,
    },
    baseSepolia: { chainId: 84532, warpPortalAddress: `0x${"15".repeat(20)}` },
    threshold: 2,
    validatorPublicKeys: ["21", "22", "23"].map((byte) => `0x${byte.repeat(48)}`),
  });
}

function settings(evidence) {
  return {
    warpPortal: evidence.baseSepolia.warpPortalAddress,
    warpChiaChain: "0x786368",
    samuelBridgingPuzzle: evidence.testnet11.bridgingPuzzleHash,
    samuelReturnPuzzle: evidence.testnet11.returnPuzzleHash,
    voucherResultAuthorizationMod:
      evidence.testnet11.resultAuthorizationModHash,
    voucherBurnInner: evidence.testnet11.voucherBurnInnerHash,
    protocolSourceSha: evidence.protocolSourceSha,
  };
}

describe("Samuel testnet coordinate evidence", function () {
  it("binds one 2-of-3 Testnet11 roster to the Base Sepolia portal", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "samuel-coordinates-"));
    const file = path.join(directory, "coordinates.json");
    const evidence = record();
    writeEvidence(file, evidence);
    expect(validateSamuelCoordinates(file, settings(evidence)).artifactHash).to.equal(evidence.artifactHash);
  });

  it("rejects legacy schema v1 evidence", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "samuel-coordinates-v1-"));
    const file = path.join(directory, "coordinates.json");
    const { artifactHash: _, ...body } = record();
    const evidence = withArtifactHash({ ...body, schemaVersion: 1 });
    writeEvidence(file, evidence);
    expect(() => validateSamuelCoordinates(file, settings(record()))).to.throw("unsupported");
  });

  it("rejects a mainnet or mismatched Warp portal", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "samuel-coordinates-invalid-"));
    const file = path.join(directory, "coordinates.json");
    const evidence = record();
    writeEvidence(file, evidence);
    expect(() => validateSamuelCoordinates(file, {
      ...settings(evidence),
      warpPortal: `0x${"99".repeat(20)}`,
    })).to.throw("does not match");
  });
});

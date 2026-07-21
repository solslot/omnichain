const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  requireNewEvidencePath,
  sha256,
  stableJson,
  withArtifactHash,
  writeEvidence,
} = require("../scripts/lib/deployment-evidence");

describe("Omnichain deployment evidence", function () {
  it("canonicalizes records before hashing", function () {
    const left = { beta: [2, 1], alpha: "value" };
    const right = { alpha: "value", beta: [2, 1] };
    expect(stableJson(left)).to.equal(stableJson(right));
    expect(sha256(left)).to.equal(sha256(right));
    expect(withArtifactHash(left).artifactHash).to.equal(sha256(left));
  });

  it("writes evidence once with restrictive permissions", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-omnichain-"));
    const output = path.join(directory, "evidence.json");
    const record = withArtifactHash({ schemaVersion: 1, sourceSha: "a".repeat(40) });

    expect(writeEvidence(output, record)).to.equal(output);
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).to.deep.equal(record);
    expect(() => writeEvidence(output, record)).to.throw("Refusing to overwrite");
    expect(fs.statSync(output).mode & 0o077).to.equal(0);
  });

  it("rejects an occupied path before any deployment transaction", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-omnichain-"));
    const output = path.join(directory, "evidence.json");
    fs.writeFileSync(output, "existing", "utf8");
    expect(() => requireNewEvidencePath(output)).to.throw("Refusing to overwrite");
    expect(() => requireNewEvidencePath("")).to.throw("DEPLOYMENT_OUTPUT is required");
  });
});

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const GIT_SHA = /^[0-9a-f]{40}$/;
const MAX_EVIDENCE_BYTES = 128 * 1024;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `0x${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function requiredSourceSha(environment = process.env, cwd = process.cwd()) {
  const expected = String(environment.SOLSLOT_OMNICHAIN_SOURCE_SHA || "").toLowerCase();
  if (!GIT_SHA.test(expected)) {
    throw new Error("SOLSLOT_OMNICHAIN_SOURCE_SHA must be a full 40-character Git SHA");
  }
  const actual = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim().toLowerCase();
  if (actual !== expected) {
    throw new Error("SOLSLOT_OMNICHAIN_SOURCE_SHA does not match the deployment checkout HEAD");
  }
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
  }).trim();
  if (status) {
    throw new Error("Refusing to deploy from a dirty Omnichain checkout");
  }
  return actual;
}

function requireNewEvidencePath(outputPath) {
  if (!outputPath) {
    throw new Error("SOLSLOT_OMNICHAIN_DEPLOYMENT_OUTPUT is required");
  }
  const resolved = path.resolve(outputPath);
  if (fs.existsSync(resolved)) {
    throw new Error("Refusing to overwrite existing Omnichain deployment evidence");
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  return resolved;
}

function writeEvidence(outputPath, evidence) {
  const resolved = requireNewEvidencePath(outputPath);
  fs.writeFileSync(resolved, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return resolved;
}

function readEvidence(inputPath, label = "deployment") {
  if (!inputPath) throw new Error(`SOLSLOT_OMNICHAIN_${label.toUpperCase()}_EVIDENCE_PATH is required`);
  const resolved = path.resolve(inputPath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_EVIDENCE_BYTES) {
    throw new Error(`${label} evidence path is invalid`);
  }
  const record = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${label} evidence must be an object`);
  }
  const artifactHash = record.artifactHash;
  if (typeof artifactHash !== "string" || artifactHash !== sha256(Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "artifactHash"),
  ))) {
    throw new Error(`${label} evidence hash mismatches`);
  }
  return record;
}

function withArtifactHash(evidence) {
  return { ...evidence, artifactHash: sha256(evidence) };
}

module.exports = {
  requireNewEvidencePath,
  requiredSourceSha,
  readEvidence,
  sha256,
  stableJson,
  withArtifactHash,
  writeEvidence,
};

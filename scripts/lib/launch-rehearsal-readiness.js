const fs = require("node:fs");
const path = require("node:path");

const {
  LaunchRehearsalCoordinator,
  loadActivationEvidence,
  loadCoordinatorConfig,
  loadCoordinatorSecrets,
} = require("./launch-rehearsal-coordinator");
const { resolveListener } = require("../serve-launch-rehearsal");

function privateRegularFile(inputPath, label) {
  const value = String(inputPath || "");
  if (!path.isAbsolute(value)) throw new Error(`${label} path must be absolute`);
  const stat = fs.lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a private regular file`);
  }
  fs.accessSync(value, fs.constants.R_OK);
  return value;
}

function privateStateDirectory(inputPath, expectedUid = process.getuid?.()) {
  const value = String(inputPath || "");
  if (!path.isAbsolute(value)) {
    throw new Error("SOLSLOT_LAUNCH_REHEARSAL_STATE_DIR must be absolute");
  }
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("launch rehearsal state directory must be a private directory");
  }
  if (expectedUid !== undefined && stat.uid !== expectedUid) {
    throw new Error("launch rehearsal state directory owner is invalid");
  }
  fs.accessSync(value, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  return value;
}

async function checkReadiness({
  environment = process.env,
  fetchImplementation = fetch,
  now = () => Math.floor(Date.now() / 1000),
  expectedUid = process.getuid?.(),
} = {}) {
  const listener = resolveListener(environment);
  privateRegularFile(
    environment.SOLSLOT_LAUNCH_REHEARSAL_CONFIG_PATH,
    "launch rehearsal config",
  );
  privateRegularFile(
    environment.SOLSLOT_OMNICHAIN_ACTIVATION_EVIDENCE_PATH,
    "activation evidence",
  );
  const stateDirectory = privateStateDirectory(
    environment.SOLSLOT_LAUNCH_REHEARSAL_STATE_DIR,
    expectedUid,
  );
  const config = loadCoordinatorConfig(environment);
  const activation = loadActivationEvidence(environment);
  const secrets = loadCoordinatorSecrets(environment);
  const coordinator = new LaunchRehearsalCoordinator({
    config,
    secrets,
    stateDirectory,
    fetchImplementation,
    now,
  });
  await coordinator.verifyRuntime();
  return {
    ready: true,
    releaseTag: config.releaseTag,
    configHash: config.configHash,
    activationArtifactHash: activation.artifactHash,
    activationSourceSha: activation.sourceSha,
    candidatesApiOrigin: new URL(config.candidatesApiUrl).origin,
    listener,
  };
}

async function main() {
  console.log(JSON.stringify(await checkReadiness()));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  checkReadiness,
  privateRegularFile,
  privateStateDirectory,
};

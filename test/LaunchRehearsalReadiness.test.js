const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { expect } = require("chai");

const { sha256, withArtifactHash } = require("../scripts/lib/deployment-evidence");
const {
  CONFIG_KIND,
} = require("../scripts/lib/launch-rehearsal-coordinator");
const {
  checkReadiness,
} = require("../scripts/lib/launch-rehearsal-readiness");

function hex(seed, bytes = 32) {
  return `0x${seed.toString(16).padStart(2, "0").repeat(bytes)}`;
}

function privateFile(directory, name, value) {
  const output = path.join(directory, name);
  fs.writeFileSync(output, value, { mode: 0o600 });
  fs.chmodSync(output, 0o600);
  return output;
}

async function expectRejected(operation, message) {
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(Error);
  expect(failure.message).to.include(message);
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solslot-readiness-"));
  const stateDirectory = path.join(directory, "state");
  fs.mkdirSync(stateDirectory, { mode: 0o700 });
  fs.chmodSync(stateDirectory, 0o700);
  const payload = {
    schemaVersion: 3,
    kind: CONFIG_KIND,
    releaseTag: "solslot-v2-alpha-rc27-20260807",
    releaseEvidenceHash: hex(91),
    network: "testnet11",
    candidatesApiUrl: "https://solslot.com/protocol-api/presales/stripe-rehearsal/candidates",
    approvedVaultLauncherId: hex(80),
    collectionId: hex(81),
    stripe: {
      accountId: "acct_testnet_alpha",
      mode: "test",
      livemode: false,
      apiVersion: "2026-02-25.clover",
    },
    validatorThreshold: 2,
    validators: [{ id: "validator-0" }, { id: "validator-1" }, { id: "validator-2" }],
  };
  const activation = withArtifactHash({
    schemaVersion: 3,
    kind: "ccip-warp-escrow-activation",
    sourceSha: "ab".repeat(20),
    network: "baseSepolia",
    chainId: 11155111,
    gatewayProfile: "testnet11-alpha",
    contracts: { gateway: hex(10, 20), spoke: hex(11, 20) },
    runtimeCodeHashes: { gateway: hex(12), spoke: hex(13) },
    ownershipAccepted: true,
  });
  const environment = {
    SOLSLOT_LAUNCH_REHEARSAL_CONFIG_PATH: privateFile(
      directory,
      "config.json",
      JSON.stringify({ configHash: sha256(payload), payload }),
    ),
    SOLSLOT_OMNICHAIN_ACTIVATION_EVIDENCE_PATH: privateFile(
      directory,
      "activation.json",
      JSON.stringify(activation),
    ),
    SOLSLOT_LAUNCH_REHEARSAL_TOKEN_FILE: privateFile(directory, "token", "t".repeat(32)),
    SOLSLOT_LAUNCH_REHEARSAL_HMAC_FILE: privateFile(directory, "hmac", "h".repeat(32)),
    SOLSLOT_LAUNCH_REHEARSAL_API_TOKEN_FILE: privateFile(directory, "api-token", "a".repeat(32)),
    SOLSLOT_LAUNCH_REHEARSAL_STATE_DIR: stateDirectory,
    SOLSLOT_LAUNCH_REHEARSAL_HOST: "127.0.0.1",
    SOLSLOT_LAUNCH_REHEARSAL_PORT: "8794",
  };
  return { activation, directory, environment, payload, stateDirectory };
}

describe("launch rehearsal activation readiness", function () {
  it("validates every runtime input and probes the candidates API without writing state", async function () {
    const current = fixture();
    let request;
    const result = await checkReadiness({
      environment: current.environment,
      now: () => 1786118400,
      fetchImplementation: async (url, options) => {
        request = { url: String(url), options };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            schema: "solslot.stripe-voucher-rehearsal-candidates.v1",
            createdAfter: 1786118400,
            vaultLauncherId: current.payload.approvedVaultLauncherId,
            collectionId: current.payload.collectionId,
            delivery: [],
            refund: [],
          }),
        };
      },
    });

    expect(result.ready).to.equal(true);
    expect(result.activationArtifactHash).to.equal(current.activation.artifactHash);
    expect(request.options.method).to.equal("GET");
    expect(request.options.headers.Authorization).to.equal(`Bearer ${"a".repeat(32)}`);
    expect(fs.readdirSync(current.stateDirectory)).to.deep.equal([]);
  });

  it("rejects unusable activation evidence", async function () {
    const current = fixture();
    const activation = { ...current.activation, ownershipAccepted: false };
    const withoutHash = Object.fromEntries(
      Object.entries(activation).filter(([key]) => key !== "artifactHash"),
    );
    fs.writeFileSync(
      current.environment.SOLSLOT_OMNICHAIN_ACTIVATION_EVIDENCE_PATH,
      JSON.stringify(withArtifactHash(withoutHash)),
    );
    await expectRejected(
      () => checkReadiness({ environment: current.environment }),
      "activation evidence is not usable",
    );
  });

  it("rejects state directories that are accessible to other users", async function () {
    const current = fixture();
    fs.chmodSync(current.stateDirectory, 0o755);
    await expectRejected(
      () => checkReadiness({ environment: current.environment }),
      "state directory must be a private directory",
    );
  });
});

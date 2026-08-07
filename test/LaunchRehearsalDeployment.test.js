const fs = require("fs");
const path = require("path");
const { expect } = require("chai");

describe("launch rehearsal staging deployment", function () {
  const workflowPath = path.join(
    __dirname,
    "..",
    ".github",
    "workflows",
    "deploy-launch-rehearsal-staging.yml",
  );
  const runbookPath = path.join(
    __dirname,
    "..",
    "security",
    "LAUNCH_REHEARSAL_RUNBOOK.md",
  );

  it("pins the isolated coordinator port and rejects the Key of Solomon port", function () {
    const workflow = fs.readFileSync(workflowPath, "utf8");
    const runbook = fs.readFileSync(runbookPath, "utf8");

    expect(workflow).to.include("SOLSLOT_REHEARSAL_PORT || '8794'");
    expect(workflow).to.include('if [ "$service_port" = "8793" ]');
    expect(runbook).to.include("SOLSLOT_LAUNCH_REHEARSAL_PORT=8794");
    expect(runbook).to.include(
      "SOLSLOT_LAUNCH_REHEARSAL_SERVICE_URL=http://127.0.0.1:8794",
    );
  });

  it("uses and verifies the pinned Node 22 binary for install and systemd", function () {
    const workflow = fs.readFileSync(workflowPath, "utf8");

    expect(workflow).to.include(
      "SOLSLOT_REHEARSAL_NODE_BIN || '/opt/solslot/runtime/node-v22.23.2/bin/node'",
    );
    expect(workflow).to.include(
      "SOLSLOT_REHEARSAL_NODE_VERSION || 'v22.23.2'",
    );
    expect(workflow).to.include(
      'test "$("$node_bin" --version)" = "$expected_node_version"',
    );
    expect(workflow).to.include(
      'PATH="$node_dir:$PATH" "$npm_bin" ci --omit=dev --ignore-scripts',
    );
    expect(workflow).to.include(
      "ExecStart=$node_bin scripts/serve-launch-rehearsal.js",
    );
    expect(workflow).not.to.include(
      "ExecStart=/usr/bin/node scripts/serve-launch-rehearsal.js",
    );
  });

  it("runs a read-only readiness gate as the service account before activation", function () {
    const workflow = fs.readFileSync(workflowPath, "utf8");
    const readiness = '"$node_bin" scripts/lib/launch-rehearsal-readiness.js';
    const enable = 'sudo systemctl enable "$service"';

    expect(workflow).to.include('sudo -u "$service_user" env');
    expect(workflow).to.include(readiness);
    expect(workflow.indexOf(readiness)).to.be.lessThan(workflow.indexOf(enable));
  });
});

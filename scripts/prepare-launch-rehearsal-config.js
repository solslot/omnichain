const fs = require("node:fs");
const path = require("node:path");

const {
  requireNewEvidencePath,
  sha256,
} = require("./lib/deployment-evidence");

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    throw new Error(
      "usage: node scripts/prepare-launch-rehearsal-config.js PAYLOAD_JSON OUTPUT_JSON",
    );
  }
  const input = path.resolve(argv[0]);
  const output = requireNewEvidencePath(
    argv[1],
    "launch rehearsal config output",
  );
  const stat = fs.lstatSync(input);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size <= 0
    || stat.size > 256 * 1024
  ) {
    throw new Error("launch rehearsal payload path is invalid");
  }
  const payload = JSON.parse(fs.readFileSync(input, "utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("launch rehearsal payload must be an object");
  }
  const envelope = { configHash: sha256(payload), payload };
  fs.writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({
    output,
    configHash: envelope.configHash,
  }));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { main };

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  WARP_SOURCE_SHA,
  WARP_SOURCE_TREE,
  readPinnedWarpArtifacts,
} = require("./lib/warp-portal-deployment");

const CONFIG = `import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  paths: {
    sources: ".solslot-build",
  },
  solidity: {
    version: "0.8.23",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
};

export default config;
`;

const BUILD_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "../contracts/Portal.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
`;

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function assertPinnedCheckout(root) {
  if (
    git(root, ["rev-parse", "HEAD"]).toLowerCase() !== WARP_SOURCE_SHA ||
    git(root, ["rev-parse", "HEAD^{tree}"]).toLowerCase() !== WARP_SOURCE_TREE ||
    git(root, ["status", "--porcelain", "--untracked-files=no"]) !== ""
  ) {
    throw new Error("Warp checkout is not the exact clean pinned source revision");
  }
}

function writeExact(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") !== content) {
    throw new Error(`Refusing to replace unexpected build helper ${file}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
}

function main() {
  const value = process.env.SOLSLOT_WARP_SOURCE_ROOT;
  if (!value) throw new Error("SOLSLOT_WARP_SOURCE_ROOT is required");
  const root = fs.realpathSync(path.resolve(value));
  assertPinnedCheckout(root);
  const configPath = path.join(root, "hardhat.config.ts");
  const sourceDirectory = path.join(root, ".solslot-build");
  const sourcePath = path.join(sourceDirectory, "CompilePinnedWarp.sol");
  writeExact(configPath, CONFIG);
  writeExact(sourcePath, BUILD_SOURCE);
  try {
    execFileSync("npm", ["ci"], { cwd: root, stdio: "inherit" });
    execFileSync("npx", ["hardhat", "clean"], { cwd: root, stdio: "inherit" });
    execFileSync("npx", ["hardhat", "compile"], { cwd: root, stdio: "inherit" });
    readPinnedWarpArtifacts(root);
  } finally {
    fs.rmSync(sourceDirectory, { recursive: true, force: true });
    fs.rmSync(configPath, { force: true });
  }
  assertPinnedCheckout(root);
  console.log(JSON.stringify({
    sourceRoot: root,
    sourceSha: WARP_SOURCE_SHA,
    sourceTree: WARP_SOURCE_TREE,
    artifactsVerified: true,
  }, null, 2));
}

main();

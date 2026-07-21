const { ethers } = require("hardhat");
const { loadRelayerConfig, runOnce } = require("./lib/escrow-relayer");

async function main() {
  const config = loadRelayerConfig();
  const once = process.argv.includes("--once") || process.env.SOLSLOT_ESCROW_RELAYER_ONCE === "true";
  do {
    const result = await runOnce(config, ethers.provider);
    console.log(JSON.stringify(result));
    if (once) return;
    await new Promise((resolve) => setTimeout(resolve, config.pollMilliseconds));
  } while (true);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

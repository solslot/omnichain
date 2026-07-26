const { ethers } = require("hardhat");
const { loadRelayerConfig, runOnce } = require("./lib/escrow-relayer");
const {
  loadSettlementConfig,
  runBaseSettlements,
} = require("./lib/base-settlement-relayer");

async function main() {
  const config = loadSettlementConfig(loadRelayerConfig());
  const signer = new ethers.Wallet(config.privateKey, ethers.provider);
  const once = process.argv.includes("--once") || process.env.SOLSLOT_ESCROW_RELAYER_ONCE === "true";
  do {
    const deposits = await runOnce(config, ethers.provider);
    const settlements = await runBaseSettlements(
      config,
      ethers.provider,
      signer,
    );
    console.log(JSON.stringify({ deposits, settlements }));
    if (once) return;
    await new Promise((resolve) => setTimeout(resolve, config.pollMilliseconds));
  } while (true);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

const { ethers } = require("hardhat");
const {
  loadRehearsalConfig,
  verifySettlementRehearsal,
} = require("./lib/settlement-rehearsal");

async function main() {
  const evidence = await verifySettlementRehearsal(
    loadRehearsalConfig(),
    ethers.provider,
  );
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

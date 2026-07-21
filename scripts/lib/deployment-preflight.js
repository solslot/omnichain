const { ethers } = require("ethers");
const { readEvidence } = require("./deployment-evidence");

const TESTNETS = new Set([
  "baseSepolia",
  "ethereumSepolia",
  "polygonAmoy",
  "optimismSepolia",
  "avalancheFuji",
  "robinhoodTestnet",
]);
const DECIMALS_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);

function isTestnet(networkName) {
  return TESTNETS.has(networkName);
}

function requiredAddress(environment, name, fallback) {
  const value = environment[name] || fallback;
  if (!value || !ethers.isAddress(value) || ethers.getAddress(value) === ethers.ZeroAddress) {
    throw new Error(`${name} is missing or invalid`);
  }
  return ethers.getAddress(value);
}

function requiredBytes(environment, name, length) {
  const value = environment[name];
  if (!value || !ethers.isHexString(value, length) || BigInt(value) === 0n) {
    throw new Error(`${name} must be a non-zero ${length}-byte hex value`);
  }
  return value.toLowerCase();
}

function requiredUint(environment, name, fallback, minimum = 0n) {
  const value = environment[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${name} must be an unsigned integer`);
  }
  if (parsed < minimum) throw new Error(`${name} must be at least ${minimum}`);
  return parsed;
}

function defaultHubName(config, networkName) {
  return config.hub === "ethereum"
    ? (isTestnet(networkName) ? "ethereumSepolia" : "ethereumMainnet")
    : (isTestnet(networkName) ? "baseSepolia" : "baseMainnet");
}

function deploymentSettings(environment, config, networkName, networks) {
  const payout = requiredAddress(environment, "PAYOUT_ADDRESS");
  const usdc = requiredAddress(environment, "USDC_ADDRESS", config.stablecoins?.usdc);
  const usdt = requiredAddress(environment, "USDT_ADDRESS", config.stablecoins?.usdt);
  if (usdc === usdt) throw new Error("USDC_ADDRESS and USDT_ADDRESS must differ");
  const governance = requiredAddress(environment, "GOVERNANCE_ADDRESS");
  const callbackGas = requiredUint(environment, "CCIP_CALLBACK_GAS", "500000", 1n);
  const emergencyDelay = requiredUint(environment, "EMERGENCY_REFUND_DELAY_SECONDS", "604800", 604800n);
  const confirmations = networkName === "hardhat"
    ? 1
    : Number(requiredUint(environment, "SOLSLOT_OMNICHAIN_CONFIRMATIONS", "12", 12n));
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) {
    throw new Error("SOLSLOT_OMNICHAIN_CONFIRMATIONS must be a positive safe integer");
  }
  const deployGateway = environment.DEPLOY_GATEWAY === "true";
  const hubName = defaultHubName(config, networkName);
  const hub = networks[hubName];
  if (!hub) throw new Error(`Missing hub configuration for ${hubName}`);
  const hubChainSelector = requiredUint(
    environment,
    "HUB_CHAIN_SELECTOR",
    hub.selector,
    1n,
  );
  const gateway = deployGateway
    ? null
    : requiredAddress(environment, "HUB_GATEWAY_ADDRESS");
  const gatewaySettings = deployGateway
    ? {
      warpPortal: requiredAddress(environment, "WARP_PORTAL_ADDRESS"),
      warpChiaChain: requiredBytes(environment, "WARP_CHIA_CHAIN", 3),
      samuelBridgingPuzzle: requiredBytes(environment, "SAMUEL_BRIDGING_PUZZLE", 32),
      samuelReturnPuzzle: requiredBytes(environment, "SAMUEL_RETURN_PUZZLE", 32),
      maxWarpTollWei: requiredUint(environment, "MAX_WARP_TOLL_WEI", undefined, 1n),
      maxCcipFeeWei: requiredUint(environment, "MAX_CCIP_FEE_WEI", undefined, 1n),
    }
    : null;
  return {
    payout,
    usdc,
    usdt,
    governance,
    callbackGas,
    emergencyDelay,
    confirmations,
    deployGateway,
    gateway,
    gatewaySettings,
    hubChainSelector,
    hubName,
  };
}

async function runtimeCode(provider, address, label) {
  const code = await provider.getCode(address);
  if (code === "0x") throw new Error(`${label} has no runtime bytecode`);
  return { address: ethers.getAddress(address), codeHash: ethers.keccak256(code) };
}

async function tokenDecimals(provider, address) {
  const data = DECIMALS_INTERFACE.encodeFunctionData("decimals");
  const result = await provider.call({ to: address, data });
  return Number(DECIMALS_INTERFACE.decodeFunctionResult("decimals", result)[0]);
}

async function inspectDeploymentReadiness({
  provider,
  config,
  settings,
  deployer,
  minimumDeployerBalanceWei = 0n,
}) {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) {
    throw new Error("deployment RPC chain does not match configured network");
  }
  const [router, usdc, usdt, governance] = await Promise.all([
    runtimeCode(provider, config.router, "CCIP router"),
    runtimeCode(provider, settings.usdc, "USDC"),
    runtimeCode(provider, settings.usdt, "USDT"),
    runtimeCode(provider, settings.governance, "governance"),
  ]);
  const [usdcDecimals, usdtDecimals] = await Promise.all([
    tokenDecimals(provider, settings.usdc),
    tokenDecimals(provider, settings.usdt),
  ]);
  if (usdcDecimals !== 6 || usdtDecimals !== 6) {
    throw new Error("USDC and USDT must both report exactly six decimals");
  }
  const additional = settings.deployGateway
    ? [await runtimeCode(provider, settings.gatewaySettings.warpPortal, "Warp portal")]
    : [await runtimeCode(provider, settings.gateway, "hub gateway")];
  const deployerAddress = ethers.getAddress(deployer);
  const deployerBalanceWei = await provider.getBalance(deployerAddress);
  if (deployerBalanceWei < minimumDeployerBalanceWei) {
    throw new Error("deployer balance is below the configured deployment minimum");
  }
  return {
    chainId: Number(network.chainId),
    deployer: deployerAddress,
    deployerBalanceWei: deployerBalanceWei.toString(),
    minimumDeployerBalanceWei: minimumDeployerBalanceWei.toString(),
    tokenDecimals: { usdc: usdcDecimals, usdt: usdtDecimals },
    runtimeCodeHashes: Object.fromEntries(
      [router, usdc, usdt, governance, ...additional].map((item) => [item.address, item.codeHash]),
    ),
  };
}

function preflightRuntimeHash(preflight, address, label) {
  const hashes = preflight.inspection?.runtimeCodeHashes;
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) {
    throw new Error("preflight evidence runtime code hashes are invalid");
  }
  const expected = ethers.getAddress(address).toLowerCase();
  const match = Object.entries(hashes).find(([candidate]) => {
    try {
      return ethers.getAddress(candidate).toLowerCase() === expected;
    } catch {
      return false;
    }
  });
  if (!match || !ethers.isHexString(match[1], 32)) {
    throw new Error(`preflight evidence is missing ${label} runtime code`);
  }
  return match[1].toLowerCase();
}

function validatePreflightEvidence({
  evidencePath,
  sourceSha,
  networkName,
  config,
  settings,
  inspection,
  now = Date.now(),
  maximumAgeSeconds = 3600,
}) {
  if (!Number.isSafeInteger(maximumAgeSeconds) || maximumAgeSeconds < 60 || maximumAgeSeconds > 86400) {
    throw new Error("SOLSLOT_OMNICHAIN_PREFLIGHT_MAX_AGE_SECONDS must be between 60 and 86400");
  }
  const preflight = readEvidence(evidencePath, "preflight");
  if (
    preflight.schemaVersion !== 1 ||
    preflight.kind !== "solslot-omnichain-testnet-deployment-preflight" ||
    preflight.sourceSha !== sourceSha ||
    preflight.network !== networkName ||
    preflight.chainId !== config.chainId ||
    preflight.chainSelector !== config.selector ||
    preflight.hubName !== settings.hubName ||
    preflight.hubChainSelector !== settings.hubChainSelector.toString() ||
    preflight.deploymentMode !== (settings.deployGateway ? "new_gateway_and_spoke" : "new_spoke")
  ) {
    throw new Error("preflight evidence does not match this deployment");
  }
  const checkedAt = Date.parse(String(preflight.checkedAt || ""));
  if (!Number.isFinite(checkedAt) || checkedAt > now + 60_000 || now - checkedAt > maximumAgeSeconds * 1000) {
    throw new Error("preflight evidence is stale or has an invalid timestamp");
  }
  const declared = preflight.settings;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
    throw new Error("preflight evidence settings are invalid");
  }
  const expectedAddresses = {
    ccipRouter: config.router,
    payout: settings.payout,
    governance: settings.governance,
    usdc: settings.usdc,
    usdt: settings.usdt,
    ...(settings.deployGateway
      ? { warpPortal: settings.gatewaySettings.warpPortal }
      : { hubGateway: settings.gateway }),
  };
  for (const [label, expected] of Object.entries(expectedAddresses)) {
    if (!ethers.isAddress(declared[label]) || ethers.getAddress(declared[label]) !== ethers.getAddress(expected)) {
      throw new Error(`preflight evidence ${label} does not match this deployment`);
    }
  }
  if (
    declared.callbackGas !== settings.callbackGas.toString() ||
    declared.emergencyDelay !== settings.emergencyDelay.toString() ||
    declared.confirmations !== settings.confirmations
  ) {
    throw new Error("preflight evidence numeric settings do not match this deployment");
  }
  if (preflight.inspection?.tokenDecimals?.usdc !== 6 || preflight.inspection?.tokenDecimals?.usdt !== 6) {
    throw new Error("preflight evidence stablecoin decimals are invalid");
  }
  for (const [label, address] of Object.entries(expectedAddresses)) {
    if (["payout"].includes(label)) continue;
    const expectedHash = preflightRuntimeHash(preflight, address, label);
    const observedHash = inspection.runtimeCodeHashes[ethers.getAddress(address)];
    if (!observedHash || observedHash.toLowerCase() !== expectedHash) {
      throw new Error(`preflight evidence ${label} runtime code has changed`);
    }
  }
  return preflight;
}

module.exports = {
  deploymentSettings,
  inspectDeploymentReadiness,
  isTestnet,
  requiredUint,
  validatePreflightEvidence,
};

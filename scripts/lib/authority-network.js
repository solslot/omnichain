/** EVM authority selection is independent of the Chia asset network. */
const AUTHORITY_NETWORKS = Object.freeze({
  baseMainnet: Object.freeze({ chainId: 8453, rpcVariable: "BASE_MAINNET_RPC_URL" }),
  baseSepolia: Object.freeze({ chainId: 84532, rpcVariable: "BASE_SEPOLIA_RPC_URL" }),
});

function authorityNetwork(name, chainId) {
  const selected = typeof name === "string" && Object.hasOwn(AUTHORITY_NETWORKS, name)
    ? AUTHORITY_NETWORKS[name] : undefined;
  if (!selected || !Number.isSafeInteger(chainId) || selected.chainId !== chainId) {
    throw new Error("Authority V3 network and chain ID do not match a supported Base deployment");
  }
  return selected;
}

async function verifyAuthorityNetwork(provider, name, chainId) {
  const selected = authorityNetwork(name, chainId);
  const observed = await provider.getNetwork();
  if (observed.chainId !== BigInt(selected.chainId)) {
    throw new Error("Authority V3 RPC chain differs from the selected deployment evidence");
  }
  return selected;
}

function authorityRpcUrl(name, chainId, environment) {
  const selected = authorityNetwork(name, chainId);
  const value = environment[selected.rpcVariable];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${selected.rpcVariable} is required for the selected authority network`);
  }
  let parsed;
  try { parsed = new URL(value); } catch {
    throw new Error("Authority V3 RPC URL is invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Authority V3 RPC URL must use HTTP or HTTPS");
  }
  return value;
}

module.exports = { authorityNetwork, authorityRpcUrl, verifyAuthorityNetwork };

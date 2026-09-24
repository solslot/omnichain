const { ethers } = require("ethers");
const deployments = require("@safe-global/safe-deployments");
const { stableJson } = require("./deployment-evidence");
const { safeSaltNonce } = require("./governance-deployment");
const { check } = require("./bounded-base-deployment");
const { ADMIN_SLOT, IMPLEMENTATION_SLOT, PORTAL_CHAIN, readPinnedWarpArtifacts, readWarpValidatorRoster } = require("./warp-portal-deployment");
const FALLBACK_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const addressInSlot = value => ethers.getAddress(`0x${value.slice(-40)}`);
const lower = value => value.toLowerCase();
function safeDependencies() {
  return [deployments.getProxyFactoryDeployment, deployments.getSafeL2SingletonDeployment,
    deployments.getCompatibilityFallbackHandlerDeployment].map(get => {
    const item = get({version: "1.4.1", network: "8453"}).deployments.canonical;
    return {address: lower(item.address), runtimeCodeHash: item.codeHash};
  });
}
async function portalSpec({rpcUrl, rosterPath, rosterHash, sourceRoot, deployer, startNonce}) {
  const {roster, addresses} = readWarpValidatorRoster(rosterPath, rosterHash, 8453);
  const artifacts = readPinnedWarpArtifacts(sourceRoot);
  const saltNonce = safeSaltNonce(roster, "warp_portal");
  const dependencies = safeDependencies();
  const setup = new ethers.Interface(["function setup(address[],uint256,address,bytes,address,address,uint256,address)"])
    .encodeFunctionData("setup", [addresses, 2, ethers.ZeroAddress, "0x", dependencies[2].address, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const factoryInterface = new ethers.Interface(["function createProxyWithNonce(address,bytes,uint256)", "function proxyCreationCode() view returns (bytes)"]);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  let creationCode;
  try {
    check(ethers.keccak256(await provider.getCode(dependencies[0].address)) === dependencies[0].runtimeCodeHash, "Safe factory runtime differs");
    creationCode = await new ethers.Contract(dependencies[0].address, factoryInterface, provider).proxyCreationCode();
  } finally { provider.destroy(); }
  const create2Salt = ethers.keccak256(ethers.solidityPacked(["bytes32", "uint256"], [ethers.keccak256(setup), saltNonce]));
  const safe = lower(ethers.getCreate2Address(dependencies[0].address, create2Salt,
    ethers.keccak256(ethers.concat([creationCode, ethers.zeroPadValue(dependencies[1].address, 32)]))));
  const safeTx = {to: dependencies[0].address, data: factoryInterface.encodeFunctionData("createProxyWithNonce", [dependencies[1].address, setup, saltNonce])};
  const implementation = lower(ethers.getCreateAddress({from: deployer, nonce: startNonce + 1}));
  const proxy = lower(ethers.getCreateAddress({from: deployer, nonce: startNonce + 2}));
  const admin = lower(ethers.getCreateAddress({from: proxy, nonce: 1}));
  const initialize = new ethers.Interface(artifacts.portal.abi).encodeFunctionData("initialize", [safe, 0, addresses, 2, [PORTAL_CHAIN]]);
  const proxyTx = await new ethers.ContractFactory(artifacts.proxy.abi, artifacts.proxy.bytecode).getDeployTransaction(implementation, safe, initialize);
  return {artifacts, dependencies, binding: {kind: "solslot-native-test-portal", rosterHash,
    owners: addresses.map(lower), threshold: 2, safeVersion: "1.4.1", saltNonce, safe,
    implementation, proxy, admin, fallbackHandler: dependencies[2].address},
  operations: [
    {name: "validatorSafe", to: ethers.getAddress(safeTx.to), data: safeTx.data, addresses: [safe]},
    {name: "portalImplementation", to: null, data: artifacts.portal.bytecode, addresses: [implementation]},
    {name: "portalProxy", to: null, data: proxyTx.data, addresses: [proxy, admin]},
  ]};
}
function verifyPlanSpec(plan, spec) {
  check(stableJson(plan.binding) === stableJson(spec.binding), "portal binding differs");
  check(stableJson(plan.dependencies) === stableJson(spec.dependencies), "Safe dependencies differ");
  check(plan.transactions.length === 3, "portal requires exactly three operations");
  for (const [i, op] of spec.operations.entries()) {
    const tx = plan.transactions[i];
    check(tx.name === op.name && tx.to === op.to && tx.data === op.data &&
      stableJson(tx.created.map(c => c.address)) === stableJson(op.addresses), "portal operation differs");
  }
  check(plan.transactions[1].created[0].runtimeCodeHash === ethers.keccak256(spec.artifacts.portal.deployedBytecode), "implementation runtime differs");
  check(plan.transactions[2].created[1].runtimeCodeHash === ethers.keccak256(spec.artifacts.proxyAdmin.deployedBytecode), "ProxyAdmin runtime differs");
}
async function verifyPortalStep(plan, index, providers, artifacts) {
  const b = plan.binding;
  for (const p of providers) {
    const safe = new ethers.Contract(b.safe, ["function getOwners() view returns (address[])",
      "function getThreshold() view returns (uint256)", "function getModulesPaginated(address,uint256) view returns (address[],address)",
      "function VERSION() view returns (string)"], p);
    const [owners, threshold, version, fallback, guard, modules, singleton] = await Promise.all([
      safe.getOwners(), safe.getThreshold(), safe.VERSION(), p.getStorage(b.safe, FALLBACK_SLOT),
      p.getStorage(b.safe, GUARD_SLOT), safe.getModulesPaginated("0x0000000000000000000000000000000000000001", 10),
      p.getStorage(b.safe, 0),
    ]);
    check(owners.map(lower).sort().join() === [...b.owners].sort().join() && threshold === 2n && version === "1.4.1" &&
      lower(addressInSlot(fallback)) === b.fallbackHandler && BigInt(guard) === 0n && modules[0].length === 0 &&
      lower(addressInSlot(singleton)) === plan.dependencies[1].address, "Safe configuration differs");
    if (index < 2) continue;
    const portal = new ethers.Contract(b.proxy, artifacts.portal.abi, p);
    const admin = new ethers.Contract(b.admin, artifacts.proxyAdmin.abi, p);
    const [owner, toll, required, xch, adminOwner, adminSlot, implSlot] = await Promise.all([
      portal.owner(), portal.messageToll(), portal.signatureThreshold(), portal.supportedChains(PORTAL_CHAIN),
      admin.owner(), p.getStorage(b.proxy, ADMIN_SLOT), p.getStorage(b.proxy, IMPLEMENTATION_SLOT),
    ]);
    check(lower(owner) === b.safe && toll === 0n && required === 2n && xch === true && lower(adminOwner) === b.safe &&
      lower(addressInSlot(adminSlot)) === b.admin && lower(addressInSlot(implSlot)) === b.implementation, "portal configuration differs");
    check((await Promise.all(b.owners.map(address => portal.isSigner(address)))).every(Boolean), "portal signer differs");
  }
}
module.exports = {portalSpec, verifyPlanSpec, verifyPortalStep};

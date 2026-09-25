// Constructor bindings for the paused Base escrow. No signer or broadcast here.
const { ethers } = require('ethers');
const { sha256, stableJson } = require('./deployment-evidence');
const { check } = require('./bounded-base-deployment');

function requireHash(record, expected, field = 'artifactHash') {
  check(record && ethers.isHexString(expected, 32) && BigInt(expected) !== 0n, 'artifact hash required');
  const body = {...record}; delete body[field];
  check(record[field] === expected && sha256(body) === expected, 'artifact hash differs');
}

function validateCoordinates({basePortal, basePortalHash, chiaPortal, chiaPortalHash, routes,
    expectedSamuelSha, expectedBridge, expectedTokens}) {
  requireHash(basePortal, basePortalHash);
  requireHash(chiaPortal, chiaPortalHash, 'manifestHash');
  check(basePortal.kind === 'solslot-native-bridge-base-mainnet-portal-deployment' &&
    basePortal.chainId === 8453 && basePortal.chiaNetwork === 'testnet11' && basePortal.testOnly === true &&
    Number.isSafeInteger(basePortal.confirmations) && basePortal.confirmations >= 12,
  'confirmed Base portal required');
  check(chiaPortal.kind === 'solslot-native-base-testnet11-portal-launch-confirmation' &&
    chiaPortal.network === 'testnet11' && chiaPortal.chainId === 8453 && chiaPortal.testOnly === true &&
    chiaPortal.broadcast === true && chiaPortal.confirmed === true &&
    chiaPortal.source?.commit === expectedSamuelSha && /^[0-9a-f]{40}$/.test(expectedSamuelSha) &&
    chiaPortal.basePortal?.artifactHash === basePortalHash &&
    chiaPortal.basePortal?.address.toLowerCase() === basePortal.portal.address.toLowerCase() &&
    chiaPortal.providerAgreement?.count === 2 && chiaPortal.providerAgreement?.minimumConfirmations >= 12 &&
    ethers.isHexString(chiaPortal.providerAgreement?.confirmationBlockHash, 32),
  'confirmed Chia portal binding required');
  check(basePortal.safe?.threshold === 2 && basePortal.portal?.signatureThreshold === 2 &&
    basePortal.safe.owners.length === 3 && new Set(basePortal.safe.owners.map(a => a.toLowerCase())).size === 3 &&
    basePortal.safe.owners.map(a => a.toLowerCase()).sort().join() === basePortal.portal.signers.map(a => a.toLowerCase()).sort().join() &&
    basePortal.portal.owner.toLowerCase() === basePortal.safe.address.toLowerCase() &&
    chiaPortal.validatorRoster?.artifactHash === basePortal.validatorRosterArtifactHash,
  'portal authority differs');
  check(Array.isArray(routes) && routes.length === 2 && expectedTokens.length === 2 &&
    new Set(expectedTokens.map(t => t.toLowerCase())).size === 2, 'two distinct fixture routes required');
  for (const [i, route] of routes.entries()) {
    requireHash(route, route.artifactHash);
    check(route.schema === 'solslot.test-asset-route-candidate.v1' && route.testOnly === true &&
      route.network === 'testnet11' && route.paymentChainId === 8453 && route.sourceChainTag === 'bse' &&
      route.fixture === ['TEST-USDC', 'TEST-USDT'][i] && route.sourceSha === expectedSamuelSha &&
      route.portalLauncherId === chiaPortal.spend.launcherId &&
      route.erc20Bridge === expectedBridge.toLowerCase() && route.tokenAddress === expectedTokens[i].toLowerCase() &&
      route.tokenDecimals === 6 && route.catDecimals === 3 && route.erc20UnitsPerCatMojo === '1000',
    'derived fixture route differs');
    for (const key of ['catTailHash', 'catMinterPuzzleHash', 'catBurnerPuzzleHash'])
      check(ethers.isHexString(route[key], 32) && BigInt(route[key]) !== 0n, 'nonzero CAT coordinate required');
  }
  check(routes[0].catMinterPuzzleHash === routes[1].catMinterPuzzleHash &&
    routes[0].catBurnerPuzzleHash === routes[1].catBurnerPuzzleHash &&
    routes[0].catMinterPuzzleHash !== routes[0].catBurnerPuzzleHash && routes[0].catTailHash !== routes[1].catTailHash,
  'CAT routes are inconsistent');
  return routes;
}

async function assetBridgeSpec({deployer, nonce, governance, transferLimitMojos, outstandingLimitMojos,
    maxMessageTollWei, artifact, ...coordinates}) {
  check(ethers.isAddress(deployer) && ethers.isAddress(governance) && governance !== ethers.ZeroAddress &&
    Number.isSafeInteger(nonce) && nonce >= 0, 'deployer, nonce and governance required');
  const address = ethers.getCreateAddress({from: deployer, nonce}).toLowerCase();
  const routes = validateCoordinates({...coordinates, expectedBridge: address});
  check(governance.toLowerCase() === coordinates.basePortal.safe.address.toLowerCase(),
    'initial escrow governance must be the confirmed validator Safe');
  for (const n of [transferLimitMojos, outstandingLimitMojos])
    check(typeof n === 'string' && /^[1-9][0-9]{0,19}$/.test(n) && BigInt(n) < (1n << 64n), 'uint64 limits required');
  check(BigInt(outstandingLimitMojos) >= BigInt(transferLimitMojos), 'outstanding limit below transfer limit');
  check(typeof maxMessageTollWei === 'string' && /^(0|[1-9][0-9]{0,24})$/.test(maxMessageTollWei), 'bounded toll required');
  check(artifact.contractName === 'SolslotTestAssetBridge', 'reviewed escrow artifact required');
  const binding = {kind: 'solslot-native-test-asset-escrow', bridge: address, governance: governance.toLowerCase(),
    evmPortal: coordinates.basePortal.portal.address.toLowerCase(), portalLauncherId: coordinates.chiaPortal.spend.launcherId,
    basePortalArtifactHash: coordinates.basePortalHash, chiaPortalArtifactHash: coordinates.chiaPortalHash,
    samuelSourceSha: coordinates.expectedSamuelSha, routeArtifactHashes: routes.map(r => r.artifactHash),
    tokens: coordinates.expectedTokens.map(a => a.toLowerCase()), catTailHashes: routes.map(r => r.catTailHash),
    mintPuzzleHash: routes[0].catMinterPuzzleHash, burnPuzzleHash: routes[0].catBurnerPuzzleHash,
    maxTransferMojos: transferLimitMojos, maxOutstandingMojos: outstandingLimitMojos, maxMessageTollWei,
    startsPaused: true};
  const args = [binding.governance, binding.evmPortal, ...binding.tokens, binding.portalLauncherId,
    binding.mintPuzzleHash, binding.burnPuzzleHash, transferLimitMojos, outstandingLimitMojos, maxMessageTollWei];
  const transaction = await new ethers.ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...args);
  return {binding, operation: {name: 'testAssetBridge', to: null, data: transaction.data, addresses: [address]}};
}

function verifyAssetBridgePlan(plan, spec) {
  check(stableJson(plan.binding) === stableJson(spec.binding) && plan.transactions.length === 1,
    'escrow plan binding differs');
  const tx = plan.transactions[0], op = spec.operation;
  check(tx.name === op.name && tx.to === null && tx.data === op.data &&
    stableJson(tx.created.map(c => c.address)) === stableJson(op.addresses), 'escrow constructor differs');
}

async function verifyPausedBridge(provider, binding, artifact, tokenRuntimeHash) {
  const bridge = new ethers.Contract(binding.bridge, artifact.abi, provider);
  const expected = {owner: binding.governance, pendingOwner: ethers.ZeroAddress, portal: binding.evmPortal,
    usdc: binding.tokens[0], usdt: binding.tokens[1], portalLauncherId: binding.portalLauncherId,
    mintPuzzleHash: binding.mintPuzzleHash, burnPuzzleHash: binding.burnPuzzleHash,
    maxTransferMojos: BigInt(binding.maxTransferMojos), maxOutstandingMojos: BigInt(binding.maxOutstandingMojos),
    maxMessageToll: BigInt(binding.maxMessageTollWei), tokenRuntimeHash, TEST_ONLY: true,
    CHIA_NETWORK: 11n, CHIA_CHAIN: '0x786368', ERC20_UNITS_PER_CAT_MOJO: 1000n,
    paused: true, depositSequence: 0n};
  // Read all bindings at the same block, then recheck that block's canonical hash.
  const block = await provider.getBlock('latest');
  for (const [field, value] of Object.entries(expected)) {
    const actual = await bridge[field]({blockTag: block.number});
    check(typeof actual === 'string' ? actual.toLowerCase() === String(value).toLowerCase() : actual === value,
      'deployed escrow differs: ' + field);
  }
  for (const token of binding.tokens)
    check(await bridge.outstandingMojos(token, {blockTag: block.number}) === 0n, 'new escrow has liability');
  check((await provider.getBlock(block.number))?.hash === block.hash, 'escrow observation reorganized');
  return {blockNumber: block.number, blockHash: block.hash, paused: true};
}

module.exports = {validateCoordinates, assetBridgeSpec, verifyAssetBridgePlan, verifyPausedBridge};

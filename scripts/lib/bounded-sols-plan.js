const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {ethers} = require('ethers');
const {check} = require('./bounded-base-deployment');
const {readEvidence, stableJson, sha256, withArtifactHash} = require('./deployment-evidence');
const {readChiaConfirmation} = require('./native-asset-context');
const {validateWarpPortalEvidence} = require('./warp-portal-deployment');

const KEYS = ['schema', 'testOnly', 'basePortalPath', 'basePortalHash', 'basePortalSourceSha',
  'chiaPortalPath', 'chiaPortalHash', 'chiaPortalSourceSha', 'genesisPath', 'genesisHash',
  'protocolRoot', 'protocolSourceSha', 'samuelRoot', 'samuelSourceSha', 'omnichainSourceSha',
  'python', 'chiaRpcRoot', 'chiaRpcPort', 'maxTransferMojos', 'maxSupplyMojos', 'maxMessageTollWei'];
function solsInputs(input) {
  check(input && Object.keys(input).sort().join() === [...KEYS].sort().join(), 'SOLS input fields differ');
  check(input.schema === 'solslot.bounded-native-sols-inputs.v1' && input.testOnly === true, 'Test SOLS input required');
  for (const k of ['basePortalHash', 'chiaPortalHash', 'genesisHash'])
    check(/^0x[0-9a-f]{64}$/.test(input[k]) && input[k] !== ethers.ZeroHash, 'Exact SOLS artifact hash required');
  for (const k of ['basePortalSourceSha', 'chiaPortalSourceSha', 'protocolSourceSha', 'samuelSourceSha', 'omnichainSourceSha'])
    check(/^[0-9a-f]{40}$/.test(input[k]) && !/^0+$/.test(input[k]), 'Exact SOLS source required');
  for (const k of ['basePortalPath', 'chiaPortalPath', 'genesisPath', 'protocolRoot', 'samuelRoot', 'python', 'chiaRpcRoot'])
    check(typeof input[k] === 'string' && path.isAbsolute(input[k]), 'Absolute SOLS input path required');
  check(Number.isInteger(input.chiaRpcPort) && input.chiaRpcPort > 0 && input.chiaRpcPort <= 65535, 'Invalid Chia RPC port');
  for (const k of ['maxTransferMojos', 'maxSupplyMojos', 'maxMessageTollWei'])
    check(typeof input[k] === 'string' && /^(0|[1-9][0-9]*)$/.test(input[k]) && input[k].length <= 78, 'Canonical SOLS limit required');
  check(BigInt(input.maxTransferMojos) > 0n && BigInt(input.maxSupplyMojos) >= BigInt(input.maxTransferMojos) &&
    BigInt(input.maxSupplyMojos) < 2n ** 64n && BigInt(input.maxMessageTollWei) < 2n ** 256n, 'SOLS limits outside contract bounds');
  const base = readEvidence(input.basePortalPath), chia = readChiaConfirmation(input.chiaPortalPath, input.chiaPortalHash);
  check(base.artifactHash === input.basePortalHash && base.sourceSha === input.basePortalSourceSha, 'Base portal provenance differs');
  check(chia.source?.commit === input.chiaPortalSourceSha && chia.network === 'testnet11' && chia.chainId === 8453 &&
    chia.testOnly === true && chia.confirmed === true && chia.providerAgreement?.count === 2 &&
    chia.providerAgreement?.minimumConfirmations >= 12 && chia.validatorRoster?.threshold === 2 &&
    chia.validatorRoster?.blsPublicKeys?.length === 3 && chia.basePortal?.artifactHash === base.artifactHash &&
    chia.basePortal?.address.toLowerCase() === base.portal.address.toLowerCase() &&
    chia.validatorRoster.artifactHash === base.validatorRosterArtifactHash, 'Chia/Base portal binding differs');
  return {input, base, chia};
}

async function solsContext({input, providers, deployer, startNonce}) {
  check(providers.length === 2, 'Two Base providers required');
  const context = solsInputs(input), {base, chia} = context;
  for (const provider of providers) await validateWarpPortalEvidence({path: input.basePortalPath, provider,
    expectedPortal: base.portal.address, expectedOmnichainSourceSha: input.basePortalSourceSha,
    expectedRosterArtifactHash: chia.validatorRoster.artifactHash, expectedValidatorAddresses: base.portal.signers,
    expectedChainId: 8453, minimumConfirmations: 12});
  const wrappedSols = ethers.getCreateAddress({from: deployer, nonce: startNonce}).toLowerCase();
  // The helper validates owner-plus-one signatures and all reconstructed genesis
  // outputs against two Chia nodes. No cached browser verification is accepted.
  const derived = JSON.parse(execFileSync(input.python, ['-I', path.resolve(__dirname, '../derive-native-sols-route.py')], {
    input: JSON.stringify({...input, chiaPortal: chia, wrappedSols}), encoding: 'utf8', timeout: 240000, maxBuffer: 1024 * 1024,
  }));
  return {...context, ...derived};
}

async function solsSpec({context, sourceRoot, deployer, startNonce}) {
  const {input, base, chia, route} = context;
  const {artifactHash, ...body} = route;
  const wrappedSols = ethers.getCreateAddress({from: deployer, nonce: startNonce}).toLowerCase();
  check(artifactHash === sha256(body) && route.schema === 'solslot.native-sols-route-candidate.v1' &&
    route.status === 'derived-not-activated' && route.testOnly === true && route.network === 'testnet11' &&
    route.paymentChainId === 8453 && route.sourceSha === input.samuelSourceSha && route.genesisArtifactHash === input.genesisHash &&
    route.wrappedSols === wrappedSols && route.portalLauncherId === chia.spend.launcherId &&
    route.nativeDecimals === 3 && route.wrappedDecimals === 3 && route.wrappedUnitsPerCatMojo === '1', 'Native SOLS route differs');
  for (const k of ['nativeSolsAssetId', 'lockerPuzzleHash', 'unlockerPuzzleHash', 'lockedInnerPuzzleHash', 'lockedCatPuzzleHash'])
    check(/^0x[0-9a-f]{64}$/.test(route[k]) && route[k] !== ethers.ZeroHash, 'Native SOLS route hash invalid');
  const artifact = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'artifacts/contracts/SolslotTestSols.sol/SolslotTestSols.json')));
  const iface = new ethers.Interface(artifact.abi);
  const args = [base.safe.address, base.portal.address, route.portalLauncherId, route.nativeSolsAssetId,
    route.lockerPuzzleHash, route.unlockerPuzzleHash, input.maxTransferMojos, input.maxSupplyMojos, input.maxMessageTollWei];
  const data = (await new ethers.ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...args)).data;
  const values = {owner: base.safe.address, pendingOwner: ethers.ZeroAddress, portal: base.portal.address,
    portalLauncherId: route.portalLauncherId, nativeSolsAssetId: route.nativeSolsAssetId, lockerPuzzleHash: route.lockerPuzzleHash,
    unlockerPuzzleHash: route.unlockerPuzzleHash, maxTransferMojos: input.maxTransferMojos, maxSupplyMojos: input.maxSupplyMojos,
    maxMessageToll: input.maxMessageTollWei, TEST_ONLY: true, CHIA_NETWORK: 11, CHIA_CHAIN: '0x786368',
    decimals: 3, name: 'Solslot Test Wrapped Sols', symbol: 'TEST-wSOLS', totalSupply: 0, paused: true};
  const finalChecks = Object.entries(values).map(([fn, value]) => ({to: wrappedSols,
    data: iface.encodeFunctionData(fn), result: iface.encodeFunctionResult(fn, [value])}));
  const dependencies = [[base.portal.address, base.runtimeCodeHashes.portal], [base.proxy.implementation, base.runtimeCodeHashes.implementation],
    [base.proxy.admin, base.runtimeCodeHashes.proxyAdmin], [base.safe.address, base.runtimeCodeHashes.safe]]
    .map(([address, runtimeCodeHash]) => ({address: address.toLowerCase(), runtimeCodeHash}));
  return {binding: {kind: 'solslot-paused-native-sols-deployment', wrappedSols, governance: base.safe.address.toLowerCase(),
    portal: base.portal.address.toLowerCase(), nativeSolsAssetId: route.nativeSolsAssetId, routeArtifactHash: route.artifactHash,
    genesisArtifactHash: input.genesisHash, basePortalArtifactHash: base.artifactHash, chiaPortalArtifactHash: chia.manifestHash,
    protocolSourceSha: input.protocolSourceSha, samuelSourceSha: input.samuelSourceSha, omnichainSourceSha: input.omnichainSourceSha,
    basePortalSourceSha: input.basePortalSourceSha, chiaPortalSourceSha: input.chiaPortalSourceSha,
    maxTransferMojos: input.maxTransferMojos, maxSupplyMojos: input.maxSupplyMojos, maxMessageTollWei: input.maxMessageTollWei},
    dependencies, operations: [{name: 'nativeSols', to: null, data, addresses: [wrappedSols], postconditions: finalChecks}],
    finalChecks, context};
}

function verifySolsPlan(plan, spec) {
  check(plan.schema === 'solslot.bounded-base-deployment.v2' && plan.sourceSha === spec.binding.omnichainSourceSha &&
    stableJson(plan.binding) === stableJson(spec.binding) && stableJson(plan.dependencies) === stableJson(spec.dependencies), 'SOLS plan binding differs');
  check(plan.transactions.length === 1, 'One SOLS deployment required');
  const tx = plan.transactions[0], op = spec.operations[0];
  check(tx.name === op.name && tx.to === null && tx.data === op.data &&
    stableJson(tx.created.map(c => c.address)) === stableJson(op.addresses) &&
    stableJson(tx.postconditions) === stableJson(op.postconditions), 'SOLS deployment operation differs');
}
async function verifySolsState(plan, spec, providers) {
  verifySolsPlan(plan, spec);
  for (const provider of providers) {
    for (const dep of [...plan.dependencies, ...plan.transactions[0].created])
      check(ethers.keccak256(await provider.getCode(dep.address)) === dep.runtimeCodeHash, 'SOLS deployed runtime differs');
    for (const c of spec.finalChecks)
      check((await provider.call({to: c.to, data: c.data})).toLowerCase() === c.result.toLowerCase(), 'SOLS final state differs');
  }
}
function solsEvidence(plan, spec, completed) {
  return withArtifactHash({schema: 'solslot.paused-native-sols-deployment.v1', chainId: 8453, chiaNetwork: 'testnet11', testOnly: true,
    actionEnvelopeId: plan.actionEnvelopeId, sourceSha: plan.sourceSha, planHash: plan.planHash, binding: plan.binding,
    address: spec.binding.wrappedSols, runtimeCodeHash: plan.transactions[0].created[0].runtimeCodeHash,
    route: spec.context.route, genesisObservations: spec.context.genesisObservations, transactions: completed,
    paused: true, totalSupply: '0', activationRequired: true, createdAt: new Date().toISOString()});
}
module.exports = {solsInputs, solsContext, solsSpec, verifySolsPlan, verifySolsState, solsEvidence};

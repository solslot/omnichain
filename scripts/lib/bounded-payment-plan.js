const fs = require('node:fs');
const path = require('node:path');
const {ethers} = require('ethers');
const networks = require('../../config/networks.json');
const {check} = require('./bounded-base-deployment');
const {readEvidence, stableJson, withArtifactHash} = require('./deployment-evidence');
const {deploymentSettings, inspectDeploymentReadiness} = require('./deployment-preflight');
const {validatePaymentGovernance} = require('./payment-governance');
const {validateSamuelCoordinates} = require('./samuel-coordinates');
const {validateWarpPortalEvidence} = require('./warp-portal-deployment');

const INPUT_KEYS = ['schema', 'environment', 'evidence', 'portalSourceSha'];
const ENV_KEYS = ['SOLSLOT_OMNICHAIN_TESTNET_DEPLOYMENT', 'SOLSLOT_CHIA_NETWORK', 'SOLSLOT_BRIDGE_TEST_ONLY',
  'PAYOUT_ADDRESS', 'ROOT_SAFE_ADDRESS', 'USDC_ADDRESS', 'GOVERNANCE_ADDRESS', 'CCIP_CALLBACK_GAS',
  'EMERGENCY_REFUND_DELAY_SECONDS', 'SOLSLOT_OMNICHAIN_CONFIRMATIONS', 'DEPLOY_GATEWAY',
  'SOLSLOT_PROTOCOL_SOURCE_SHA', 'SOLSLOT_SAMUEL_SOURCE_SHA', 'HUB_CHAIN_SELECTOR', 'WARP_PORTAL_ADDRESS',
  'WARP_CHIA_CHAIN', 'SAMUEL_BRIDGING_PUZZLE', 'SAMUEL_RETURN_PUZZLE', 'VOUCHER_RESULT_AUTHORIZATION_MOD_HASH',
  'VOUCHER_BURN_INNER_HASH', 'MAX_WARP_TOLL_WEI', 'MAX_CCIP_FEE_WEI'];
const lower = x => x.toLowerCase();
function exact(value, keys, label) {
  check(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join(), `${label} fields differ`);
}
function paymentInputs(input) {
  exact(input, INPUT_KEYS, 'Payment input');
  check(input.schema === 'solslot.bounded-payment-inputs.v1' && /^[0-9a-f]{40}$/.test(input.portalSourceSha), 'Payment input schema or portal source differs');
  exact(input.environment, ENV_KEYS, 'Payment environment');
  check(Object.values(input.environment).every(v => typeof v === 'string'), 'Payment environment must contain strings');
  exact(input.evidence, ['governance', 'samuel', 'portal', 'testAsset'], 'Payment evidence');
  const records = {};
  for (const [name, ref] of Object.entries(input.evidence)) {
    exact(ref, ['path', 'artifactHash'], 'Payment evidence reference');
    check(typeof ref.path === 'string' && path.isAbsolute(ref.path) && ethers.isHexString(ref.artifactHash, 32), 'Payment evidence reference invalid');
    records[name] = readEvidence(ref.path);
    check(records[name].artifactHash === ref.artifactHash, `Reviewed ${name} evidence differs`);
  }
  check(records.portal.sourceSha === input.portalSourceSha, 'Reviewed portal build differs');
  const settings = deploymentSettings({...input.environment, SOLSLOT_TEST_ASSET_EVIDENCE_PATH: input.evidence.testAsset.path},
    networks.baseMainnet, 'baseMainnet', networks);
  check(settings.deployGateway && settings.hubChainSelector === BigInt(networks.baseMainnet.selector), 'Dedicated Base gateway required');
  check(settings.confirmations === 12, 'Bounded payment sequence requires twelve confirmations');
  return {settings, records};
}

// Both providers recheck governance, fixture creation, portal provenance and live
// storage. Historical deployment SHAs stay pinned to their original artifacts.
// A newer deployment tool commit must never relabel an older deployed portal.
async function paymentContext({input, providers, deployer, startNonce}) {
  check(providers.length === 2, 'Two payment providers required');
  const {settings, records} = paymentInputs(input), config = networks.baseMainnet;
  const gateway = ethers.getCreateAddress({from: deployer, nonce: startNonce});
  const samuel = validateSamuelCoordinates(input.evidence.samuel.path,
    {...settings.gatewaySettings, predictedGatewayAddress: gateway}, 8453);
  const inspections = [];
  for (const provider of providers) {
    await validatePaymentGovernance({path: input.evidence.governance.path, provider,
      rootSafe: settings.rootSafe, timelock: settings.governance, expectedChainId: 8453});
    await validateWarpPortalEvidence({path: input.evidence.portal.path, provider,
      expectedPortal: settings.gatewaySettings.warpPortal, expectedOmnichainSourceSha: input.portalSourceSha,
      expectedRosterArtifactHash: samuel.validatorRosterArtifactHash, expectedValidatorAddresses: samuel.validatorEvmAddresses,
      expectedChainId: 8453, minimumConfirmations: settings.confirmations});
    inspections.push(await inspectDeploymentReadiness({provider, config, settings, deployer}));
  }
  check(stableJson(inspections[0].runtimeCodeHashes) === stableJson(inspections[1].runtimeCodeHashes), 'Payment provider runtimes disagree');
  // The journal may already have consumed some nonces. runSequence checks the
  // next exact nonce; coordinates remain bound to the original reviewed nonce.
  return {settings, config, records, runtimeCodeHashes: inspections[0].runtimeCodeHashes};
}

async function paymentSpec({context, sourceRoot, deployer, startNonce}) {
  const {settings: s, config: c, records, runtimeCodeHashes} = context, g = s.gatewaySettings;
  const artifacts = {};
  for (const name of ['SolomonWarpGateway', 'OmnichainEscrowSpoke'])
    artifacts[name] = JSON.parse(fs.readFileSync(path.join(sourceRoot, `artifacts/contracts/${name}.sol/${name}.json`)));
  const operations = [], finalChecks = [];
  const condition = (to, contract, fn, result, args = []) => {
    const iface = new ethers.Interface(artifacts[contract].abi);
    return {to: lower(to), data: iface.encodeFunctionData(fn, args), result: iface.encodeFunctionResult(fn, result)};
  };
  const ownerChecks = (to, contract, pending) => [condition(to, contract, 'owner', [deployer]),
    condition(to, contract, 'pendingOwner', [pending])];
  async function create(name, contract, args, immutableChecks) {
    const address = lower(ethers.getCreateAddress({from: deployer, nonce: startNonce + operations.length}));
    const artifact = artifacts[contract];
    const data = (await new ethers.ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...args)).data;
    const invariants = immutableChecks(address);
    operations.push({name, to: null, data, addresses: [address], postconditions: [...invariants,
      ...ownerChecks(address, contract, ethers.ZeroAddress), condition(address, contract, 'paused', [false])]});
    finalChecks.push(...invariants, ...ownerChecks(address, contract, s.governance), condition(address, contract, 'paused', [true]));
    return address;
  }
  function call(name, address, contract, fn, args, postconditions) {
    operations.push({name, to: ethers.getAddress(address), data: new ethers.Interface(artifacts[contract].abi).encodeFunctionData(fn, args),
      addresses: [], postconditions});
  }
  const gateway = await create('gateway', 'SolomonWarpGateway', [c.router, BigInt(c.selector), g.warpPortal,
    g.warpChiaChain, g.samuelBridgingPuzzle, g.samuelReturnPuzzle, s.callbackGas, g.maxWarpTollWei, g.maxCcipFeeWei],
    a => Object.entries({getRouter: c.router, localChainSelector: c.selector, warpPortal: g.warpPortal,
      chiaChain: g.warpChiaChain, samuelBridgingPuzzle: g.samuelBridgingPuzzle, samuelReturnPuzzle: g.samuelReturnPuzzle,
      resultGasLimit: s.callbackGas, maxWarpToll: g.maxWarpTollWei, maxCcipFee: g.maxCcipFeeWei})
      .map(([fn, value]) => condition(a, 'SolomonWarpGateway', fn, [value])));
  const gc = (fn, result, args) => condition(gateway, 'SolomonWarpGateway', fn, result, args);
  call('pauseGateway', gateway, 'SolomonWarpGateway', 'pause', [], [gc('paused', [true])]);
  call('gatewayOwnershipTransfer', gateway, 'SolomonWarpGateway', 'transferOwnership', [s.governance],
    [...ownerChecks(gateway, 'SolomonWarpGateway', s.governance), gc('paused', [true])]);
  const spoke = await create('spoke', 'OmnichainEscrowSpoke', [c.router, BigInt(c.selector), s.usdc, s.payout,
    s.hubChainSelector, gateway, s.callbackGas, s.emergencyDelay],
    a => Object.entries({getRouter: c.router, localChainSelector: c.selector, usdcToken: s.usdc,
      payoutAddress: s.payout, hubChainSelector: s.hubChainSelector, hubGateway: gateway,
      resultGasLimit: s.callbackGas, emergencyDelay: s.emergencyDelay, depositCount: 0})
      .map(([fn, value]) => condition(a, 'OmnichainEscrowSpoke', fn, [value])));
  const sc = (fn, result, args) => condition(spoke, 'OmnichainEscrowSpoke', fn, result, args);
  call('pauseSpoke', spoke, 'OmnichainEscrowSpoke', 'pause', [], [sc('paused', [true])]);
  call('trustedSpokeUpdate', gateway, 'SolomonWarpGateway', 'setTrustedSpoke', [c.selector, spoke],
    [gc('trustedSpokes', [spoke], [c.selector]), gc('paused', [true]), sc('paused', [true])]);
  call('spokeOwnershipTransfer', spoke, 'OmnichainEscrowSpoke', 'transferOwnership', [s.governance],
    [...ownerChecks(spoke, 'OmnichainEscrowSpoke', s.governance), sc('paused', [true])]);
  finalChecks.push(gc('trustedSpokes', [spoke], [c.selector]));
  const dependencies = Object.entries(runtimeCodeHashes).map(([address, runtimeCodeHash]) => ({address: lower(address), runtimeCodeHash}));
  const binding = {kind: 'solslot-paused-payment-deployment', gateway, spoke, rootSafe: lower(s.rootSafe), timelock: lower(s.governance),
    testAsset: {address: lower(s.usdc), fixture: records.testAsset.fixture, decimals: 6},
    evidence: Object.fromEntries(Object.entries(records).map(([name, record]) => [name, record.artifactHash])),
    portalSourceSha: records.portal.sourceSha, samuelSourceSha: g.samuelSourceSha, protocolSourceSha: g.protocolSourceSha};
  return {binding, dependencies, operations, finalChecks, context};
}

function verifyPaymentPlan(plan, spec) {
  check(plan.schema === 'solslot.bounded-base-deployment.v2', 'Payment postconditions required');
  check(stableJson(plan.binding) === stableJson(spec.binding) && stableJson(plan.dependencies) === stableJson(spec.dependencies), 'Payment binding differs');
  check(plan.transactions.length === spec.operations.length, 'Payment operation count differs');
  for (const [i, op] of spec.operations.entries()) {
    const tx = plan.transactions[i];
    check(tx.name === op.name && tx.to === op.to && tx.data === op.data &&
      stableJson(tx.created.map(c => c.address)) === stableJson(op.addresses) &&
      stableJson(tx.postconditions) === stableJson(op.postconditions), 'Payment operation differs');
  }
}

async function verifyPaymentState(plan, spec, providers) {
  verifyPaymentPlan(plan, spec);
  for (const provider of providers) {
    for (const dep of [...plan.dependencies, ...plan.transactions.flatMap(t => t.created)])
      check(ethers.keccak256(await provider.getCode(dep.address)) === dep.runtimeCodeHash, 'Payment deployed runtime differs');
    for (const condition of spec.finalChecks)
      check((await provider.call({to: condition.to, data: condition.data})).toLowerCase() === condition.result.toLowerCase(), 'Payment final state differs');
  }
}

function paymentEvidence(plan, spec, completed) {
  const {settings: s, config: c} = spec.context, b = plan.binding;
  const hashes = Object.fromEntries([...plan.dependencies, ...plan.transactions.flatMap(t => t.created)].map(d => [lower(d.address), d.runtimeCodeHash]));
  return withArtifactHash({schemaVersion: 5, protocolVersion: 'solslot-v2', rail: 'ccip-warp-escrow',
    sourceSha: plan.sourceSha, network: 'baseMainnet', chainId: 8453, chainSelector: c.selector, confirmations: 12,
    chiaNetwork: 'testnet11', testOnly: true, actionEnvelopeId: plan.actionEnvelopeId, planHash: plan.planHash,
    // This bounded plan replaces the legacy preflight and fixes exact calldata,
    // nonce, per-step checks, dependencies and a total fee ceiling.
    preflightArtifactHash: plan.planHash, governanceArtifactHash: b.evidence.governance,
    samuelCoordinateArtifactHash: b.evidence.samuel, warpPortalArtifactHash: b.evidence.portal, testAssetArtifactHash: b.evidence.testAsset,
    contracts: {ccipRouter: c.router, gateway: b.gateway, spoke: b.spoke, usdc: s.usdc},
    configuration: {hubChainSelector: String(s.hubChainSelector), callbackGas: String(s.callbackGas), emergencyDelay: String(s.emergencyDelay),
      payoutAddress: s.payout, governanceRootSafe: s.rootSafe, governanceTimelock: s.governance,
      samuelSourceSha: b.samuelSourceSha, predictedGatewayAddress: ethers.getAddress(b.gateway), ownershipAccepted: false, paused: true},
    deploymentTransactions: Object.fromEntries(completed.map(r => [r.name, {hash: r.transactionHash, blockNumber: r.blockNumber}])),
    runtimeCodeHashes: Object.fromEntries(Object.entries({ccipRouter: c.router, gateway: b.gateway, spoke: b.spoke,
      usdc: s.usdc, governanceRootSafe: s.rootSafe, governanceTimelock: s.governance}).map(([name, address]) => [name, hashes[lower(address)]])),
    createdAt: new Date().toISOString()});
}
module.exports = {paymentInputs, paymentContext, paymentSpec, verifyPaymentPlan, verifyPaymentState, paymentEvidence};

const fs = require('node:fs');
const path = require('node:path');
const {ethers} = require('ethers');
const deployments = require('@safe-global/safe-deployments');
const {check} = require('./bounded-base-deployment');
const {stableJson, withArtifactHash} = require('./deployment-evidence');
const {safeSaltNonce} = require('./governance-deployment');

const FALLBACK_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
const GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';
const SENTINEL = '0x0000000000000000000000000000000000000001';
const lower = value => value.toLowerCase();
const SAFE_ABI = [
  'function setup(address[],uint256,address,bytes,address,address,uint256,address)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function getStorageAt(uint256,uint256) view returns (bytes)',
  'function getModulesPaginated(address,uint256) view returns (address[],address)',
];

function authorityDependencies() {
  return [deployments.getProxyFactoryDeployment, deployments.getSafeL2SingletonDeployment,
    deployments.getCompatibilityFallbackHandlerDeployment, deployments.getSignMessageLibDeployment].map(get => {
    const item = get({version: '1.4.1', network: '8453'}).deployments.canonical;
    return {address: lower(item.address), runtimeCodeHash: item.codeHash};
  });
}

async function authoritySpec({authority, providers, sourceRoot, deployer, startNonce}) {
  check(authority.authorityChainId === 8453, 'Authority sequence requires Base 8453');
  // The deployed coordinator initializes on-chain recovery revisions at one.
  // A rotated kit needs an explicit migration, not misleading evidence.
  check(authority.recoveryKeyRevisions.every(n => n === 1), 'Fresh Authority V3 deployment requires revision-one recovery kits');
  check(providers.length === 2, 'Two independent providers required');
  const dependencies = authorityDependencies();
  for (const provider of providers) {
    check((await provider.getNetwork()).chainId === 8453n, 'Authority provider chain differs');
    for (const dep of dependencies)
      check(ethers.keccak256(await provider.getCode(dep.address)) === dep.runtimeCodeHash, 'Safe infrastructure runtime differs');
  }
  const factoryInterface = new ethers.Interface([
    'function createProxyWithNonce(address,bytes,uint256)',
    'function proxyCreationCode() view returns (bytes)',
  ]);
  const creationCodes = await Promise.all(providers.map(p => new ethers.Contract(dependencies[0].address, factoryInterface, p).proxyCreationCode()));
  check(creationCodes[0] === creationCodes[1], 'Safe factory creation code disagrees');
  const proxyInitCodeHash = ethers.keccak256(ethers.concat([creationCodes[0], ethers.zeroPadValue(dependencies[1].address, 32)]));
  const artifacts = {};
  for (const name of ['SolslotAdminRecoveryV3', 'SolslotAuthorityGuardV3', 'SolslotOwnerIdentitySetup', 'SolslotAlphaTimelock']) {
    artifacts[name] = JSON.parse(fs.readFileSync(path.join(sourceRoot, `artifacts/contracts/${name}.sol/${name}.json`)));
  }
  const operations = [];
  function condition(to, abi, name, args, result) {
    const iface = new ethers.Interface(abi);
    return {to: lower(to), data: iface.encodeFunctionData(name, args), result: iface.encodeFunctionResult(name, result)};
  }
  function getter(to, contract, name, result, args = []) {
    return condition(to, artifacts[contract].abi, name, args, result);
  }
  async function create(name, contract, args, checks) {
    const address = lower(ethers.getCreateAddress({from: deployer, nonce: startNonce + operations.length}));
    const artifact = artifacts[contract];
    const tx = await new ethers.ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...args);
    operations.push({name, to: null, data: tx.data, addresses: [address], postconditions: checks(address)});
    return address;
  }
  const recovery = await create('recovery', 'SolslotAdminRecoveryV3', [deployer, authority.authorityLauncherId,
    authority.identityLauncherIds, 'testnet11', authority.sourceManifestHash,
    authority.administrators.map(a => ethers.keccak256(a.compressedPubkey)), authority.guardians,
    authority.recoveryBlsCommitments], address => [
    getter(address, 'SolslotAdminRecoveryV3', 'initializer', [deployer]),
    getter(address, 'SolslotAdminRecoveryV3', 'authorityLauncherId', [authority.authorityLauncherId]),
    getter(address, 'SolslotAdminRecoveryV3', 'identityLauncherIds', [authority.identityLauncherIds]),
    getter(address, 'SolslotAdminRecoveryV3', 'sourceManifestHash', [authority.sourceManifestHash]),
    getter(address, 'SolslotAdminRecoveryV3', 'recoveryGuardians', [authority.guardians]),
    getter(address, 'SolslotAdminRecoveryV3', 'recoveryBlsCommitments', [authority.recoveryBlsCommitments]),
    getter(address, 'SolslotAdminRecoveryV3', 'recoveryKeyRevisions', [[1, 1, 1]]),
    getter(address, 'SolslotAdminRecoveryV3', 'topologyBound', [false]),
    getter(address, 'SolslotAdminRecoveryV3', 'ROUTINE_DELAY_SECONDS', [86400]),
    getter(address, 'SolslotAdminRecoveryV3', 'LOST_KEY_DELAY_SECONDS', [604800]),
  ]);
  const guards = [];
  for (const name of ['identityGuard0', 'identityGuard1', 'identityGuard2', 'coadminGuard', 'rootGuard']) {
    guards.push(await create(name, 'SolslotAuthorityGuardV3', [deployer, dependencies[3].address, recovery], address => [
      getter(address, 'SolslotAuthorityGuardV3', 'initializer', [deployer]),
      getter(address, 'SolslotAuthorityGuardV3', 'signMessageLibrary', [dependencies[3].address]),
      getter(address, 'SolslotAuthorityGuardV3', 'recoveryCoordinator', [recovery]),
      getter(address, 'SolslotAuthorityGuardV3', 'authoritySafe', [ethers.ZeroAddress]),
    ]));
  }
  // The stateless setup helper is checked by its exact compiled runtime hash.
  const setup = await create('identitySetup', 'SolslotOwnerIdentitySetup', [], () => [
    getter(recovery, 'SolslotAdminRecoveryV3', 'topologyBound', [false]),
  ]);
  const setupInterface = new ethers.Interface(artifacts.SolslotOwnerIdentitySetup.abi);
  function safe(name, label, owners, threshold, guard, identity) {
    const setupData = setupInterface.encodeFunctionData(identity ? 'configureIdentity' : 'configureStatic', identity ? [recovery, guard] : [guard]);
    const init = new ethers.Interface(SAFE_ABI).encodeFunctionData('setup', [owners, threshold, setup, setupData,
      dependencies[2].address, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
    const saltNonce = safeSaltNonce(authority.roster, label);
    const salt = ethers.keccak256(ethers.solidityPacked(['bytes32', 'uint256'], [ethers.keccak256(init), saltNonce]));
    const address = lower(ethers.getCreate2Address(dependencies[0].address, salt, proxyInitCodeHash));
    const c = (fn, args, result) => condition(address, SAFE_ABI, fn, args, result);
    operations.push({name, to: ethers.getAddress(dependencies[0].address),
      data: factoryInterface.encodeFunctionData('createProxyWithNonce', [dependencies[1].address, init, saltNonce]),
      addresses: [address], postconditions: [
        c('getOwners', [], [owners]), c('getThreshold', [], [threshold]), c('VERSION', [], ['1.4.1']),
        c('getStorageAt', [0, 1], [ethers.zeroPadValue(dependencies[1].address, 32)]),
        c('getStorageAt', [FALLBACK_SLOT, 1], [ethers.zeroPadValue(dependencies[2].address, 32)]),
        c('getStorageAt', [GUARD_SLOT, 1], [ethers.zeroPadValue(guard, 32)]),
        c('getModulesPaginated', [SENTINEL, 10], [identity ? [recovery] : [], SENTINEL]),
      ]});
    return address;
  }
  const identities = authority.owners.map((owner, i) => safe(`identitySafe${i}`, `identity_${i}`, [owner], 1, guards[i], true));
  const coadmin = safe('coadminSafe', 'coadmin', identities.slice(1), 1, guards[3], false);
  const root = safe('rootSafe', 'root', [identities[0], coadmin], 2, guards[4], false);
  operations.push({name: 'bindTopology', to: ethers.getAddress(recovery),
    data: new ethers.Interface(artifacts.SolslotAdminRecoveryV3.abi).encodeFunctionData('bindAuthorityTopology', [identities, coadmin, root]),
    addresses: [], postconditions: [getter(recovery, 'SolslotAdminRecoveryV3', 'topologyBound', [true]),
      getter(recovery, 'SolslotAdminRecoveryV3', 'identitySafes', [identities]),
      getter(recovery, 'SolslotAdminRecoveryV3', 'coadminSafe', [coadmin]),
      getter(recovery, 'SolslotAdminRecoveryV3', 'rootSafe', [root]) ]});
  for (const [i, address] of [...identities, coadmin, root].entries()) {
    operations.push({name: `bindGuard${i}`, to: ethers.getAddress(guards[i]),
      data: new ethers.Interface(artifacts.SolslotAuthorityGuardV3.abi).encodeFunctionData('bindAuthoritySafe', [address]),
      addresses: [], postconditions: [getter(guards[i], 'SolslotAuthorityGuardV3', 'authoritySafe', [address])]});
  }
  const timelock = await create('timelock', 'SolslotAlphaTimelock', [86400, [root], [root]], address => [
    getter(address, 'SolslotAlphaTimelock', 'getMinDelay', [86400]),
    ...['PROPOSER_ROLE', 'EXECUTOR_ROLE', 'CANCELLER_ROLE'].map(role =>
      getter(address, 'SolslotAlphaTimelock', 'hasRole', [true], [ethers.id(role), root])),
    getter(address, 'SolslotAlphaTimelock', 'hasRole', [true], [ethers.id('TIMELOCK_ADMIN_ROLE'), address]),
    getter(address, 'SolslotAlphaTimelock', 'hasRole', [false], [ethers.id('TIMELOCK_ADMIN_ROLE'), deployer]),
  ]);
  return {authority, dependencies, operations, binding: {kind: 'solslot-authority-v3-deployment',
    rosterArtifactHash: authority.roster.artifactHash, sourceManifestHash: authority.sourceManifestHash,
    authorityLauncherId: authority.authorityLauncherId, identityLauncherIds: authority.identityLauncherIds,
    recovery, guards, setup, identities, coadmin, root, timelock}};
}

function verifyAuthorityPlan(plan, spec) {
  check(plan.schema === 'solslot.bounded-base-deployment.v2', 'Authority plan requires checked binding calls');
  check(stableJson(plan.binding) === stableJson(spec.binding), 'Authority binding differs');
  check(stableJson(plan.dependencies) === stableJson(spec.dependencies), 'Authority dependencies differ');
  check(plan.transactions.length === spec.operations.length, 'Authority operation count differs');
  for (const [index, operation] of spec.operations.entries()) {
    const tx = plan.transactions[index];
    check(tx.name === operation.name && tx.to === operation.to && tx.data === operation.data &&
      stableJson(tx.created.map(c => c.address)) === stableJson(operation.addresses) &&
      stableJson(tx.postconditions) === stableJson(operation.postconditions), 'Authority operation differs');
  }
}

function authorityEvidence(plan, spec, completed) {
  const b = plan.binding, a = spec.authority;
  const named = Object.fromEntries(completed.map(r => [r.name, {hash: r.transactionHash, blockNumber: r.blockNumber}]));
  const hashes = Object.fromEntries(plan.transactions.flatMap(tx => tx.created.map(c => [c.address, c.runtimeCodeHash])));
  const runtimeCodeHashes = {recovery: hashes[b.recovery], identitySetup: hashes[b.setup], timelock: hashes[b.timelock],
    coadminSafe: hashes[b.coadmin], rootSafe: hashes[b.root], coadminGuard: hashes[b.guards[3]], rootGuard: hashes[b.guards[4]],
    compatibilityFallbackHandler: spec.dependencies[2].runtimeCodeHash, signMessageLibrary: spec.dependencies[3].runtimeCodeHash};
  for (let i = 0; i < 3; i++) { runtimeCodeHashes[`identitySafe${i}`] = hashes[b.identities[i]]; runtimeCodeHashes[`identityGuard${i}`] = hashes[b.guards[i]]; }
  return withArtifactHash({schemaVersion: 3, kind: 'solslot-alpha-authority-v3-governance-deployment',
    authorityRule: 'slot0_and_one_of_slot1_slot2', sourceSha: plan.sourceSha, network: 'baseMainnet', chainId: 8453,
    testOnly: true, actionEnvelopeId: plan.actionEnvelopeId, planHash: plan.planHash,
    rosterArtifactHash: b.rosterArtifactHash, chiaAuthority: {network: 'testnet11', sourceManifestHash: b.sourceManifestHash,
      authorityLauncherId: b.authorityLauncherId, identityLauncherIds: b.identityLauncherIds},
    administrators: a.administrators.map(({slot, address, compressedPubkey}) => ({slot, address, compressedPubkey})),
    safes: {
      identities: b.identities.map((address, slot) => ({slot, address, owners: [a.owners[slot]], threshold: 1, guard: b.guards[slot], recoveryModule: b.recovery})),
      coadmin: {address: b.coadmin, owners: b.identities.slice(1), threshold: 1, guard: b.guards[3]},
      root: {address: b.root, owners: [b.identities[0], b.coadmin], threshold: 2, guard: b.guards[4]},
    },
    timelock: {address: b.timelock, minimumDelaySeconds: '86400', proposer: b.root, executor: b.root, canceller: b.root, externalAdmin: ethers.ZeroAddress},
    payoutAddress: b.root, recovery: {address: b.recovery, routineDelaySeconds: '86400', lostKeyDelaySeconds: '604800',
      replacementAcceptanceRequired: true, globalFreezeRequired: true, crossChainConvergenceRequired: true,
      recoveryKitRotationSupported: true, rollbackRequiresChiaCancellationReceipt: true,
      identities: a.administrators.map(({slot, recovery: kit}) => ({slot, evmGuardian: kit.evmGuardian, blsPubkey: kit.blsPubkey,
        blsCommitment: kit.blsCommitment, revision: kit.revision, drillVerifiedAt: kit.drillVerifiedAt}))},
    safeInfrastructure: {safeVersion: '1.4.1', compatibilityFallbackHandler: spec.dependencies[2].address,
      signMessageLibrary: spec.dependencies[3].address, identitySetup: b.setup},
    deploymentTransactions: {recovery: named.recovery, identityGuards: [0, 1, 2].map(i => named[`identityGuard${i}`]),
      coadminGuard: named.coadminGuard, rootGuard: named.rootGuard, identitySetup: named.identitySetup,
      identitySafes: [0, 1, 2].map(i => named[`identitySafe${i}`]), coadminSafe: named.coadminSafe, rootSafe: named.rootSafe,
      topologyBinding: named.bindTopology, guardBindings: [0, 1, 2, 3, 4].map(i => named[`bindGuard${i}`]), timelock: named.timelock},
    runtimeCodeHashes, createdAt: new Date().toISOString()});
}
module.exports = {authorityDependencies, authoritySpec, verifyAuthorityPlan, authorityEvidence};

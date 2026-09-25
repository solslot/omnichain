const {expect} = require('chai');
const {ethers, artifacts} = require('hardhat');
const {loadFixture} = require('@nomicfoundation/hardhat-network-helpers');
const {sha256} = require('../scripts/lib/deployment-evidence');
const {assetBridgeSpec, verifyAssetBridgePlan, verifyPausedBridge} = require('../scripts/lib/native-asset-deployment');
const hash = n => ethers.zeroPadValue(ethers.toBeHex(n), 32);
const seal = (record, field = 'artifactHash') => ({...record, [field]: sha256(record)});

describe('Paused native test escrow deployment binding', function () {
  async function setup() {
    const [operator, second, third] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractFactory('SolslotTestToken');
    const usdc = await tokenFactory.deploy(false), usdt = await tokenFactory.deploy(true);
    const portal = await (await ethers.getContractFactory('NativeBridgePortalMock')).deploy();
    const nonce = await operator.getNonce();
    const expectedBridge = ethers.getCreateAddress({from: operator.address, nonce}).toLowerCase();
    const owners = [operator.address, second.address, third.address];
    const source = 'a'.repeat(40), roster = hash(91), launcher = hash(92);
    const base = seal({kind: 'solslot-native-bridge-base-mainnet-portal-deployment', chainId: 8453,
      chiaNetwork: 'testnet11', testOnly: true, confirmations: 12, validatorRosterArtifactHash: roster,
      safe: {address: operator.address, owners, threshold: 2},
      portal: {address: portal.target, owner: operator.address, signers: owners, signatureThreshold: 2}});
    const chia = seal({kind: 'solslot-native-base-testnet11-portal-launch-confirmation', network: 'testnet11',
      chainId: 8453, testOnly: true, broadcast: true, confirmed: true, source: {commit: source},
      basePortal: {artifactHash: base.artifactHash, address: portal.target}, validatorRoster: {artifactHash: roster},
      spend: {launcherId: launcher}, providerAgreement: {count: 2, minimumConfirmations: 12, confirmationBlockHash: hash(93)}}, 'manifestHash');
    const tokens = [usdc.target, usdt.target];
    const routes = tokens.map((token, i) => seal({schema: 'solslot.test-asset-route-candidate.v1',
      testOnly: true, network: 'testnet11', paymentChainId: 8453, sourceChainTag: 'bse',
      fixture: ['TEST-USDC', 'TEST-USDT'][i], sourceSha: source, portalLauncherId: launcher,
      erc20Bridge: expectedBridge, tokenAddress: token.toLowerCase(), tokenDecimals: 6, catDecimals: 3,
      erc20UnitsPerCatMojo: '1000', catTailHash: hash(94 + i), catMinterPuzzleHash: hash(96), catBurnerPuzzleHash: hash(97)}));
    const artifact = await artifacts.readArtifact('SolslotTestAssetBridge');
    const options = {deployer: operator.address, nonce, governance: operator.address,
      transferLimitMojos: '100000', outstandingLimitMojos: '250000', maxMessageTollWei: '0', artifact,
      basePortal: base, basePortalHash: base.artifactHash, chiaPortal: chia, chiaPortalHash: chia.manifestHash,
      routes, expectedSamuelSha: source, expectedTokens: tokens};
    const spec = await assetBridgeSpec(options);
    return {operator, options, spec, artifact, usdc, usdt};
  }
  const copy = x => JSON.parse(JSON.stringify(x));
  async function rejected(promise, message) {
    try { await promise; } catch (error) { expect(error.message).to.include(message); return; }
    throw new Error('expected rejection');
  }

  it('deploys exact constructor and verifies all immutable bindings while paused', async function () {
    const f = await loadFixture(setup);
    const receipt = await (await f.operator.sendTransaction({data: f.spec.operation.data})).wait();
    expect(receipt.contractAddress.toLowerCase()).to.equal(f.spec.binding.bridge);
    const tokenHash = ethers.keccak256(await ethers.provider.getCode(f.usdc.target));
    expect((await verifyPausedBridge(ethers.provider, f.spec.binding, f.artifact, tokenHash)).paused).to.equal(true);
    const bridge = await ethers.getContractAt('SolslotTestAssetBridge', receipt.contractAddress);
    await bridge.unpause();
    await rejected(verifyPausedBridge(ethers.provider, f.spec.binding, f.artifact, tokenHash), 'paused');
  });

  for (const mutation of ['unconfirmed', 'wrong-domain', 'wrong-source', 'wrong-base', 'one-provider'])
    it('refuses a resealed but invalid Chia portal: ' + mutation, async function () {
      const f = await loadFixture(setup), options = {...f.options, chiaPortal: copy(f.options.chiaPortal)};
      delete options.chiaPortal.manifestHash;
      if (mutation === 'unconfirmed') options.chiaPortal.confirmed = false;
      if (mutation === 'wrong-domain') options.chiaPortal.network = 'mainnet';
      if (mutation === 'wrong-source') options.chiaPortal.source.commit = 'b'.repeat(40);
      if (mutation === 'wrong-base') options.chiaPortal.basePortal.artifactHash = hash(101);
      if (mutation === 'one-provider') options.chiaPortal.providerAgreement.count = 1;
      options.chiaPortal = seal(options.chiaPortal, 'manifestHash'); options.chiaPortalHash = options.chiaPortal.manifestHash;
      await rejected(assetBridgeSpec(options), 'confirmed Chia portal binding required');
    });

  it('refuses a substituted token, bridge nonce or swapped route', async function () {
    const f = await loadFixture(setup);
    await rejected(assetBridgeSpec({...f.options, expectedTokens: [...f.options.expectedTokens].reverse()}), 'derived fixture route differs');
    await rejected(assetBridgeSpec({...f.options, nonce: f.options.nonce + 1}), 'derived fixture route differs');
    await rejected(assetBridgeSpec({...f.options, routes: [...f.options.routes].reverse()}), 'derived fixture route differs');
  });

  it('refuses stale artifact commitments', async function () {
    const f = await loadFixture(setup), routes = copy(f.options.routes); routes[0].catTailHash = hash(777);
    await rejected(assetBridgeSpec({...f.options, routes}), 'artifact hash differs');
  });

  it('refuses an owner outside the confirmed validator Safe', async function () {
    const f = await loadFixture(setup);
    await rejected(assetBridgeSpec({...f.options, governance: f.usdc.target}), 'confirmed validator Safe');
  });

  it('refuses invalid uint64 amounts and unbounded tolls', async function () {
    const f = await loadFixture(setup);
    await rejected(assetBridgeSpec({...f.options, transferLimitMojos: '0'}), 'uint64');
    await rejected(assetBridgeSpec({...f.options, outstandingLimitMojos: String(1n << 64n)}), 'uint64');
    await rejected(assetBridgeSpec({...f.options, outstandingLimitMojos: '1'}), 'outstanding limit');
    await rejected(assetBridgeSpec({...f.options, maxMessageTollWei: '-1'}), 'bounded toll');
  });

  it('refuses altered constructor bytes or a second activation transaction', async function () {
    const f = await loadFixture(setup), plan = {binding: f.spec.binding, transactions: [{...f.spec.operation,
      created: f.spec.operation.addresses.map(address => ({address}))}]};
    verifyAssetBridgePlan(plan, f.spec);
    expect(() => verifyAssetBridgePlan({...plan, transactions: [...plan.transactions, plan.transactions[0]]}, f.spec)).to.throw('binding differs');
    const bad = copy(plan); bad.transactions[0].data += '00';
    expect(() => verifyAssetBridgePlan(bad, f.spec)).to.throw('constructor differs');
  });
});

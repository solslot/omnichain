const {expect} = require('chai');
const {ethers, network} = require('hardhat');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {solsInputs, solsSpec, verifySolsPlan, verifySolsState, solsEvidence} = require('../scripts/lib/bounded-sols-plan');
const {rehearseSequence} = require('../scripts/lib/bounded-rehearsal');
const {writeEvidence, withArtifactHash, sha256} = require('../scripts/lib/deployment-evidence');
const {readCanonical, writeOnce} = require('../scripts/lib/test-token-deployment');

describe('Bounded native SOLS deployment', function () {
  let snapshot, directory, signer, input, context;
  beforeEach(async function () {
    snapshot = await network.provider.send('evm_snapshot');
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sols-deploy-'));
    [signer] = await ethers.getSigners();
    const portal = await ethers.deployContract('MockWarpPortal');
    const implementation = await ethers.deployContract('MockWarpPortal'), admin = await ethers.deployContract('MockWarpPortal');
    const safe = await ethers.deployContract('MockRouter');
    const codeHash = ethers.keccak256(await ethers.provider.getCode(portal.target));
    // Compact receipts exercise pinning and construction. solsContext performs
    // the full deployed Safe/portal checks and Python genesis verification.
    const base = withArtifactHash({sourceSha: 'a'.repeat(40), validatorRosterArtifactHash: ethers.id('roster'),
      portal: {address: portal.target}, safe: {address: safe.target}, proxy: {implementation: implementation.target, admin: admin.target},
      runtimeCodeHashes: {portal: codeHash, implementation: codeHash, proxyAdmin: codeHash, safe: ethers.keccak256(await ethers.provider.getCode(safe.target))}});
    const body = {source: {commit: 'b'.repeat(40)}, network: 'testnet11', chainId: 8453, testOnly: true, confirmed: true,
      providerAgreement: {count: 2, minimumConfirmations: 12}, validatorRoster: {threshold: 2, blsPublicKeys: ['a', 'b', 'c'], artifactHash: base.validatorRosterArtifactHash},
      basePortal: {artifactHash: base.artifactHash, address: portal.target}, spend: {launcherId: ethers.id('launcher')}};
    const chia = {...body, manifestHash: sha256(body)};
    const basePortalPath = path.join(directory, 'base.json'), chiaPortalPath = path.join(directory, 'chia.json');
    writeEvidence(basePortalPath, base); writeOnce(chiaPortalPath, chia);
    input = {schema: 'solslot.bounded-native-sols-inputs.v1', testOnly: true, basePortalPath, basePortalHash: base.artifactHash,
      basePortalSourceSha: base.sourceSha, chiaPortalPath, chiaPortalHash: chia.manifestHash, chiaPortalSourceSha: body.source.commit,
      genesisPath: '/unused/genesis.json', genesisHash: ethers.id('fresh signed genesis'), protocolRoot: '/unused/protocol',
      protocolSourceSha: 'c'.repeat(40), samuelRoot: '/unused/samuel', samuelSourceSha: 'd'.repeat(40), omnichainSourceSha: 'e'.repeat(40),
      python: '/unused/python', chiaRpcRoot: '/unused/rpc', chiaRpcPort: 8555,
      maxTransferMojos: '1000000', maxSupplyMojos: '10000000', maxMessageTollWei: '0'};
    context = solsInputs(input);
  });
  afterEach(async function () {await network.provider.send('evm_revert', [snapshot]); fs.rmSync(directory, {recursive: true, force: true});});
  async function makeSpec() {
    const startNonce = await signer.getNonce();
    const route = withArtifactHash({schema: 'solslot.native-sols-route-candidate.v1', status: 'derived-not-activated',
      testOnly: true, network: 'testnet11', paymentChainId: 8453, sourceSha: input.samuelSourceSha,
      genesisArtifactHash: input.genesisHash, wrappedSols: ethers.getCreateAddress({from: signer.address, nonce: startNonce}).toLowerCase(),
      portalLauncherId: context.chia.spend.launcherId, nativeSolsAssetId: ethers.id('native three decimal SOLS'),
      nativeDecimals: 3, wrappedDecimals: 3, wrappedUnitsPerCatMojo: '1', lockerPuzzleHash: ethers.id('locker'),
      unlockerPuzzleHash: ethers.id('unlocker'), lockedInnerPuzzleHash: ethers.id('locked inner'), lockedCatPuzzleHash: ethers.id('locked CAT')});
    const ctx = {...context, route, genesisObservations: [{height: 100, blockHash: ethers.id('genesis')}, {height: 100, blockHash: ethers.id('genesis')}]};
    return {spec: await solsSpec({context: ctx, sourceRoot: process.cwd(), deployer: signer.address, startNonce}), startNonce};
  }
  async function rehearse() {
    const {spec, startNonce} = await makeSpec();
    await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1e8480']);
    return {spec, ...await rehearseSequence({spec, signer, local: ethers.provider, deployer: signer.address, startNonce,
      sourceSha: input.omnichainSourceSha, actionEnvelopeId: 'AE-SOLSLOT-SOLS-TEST', publicBlock: {baseFeePerGas: 2000000n}, auxiliaryFee: async () => 1000n})};
  }
  it('deploys paused, binds exact native CAT and decimal units, and records no faucet supply', async function () {
    const {spec, plan, completed} = await rehearse();
    await verifySolsState(plan, spec, [ethers.provider]);
    const token = await ethers.getContractAt('SolslotTestSols', spec.binding.wrappedSols);
    expect(await token.decimals()).to.equal(3);
    expect(await token.nativeSolsAssetId()).to.equal(spec.context.route.nativeSolsAssetId);
    expect(await token.totalSupply()).to.equal(0);
    await expect(token.bridgeBack(ethers.id('receiver'), 1)).to.be.revertedWith('Pausable: paused');
    await expect(token.transfer(signer.address, 0)).to.be.revertedWith('Pausable: paused');
    const file = path.join(directory, 'plan.json'); writeOnce(file, plan); expect(readCanonical(file)).to.deep.equal(plan);
    const evidence = solsEvidence(plan, spec, completed);
    expect(evidence).to.include({paused: true, activationRequired: true, totalSupply: '0'});
    expect(evidence.binding.genesisArtifactHash).to.equal(input.genesisHash);
  });
  it('rejects changed token identity, calldata, source and activation during reconciliation', async function () {
    const {spec, plan} = await rehearse();
    for (const mutate of [p => p.binding.nativeSolsAssetId = ethers.id('other'), p => p.sourceSha = 'f'.repeat(40),
      p => p.transactions[0].data += '00', p => p.transactions[0].postconditions.pop()]) {
      const changed = structuredClone(plan); mutate(changed); expect(() => verifySolsPlan(changed, spec)).to.throw();
    }
    await network.provider.send('hardhat_setBalance', [context.base.safe.address, '0x100000000000000000']);
    await network.provider.send('hardhat_impersonateAccount', [context.base.safe.address]);
    await (await ethers.getContractAt('SolslotTestSols', spec.binding.wrappedSols, await ethers.getSigner(context.base.safe.address))).unpause();
    await network.provider.send('hardhat_stopImpersonatingAccount', [context.base.safe.address]);
    await expect(verifySolsState(plan, spec, [ethers.provider])).to.be.rejectedWith('final state differs');
  });
  it('rejects relabelled historical sources, unknown input and unbounded amounts', async function () {
    for (const change of [{basePortalSourceSha: 'f'.repeat(40)}, {chiaPortalSourceSha: 'f'.repeat(40)}, {testOnly: false},
      {maxTransferMojos: '0'}, {maxSupplyMojos: String(2n ** 64n)}, {maxTransferMojos: '10000001'},
      {maxMessageTollWei: '-1'}, {privateKey: 'forbidden'}]) expect(() => solsInputs({...input, ...change})).to.throw();
    const {spec, startNonce} = await makeSpec();
    const bad = structuredClone(spec.context);
    bad.route.wrappedDecimals = 6;
    const {artifactHash, ...body} = bad.route; bad.route = withArtifactHash(body);
    await expect(solsSpec({context: bad, sourceRoot: process.cwd(), deployer: signer.address, startNonce})).to.be.rejectedWith('route differs');
  });
});

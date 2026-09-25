const {expect} = require('chai');
const {ethers, network} = require('hardhat');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {withArtifactHash, writeEvidence} = require('../scripts/lib/deployment-evidence');
const {readAuthorityV3Roster, validateAuthorityV3GovernanceEvidence} = require('../scripts/lib/authority-v3-deployment');
const {authorityDependencies, authoritySpec, verifyAuthorityPlan} = require('../scripts/lib/bounded-authority-plan');
const {rehearseAuthority} = require('../scripts/prepare-bounded-authority');
const {safeSaltNonce} = require('../scripts/lib/governance-deployment');
const {readCanonical, writeOnce} = require('../scripts/lib/test-token-deployment');

function baseView() {
  return new Proxy(ethers.provider, {get(target, property) {
    if (property === 'getNetwork') return async () => ({chainId: 8453n});
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  }});
}

describe('Bounded Authority V3 deployment', function () {
  let directory, snapshot, authority, provider, signer, spec;
  beforeEach(async function () {
    snapshot = await network.provider.send('evm_snapshot');
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-sequence-'));
    [signer] = await ethers.getSigners(); provider = baseView();
    // Real Safe runtimes, at their real deterministic addresses. No mocks for
    // delegatecall setup, module lists, nested ownership, or guard binding.
    const files = ['proxies/SafeProxyFactory.sol/SafeProxyFactory.json', 'SafeL2.sol/SafeL2.json',
      'handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json', 'libraries/SignMessageLib.sol/SignMessageLib.json'];
    for (const [i, dep] of authorityDependencies().entries()) {
      const artifact = require(path.join(__dirname, 'fixtures/safe-1.4.1', files[i]));
      expect(ethers.keccak256(artifact.deployedBytecode)).to.equal(dep.runtimeCodeHash);
      await network.provider.send('hardhat_setCode', [dep.address, artifact.deployedBytecode]);
    }
    const administrators = [0, 1, 2].map(slot => {
      const wallet = ethers.Wallet.createRandom(), guardian = ethers.Wallet.createRandom(), key = `0x${String(slot + 31).repeat(48)}`;
      return {slot, address: wallet.address, compressedPubkey: wallet.signingKey.compressedPublicKey,
        recovery: {evmGuardian: guardian.address, blsPubkey: key, blsCommitment: ethers.keccak256(key), revision: 1,
          drillVerifiedAt: '2026-07-28T12:00:00.000Z'}};
    });
    const roster = withArtifactHash({schemaVersion: 3, kind: 'solslot-alpha-authority-v3-roster',
      network: 'testnet11', paymentChainId: 8453, evmChainId: 11155111, ceremonyState: 'planned',
      ceremonyId: ethers.id('fixture ceremony'), authorityRule: 'slot0_and_one_of_slot1_slot2',
      sourceManifestHash: ethers.id('fixture source manifest'), authorityLauncherId: ethers.id('fixture authority'),
      identityLauncherIds: [0, 1, 2].map(i => ethers.id(`fixture identity ${i}`)), administrators});
    const file = path.join(directory, 'roster.json'); writeEvidence(file, roster);
    authority = readAuthorityV3Roster(file, 8453);
    spec = await authoritySpec({authority, providers: [provider, provider], sourceRoot: process.cwd(),
      deployer: signer.address, startNonce: await signer.getNonce()});
  });
  afterEach(async function () {
    await network.provider.send('evm_revert', [snapshot]);
    fs.rmSync(directory, {recursive: true, force: true});
  });
  it('accepts numbered identity salt labels and keeps every slot and roster distinct', function () {
    const salts = [0, 1, 2].map(i => safeSaltNonce(authority.roster, `identity_${i}`));
    expect(new Set(salts).size).to.equal(3);
    expect(safeSaltNonce({...authority.roster, artifactHash: ethers.id('another')}, 'identity_0')).not.to.equal(salts[0]);
    expect(() => safeSaltNonce(authority.roster, 'identity/0')).to.throw('invalid');
  });
  it('executes and verifies the complete 19-step owner-plus-one topology with official Safe bytecode', async function () {
    await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1e8480']);
    const result = await rehearseAuthority({spec, signer, local: ethers.provider, deployer: signer.address,
      startNonce: await signer.getNonce(), sourceSha: 'a'.repeat(40), actionEnvelopeId: 'AE-SOLSLOT-AUTHORITY-TEST',
      publicBlock: {baseFeePerGas: 2000000n}, auxiliaryFee: async () => 1000n});
    expect(result.completed).to.have.length(19);
    const planPath = path.join(directory, 'plan.json');
    writeOnce(planPath, result.plan);
    expect(readCanonical(planPath)).to.deep.equal(result.plan);
    const evidencePath = path.join(directory, 'rehearsal.json'); writeEvidence(evidencePath, result.evidence);
    await validateAuthorityV3GovernanceEvidence({path: evidencePath, provider, rootSafe: spec.binding.root, timelock: spec.binding.timelock});
    const altered = structuredClone(result.plan);
    altered.transactions[12].data = '0x12345678';
    expect(() => verifyAuthorityPlan(altered, spec)).to.throw('operation differs');
    const alteredCheck = structuredClone(result.plan);
    alteredCheck.transactions[12].postconditions[0].result = ethers.ZeroHash;
    expect(() => verifyAuthorityPlan(alteredCheck, spec)).to.throw('operation differs');
    // Immutable snapshot checks still succeed after later steps bind the
    // recovery coordinator and the guards. Latest state would fail here.
    for (const [i, tx] of result.plan.transactions.entries()) for (const check of tx.postconditions)
      expect((await ethers.provider.call({to: check.to, data: check.data, blockTag: result.completed[i].blockNumber})).toLowerCase()).to.equal(check.result.toLowerCase());
  });
  it('refuses a rotated kit that cannot match the constructor revision', async function () {
    await expect(authoritySpec({authority: {...authority, recoveryKeyRevisions: [2, 1, 1]}, providers: [provider, provider],
      sourceRoot: process.cwd(), deployer: signer.address, startNonce: 0})).to.be.rejectedWith('revision-one');
  });
});

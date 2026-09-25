const {expect} = require('chai');
const {ethers, network} = require('hardhat');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {rehearseSequence} = require('../scripts/lib/bounded-rehearsal');
const {paymentInputs, paymentSpec, verifyPaymentPlan, verifyPaymentState, paymentEvidence} = require('../scripts/lib/bounded-payment-plan');
const {writeEvidence, withArtifactHash} = require('../scripts/lib/deployment-evidence');
const {writeOnce, readCanonical} = require('../scripts/lib/test-token-deployment');
const networks = require('../config/networks.json');

describe('Bounded paused payment deployment', function () {
  let snapshot, directory, signer, root, timelock, token, context, input;
  beforeEach(async function () {
    snapshot = await network.provider.send('evm_snapshot');
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-sequence-'));
    [signer] = await ethers.getSigners();
    const rootContract = await ethers.deployContract('MockRouter');
    root = {address: rootContract.target};
    const router = await ethers.deployContract('MockRouter'), portal = await ethers.deployContract('MockWarpPortal');
    token = await ethers.deployContract('SolslotTestToken', [false]);
    timelock = await ethers.deployContract('SolslotAlphaTimelock', [86400, [root.address], [root.address]]);
    const environment = {SOLSLOT_OMNICHAIN_TESTNET_DEPLOYMENT: 'true', SOLSLOT_CHIA_NETWORK: 'testnet11', SOLSLOT_BRIDGE_TEST_ONLY: 'true',
      PAYOUT_ADDRESS: root.address, ROOT_SAFE_ADDRESS: root.address, USDC_ADDRESS: token.target, GOVERNANCE_ADDRESS: timelock.target,
      CCIP_CALLBACK_GAS: '500000', EMERGENCY_REFUND_DELAY_SECONDS: '604800', SOLSLOT_OMNICHAIN_CONFIRMATIONS: '12', DEPLOY_GATEWAY: 'true',
      SOLSLOT_PROTOCOL_SOURCE_SHA: 'a'.repeat(40), SOLSLOT_SAMUEL_SOURCE_SHA: 'b'.repeat(40), HUB_CHAIN_SELECTOR: networks.baseMainnet.selector,
      WARP_PORTAL_ADDRESS: portal.target, WARP_CHIA_CHAIN: '0x786368', SAMUEL_BRIDGING_PUZZLE: ethers.id('bridging puzzle'),
      SAMUEL_RETURN_PUZZLE: ethers.id('return puzzle'), VOUCHER_RESULT_AUTHORIZATION_MOD_HASH: ethers.id('authorization puzzle'),
      VOUCHER_BURN_INNER_HASH: ethers.id('burn puzzle'), MAX_WARP_TOLL_WEI: '1', MAX_CCIP_FEE_WEI: '1000000000000000'};
    // These compact records test input pinning, not governance/portal validation.
    // paymentContext runs the separate on-chain validators before using a spec.
    const evidence = {};
    for (const name of ['governance', 'portal', 'samuel', 'testAsset']) {
      const record = withArtifactHash({fixture: 'TEST-USDC', sourceSha: 'c'.repeat(40), name});
      const file = path.join(directory, `${name}.json`); writeEvidence(file, record);
      evidence[name] = {path: file, artifactHash: record.artifactHash};
    }
    input = {schema: 'solslot.bounded-payment-inputs.v1', environment, evidence, portalSourceSha: 'c'.repeat(40)};
    const runtimeCodeHashes = {};
    for (const address of [router.target, portal.target, token.target, timelock.target, root.address])
      runtimeCodeHashes[address] = ethers.keccak256(await ethers.provider.getCode(address));
    context = {...paymentInputs(input), config: {...networks.baseMainnet, router: router.target}, runtimeCodeHashes};
  });
  afterEach(async function () {
    await network.provider.send('evm_revert', [snapshot]);
    fs.rmSync(directory, {recursive: true, force: true});
  });
  async function rehearse() {
    const startNonce = await signer.getNonce();
    const spec = await paymentSpec({context, sourceRoot: process.cwd(), deployer: signer.address, startNonce});
    await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1e8480']);
    const result = await rehearseSequence({spec, signer, local: ethers.provider, deployer: signer.address, startNonce,
      sourceSha: 'd'.repeat(40), actionEnvelopeId: 'AE-SOLSLOT-PAYMENT-TEST', publicBlock: {baseFeePerGas: 2000000n}, auxiliaryFee: async () => 1000n});
    return {...result, spec};
  }
  it('deploys seven exact operations, rejects purchases while paused, and leaves ownership for the timelock', async function () {
    const {plan, completed, spec} = await rehearse();
    expect(completed).to.have.length(7);
    await verifyPaymentState(plan, spec, [ethers.provider]);
    const gateway = await ethers.getContractAt('SolomonWarpGateway', spec.binding.gateway);
    const spoke = await ethers.getContractAt('OmnichainEscrowSpoke', spec.binding.spoke);
    expect(await gateway.owner()).to.equal(signer.address);
    expect(await spoke.pendingOwner()).to.equal(timelock.target);
    expect(await timelock.getMinDelay()).to.equal(86400);
    await expect(gateway.acceptLocalRequest('0x')).to.be.revertedWith('Pausable: paused');
    await expect(spoke.depositPayment(token.target, ...Array(7).fill(ethers.id('fixture')), 1, 1, 9999999999))
      .to.be.revertedWith('Pausable: paused');
    const file = path.join(directory, 'plan.json'); writeOnce(file, plan);
    expect(readCanonical(file)).to.deep.equal(plan);
    const receipt = paymentEvidence(plan, spec, completed);
    writeEvidence(path.join(directory, 'deployment.json'), receipt);
    expect(receipt.configuration).to.include({ownershipAccepted: false, paused: true});
    expect(receipt.deploymentTransactions.gatewayOwnershipTransfer.hash).to.equal(completed[2].transactionHash);
    expect(receipt.governanceArtifactHash).to.equal(input.evidence.governance.artifactHash);
    // Reconciliation uses receipt-block state after later pause/binding calls.
    for (const [i, tx] of plan.transactions.entries()) for (const check of tx.postconditions)
      expect((await ethers.provider.call({to: check.to, data: check.data, blockTag: completed[i].blockNumber})).toLowerCase()).to.equal(check.result.toLowerCase());
  });
  it('rejects dropped pauses, changed payout calldata, and later unexpected activation', async function () {
    const {plan, spec} = await rehearse();
    const dropped = structuredClone(plan); dropped.transactions.splice(1, 1);
    expect(() => verifyPaymentPlan(dropped, spec)).to.throw('operation count');
    const altered = structuredClone(plan); altered.transactions[3].data += '00';
    expect(() => verifyPaymentPlan(altered, spec)).to.throw('operation differs');
    const checks = structuredClone(plan); checks.transactions[1].postconditions[0].result = ethers.ZeroHash;
    expect(() => verifyPaymentPlan(checks, spec)).to.throw('operation differs');
    const gateway = await ethers.getContractAt('SolomonWarpGateway', spec.binding.gateway);
    await gateway.unpause();
    await expect(verifyPaymentState(plan, spec, [ethers.provider])).to.be.rejectedWith('final state differs');
  });
  it('pins historical portal provenance and refuses unreviewed evidence and ambiguous scope', function () {
    expect(context.records.portal.sourceSha).to.equal('c'.repeat(40));
    const altered = structuredClone(input); altered.evidence.portal.artifactHash = ethers.id('different receipt');
    expect(() => paymentInputs(altered)).to.throw('Reviewed portal evidence differs');
    expect(() => paymentInputs({...input, portalSourceSha: 'd'.repeat(40)})).to.throw('portal build differs');
    for (const [name, value] of [['SOLSLOT_BRIDGE_TEST_ONLY', 'false'], ['SOLSLOT_CHIA_NETWORK', 'mainnet'],
      ['SOLSLOT_OMNICHAIN_CONFIRMATIONS', '1'], ['DEPLOY_GATEWAY', 'false'], ['USDC_ADDRESS', '']]) {
      const copy = structuredClone(input); copy.environment[name] = value;
      expect(() => paymentInputs(copy), name).to.throw();
    }
    const extra = structuredClone(input); extra.environment.DEPLOYER_PRIVATE_KEY = 'not-allowed';
    expect(() => paymentInputs(extra)).to.throw('environment fields');
  });
});

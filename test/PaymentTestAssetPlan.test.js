const {expect} = require('chai');
const {ethers, artifacts} = require('hardhat');
const {prepareFixturePlan, requestFor, validatePlan, seal, runDeployment} = require('../scripts/lib/test-token-deployment');
describe('reviewed USDC and USDT test fixture plans', function () {
  for (const fixture of ['TEST-USDC','TEST-USDT']) {
    it(`pins ${fixture} constructor and deployed runtime`, async function () {
      const [owner] = await ethers.getSigners();
      const artifact = await artifacts.readArtifact('SolslotTestToken');
      const plan = prepareFixturePlan({sourceSha:'a'.repeat(40), actionEnvelopeId:'AE-SOLSLOT-PAYMENT-FIXTURE-TEST',
        deployer:owner.address, nonce:await owner.getNonce(), gasLimit:'1500000', maxFeePerGas:'20000000',
        maxPriorityFeePerGas:'1000000', l1FeeBudgetWei:'100000000000000'}, artifact, fixture);
      const request = requestFor(plan, artifact);
      const factory = await ethers.getContractFactory('SolslotTestToken');
      const token = await factory.deploy(fixture === 'TEST-USDT');
      expect(token.deploymentTransaction().data).to.equal(request.data);
      expect((await token.getAddress()).toLowerCase()).to.equal(plan.tokenAddress);
      expect(ethers.keccak256(await ethers.provider.getCode(await token.getAddress()))).to.equal(plan.runtimeCodeHash);
      expect(await token.symbol()).to.equal(fixture);
      expect(await token.totalSupply()).to.equal(0n);
      const {planHash,...body} = plan;
      expect(() => validatePlan(seal({...body,token:{...body.token,symbol:'USDC'}}))).to.throw('identity');
      expect(() => requestFor(seal({...body,token:{...body.token,symbol:fixture==='TEST-USDC'?'TEST-USDT':'TEST-USDC'}}),artifact)).to.throw();
      let reads=0;
      await expect(runDeployment({plan,artifact,providers:[ethers.provider,{getNetwork:async()=>({chainId:84532n})}],
        execute:true,signerFactory:async()=>{reads++;return owner;}})).to.be.rejectedWith('Base mainnet');
      expect(reads).to.equal(0);
    });
  }
});

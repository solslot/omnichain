const { expect } = require('chai');
const { ethers, artifacts } = require('hardhat');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateTestAssetEvidence, validateTestAssetRecord } = require('../scripts/lib/test-asset-evidence');
const { requireTestAssetScope } = require('../scripts/lib/deployment-preflight');
const { withArtifactHash, writeEvidence } = require('../scripts/lib/deployment-evidence');

describe('Base valueless test assets', function () {
  it('admits the existing pinned TEST-SOLS fixture only with exact creation and runtime evidence', async function () {
    const compiled = await artifacts.readArtifact('SolslotAlphaTestToken');
    const address='0xd48548a2dccb9b05f31a3f342f7bfd14b72c29c3';
    const hash='0x'+'11'.repeat(32), blockHash='0x'+'22'.repeat(32), headHash='0x'+'33'.repeat(32);
    const from='0x4035edd8499ebdd6da3d4f825a7e96e4730993bb';
    const record={schemaVersion:1,kind:'solslot-test-asset-deployment',network:'baseMainnet',chainId:8453,
      chiaNetwork:'testnet11',testOnly:true,fixture:'TEST-SOLS',decimals:6,sourceSha:'a'.repeat(40),address,
      transactionHash:hash,blockHash,blockNumber:100,runtimeCodeHash:ethers.keccak256(compiled.deployedBytecode)};
    const tx={hash,from,to:null,chainId:8453n,value:0n,blockHash,blockNumber:100,
      data:ethers.concat([compiled.bytecode,ethers.AbiCoder.defaultAbiCoder().encode(['address'],[from])])};
    const receipt={hash,contractAddress:address,status:1,blockHash,blockNumber:100};
    const provider={getNetwork:async()=>({chainId:8453n}),getCode:async()=>compiled.deployedBytecode,
      getTransaction:async()=>tx,getTransactionReceipt:async()=>receipt,
      getBlock:async n=>n==='latest'||n===111?{number:111,hash:headHash}:{number:100,hash:blockHash}};
    const args={provider,record,expectedToken:address};
    expect(await validateTestAssetRecord(args)).to.equal(record);
    await expect(validateTestAssetRecord({...args,record:{...record,address:from},expectedToken:from})).to.be.rejectedWith('pinned alpha profile');
    await expect(validateTestAssetRecord({...args,provider:{...provider,getTransaction:async()=>({...tx,data:'0x'})}})).to.be.rejectedWith('reviewed faucet bytecode');
    await expect(validateTestAssetRecord({...args,provider:{...provider,getBlock:async n=>({number:111,hash:headHash})}})).to.be.rejectedWith('not canonical');
  });
  it('uses six decimals and limits repeat self-claims', async function () {
    const [user] = await ethers.getSigners();
    for (const isUsdt of [false, true]) {
      const token = await ethers.deployContract('SolslotTestToken', [isUsdt]);
      expect(await token.decimals()).to.equal(6);
      expect(await token.symbol()).to.equal(isUsdt ? 'TEST-USDT' : 'TEST-USDC');
      await token.claim();
      expect(await token.balanceOf(user.address)).to.equal(10_000n * 10n ** 6n);
      await expect(token.claim()).to.be.reverted;
    }
  });

  it('requires explicit Testnet11 scope on Base', function () {
    const scope = { SOLSLOT_OMNICHAIN_TESTNET_DEPLOYMENT:'true', SOLSLOT_CHIA_NETWORK:'testnet11', SOLSLOT_BRIDGE_TEST_ONLY:'true' };
    expect(() => requireTestAssetScope(scope, 'baseMainnet')).not.to.throw();
    for (const field of Object.keys(scope)) {
      expect(() => requireTestAssetScope({ ...scope, [field]:undefined }, 'baseMainnet')).to.throw();
    }
  });

  it('rejects a real token or altered constructor despite a claimed test label', async function () {
    const token = await ethers.deployContract('SolslotTestToken', [false]);
    await token.waitForDeployment();
    const receipt = await token.deploymentTransaction().wait();
    const tx = await ethers.provider.getTransaction(receipt.hash);
    const code = await ethers.provider.getCode(token.target);
    const value = withArtifactHash({schemaVersion:1,kind:'solslot-test-asset-deployment',network:'baseMainnet',
      chainId:8453,chiaNetwork:'testnet11',testOnly:true,fixture:'TEST-USDC',decimals:6,sourceSha:'a'.repeat(40),
      address:token.target,transactionHash:receipt.hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,
      runtimeCodeHash:ethers.keccak256(code)});
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(),'solslot-test-token-')),'evidence.json');
    writeEvidence(file,value);
    const latest = {number:receipt.blockNumber+11,hash:'0x'+'ee'.repeat(32)};
    const provider = {getNetwork:async()=>({chainId:8453n}),getCode:async()=>code,
      getTransaction:async()=>({...tx,chainId:8453n}),getTransactionReceipt:async()=>receipt,
      getBlock:async n => n==='latest'||n===latest.number ? latest : {hash:receipt.blockHash}};
    const args = {provider,path:file,expectedToken:token.target,artifact:await artifacts.readArtifact('SolslotTestToken')};
    expect((await validateTestAssetEvidence(args)).artifactHash).to.equal(value.artifactHash);
    await expect(validateTestAssetEvidence({...args,provider:{...provider,getTransaction:async()=>({...tx,chainId:8453n,data:'0x6000'})}}))
      .to.be.rejectedWith('reviewed faucet bytecode');
    await expect(validateTestAssetEvidence({...args,provider:{...provider,getBlock:async()=>({number:receipt.blockNumber,hash:receipt.blockHash})}}))
      .to.be.rejectedWith('confirmed creation receipt');
    await expect(validateTestAssetEvidence({...args,provider:{...provider,getNetwork:async()=>({chainId:11155111n})}}))
      .to.be.rejectedWith('RPC chain differs');
  });
});

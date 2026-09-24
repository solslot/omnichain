const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const word = v => ethers.zeroPadValue(ethers.toBeHex(v), 32);
const chia = '0x786368', launcher = word(1), asset = word(2), locker = word(3), unlocker = word(4), receiver = word(5);

describe('Chia-origin test SOLS counterpart', function () {
  async function fixture() {
    const [owner, alice, bob] = await ethers.getSigners();
    const portal = await (await ethers.getContractFactory('NativeBridgePortalMock')).deploy();
    const token = await (await ethers.getContractFactory('SolslotTestSols')).deploy(owner.address, portal.target,
      launcher, asset, locker, unlocker, 100_000, 150_000, 20);
    const mint = (nonce=word(1), amount=10_000, to=alice.address) => portal.deliver(token.target, nonce, chia, locker, [word(to), word(amount)]);
    const burn = (amount=10_000, to=receiver) => token.connect(alice).bridgeBack(to, amount, {value:10});
    return {owner, alice, bob, portal, token, mint, burn};
  }
  async function active() { const f = await fixture(); await f.token.unpause(); return f; }
  it('starts paused, with no supply or faucet, and immutable Chia-origin identity', async function () {
    const f = await loadFixture(fixture);
    expect(await f.token.totalSupply()).to.equal(0);
    expect(await f.token.decimals()).to.equal(3);
    expect(await f.token.nativeSolsAssetId()).to.equal(asset);
    expect(await f.token.portalLauncherId()).to.equal(launcher);
    await expect(f.mint()).to.be.revertedWith('Pausable: paused');
    await expect(f.token.connect(f.alice).unpause()).to.be.revertedWith('Ownable: caller is not the owner');
    expect(f.token.interface.hasFunction('claim')).to.equal(false);
    expect(f.token.interface.hasFunction('initializePuzzleHashes')).to.equal(false);
  });
  it('mints only from a portal lock and burns exact mojo amounts into a Chia return message', async function () {
    const f = await loadFixture(active);
    await expect(f.mint()).to.emit(f.token,'LockMinted').withArgs(word(1), f.alice.address, 10_000);
    expect(await f.token.balanceOf(f.alice.address)).to.equal(10_000);
    await expect(f.burn()).to.emit(f.portal,'MessageSent').withArgs(word(1), f.token.target, chia, unlocker, [receiver, word(10_000)]);
    expect(await f.token.totalSupply()).to.equal(0);
    await expect(f.mint()).to.be.revertedWithCustomError(f.token,'Replay');
    expect(await f.token.totalSupply()).to.equal(0);
  });
  for (const fault of ['caller','chain','source','nonce','length','padding','receiver','self','overflow']) {
    it(`rejects a ${fault} substitution before minting`, async function () {
      const f = await loadFixture(active);
      let nonce=word(1), chain=chia, source=locker, contents=[word(f.alice.address),word(10_000)];
      if (fault==='chain') chain='0x627365';
      if (fault==='source') source=word(20);
      if (fault==='nonce') nonce=word(0);
      if (fault==='length') contents.push(word(1));
      if (fault==='padding') contents[0]=word((1n<<160n)+BigInt(f.alice.address));
      if (fault==='receiver') contents[0]=word(0);
      if (fault==='self') contents[0]=word(f.token.target);
      if (fault==='overflow') contents[1]=word(1n<<64n);
      await expect(fault==='caller' ? f.token.receiveMessage(nonce,chain,source,contents) :
        f.portal.deliver(f.token.target,nonce,chain,source,contents)).to.be.reverted;
      expect(await f.token.totalSupply()).to.equal(0);
      expect(await f.token.usedLockNonces(nonce)).to.equal(false);
    });
  }
  it('enforces per-message and total supply caps without consuming rejected nonces', async function () {
    const f = await loadFixture(active);
    await expect(f.mint(word(1),0)).to.be.revertedWithCustomError(f.token,'AmountLimit');
    await expect(f.mint(word(1),100_001)).to.be.revertedWithCustomError(f.token,'AmountLimit');
    await f.mint(word(1),100_000);
    await expect(f.mint(word(2),50_001)).to.be.revertedWithCustomError(f.token,'SupplyLimit');
    await f.burn(50_000); await f.mint(word(2),100_000);
    expect(await f.token.totalSupply()).to.equal(150_000);
  });
  it('rejects incorrect tolls and rolls back burns when the portal is unavailable', async function () {
    const f = await loadFixture(active); await f.mint();
    await expect(f.token.connect(f.alice).bridgeBack(receiver,10_000,{value:9})).to.be.revertedWithCustomError(f.token,'TollLimit');
    await f.portal.setToll(21);
    await expect(f.token.connect(f.alice).bridgeBack(receiver,10_000,{value:21})).to.be.revertedWithCustomError(f.token,'TollLimit');
    await f.portal.setToll(10); await f.portal.setFail(true);
    await expect(f.burn()).to.be.revertedWith('portal unavailable');
    expect(await f.token.balanceOf(f.alice.address)).to.equal(10_000);
    expect(await f.token.totalSupply()).to.equal(10_000);
  });
  it('honors emergency pause for mint, burn and ordinary token transfer', async function () {
    const f = await loadFixture(active); await f.mint(); await f.token.pause();
    await expect(f.mint(word(2))).to.be.revertedWith('Pausable: paused');
    await expect(f.burn()).to.be.revertedWith('Pausable: paused');
    await expect(f.token.connect(f.alice).transfer(f.bob.address,1)).to.be.revertedWith('Pausable: paused');
  });
  it('never burns someone else’s balance or releases zero/over-limit amounts', async function () {
    const f = await loadFixture(active); await f.mint();
    await expect(f.token.connect(f.bob).bridgeBack(receiver,1,{value:10})).to.be.revertedWith('ERC20: burn amount exceeds balance');
    await expect(f.burn(0)).to.be.revertedWithCustomError(f.token,'AmountLimit');
    await expect(f.burn(100_001)).to.be.revertedWithCustomError(f.token,'AmountLimit');
    await expect(f.burn(1,word(0))).to.be.revertedWithCustomError(f.token,'InvalidMessage');
    expect(await f.token.totalSupply()).to.equal(10_000);
  });
});

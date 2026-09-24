const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

const word = value => ethers.zeroPadValue(ethers.toBeHex(value), 32);
const chia = '0x786368';
const launcher = word(1), minter = word(2), burner = word(3), receiver = word(4);

describe('Solslot native test-asset escrow', function () {
  async function fixture() {
    const [owner, alice, bob, other] = await ethers.getSigners();
    const Token = await ethers.getContractFactory('SolslotTestToken');
    const usdc = await Token.deploy(false), usdt = await Token.deploy(true);
    const portal = await (await ethers.getContractFactory('NativeBridgePortalMock')).deploy();
    const Factory = await ethers.getContractFactory('SolslotTestAssetBridge');
    const args = [owner.address, portal.target, usdc.target, usdt.target, launcher, minter, burner, 100_000n, 250_000n, 20n];
    const bridge = await Factory.deploy(...args);
    for (const token of [usdc, usdt]) {
      await token.connect(alice).claim();
      await token.connect(alice).approve(bridge.target, ethers.MaxUint256);
    }
    const deposit = (token = usdc, amount = 10_000n) => bridge.connect(alice).bridgeToChia(token.target, receiver, amount, { value: 10 });
    const release = (nonce = word(1), token = usdc, amount = 10_000n, to = bob.address) =>
      portal.deliver(bridge.target, nonce, chia, burner, [word(token.target), word(to), word(amount)]);
    return { owner, alice, bob, other, usdc, usdt, portal, Factory, args, bridge, deposit, release };
  }
  async function active() { const f = await fixture(); await f.bridge.unpause(); return f; }

  it('starts closed and only governance may change pause state', async function () {
    const f = await loadFixture(fixture);
    await expect(f.deposit()).to.be.revertedWith('Pausable: paused');
    await expect(f.bridge.connect(f.alice).unpause()).to.be.revertedWith('Ownable: caller is not the owner');
    await f.bridge.unpause(); await f.deposit(); await f.bridge.pause();
    await expect(f.release()).to.be.revertedWith('Pausable: paused');
    expect(await f.bridge.outstandingMojos(f.usdc.target)).to.equal(10_000);
  });

  for (const usdtRoute of [false, true]) it(`locks exact six-decimal units and releases the ${usdtRoute ? 'USDT' : 'USDC'} liability`, async function () {
    const f = await loadFixture(active), token = usdtRoute ? f.usdt : f.usdc;
    await expect(f.deposit(token)).to.emit(f.portal, 'MessageSent')
      .withArgs(word(1), f.bridge.target, chia, minter, [word(token.target), receiver, word(10_000)]);
    expect(await token.balanceOf(f.bridge.target)).to.equal(10_000_000);
    expect(await f.bridge.outstandingMojos(token.target)).to.equal(10_000);
    await expect(f.release(word(1), token)).to.emit(f.bridge, 'BurnReleased')
      .withArgs(word(1), token.target, f.bob.address, 10_000, 10_000_000);
    expect(await token.balanceOf(f.bob.address)).to.equal(10_000_000);
    expect(await token.balanceOf(f.bridge.target)).to.equal(0);
    expect(await f.bridge.outstandingMojos(token.target)).to.equal(0);
  });

  it('does not let token donations authorize releases or expand outstanding supply', async function () {
    const f = await loadFixture(active);
    await f.usdc.connect(f.alice).transfer(f.bridge.target, 50_000_000);
    await expect(f.release()).to.be.revertedWithCustomError(f.bridge, 'InsufficientLiability');
    await f.deposit(); await f.release();
    expect(await f.usdc.balanceOf(f.bridge.target)).to.equal(50_000_000);
    expect(await f.bridge.outstandingMojos(f.usdc.target)).to.equal(0);
  });

  it('prevents duplicate burns even across different configured assets', async function () {
    const f = await loadFixture(active);
    await f.deposit(); await f.deposit(f.usdt); await f.release();
    await expect(f.release(word(1), f.usdt)).to.be.revertedWithCustomError(f.bridge, 'Replay');
    expect(await f.bridge.outstandingMojos(f.usdt.target)).to.equal(10_000);
  });

  it('separates each token liability and rejects unknown tokens', async function () {
    const f = await loadFixture(active);
    await f.deposit(); await expect(f.release(word(1), f.usdt)).to.be.revertedWithCustomError(f.bridge, 'InsufficientLiability');
    await expect(f.bridge.connect(f.alice).bridgeToChia(f.other.address, receiver, 1, { value: 10 }))
      .to.be.revertedWithCustomError(f.bridge, 'UnsupportedAsset');
  });

  it('enforces per-transfer and aggregate outstanding limits and permits capacity after release', async function () {
    const f = await loadFixture(active);
    for (const n of [0n, 100_001n]) await expect(f.deposit(f.usdc, n)).to.be.revertedWithCustomError(f.bridge, 'TransferLimit');
    await f.deposit(f.usdc, 100_000n); await f.deposit(f.usdc, 100_000n);
    await expect(f.deposit(f.usdc, 50_001n)).to.be.revertedWithCustomError(f.bridge, 'OutstandingLimit');
    await f.release(word(1), f.usdc, 100_000n); await f.deposit(f.usdc, 100_000n);
    expect(await f.bridge.outstandingMojos(f.usdc.target)).to.equal(200_000);
  });

  it('rejects invalid caller, source chain and source puzzle without consuming a nonce', async function () {
    const f = await loadFixture(active); await f.deposit();
    const words = [word(f.usdc.target), word(f.bob.address), word(10_000)];
    await expect(f.bridge.receiveMessage(word(1), chia, burner, words)).to.be.revertedWithCustomError(f.bridge, 'InvalidCounterpart');
    for (const [chain, source] of [['0x657468', burner], [chia, word(99)]])
      await expect(f.portal.deliver(f.bridge.target, word(1), chain, source, words)).to.be.revertedWithCustomError(f.bridge, 'InvalidCounterpart');
    expect(await f.bridge.usedBurnNonces(word(1))).to.equal(false); await f.release();
  });

  for (const malformed of ['length', 'trailing', 'token-padding', 'receiver-padding', 'zero-nonce', 'zero-receiver', 'self-receiver', 'overflow'])
    it(`rejects ${malformed} messages without mutating liabilities`, async function () {
      const f = await loadFixture(active); await f.deposit();
      let nonce = word(1), words = [word(f.usdc.target), word(f.bob.address), word(10_000)];
      if (malformed === 'length') words.pop();
      if (malformed === 'trailing') words.push(word(7));
      if (malformed === 'token-padding') words[0] = word(BigInt(f.usdc.target) | (1n << 160n));
      if (malformed === 'receiver-padding') words[1] = word(BigInt(f.bob.address) | (1n << 160n));
      if (malformed === 'zero-nonce') nonce = word(0);
      if (malformed === 'zero-receiver') words[1] = word(0);
      if (malformed === 'self-receiver') words[1] = word(f.bridge.target);
      if (malformed === 'overflow') words[2] = word(1n << 64n);
      await expect(f.portal.deliver(f.bridge.target, nonce, chia, burner, words)).to.be.revertedWithCustomError(f.bridge, 'InvalidMessage');
      expect(await f.bridge.outstandingMojos(f.usdc.target)).to.equal(10_000);
      expect(await f.bridge.usedBurnNonces(nonce)).to.equal(false);
    });

  it('bounds the message toll and rejects accidental ETH overpayment', async function () {
    const f = await loadFixture(active);
    await expect(f.bridge.connect(f.alice).bridgeToChia(f.usdc.target, receiver, 1, { value: 11 })).to.be.revertedWithCustomError(f.bridge, 'TollLimit');
    await f.portal.setToll(21);
    await expect(f.bridge.connect(f.alice).bridgeToChia(f.usdc.target, receiver, 1, { value: 21 })).to.be.revertedWithCustomError(f.bridge, 'TollLimit');
  });

  it('rolls back token transfer and accounting when portal submission fails', async function () {
    const f = await loadFixture(active), before = await f.usdc.balanceOf(f.alice.address);
    await f.portal.setFail(true); await expect(f.deposit()).to.be.revertedWith('portal unavailable');
    expect(await f.usdc.balanceOf(f.alice.address)).to.equal(before);
    expect(await f.usdc.balanceOf(f.bridge.target)).to.equal(0);
    expect(await f.bridge.outstandingMojos(f.usdc.target)).to.equal(0);
    expect(await f.bridge.depositSequence()).to.equal(0);
  });

  it('blocks portal callback reentrancy and preserves escrow', async function () {
    const f = await loadFixture(active);
    await f.portal.setCallback(f.bridge.target, f.bridge.interface.encodeFunctionData('receiveMessage',
      [word(1), chia, burner, [word(f.usdc.target), word(f.bob.address), word(1)]]));
    await expect(f.deposit()).to.be.revertedWith('callback rejected');
    expect(await f.bridge.outstandingMojos(f.usdc.target)).to.equal(0);
  });

  it('rejects swapped fixture identities, duplicates, and a substituted runtime', async function () {
    const f = await loadFixture(fixture);
    const swapped = [...f.args]; [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
    await expect(f.Factory.deploy(...swapped)).to.be.revertedWithCustomError(f.Factory, 'UnsupportedAsset');
    const duplicate = [...f.args]; duplicate[3] = duplicate[2];
    await expect(f.Factory.deploy(...duplicate)).to.be.revertedWithCustomError(f.Factory, 'InvalidConfiguration');
    await f.bridge.unpause(); await f.deposit();
    await network.provider.send('hardhat_setCode', [f.usdc.target, '0x60006000f3']);
    await expect(f.release()).to.be.revertedWithCustomError(f.bridge, 'UnsupportedAsset');
  });

  it('conserves each asset across interleaved deposits, donations and partial burns', async function () {
    const f = await loadFixture(active); const debt = [0n, 0n], donations = [0n, 0n];
    for (let i = 1; i <= 40; ++i) {
      const t = i % 2, token = t ? f.usdt : f.usdc, amount = BigInt((i * 71) % 1100 + 1);
      await f.deposit(token, amount); debt[t] += amount;
      if (i % 3 === 0) { await token.connect(f.alice).transfer(f.bridge.target, 123); donations[t] += 123n; }
      if (i % 4 === 0) { const burn = debt[t] / 2n; await f.release(word(i), token, burn); debt[t] -= burn; }
      for (const [j, asset] of [f.usdc, f.usdt].entries()) {
        expect(await f.bridge.outstandingMojos(asset.target)).to.equal(debt[j]);
        expect(await asset.balanceOf(f.bridge.target)).to.equal(debt[j] * 1000n + donations[j]);
      }
    }
  });
});

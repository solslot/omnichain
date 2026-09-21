const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Solslot alpha test payment token", function () {
  async function fixture() {
    const [operator, tester, spender] = await ethers.getSigners();
    const token = await ethers.deployContract("SolslotAlphaTestToken", [operator.address]);
    return { token, operator, tester, spender };
  }
  it("labels the token explicitly and uses six-decimal units", async function () {
    const { token, operator } = await loadFixture(fixture);
    expect(await token.name()).to.equal("Solslot Alpha Test Token");
    expect(await token.symbol()).to.equal("TEST-SOLS");
    expect(await token.decimals()).to.equal(6);
    expect(await token.balanceOf(operator.address)).to.equal(10_000_000n * 10n ** 6n);
    expect(await token.totalSupply()).to.equal(await token.INITIAL_SUPPLY());
  });
  it("lets a new tester claim, prevents early repeats, and reopens at the boundary", async function () {
    const { token, tester, spender } = await loadFixture(fixture);
    const amount = await token.FAUCET_AMOUNT();
    await token.connect(tester).claim();
    const next = await token.nextClaimAt(tester.address);
    expect(await token.balanceOf(tester.address)).to.equal(amount);
    await time.setNextBlockTimestamp(next - 1n);
    await expect(token.connect(tester).claim()).to.be.revertedWithCustomError(token, "FaucetCooldown").withArgs(next);
    await time.setNextBlockTimestamp(next);
    await expect(token.connect(tester).claim()).to.emit(token, "TestTokensClaimed");
    expect(await token.balanceOf(tester.address)).to.equal(2n * amount);
    await token.connect(spender).claim();
    expect(await token.balanceOf(spender.address)).to.equal(amount);
  });
  it("supports exact ERC20 approvals and escrow-style transferFrom accounting", async function () {
    const { token, operator, tester, spender } = await loadFixture(fixture);
    const amount = 1_010_000n; // 1.01 test tokens, not dollars.
    await token.connect(operator).transfer(tester.address, amount);
    await expect(token.connect(spender).transferFrom(tester.address, operator.address, amount)).to.be.reverted;
    await token.connect(tester).approve(spender.address, amount);
    await token.connect(spender).transferFrom(tester.address, operator.address, amount);
    expect(await token.balanceOf(tester.address)).to.equal(0);
    expect(await token.allowance(tester.address, spender.address)).to.equal(0);
  });
  it("rejects a zero initial recipient and direct native ETH payments", async function () {
    const { token, operator } = await loadFixture(fixture);
    await expect(ethers.deployContract("SolslotAlphaTestToken", [ethers.ZeroAddress])).to.be.reverted;
    await expect(operator.sendTransaction({ to: await token.getAddress(), value: 1n })).to.be.reverted;
  });
});

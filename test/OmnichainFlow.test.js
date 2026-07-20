const { expect } = require("chai");
const { ethers } = require("hardhat");

const BASE_SELECTOR = 15971525489660198786n;
const POLYGON_SELECTOR = 4051577828743386545n;
const XCH = "0x786368";
const BRIDGING_PUZZLE = ethers.id("samuel-bridging-puzzle");
const RETURN_PUZZLE = ethers.id("samuel-return-puzzle");
const PAYMENT_ID = ethers.id("payment-1");
const PURCHASE_ID = ethers.id("purchase-1");
const ARTIFACT_HASH = ethers.id("artifact-1");
const COLLECTION_ID = ethers.id("collection-1");
const DEED_LAUNCHER_ID = ethers.id("deed-launcher-1");
const VAULT_LAUNCHER_ID = ethers.id("vault-launcher-1");
const DESTINATION_PUZZLE = ethers.id("destination-1");
const AMOUNT = 25_000_000n;
const QUANTITY = 1n;
const ROUTER_FEE = ethers.parseEther("0.01");
const WARP_TOLL = ethers.parseEther("0.005");

async function deploySystem(remote) {
  const [owner, user, payout, outsider] = await ethers.getSigners();
  const router = await ethers.deployContract("MockRouter");
  const portal = await ethers.deployContract("MockWarpPortal");
  const usdc = await ethers.deployContract("MockUSDC");
  const usdt = await ethers.deployContract("MockUSDT");
  const gateway = await ethers.deployContract("SolomonWarpGateway", [
    router.target,
    BASE_SELECTOR,
    portal.target,
    XCH,
    BRIDGING_PUZZLE,
    RETURN_PUZZLE,
    500_000,
    WARP_TOLL,
    ROUTER_FEE,
  ]);
  const spokeSelector = remote ? POLYGON_SELECTOR : BASE_SELECTOR;
  const spoke = await ethers.deployContract("OmnichainEscrowSpoke", [
    router.target,
    spokeSelector,
    usdc.target,
    usdt.target,
    payout.address,
    BASE_SELECTOR,
    gateway.target,
    500_000,
    7 * 24 * 60 * 60,
  ]);

  await gateway.setTrustedSpoke(spokeSelector, spoke.target);
  await usdc.mint(user.address, AMOUNT * 10n);
  await usdt.mint(user.address, AMOUNT * 10n);
  await usdc.connect(user).approve(spoke.target, AMOUNT * 10n);
  await usdt.connect(user).approve(spoke.target, AMOUNT * 10n);
  await owner.sendTransaction({ to: gateway.target, value: ethers.parseEther("1") });

  return { owner, user, payout, outsider, router, portal, usdc, usdt, token: usdc, gateway, spoke, spokeSelector };
}

async function deposit(
  system,
  paymentId = PAYMENT_ID,
  token = system.usdc,
  purchaseId = PURCHASE_ID,
  artifactHash = ARTIFACT_HASH,
  expiryOffset = 300,
) {
  const fee = system.spokeSelector === BASE_SELECTOR ? 0n : ROUTER_FEE;
  const block = await ethers.provider.getBlock("latest");
  const quoteExpiresAt = BigInt(block.timestamp + expiryOffset);
  await system.spoke.connect(system.user).depositPayment(
    token.target,
    paymentId,
    purchaseId,
    artifactHash,
    COLLECTION_ID,
    DEED_LAUNCHER_ID,
    VAULT_LAUNCHER_ID,
    DESTINATION_PUZZLE,
    AMOUNT,
    QUANTITY,
    quoteExpiresAt,
    { value: fee },
  );
  return system.spoke.deriveGlobalPaymentId(
    token.target,
    paymentId,
    purchaseId,
    artifactHash,
  );
}

async function relayRequest(system) {
  await system.router.deliverLast(system.spokeSelector, system.spoke.target);
}

async function relayWarpResult(system, globalPaymentId, succeeded, nonce = ethers.id("warp-nonce")) {
  await system.gateway.forwardToWarp(globalPaymentId);
  await system.portal.relayResult(
    system.gateway.target,
    nonce,
    XCH,
    RETURN_PUZZLE,
    [globalPaymentId, ethers.zeroPadValue(ethers.toBeHex(AMOUNT), 32), ethers.zeroPadValue(ethers.toBeHex(succeeded ? 1 : 0), 32)],
  );
  return nonce;
}

async function relayResult(system) {
  await system.gateway.forwardResult(
    await system.spoke.deriveGlobalPaymentId(
      system.usdc.target,
      PAYMENT_ID,
      PURCHASE_ID,
      ARTIFACT_HASH,
    ),
  );
  await system.router.deliverLast(BASE_SELECTOR, system.gateway.target);
}

describe("SolSlot CCIP-to-Warp omnichain flow", function () {
  it("completes a Base-local success without a CCIP hop", async function () {
    const system = await deploySystem(false);
    const globalPaymentId = await deposit(system);

    const queued = await system.gateway.getRequest(globalPaymentId);
    expect(queued.status).to.equal(1);
    expect(queued.request.globalPaymentId).to.equal(globalPaymentId);

    const warpNonce = await relayWarpResult(system, globalPaymentId, true);
    expect(await system.portal.lastDestinationChain()).to.equal(XCH);
    expect(await system.portal.lastDestination()).to.equal(BRIDGING_PUZZLE);
    expect(await system.portal.lastContents()).to.deep.equal([
      globalPaymentId,
      PURCHASE_ID,
      ARTIFACT_HASH,
      ethers.zeroPadValue(ethers.toBeHex(AMOUNT), 32),
      ethers.zeroPadValue(ethers.toBeHex(QUANTITY), 32),
      COLLECTION_ID,
      DEED_LAUNCHER_ID,
      VAULT_LAUNCHER_ID,
      DESTINATION_PUZZLE,
      ethers.zeroPadValue(ethers.toBeHex(queued.request.quoteExpiresAt), 32),
    ]);

    await system.gateway.forwardResult(globalPaymentId);
    const received = await system.spoke.getDeposit(globalPaymentId);
    expect(received.status).to.equal(2);
    expect(received.warpNonce).to.equal(warpNonce);
    expect(received.succeeded).to.equal(true);

    await system.spoke.connect(system.outsider).settle(globalPaymentId);
    expect(await system.token.balanceOf(system.payout.address)).to.equal(AMOUNT);
    expect((await system.spoke.getDeposit(globalPaymentId)).status).to.equal(3);
  });

  it("escrows and settles USDC and USDT independently", async function () {
    const system = await deploySystem(false);
    const sharedLocalPaymentId = ethers.id("dual-token-payment");
    const usdcPayment = await deposit(system, sharedLocalPaymentId, system.usdc);
    const usdtPayment = await deposit(
      system,
      sharedLocalPaymentId,
      system.usdt,
      ethers.id("purchase-usdt"),
      ethers.id("artifact-usdt"),
    );

    expect(usdcPayment).not.to.equal(usdtPayment);
    expect((await system.spoke.getDeposit(usdcPayment)).settlementToken).to.equal(system.usdc.target);
    expect((await system.spoke.getDeposit(usdtPayment)).settlementToken).to.equal(system.usdt.target);

    await relayWarpResult(system, usdcPayment, true, ethers.id("usdc-warp"));
    await system.gateway.forwardResult(usdcPayment);
    await system.spoke.settle(usdcPayment);
    await relayWarpResult(system, usdtPayment, true, ethers.id("usdt-warp"));
    await system.gateway.forwardResult(usdtPayment);
    await system.spoke.settle(usdtPayment);

    expect(await system.usdc.balanceOf(system.payout.address)).to.equal(AMOUNT);
    expect(await system.usdt.balanceOf(system.payout.address)).to.equal(AMOUNT);
    expect(await system.usdc.balanceOf(system.spoke.target)).to.equal(0);
    expect(await system.usdt.balanceOf(system.spoke.target)).to.equal(0);
  });

  it("rejects tokens outside the immutable USDC/USDT allowlist", async function () {
    const system = await deploySystem(false);
    const unsupported = await ethers.deployContract("MockUSDC");
    await unsupported.mint(system.user.address, AMOUNT);
    await unsupported.connect(system.user).approve(system.spoke.target, AMOUNT);
    await expect(deposit(system, ethers.id("unsupported-payment"), unsupported))
      .to.be.revertedWithCustomError(system.spoke, "InvalidPayment");
  });

  it("routes a remote-chain request and result through authenticated CCIP callbacks", async function () {
    const system = await deploySystem(true);
    const globalPaymentId = await deposit(system);

    expect(await system.router.lastDestinationSelector()).to.equal(BASE_SELECTOR);
    expect(await system.router.lastValue()).to.equal(ROUTER_FEE);
    await relayRequest(system);
    expect((await system.gateway.getRequest(globalPaymentId)).status).to.equal(1);

    await relayWarpResult(system, globalPaymentId, true);
    await system.gateway.forwardResult(globalPaymentId);
    expect(await system.router.lastDestinationSelector()).to.equal(POLYGON_SELECTOR);
    await system.router.deliverLast(BASE_SELECTOR, system.gateway.target);

    await system.spoke.settle(globalPaymentId);
    expect(await system.token.balanceOf(system.payout.address)).to.equal(AMOUNT);
  });

  it("refunds only the original depositor after a failed result", async function () {
    const system = await deploySystem(false);
    const startingBalance = await system.token.balanceOf(system.user.address);
    const globalPaymentId = await deposit(system);
    await relayWarpResult(system, globalPaymentId, false);
    await system.gateway.forwardResult(globalPaymentId);
    await system.spoke.connect(system.outsider).settle(globalPaymentId);

    expect(await system.token.balanceOf(system.user.address)).to.equal(startingBalance);
    expect(await system.token.balanceOf(system.payout.address)).to.equal(0);
    expect((await system.spoke.getDeposit(globalPaymentId)).status).to.equal(4);
  });

  it("rejects spoofed CCIP source selectors and senders", async function () {
    const system = await deploySystem(true);
    await deposit(system);

    await expect(
      system.router.deliverLast(BASE_SELECTOR, system.spoke.target),
    ).to.be.revertedWithCustomError(system.gateway, "InvalidCounterpart");
    await expect(
      system.router.deliverLast(POLYGON_SELECTOR, system.outsider.address),
    ).to.be.revertedWithCustomError(system.gateway, "InvalidCounterpart");
  });

  it("rejects duplicate payment IDs and duplicate Warp nonces", async function () {
    const system = await deploySystem(false);
    const globalPaymentId = await deposit(system);
    await expect(deposit(system)).to.be.revertedWithCustomError(system.spoke, "InvalidPayment");
    await expect(
      deposit(system, ethers.id("different-local-id")),
    ).to.be.revertedWithCustomError(system.spoke, "InvalidPayment");

    const nonce = await relayWarpResult(system, globalPaymentId, true);
    await expect(
      system.portal.relayResult(
        system.gateway.target,
        nonce,
        XCH,
        RETURN_PUZZLE,
        [globalPaymentId, ethers.zeroPadValue(ethers.toBeHex(AMOUNT), 32), ethers.zeroPadValue("0x01", 32)],
      ),
    ).to.be.revertedWithCustomError(system.gateway, "Replay");
  });

  it("rejects expired and excessively long coordinator quotes", async function () {
    const expired = await deploySystem(false);
    await expect(
      deposit(expired, PAYMENT_ID, expired.usdc, PURCHASE_ID, ARTIFACT_HASH, -1),
    ).to.be.revertedWithCustomError(expired.spoke, "InvalidPayment");

    const overlong = await deploySystem(false);
    await expect(
      deposit(overlong, PAYMENT_ID, overlong.usdc, PURCHASE_ID, ARTIFACT_HASH, 1900),
    ).to.be.revertedWithCustomError(overlong.spoke, "InvalidPayment");
  });

  it("rejects a result whose artifact binding differs from escrow", async function () {
    const system = await deploySystem(true);
    const globalPaymentId = await deposit(system);
    const harness = await ethers.deployContract("CodecHarness");
    const forged = await harness.encodeResult({
      originChainSelector: system.spokeSelector,
      originSpoke: system.spoke.target,
      globalPaymentId,
      purchaseId: PURCHASE_ID,
      artifactHash: ethers.id("wrong-artifact"),
      destinationPuzzle: DESTINATION_PUZZLE,
      warpNonce: ethers.id("forged-warp-result"),
      amount: AMOUNT,
      succeeded: true,
    });

    await expect(
      system.router.deliver(
        system.spoke.target,
        ethers.id("forged-result-message"),
        BASE_SELECTOR,
        system.gateway.target,
        forged,
      ),
    ).to.be.revertedWithCustomError(system.spoke, "InvalidMessage");
  });

  it("rejects wrong Warp counterparts and amount mismatches", async function () {
    const system = await deploySystem(false);
    const globalPaymentId = await deposit(system);
    await system.gateway.forwardToWarp(globalPaymentId);

    await expect(
      system.gateway.receiveMessage(
        ethers.id("direct"),
        XCH,
        RETURN_PUZZLE,
        [globalPaymentId, ethers.zeroPadValue(ethers.toBeHex(AMOUNT), 32), ethers.ZeroHash],
      ),
    ).to.be.revertedWithCustomError(system.gateway, "InvalidCounterpart");
    await expect(
      system.portal.relayResult(
        system.gateway.target,
        ethers.id("wrong-amount"),
        XCH,
        RETURN_PUZZLE,
        [globalPaymentId, ethers.zeroPadValue(ethers.toBeHex(AMOUNT - 1n), 32), ethers.ZeroHash],
      ),
    ).to.be.revertedWithCustomError(system.gateway, "InvalidMessage");
  });

  it("enforces Warp and CCIP treasury fee caps", async function () {
    const system = await deploySystem(true);
    const globalPaymentId = await deposit(system);
    await relayRequest(system);

    await system.portal.setMessageToll(WARP_TOLL + 1n);
    await expect(system.gateway.forwardToWarp(globalPaymentId))
      .to.be.revertedWithCustomError(system.gateway, "FeeCapExceeded")
      .withArgs(WARP_TOLL + 1n, WARP_TOLL);

    await system.portal.setMessageToll(WARP_TOLL);
    await relayWarpResult(system, globalPaymentId, true);
    await system.router.setFee(ROUTER_FEE + 1n);
    await expect(system.gateway.forwardResult(globalPaymentId))
      .to.be.revertedWithCustomError(system.gateway, "FeeCapExceeded")
      .withArgs(ROUTER_FEE + 1n, ROUTER_FEE);
  });

  it("allows a delayed emergency refund only to the depositor", async function () {
    const system = await deploySystem(false);
    const startingBalance = await system.token.balanceOf(system.user.address);
    const globalPaymentId = await deposit(system);

    await system.spoke.scheduleEmergencyRefund(globalPaymentId);
    await expect(system.spoke.executeEmergencyRefund(globalPaymentId))
      .to.be.revertedWithCustomError(system.spoke, "EmergencyDelayActive");
    await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine");
    await system.spoke.connect(system.outsider).executeEmergencyRefund(globalPaymentId);

    expect(await system.token.balanceOf(system.user.address)).to.equal(startingBalance);
    expect((await system.spoke.getDeposit(globalPaymentId)).status).to.equal(5);
  });

  it("rejects noncanonical codec data and derives domain-separated IDs", async function () {
    const harness = await ethers.deployContract("CodecHarness");
    const [owner, another] = await ethers.getSigners();
    const token = ethers.Wallet.createRandom().address;
    const otherToken = ethers.Wallet.createRandom().address;
    const first = await harness.derive(
      BASE_SELECTOR,
      owner.address,
      token,
      PAYMENT_ID,
      PURCHASE_ID,
      ARTIFACT_HASH,
    );
    const second = await harness.derive(
      POLYGON_SELECTOR,
      owner.address,
      token,
      PAYMENT_ID,
      PURCHASE_ID,
      ARTIFACT_HASH,
    );
    const third = await harness.derive(
      BASE_SELECTOR,
      another.address,
      token,
      PAYMENT_ID,
      PURCHASE_ID,
      ARTIFACT_HASH,
    );
    const fourth = await harness.derive(
      BASE_SELECTOR,
      owner.address,
      otherToken,
      PAYMENT_ID,
      PURCHASE_ID,
      ARTIFACT_HASH,
    );
    expect(first).not.to.equal(second);
    expect(first).not.to.equal(third);
    expect(first).not.to.equal(fourth);

    await expect(harness.decodeRequest("0x1234")).to.be.reverted;
  });
});

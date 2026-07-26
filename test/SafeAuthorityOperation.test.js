const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  encodeContractSignatures,
  recoverSafeMessageSigner,
  safeMessageTypedData,
  safeTransaction,
  validateAuthorityApprovalEvidence,
} = require("../scripts/lib/safe-authority-operation");
const { withArtifactHash } = require("../scripts/lib/deployment-evidence");

describe("Nested Safe authority operations", function () {
  it("binds each administrator signature to its child Safe and exact root message", async function () {
    const [owner, coadmin] = await ethers.getSigners();
    const message = ethers.hexlify(ethers.randomBytes(96));
    const ownerTypedData = safeMessageTypedData(84532, ethers.Wallet.createRandom().address, message);
    const coadminTypedData = safeMessageTypedData(84532, ethers.Wallet.createRandom().address, message);
    const ownerSignature = await owner.signTypedData(
      ownerTypedData.domain,
      ownerTypedData.types,
      ownerTypedData.message,
    );
    const coadminSignature = await coadmin.signTypedData(
      coadminTypedData.domain,
      coadminTypedData.types,
      coadminTypedData.message,
    );

    expect(recoverSafeMessageSigner(ownerTypedData, ownerSignature)).to.equal(owner.address);
    expect(recoverSafeMessageSigner(coadminTypedData, coadminSignature)).to.equal(coadmin.address);
    expect(recoverSafeMessageSigner(
      safeMessageTypedData(84532, ownerTypedData.domain.verifyingContract, `${message}00`),
      ownerSignature,
    )).not.to.equal(owner.address);
    expect(recoverSafeMessageSigner(coadminTypedData, ownerSignature)).not.to.equal(owner.address);
  });

  it("encodes sorted EIP-1271 contract signatures with bounded dynamic offsets", async function () {
    const [firstSigner, secondSigner] = await ethers.getSigners();
    const firstOwner = "0x73a282e829dF5b7E12824a53F54c2FB6f07D13a5";
    const secondOwner = "0x428700faA2b6Ebc613435994C84dB27908964A88";
    const firstSignature = await firstSigner.signMessage("owner");
    const secondSignature = await secondSigner.signMessage("coadmin");
    const encoded = ethers.getBytes(encodeContractSignatures([
      { owner: firstOwner, signature: firstSignature },
      { owner: secondOwner, signature: secondSignature },
    ]));

    expect(encoded.length).to.equal((65 * 2) + (32 + 96) * 2);
    expect(ethers.getAddress(ethers.hexlify(encoded.slice(12, 32)))).to.equal(secondOwner);
    expect(BigInt(ethers.hexlify(encoded.slice(32, 64)))).to.equal(130n);
    expect(encoded[64]).to.equal(0);
    expect(ethers.getAddress(ethers.hexlify(encoded.slice(65 + 12, 65 + 32)))).to.equal(firstOwner);
    expect(BigInt(ethers.hexlify(encoded.slice(65 + 32, 65 + 64)))).to.equal(258n);
    expect(encoded[65 + 64]).to.equal(0);
    expect(BigInt(ethers.hexlify(encoded.slice(130, 162)))).to.equal(65n);
    expect(BigInt(ethers.hexlify(encoded.slice(258, 290)))).to.equal(65n);
  });

  it("rejects malformed or duplicate nested signatures and unsafe transaction inputs", async function () {
    const signer = ethers.Wallet.createRandom();
    const signature = await signer.signMessage("duplicate");
    expect(() => encodeContractSignatures([
      { owner: signer.address, signature },
      { owner: signer.address, signature },
    ])).to.throw("must be unique");
    expect(() => encodeContractSignatures([
      { owner: signer.address, signature: "0x12" },
    ])).to.throw("must be 65 bytes");
    expect(() => safeTransaction(ethers.ZeroAddress, "not-hex", 0)).to.throw("calldata");
    expect(() => safeTransaction(ethers.ZeroAddress, "0x", -1)).to.throw("nonce");
  });

  it("accepts only one owner and one authorized coadmin approval for the sealed package", async function () {
    const [owner, coadmin, outsider] = await ethers.getSigners();
    const transactionData = ethers.hexlify(ethers.randomBytes(128));
    const ownerSafe = ethers.Wallet.createRandom().address;
    const coadminSafe = ethers.Wallet.createRandom().address;
    const approvals = [
      { role: "owner_identity", safe: ownerSafe, allowedSigners: [owner.address] },
      { role: "coadmin", safe: coadminSafe, allowedSigners: [coadmin.address] },
    ].map((approval) => {
      const typedData = safeMessageTypedData(84532, approval.safe, transactionData);
      return {
        ...approval,
        messageHash: ethers.TypedDataEncoder.hash(
          typedData.domain,
          typedData.types,
          typedData.message,
        ),
        typedData,
      };
    });
    const packageEvidence = withArtifactHash({
      schemaVersion: 1,
      kind: "solslot-safe-authority-operation",
      chainId: 84532,
      phase: "schedule",
      authorityOperation: { transactionData, approvals },
    });
    const ownerSignature = await owner.signTypedData(
      approvals[0].typedData.domain,
      approvals[0].typedData.types,
      approvals[0].typedData.message,
    );
    const coadminSignature = await coadmin.signTypedData(
      approvals[1].typedData.domain,
      approvals[1].typedData.types,
      approvals[1].typedData.message,
    );
    const evidence = {
      schemaVersion: 1,
      kind: "solslot-safe-authority-approvals",
      authorityOperationArtifactHash: packageEvidence.artifactHash,
      phase: "schedule",
      signatures: [
        { role: "owner_identity", signature: ownerSignature },
        { role: "coadmin", signature: coadminSignature },
      ],
    };
    expect(validateAuthorityApprovalEvidence(packageEvidence, evidence).map(({ signer }) => signer))
      .to.deep.equal([owner.address, coadmin.address]);

    evidence.signatures[1].signature = await outsider.signTypedData(
      approvals[1].typedData.domain,
      approvals[1].typedData.types,
      approvals[1].typedData.message,
    );
    expect(() => validateAuthorityApprovalEvidence(packageEvidence, evidence))
      .to.throw("not from an authorized administrator");
    evidence.signatures.push({ role: "coadmin", signature: coadminSignature });
    expect(() => validateAuthorityApprovalEvidence(packageEvidence, evidence))
      .to.throw("does not match");
  });
});

const { ethers } = require("ethers");

const ZERO_ADDRESS = ethers.ZeroAddress;
const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)",
  "function encodeTransactionData(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes)",
];

function safeTransaction(to, data, nonce) {
  if (!ethers.isAddress(to)) throw new Error("Safe transaction target is invalid");
  if (!ethers.isHexString(data)) throw new Error("Safe transaction calldata is invalid");
  const parsedNonce = BigInt(nonce);
  if (parsedNonce < 0n) throw new Error("Safe transaction nonce is invalid");
  return {
    to: ethers.getAddress(to),
    value: "0",
    data,
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce: parsedNonce.toString(),
  };
}

function safeTransactionArguments(transaction) {
  return [
    transaction.to,
    BigInt(transaction.value),
    transaction.data,
    transaction.operation,
    BigInt(transaction.safeTxGas),
    BigInt(transaction.baseGas),
    BigInt(transaction.gasPrice),
    transaction.gasToken,
    transaction.refundReceiver,
    BigInt(transaction.nonce),
  ];
}

function safeMessageTypedData(chainId, safeAddress, message) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("Safe message chain ID is invalid");
  }
  if (!ethers.isAddress(safeAddress) || !ethers.isHexString(message)) {
    throw new Error("Safe message approval is invalid");
  }
  return {
    domain: {
      chainId,
      verifyingContract: ethers.getAddress(safeAddress),
    },
    types: {
      SafeMessage: [{ name: "message", type: "bytes" }],
    },
    primaryType: "SafeMessage",
    message: { message },
  };
}

function recoverSafeMessageSigner(typedData, signature) {
  if (!ethers.isHexString(signature, 65)) {
    throw new Error("Safe message signature must be 65 bytes");
  }
  return ethers.getAddress(ethers.verifyTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
    signature,
  ));
}

function approvalTypedData(chainId, approval, transactionData) {
  let message = transactionData;
  if (approval.parentSafe) {
    const parent = safeMessageTypedData(chainId, approval.parentSafe, transactionData);
    message = ethers.TypedDataEncoder.encode(parent.domain, parent.types, parent.message);
  }
  return safeMessageTypedData(chainId, approval.safe, message);
}

function validateAuthorityApprovalEvidence(packageEvidence, approvalEvidence) {
  const expectedApprovals = packageEvidence?.authorityOperation?.approvals;
  if (
    approvalEvidence?.schemaVersion !== 1 ||
    approvalEvidence?.kind !== "solslot-safe-authority-approvals" ||
    approvalEvidence?.authorityOperationArtifactHash !== packageEvidence?.artifactHash ||
    approvalEvidence?.phase !== packageEvidence?.phase ||
    !Array.isArray(approvalEvidence?.signatures) ||
    !Array.isArray(expectedApprovals) ||
    approvalEvidence.signatures.length !== expectedApprovals.length ||
    new Set(approvalEvidence.signatures.map(({ role }) => role)).size !==
      expectedApprovals.length
  ) {
    throw new Error("administrator approval evidence does not match the authority operation");
  }
  return expectedApprovals.map((approval) => {
    const supplied = approvalEvidence.signatures.find(({ role }) => role === approval.role);
    if (!supplied || typeof supplied.signature !== "string") {
      throw new Error(`Missing ${approval.role} administrator signature`);
    }
    const typedData = approvalTypedData(packageEvidence.chainId, approval,
      packageEvidence.authorityOperation.transactionData);
    const messageHash = ethers.TypedDataEncoder.hash(
      typedData.domain,
      typedData.types,
      typedData.message,
    );
    if (messageHash !== approval.messageHash) {
      throw new Error(`${approval.role} Safe message hash changed after review`);
    }
    const signer = recoverSafeMessageSigner(typedData, supplied.signature);
    if (!approval.allowedSigners.some((allowed) => allowed.toLowerCase() === signer.toLowerCase())) {
      throw new Error(`${approval.role} signature is not from an authorized administrator`);
    }
    return {
      role: approval.role,
      signer,
      safe: approval.safe,
      ...(approval.parentSafe ? { parentSafe: approval.parentSafe } : {}),
      signature: supplied.signature,
    };
  });
}

function normalizeSignature(signature) {
  if (!ethers.isHexString(signature, 65)) {
    throw new Error("Nested Safe signature must be 65 bytes");
  }
  return ethers.Signature.from(signature).serialized;
}

function encodeContractSignatures(entries, nested = false) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("At least one contract signature is required");
  }
  const normalized = entries.map(({ owner, signature }) => {
    if (!ethers.isAddress(owner)) throw new Error("Contract signature owner is invalid");
    return {
      owner: ethers.getAddress(owner),
      signature: nested ? checkedContractSignature(signature) : normalizeSignature(signature),
    };
  }).sort((left, right) => (
    BigInt(left.owner.toLowerCase()) < BigInt(right.owner.toLowerCase()) ? -1 : 1
  ));
  if (new Set(normalized.map(({ owner }) => owner.toLowerCase())).size !== normalized.length) {
    throw new Error("Contract signature owners must be unique");
  }

  const staticSize = 65 * normalized.length;
  let dynamicOffset = staticSize;
  const staticParts = [];
  const dynamicParts = [];
  for (const { owner, signature } of normalized) {
    const signatureBytes = ethers.getBytes(signature);
    const paddedLength = Math.ceil(signatureBytes.length / 32) * 32;
    const dynamicPart = ethers.concat([
      ethers.zeroPadValue(ethers.toBeHex(signatureBytes.length), 32),
      signatureBytes,
      new Uint8Array(paddedLength - signatureBytes.length),
    ]);
    staticParts.push(ethers.concat([
      ethers.zeroPadValue(owner, 32),
      ethers.zeroPadValue(ethers.toBeHex(dynamicOffset), 32),
      "0x00",
    ]));
    dynamicParts.push(dynamicPart);
    dynamicOffset += ethers.getBytes(dynamicPart).length;
  }
  return ethers.hexlify(ethers.concat([...staticParts, ...dynamicParts]));
}

function checkedContractSignature(signature) {
  if (!ethers.isHexString(signature) || ethers.getBytes(signature).length < 65 ||
      ethers.getBytes(signature).length > 4096) throw new Error('Nested contract signature is invalid');
  return signature;
}

function encodeAuthoritySignatures(approvals) {
  return encodeContractSignatures(approvals.map(({ safe, parentSafe, signature }) => ({
    owner: parentSafe || safe,
    signature: parentSafe ? encodeContractSignatures([{ owner: safe, signature }]) : normalizeSignature(signature),
  })), true);
}

async function buildSafeAuthorityOperation({
  provider,
  chainId,
  phase,
  rootSafeAddress,
  rootTransaction,
  ownerIdentitySafe,
  coadminSafe,
  coadminIdentitySafe,
}) {
  if (!["schedule", "execute"].includes(phase)) {
    throw new Error("Safe authority phase must be schedule or execute");
  }
  for (const entry of [ownerIdentitySafe, coadminSafe, ...(coadminIdentitySafe ? [coadminIdentitySafe] : [])]) {
    if (
      !ethers.isAddress(entry?.address) ||
      !Array.isArray(entry?.owners) ||
      entry.owners.length === 0 ||
      entry.owners.some((owner) => !ethers.isAddress(owner))
    ) {
      throw new Error("Child Safe authority evidence is invalid");
    }
  }
  const rootSafe = new ethers.Contract(rootSafeAddress, SAFE_ABI, provider);
  const transaction = safeTransaction(
    rootTransaction.to,
    rootTransaction.data,
    await rootSafe.nonce(),
  );
  const args = safeTransactionArguments(transaction);
  const [transactionHash, transactionData] = await Promise.all([
    rootSafe.getTransactionHash(...args),
    rootSafe.encodeTransactionData(...args),
  ]);
  const approvals = [
    {
      role: "owner_identity",
      safe: ethers.getAddress(ownerIdentitySafe.address),
      allowedSigners: ownerIdentitySafe.owners.map(ethers.getAddress),
    },
    {
      role: "coadmin",
      safe: ethers.getAddress(coadminIdentitySafe?.address || coadminSafe.address),
      ...(coadminIdentitySafe ? { parentSafe: ethers.getAddress(coadminSafe.address) } : {}),
      allowedSigners: (coadminIdentitySafe || coadminSafe).owners.map(ethers.getAddress),
    },
  ].map((approval) => {
    const typedData = approvalTypedData(chainId, approval, transactionData);
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
  return {
    phase,
    rootSafe: ethers.getAddress(rootSafeAddress),
    transaction,
    transactionHash,
    transactionData,
    approvals,
  };
}

module.exports = {
  approvalTypedData,
  encodeAuthoritySignatures,
  buildSafeAuthorityOperation,
  encodeContractSignatures,
  recoverSafeMessageSigner,
  safeMessageTypedData,
  safeTransaction,
  safeTransactionArguments,
  validateAuthorityApprovalEvidence,
};

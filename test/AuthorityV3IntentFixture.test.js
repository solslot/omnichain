const { expect } = require("chai");
const { ethers } = require("hardhat");
const fixture = require("./fixtures/admin_key_change_intent_v1.json");

const TUPLE =
  "(uint8,uint8,address,address,bytes,bytes,address,address,bytes,bytes,bytes32[3],address[3],bytes32,address,address,string,uint256,bytes32,uint256,uint64,uint64)";

function changeKind(kind) {
  if (kind === "ROUTINE") return 1;
  if (kind === "LOST") return 2;
  if (kind === "RECOVERY_KIT") return 3;
  throw new Error(`unsupported change kind: ${kind}`);
}

function solidityIntent(intent) {
  return [
    intent.slot,
    changeKind(intent.kind),
    intent.oldDailyEvmKey,
    intent.newDailyEvmKey,
    intent.oldDailyChiaKey,
    intent.newDailyChiaKey,
    intent.oldRecoveryGuardian,
    intent.newRecoveryGuardian,
    intent.oldRecoveryBlsKey,
    intent.newRecoveryBlsKey,
    intent.identityLauncherIds,
    intent.identitySafes,
    intent.authorityLauncherId,
    intent.coadminSafe,
    intent.rootSafe,
    intent.chiaNetwork,
    intent.evmChainId,
    intent.sourceManifestHash,
    intent.nonce,
    intent.expiresAt,
    intent.recoveryKeyRevision,
  ];
}

function atomHash(value) {
  return ethers.sha256(ethers.concat(["0x01", value]));
}

function pairHash(left, right) {
  return ethers.sha256(ethers.concat(["0x02", left, right]));
}

describe("Authority V3 cross-language intent fixture", function () {
  it("matches Python for intent hashing, calldata, and recovery digest", async function () {
    const intent = fixture.intent;
    const kind = changeKind(intent.kind);
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "bytes32",
        "uint8",
        "uint8",
        "address",
        "address",
        "bytes32",
        "bytes32",
        "address",
        "address",
        "bytes32",
        "bytes32",
        "bytes32[3]",
        "address[3]",
        "bytes32",
        "address",
        "address",
        "bytes32",
        "uint256",
        "bytes32",
        "uint256",
        "uint64",
        "uint64",
      ],
      [
        ethers.keccak256(
          ethers.toUtf8Bytes("SolslotAdminKeyChangeIntentV1"),
        ),
        intent.slot,
        kind,
        intent.oldDailyEvmKey,
        intent.newDailyEvmKey,
        ethers.keccak256(intent.oldDailyChiaKey),
        ethers.keccak256(intent.newDailyChiaKey),
        intent.oldRecoveryGuardian,
        intent.newRecoveryGuardian,
        ethers.keccak256(intent.oldRecoveryBlsKey),
        ethers.keccak256(intent.newRecoveryBlsKey),
        intent.identityLauncherIds,
        intent.identitySafes,
        intent.authorityLauncherId,
        intent.coadminSafe,
        intent.rootSafe,
        ethers.keccak256(ethers.toUtf8Bytes(intent.chiaNetwork)),
        intent.evmChainId,
        intent.sourceManifestHash,
        intent.nonce,
        intent.expiresAt,
        intent.recoveryKeyRevision,
      ],
    );
    const intentHash = ethers.keccak256(encoded);
    expect(intentHash).to.equal(fixture.expected.intentHash);

    const iface = new ethers.Interface([
      `function prepareRoutine(${TUPLE} intent)`,
    ]);
    const calldata = iface.encodeFunctionData("prepareRoutine", [
      solidityIntent(intent),
    ]);
    expect(calldata.slice(0, 10)).to.equal(
      fixture.expected.prepareRoutineSelector,
    );
    expect(ethers.dataLength(calldata)).to.equal(
      fixture.expected.prepareRoutineCalldataBytes,
    );

    const message = pairHash(
      atomHash(ethers.toUtf8Bytes("SolslotAdminKeyChangeIntentV1")),
      atomHash(intentHash),
    );
    const digest = pairHash(
      atomHash(ethers.toUtf8Bytes("Chia Signed Message")),
      atomHash(message),
    );
    expect(digest).to.equal(fixture.expected.recoveryBlsDigest);
  });
});

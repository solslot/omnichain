// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

library OmnichainMessageCodec {
    uint8 internal constant PROTOCOL_VERSION = 3;

    enum Action {
        Request,
        Result
    }

    struct Request {
        uint64 originChainSelector;
        address originSpoke;
        address depositor;
        address settlementToken;
        bytes32 localPaymentId;
        bytes32 globalPaymentId;
        bytes32 purchaseId;
        bytes32 artifactHash;
        bytes32 collectionId;
        bytes32 deedLauncherId;
        bytes32 vaultLauncherId;
        bytes32 destinationPuzzle;
        uint256 amount;
        uint256 quantity;
        uint64 quoteExpiresAt;
        uint64 hubChainSelector;
        address hubGateway;
    }

    struct Result {
        uint64 originChainSelector;
        address originSpoke;
        bytes32 globalPaymentId;
        bytes32 purchaseId;
        bytes32 artifactHash;
        bytes32 destinationPuzzle;
        bytes32 warpNonce;
        uint256 amount;
        bool succeeded;
    }

    error InvalidMessage();

    function deriveGlobalPaymentId(
        uint64 originChainSelector,
        address originSpoke,
        address settlementToken,
        bytes32 localPaymentId,
        bytes32 purchaseId,
        bytes32 artifactHash
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PROTOCOL_VERSION,
                originChainSelector,
                originSpoke,
                settlementToken,
                localPaymentId,
                purchaseId,
                artifactHash
            )
        );
    }

    function encodeRequest(Request memory request) internal pure returns (bytes memory) {
        return abi.encode(PROTOCOL_VERSION, Action.Request, request);
    }

    function decodeRequest(bytes memory data) internal pure returns (Request memory request) {
        uint8 version;
        Action action;
        (version, action, request) = abi.decode(data, (uint8, Action, Request));
        if (
            version != PROTOCOL_VERSION ||
            action != Action.Request ||
            keccak256(data) != keccak256(encodeRequest(request))
        ) revert InvalidMessage();
    }

    function encodeResult(Result memory result) internal pure returns (bytes memory) {
        return abi.encode(PROTOCOL_VERSION, Action.Result, result);
    }

    function decodeResult(bytes memory data) internal pure returns (Result memory result) {
        uint8 version;
        Action action;
        (version, action, result) = abi.decode(data, (uint8, Action, Result));
        if (
            version != PROTOCOL_VERSION ||
            action != Action.Result ||
            keccak256(data) != keccak256(encodeResult(result))
        ) revert InvalidMessage();
    }
}

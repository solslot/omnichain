// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {OmnichainMessageCodec} from "../libraries/OmnichainMessageCodec.sol";

contract CodecHarness {
    function derive(
        uint64 selector,
        address spoke,
        address settlementToken,
        bytes32 paymentId,
        bytes32 purchaseId,
        bytes32 artifactHash
    ) external pure returns (bytes32) {
        return OmnichainMessageCodec.deriveGlobalPaymentId(
            selector,
            spoke,
            settlementToken,
            paymentId,
            purchaseId,
            artifactHash
        );
    }

    function encodeRequest(
        OmnichainMessageCodec.Request calldata request
    ) external pure returns (bytes memory) {
        return OmnichainMessageCodec.encodeRequest(request);
    }

    function decodeRequest(
        bytes calldata data
    ) external pure returns (OmnichainMessageCodec.Request memory) {
        return OmnichainMessageCodec.decodeRequest(data);
    }

    function encodeResult(
        OmnichainMessageCodec.Result calldata result
    ) external pure returns (bytes memory) {
        return OmnichainMessageCodec.encodeResult(result);
    }
}

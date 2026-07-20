// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

interface ILocalGateway {
    function acceptLocalRequest(bytes calldata data) external returns (bytes32 messageId);
}

interface ILocalSpoke {
    function receiveLocalResult(bytes calldata data) external;
}

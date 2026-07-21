// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

interface IWarpPortal {
    function messageToll() external view returns (uint256);

    function sendMessage(
        bytes3 destinationChain,
        bytes32 destination,
        bytes32[] calldata contents
    ) external payable;
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {IWarpPortal} from "../interfaces/IWarpPortal.sol";

interface IWarpMessageReceiver {
    function receiveMessage(
        bytes32 nonce,
        bytes3 sourceChain,
        bytes32 source,
        bytes32[] calldata contents
    ) external;
}

contract MockWarpPortal is IWarpPortal {
    uint256 public override messageToll = 0.005 ether;
    address public owner;
    uint256 public signatureThreshold;
    mapping(address => bool) public isSigner;
    mapping(bytes3 => bool) public supportedChains;
    bytes3 public lastDestinationChain;
    bytes32 public lastDestination;
    bytes32[] private s_lastContents;

    function setMessageToll(uint256 newToll) external {
        messageToll = newToll;
    }

    function configureAuthority(
        address newOwner,
        address[] calldata signers,
        uint256 threshold,
        bytes3 supportedChain
    ) external {
        owner = newOwner;
        signatureThreshold = threshold;
        supportedChains[supportedChain] = true;
        for (uint256 i = 0; i < signers.length; ++i) {
            isSigner[signers[i]] = true;
        }
    }

    function sendMessage(
        bytes3 destinationChain,
        bytes32 destination,
        bytes32[] calldata contents
    ) external payable {
        require(msg.value == messageToll, "toll");
        lastDestinationChain = destinationChain;
        lastDestination = destination;
        delete s_lastContents;
        for (uint256 i = 0; i < contents.length; ++i) s_lastContents.push(contents[i]);
    }

    function lastContents() external view returns (bytes32[] memory) {
        return s_lastContents;
    }

    function relayResult(
        address gateway,
        bytes32 nonce,
        bytes3 sourceChain,
        bytes32 source,
        bytes32[] calldata contents
    ) external {
        IWarpMessageReceiver(gateway).receiveMessage(nonce, sourceChain, source, contents);
    }
}

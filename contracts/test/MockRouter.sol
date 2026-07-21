// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {IAny2EVMMessageReceiver} from "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";

contract MockRouter is IRouterClient {
    uint256 public fee = 0.01 ether;
    uint256 public nonce;
    bytes32 public lastMessageId;
    uint64 public lastDestinationSelector;
    bytes public lastReceiver;
    bytes public lastData;
    bytes public lastExtraArgs;
    uint256 public lastValue;

    function setFee(uint256 newFee) external {
        fee = newFee;
    }

    function isChainSupported(uint64) external pure returns (bool) {
        return true;
    }

    function getFee(uint64, Client.EVM2AnyMessage memory) external view returns (uint256) {
        return fee;
    }

    function ccipSend(
        uint64 destinationChainSelector,
        Client.EVM2AnyMessage calldata message
    ) external payable returns (bytes32 messageId) {
        if (msg.value != fee) revert InvalidMsgValue();
        if (message.tokenAmounts.length != 0 || message.feeToken != address(0)) revert InvalidMsgValue();
        nonce += 1;
        messageId = keccak256(abi.encode(block.chainid, msg.sender, nonce, message.data));
        lastMessageId = messageId;
        lastDestinationSelector = destinationChainSelector;
        lastReceiver = message.receiver;
        lastData = message.data;
        lastExtraArgs = message.extraArgs;
        lastValue = msg.value;
    }

    function deliverLast(uint64 sourceChainSelector, address sender) external {
        address receiver = abi.decode(lastReceiver, (address));
        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](0);
        IAny2EVMMessageReceiver(receiver).ccipReceive(
            Client.Any2EVMMessage({
                messageId: lastMessageId,
                sourceChainSelector: sourceChainSelector,
                sender: abi.encode(sender),
                data: lastData,
                destTokenAmounts: tokenAmounts
            })
        );
    }

    function deliver(
        address receiver,
        bytes32 messageId,
        uint64 sourceChainSelector,
        address sender,
        bytes calldata data
    ) external {
        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](0);
        IAny2EVMMessageReceiver(receiver).ccipReceive(
            Client.Any2EVMMessage({
                messageId: messageId,
                sourceChainSelector: sourceChainSelector,
                sender: abi.encode(sender),
                data: data,
                destTokenAmounts: tokenAmounts
            })
        );
    }
}

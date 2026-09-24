// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

contract NativeBridgePortalMock {
    uint256 public messageToll = 10;
    uint256 public sequence;
    bool public failSend;
    address public callbackTarget;
    bytes public callback;
    event MessageSent(bytes32 nonce, address source, bytes3 destination_chain,
        bytes32 destination, bytes32[] contents);

    function setToll(uint256 value) external { messageToll = value; }
    function setFail(bool value) external { failSend = value; }
    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target; callback = data;
    }
    function sendMessage(bytes3 chain, bytes32 destination, bytes32[] calldata contents) external payable {
        require(!failSend, "portal unavailable");
        require(msg.value == messageToll, "toll");
        if (callbackTarget != address(0)) {
            (bool ok,) = callbackTarget.call(callback);
            require(ok, "callback rejected");
        }
        emit MessageSent(bytes32(++sequence), msg.sender, chain, destination, contents);
    }
    function deliver(address target, bytes32 nonce, bytes3 chain, bytes32 source, bytes32[] calldata contents) external {
        (bool ok, bytes memory result) = target.call(abi.encodeWithSignature(
            "receiveMessage(bytes32,bytes3,bytes32,bytes32[])", nonce, chain, source, contents));
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
    }
}

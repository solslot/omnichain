// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {OmnichainMessageCodec} from "./libraries/OmnichainMessageCodec.sol";
import {IWarpPortal} from "./interfaces/IWarpPortal.sol";
import {ILocalGateway, ILocalSpoke} from "./interfaces/ILocalOmnichain.sol";

contract SolomonWarpGateway is CCIPReceiver, ILocalGateway, Ownable2Step, Pausable, ReentrancyGuard {
    enum Status {
        None,
        Queued,
        WarpSent,
        ResultQueued,
        ResultSent
    }

    struct GatewayRequest {
        OmnichainMessageCodec.Request request;
        bytes32 inboundMessageId;
        bytes32 outboundMessageId;
        bytes32 warpNonce;
        uint64 queuedAt;
        Status status;
        bool succeeded;
    }

    uint64 public immutable localChainSelector;
    IWarpPortal public immutable warpPortal;
    bytes3 public immutable chiaChain;
    bytes32 public immutable samuelBridgingPuzzle;
    bytes32 public immutable samuelReturnPuzzle;
    uint256 public immutable resultGasLimit;

    uint256 public maxWarpToll;
    uint256 public maxCcipFee;
    IRouterClient private immutable i_router;

    mapping(uint64 => address) public trustedSpokes;
    mapping(bytes32 => GatewayRequest) private s_requests;
    mapping(bytes32 => bytes32) public globalPaymentForPurchase;
    mapping(bytes32 => bool) public usedInboundMessageIds;
    mapping(bytes32 => bool) public usedWarpNonces;

    event TrustedSpokeUpdated(uint64 indexed chainSelector, address indexed previousSpoke, address indexed newSpoke);
    event FeeCapsUpdated(uint256 previousWarpToll, uint256 newWarpToll, uint256 previousCcipFee, uint256 newCcipFee);
    event RequestQueued(
        bytes32 indexed globalPaymentId,
        bytes32 indexed inboundMessageId,
        uint64 indexed originChainSelector,
        address originSpoke,
        uint256 amount
    );
    event WarpRequestSent(bytes32 indexed globalPaymentId, uint256 toll);
    event WarpResultQueued(bytes32 indexed globalPaymentId, bytes32 indexed warpNonce, bool succeeded);
    event ResultForwarded(bytes32 indexed globalPaymentId, bytes32 indexed outboundMessageId, uint256 fee);
    event TreasuryFunded(address indexed sender, uint256 amount);
    event TreasuryWithdrawn(address indexed recipient, uint256 amount);

    error ZeroAddress();
    error InvalidConfiguration();
    error InvalidCounterpart();
    error InvalidMessage();
    error InvalidStatus();
    error Replay();
    error FeeCapExceeded(uint256 fee, uint256 cap);
    error InsufficientTreasury(uint256 required, uint256 available);
    error NativeTransferFailed();

    constructor(
        address router,
        uint64 chainSelector,
        address portal,
        bytes3 chiaSourceChain,
        bytes32 bridgingPuzzle,
        bytes32 returnPuzzle,
        uint256 ccipResultGasLimit,
        uint256 initialMaxWarpToll,
        uint256 initialMaxCcipFee
    ) CCIPReceiver(router) {
        if (router == address(0) || portal == address(0)) revert ZeroAddress();
        if (
            chainSelector == 0 ||
            chiaSourceChain == bytes3(0) ||
            bridgingPuzzle == bytes32(0) ||
            returnPuzzle == bytes32(0) ||
            ccipResultGasLimit == 0
        ) revert InvalidConfiguration();

        i_router = IRouterClient(router);
        localChainSelector = chainSelector;
        warpPortal = IWarpPortal(portal);
        chiaChain = chiaSourceChain;
        samuelBridgingPuzzle = bridgingPuzzle;
        samuelReturnPuzzle = returnPuzzle;
        resultGasLimit = ccipResultGasLimit;
        maxWarpToll = initialMaxWarpToll;
        maxCcipFee = initialMaxCcipFee;
    }

    receive() external payable {
        emit TreasuryFunded(msg.sender, msg.value);
    }

    function getRequest(bytes32 globalPaymentId) external view returns (GatewayRequest memory) {
        return s_requests[globalPaymentId];
    }

    function requestStatus(
        bytes32 globalPaymentId
    ) external view returns (
        Status status,
        uint64 originChainSelector,
        address originSpoke,
        uint256 amount,
        bool succeeded,
        bytes32 outboundMessageId
    ) {
        GatewayRequest storage record = s_requests[globalPaymentId];
        return (
            record.status,
            record.request.originChainSelector,
            record.request.originSpoke,
            record.request.amount,
            record.succeeded,
            record.outboundMessageId
        );
    }

    function quoteResultFee(bytes32 globalPaymentId) external view returns (uint256) {
        GatewayRequest storage record = s_requests[globalPaymentId];
        if (record.status != Status.ResultQueued) revert InvalidStatus();
        if (record.request.originChainSelector == localChainSelector) return 0;
        return i_router.getFee(
            record.request.originChainSelector,
            _resultMessage(record)
        );
    }

    function acceptLocalRequest(bytes calldata data) external whenNotPaused returns (bytes32 messageId) {
        OmnichainMessageCodec.Request memory request = OmnichainMessageCodec.decodeRequest(data);
        if (
            request.originChainSelector != localChainSelector ||
            request.originSpoke != msg.sender
        ) revert InvalidCounterpart();
        messageId = keccak256(abi.encode("LOCAL_REQUEST", request.globalPaymentId));
        _queueRequest(request, messageId);
    }

    function forwardToWarp(bytes32 globalPaymentId) external whenNotPaused nonReentrant {
        GatewayRequest storage record = s_requests[globalPaymentId];
        if (record.status != Status.Queued) revert InvalidStatus();

        uint256 toll = warpPortal.messageToll();
        if (toll > maxWarpToll) revert FeeCapExceeded(toll, maxWarpToll);
        if (address(this).balance < toll) revert InsufficientTreasury(toll, address(this).balance);

        record.status = Status.WarpSent;
        bytes32[] memory contents = new bytes32[](10);
        contents[0] = globalPaymentId;
        contents[1] = record.request.purchaseId;
        contents[2] = record.request.artifactHash;
        contents[3] = bytes32(record.request.amount);
        contents[4] = bytes32(record.request.quantity);
        contents[5] = record.request.collectionId;
        contents[6] = record.request.deedLauncherId;
        contents[7] = record.request.vaultLauncherId;
        contents[8] = record.request.destinationPuzzle;
        contents[9] = bytes32(uint256(record.request.quoteExpiresAt));
        warpPortal.sendMessage{value: toll}(chiaChain, samuelBridgingPuzzle, contents);
        emit WarpRequestSent(globalPaymentId, toll);
    }

    function receiveMessage(
        bytes32 nonce,
        bytes3 sourceChain,
        bytes32 source,
        bytes32[] calldata contents
    ) external nonReentrant {
        if (
            msg.sender != address(warpPortal) ||
            sourceChain != chiaChain ||
            source != samuelReturnPuzzle
        ) revert InvalidCounterpart();
        bytes32 replayKey = keccak256(abi.encode(sourceChain, nonce));
        if (usedWarpNonces[replayKey]) revert Replay();
        if (nonce == bytes32(0) || contents.length != 3) revert InvalidMessage();

        bytes32 globalPaymentId = contents[0];
        GatewayRequest storage record = s_requests[globalPaymentId];
        if (record.status != Status.WarpSent) revert InvalidStatus();
        if (uint256(contents[1]) != record.request.amount || uint256(contents[2]) > 1) {
            revert InvalidMessage();
        }

        usedWarpNonces[replayKey] = true;
        record.status = Status.ResultQueued;
        record.warpNonce = nonce;
        record.succeeded = uint256(contents[2]) == 1;
        emit WarpResultQueued(globalPaymentId, nonce, record.succeeded);
    }

    function forwardResult(bytes32 globalPaymentId) external whenNotPaused nonReentrant returns (bytes32 messageId) {
        GatewayRequest storage record = s_requests[globalPaymentId];
        if (record.status != Status.ResultQueued) revert InvalidStatus();

        bytes memory data = OmnichainMessageCodec.encodeResult(_result(record));
        uint256 fee = 0;
        record.status = Status.ResultSent;
        if (record.request.originChainSelector == localChainSelector) {
            ILocalSpoke(record.request.originSpoke).receiveLocalResult(data);
            messageId = keccak256(abi.encode("LOCAL_RESULT", globalPaymentId));
        } else {
            Client.EVM2AnyMessage memory message = _resultMessage(record);
            fee = i_router.getFee(record.request.originChainSelector, message);
            if (fee > maxCcipFee) revert FeeCapExceeded(fee, maxCcipFee);
            if (address(this).balance < fee) revert InsufficientTreasury(fee, address(this).balance);
            messageId = i_router.ccipSend{value: fee}(record.request.originChainSelector, message);
        }
        record.outboundMessageId = messageId;
        emit ResultForwarded(globalPaymentId, messageId, fee);
    }

    function setTrustedSpoke(uint64 chainSelector, address spoke) external onlyOwner {
        if (chainSelector == 0) revert InvalidConfiguration();
        address previous = trustedSpokes[chainSelector];
        trustedSpokes[chainSelector] = spoke;
        emit TrustedSpokeUpdated(chainSelector, previous, spoke);
    }

    function setFeeCaps(uint256 newMaxWarpToll, uint256 newMaxCcipFee) external onlyOwner {
        uint256 previousWarpToll = maxWarpToll;
        uint256 previousCcipFee = maxCcipFee;
        maxWarpToll = newMaxWarpToll;
        maxCcipFee = newMaxCcipFee;
        emit FeeCapsUpdated(previousWarpToll, newMaxWarpToll, previousCcipFee, newMaxCcipFee);
    }

    function withdrawTreasury(address payable recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) revert NativeTransferFailed();
        emit TreasuryWithdrawn(recipient, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        if (message.destTokenAmounts.length != 0 || usedInboundMessageIds[message.messageId]) {
            revert InvalidMessage();
        }
        address sender = abi.decode(message.sender, (address));
        OmnichainMessageCodec.Request memory request = OmnichainMessageCodec.decodeRequest(message.data);
        if (
            message.sourceChainSelector != request.originChainSelector ||
            sender != request.originSpoke ||
            request.originChainSelector == localChainSelector
        ) revert InvalidCounterpart();
        usedInboundMessageIds[message.messageId] = true;
        _queueRequest(request, message.messageId);
    }

    function _queueRequest(
        OmnichainMessageCodec.Request memory request,
        bytes32 messageId
    ) private {
        if (
            request.hubChainSelector != localChainSelector ||
            request.hubGateway != address(this) ||
            request.originChainSelector == 0 ||
            request.originSpoke == address(0) ||
            request.depositor == address(0) ||
            request.settlementToken == address(0) ||
            request.localPaymentId == bytes32(0) ||
            request.purchaseId == bytes32(0) ||
            request.artifactHash == bytes32(0) ||
            request.collectionId == bytes32(0) ||
            request.deedLauncherId == bytes32(0) ||
            request.vaultLauncherId == bytes32(0) ||
            request.destinationPuzzle == bytes32(0) ||
            request.amount == 0 ||
            request.quantity != 1 ||
            request.quoteExpiresAt <= block.timestamp ||
            trustedSpokes[request.originChainSelector] != request.originSpoke ||
            request.globalPaymentId != OmnichainMessageCodec.deriveGlobalPaymentId(
                request.originChainSelector,
                request.originSpoke,
                request.settlementToken,
                request.localPaymentId,
                request.purchaseId,
                request.artifactHash
            )
        ) revert InvalidMessage();
        if (
            s_requests[request.globalPaymentId].status != Status.None ||
            globalPaymentForPurchase[request.purchaseId] != bytes32(0)
        ) revert Replay();

        GatewayRequest storage record = s_requests[request.globalPaymentId];
        record.request = request;
        record.inboundMessageId = messageId;
        record.queuedAt = uint64(block.timestamp);
        record.status = Status.Queued;
        globalPaymentForPurchase[request.purchaseId] = request.globalPaymentId;
        emit RequestQueued(
            request.globalPaymentId,
            messageId,
            request.originChainSelector,
            request.originSpoke,
            request.amount
        );
    }

    function _result(
        GatewayRequest storage record
    ) private view returns (OmnichainMessageCodec.Result memory) {
        return OmnichainMessageCodec.Result({
            originChainSelector: record.request.originChainSelector,
            originSpoke: record.request.originSpoke,
            globalPaymentId: record.request.globalPaymentId,
            purchaseId: record.request.purchaseId,
            artifactHash: record.request.artifactHash,
            destinationPuzzle: record.request.destinationPuzzle,
            warpNonce: record.warpNonce,
            amount: record.request.amount,
            succeeded: record.succeeded
        });
    }

    function _resultMessage(
        GatewayRequest storage record
    ) private view returns (Client.EVM2AnyMessage memory) {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(record.request.originSpoke),
            data: OmnichainMessageCodec.encodeResult(_result(record)),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(0),
            extraArgs: Client._argsToBytes(
                Client.GenericExtraArgsV2({
                    gasLimit: resultGasLimit,
                    allowOutOfOrderExecution: true
                })
            )
        });
    }
}

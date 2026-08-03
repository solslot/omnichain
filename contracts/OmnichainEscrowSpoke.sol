// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {OmnichainMessageCodec} from "./libraries/OmnichainMessageCodec.sol";
import {ILocalGateway, ILocalSpoke} from "./interfaces/ILocalOmnichain.sol";

contract OmnichainEscrowSpoke is CCIPReceiver, ILocalSpoke, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // The generic field is either a SmartDeed count (server-capped at 100) or
    // one vault-locked SGT CAT amount (permanently capped by total supply).
    uint256 public constant MAX_DELIVERY_QUANTITY = 1_000_000;

    enum Status {
        None,
        RequestSent,
        ResultReceived,
        SettledSuccess,
        SettledRefund,
        EmergencyRefund
    }

    struct Deposit {
        address depositor;
        address settlementToken;
        bytes32 localPaymentId;
        bytes32 purchaseId;
        bytes32 artifactHash;
        bytes32 collectionId;
        bytes32 deedLauncherId;
        bytes32 vaultLauncherId;
        bytes32 destinationPuzzle;
        bytes32 requestMessageId;
        bytes32 resultMessageId;
        bytes32 warpNonce;
        uint256 amount;
        uint256 quantity;
        uint64 hubChainSelector;
        address hubGateway;
        uint64 createdAt;
        uint64 quoteExpiresAt;
        Status status;
        bool succeeded;
    }

    IERC20 public immutable usdcToken;
    address public immutable payoutAddress;
    uint64 public immutable localChainSelector;
    uint256 public immutable resultGasLimit;
    uint256 public immutable emergencyDelay;

    uint64 public hubChainSelector;
    address public hubGateway;
    uint256 public depositCount;

    IRouterClient private immutable i_router;
    mapping(bytes32 => Deposit) private s_deposits;
    mapping(bytes32 => bool) public usedResultMessageIds;
    mapping(bytes32 => bytes32) public globalPaymentForPurchase;
    mapping(bytes32 => uint256) public emergencyRefundAvailableAt;

    event HubRouteUpdated(
        uint64 indexed previousSelector,
        address indexed previousGateway,
        uint64 indexed newSelector,
        address newGateway
    );
    event PaymentDeposited(
        bytes32 indexed globalPaymentId,
        bytes32 indexed localPaymentId,
        address indexed depositor,
        address settlementToken,
        uint256 amount,
        uint64 hubChainSelector,
        address hubGateway,
        bytes32 requestMessageId,
        uint256 bridgeFee
    );
    event ResultReceived(
        bytes32 indexed globalPaymentId,
        bytes32 indexed resultMessageId,
        bytes32 indexed warpNonce,
        bool succeeded
    );
    event PaymentSettled(
        bytes32 indexed globalPaymentId,
        address indexed recipient,
        address settlementToken,
        uint256 amount,
        bool succeeded,
        bool emergency
    );
    event EmergencyRefundScheduled(bytes32 indexed globalPaymentId, uint256 availableAt);

    error ZeroAddress();
    error InvalidConfiguration();
    error InvalidPayment();
    error InvalidStatus();
    error InvalidCounterpart();
    error InvalidAmount();
    error InvalidMessage();
    error InsufficientFee(uint256 required, uint256 supplied);
    error RefundFailed();
    error EmergencyDelayActive();

    constructor(
        address router,
        uint64 chainSelector,
        address usdc,
        address payout,
        uint64 initialHubChainSelector,
        address initialHubGateway,
        uint256 ccipResultGasLimit,
        uint256 refundDelay
    ) CCIPReceiver(router) {
        if (router == address(0) || usdc == address(0) || payout == address(0)) {
            revert ZeroAddress();
        }
        if (
            chainSelector == 0 ||
            initialHubChainSelector == 0 ||
            initialHubGateway == address(0) ||
            ccipResultGasLimit == 0 ||
            refundDelay < 7 days ||
            IERC20Metadata(usdc).decimals() != 6
        ) revert InvalidConfiguration();

        i_router = IRouterClient(router);
        usdcToken = IERC20(usdc);
        payoutAddress = payout;
        localChainSelector = chainSelector;
        hubChainSelector = initialHubChainSelector;
        hubGateway = initialHubGateway;
        resultGasLimit = ccipResultGasLimit;
        emergencyDelay = refundDelay;
    }

    function getDeposit(bytes32 globalPaymentId) external view returns (Deposit memory) {
        return s_deposits[globalPaymentId];
    }

    function isSupportedToken(address token) public view returns (bool) {
        return token == address(usdcToken);
    }

    function deriveGlobalPaymentId(
        address token,
        bytes32 localPaymentId,
        bytes32 purchaseId,
        bytes32 artifactHash
    ) public view returns (bytes32) {
        if (!isSupportedToken(token)) revert InvalidConfiguration();
        return OmnichainMessageCodec.deriveGlobalPaymentId(
            localChainSelector,
            address(this),
            token,
            localPaymentId,
            purchaseId,
            artifactHash
        );
    }

    function quoteDepositFee(
        address token,
        bytes32 localPaymentId,
        bytes32 purchaseId,
        bytes32 artifactHash,
        bytes32 collectionId,
        bytes32 deedLauncherId,
        bytes32 vaultLauncherId,
        bytes32 destinationPuzzle,
        uint256 amount,
        uint256 quantity,
        uint64 quoteExpiresAt,
        address depositor
    ) external view returns (uint256) {
        OmnichainMessageCodec.Request memory request = _request(
            token,
            localPaymentId,
            purchaseId,
            artifactHash,
            collectionId,
            deedLauncherId,
            vaultLauncherId,
            destinationPuzzle,
            amount,
            quantity,
            quoteExpiresAt,
            depositor
        );
        if (request.hubChainSelector == localChainSelector) return 0;
        return i_router.getFee(request.hubChainSelector, _ccipMessage(request));
    }

    function depositPayment(
        address token,
        bytes32 localPaymentId,
        bytes32 purchaseId,
        bytes32 artifactHash,
        bytes32 collectionId,
        bytes32 deedLauncherId,
        bytes32 vaultLauncherId,
        bytes32 destinationPuzzle,
        uint256 amount,
        uint256 quantity,
        uint64 quoteExpiresAt
    ) external payable whenNotPaused nonReentrant returns (bytes32 globalPaymentId, bytes32 messageId) {
        OmnichainMessageCodec.Request memory request = _request(
            token,
            localPaymentId,
            purchaseId,
            artifactHash,
            collectionId,
            deedLauncherId,
            vaultLauncherId,
            destinationPuzzle,
            amount,
            quantity,
            quoteExpiresAt,
            msg.sender
        );
        globalPaymentId = request.globalPaymentId;
        if (
            s_deposits[globalPaymentId].status != Status.None ||
            globalPaymentForPurchase[purchaseId] != bytes32(0)
        ) revert InvalidPayment();

        IERC20 selectedToken = IERC20(token);
        uint256 balanceBefore = selectedToken.balanceOf(address(this));
        Deposit storage record = s_deposits[globalPaymentId];
        record.depositor = msg.sender;
        record.settlementToken = token;
        record.localPaymentId = localPaymentId;
        record.purchaseId = purchaseId;
        record.artifactHash = artifactHash;
        record.collectionId = collectionId;
        record.deedLauncherId = deedLauncherId;
        record.vaultLauncherId = vaultLauncherId;
        record.destinationPuzzle = destinationPuzzle;
        record.amount = amount;
        record.quantity = quantity;
        record.hubChainSelector = request.hubChainSelector;
        record.hubGateway = request.hubGateway;
        record.createdAt = uint64(block.timestamp);
        record.quoteExpiresAt = quoteExpiresAt;
        record.status = Status.RequestSent;
        globalPaymentForPurchase[purchaseId] = globalPaymentId;
        depositCount += 1;

        selectedToken.safeTransferFrom(msg.sender, address(this), amount);
        if (selectedToken.balanceOf(address(this)) - balanceBefore != amount) revert InvalidAmount();

        uint256 fee = 0;
        bytes memory data = OmnichainMessageCodec.encodeRequest(request);
        if (request.hubChainSelector == localChainSelector) {
            if (msg.value != 0) revert InsufficientFee(0, msg.value);
            messageId = ILocalGateway(request.hubGateway).acceptLocalRequest(data);
        } else {
            Client.EVM2AnyMessage memory ccipMessage = _ccipMessage(request);
            fee = i_router.getFee(request.hubChainSelector, ccipMessage);
            if (msg.value < fee) revert InsufficientFee(fee, msg.value);
            messageId = i_router.ccipSend{value: fee}(request.hubChainSelector, ccipMessage);
            if (msg.value > fee) {
                (bool refunded, ) = payable(msg.sender).call{value: msg.value - fee}("");
                if (!refunded) revert RefundFailed();
            }
        }
        record.requestMessageId = messageId;

        emit PaymentDeposited(
            globalPaymentId,
            localPaymentId,
            msg.sender,
            token,
            amount,
            request.hubChainSelector,
            request.hubGateway,
            messageId,
            fee
        );
    }

    function receiveLocalResult(bytes calldata data) external nonReentrant {
        OmnichainMessageCodec.Result memory result = OmnichainMessageCodec.decodeResult(data);
        Deposit storage record = s_deposits[result.globalPaymentId];
        if (
            record.hubChainSelector != localChainSelector ||
            record.hubGateway != msg.sender
        ) revert InvalidCounterpart();
        _recordResult(result, keccak256(abi.encode("LOCAL_RESULT", result.globalPaymentId)));
    }

    function settle(bytes32 globalPaymentId) external nonReentrant {
        Deposit storage record = s_deposits[globalPaymentId];
        if (record.status != Status.ResultReceived) revert InvalidStatus();

        address recipient;
        if (record.succeeded) {
            record.status = Status.SettledSuccess;
            recipient = payoutAddress;
        } else {
            record.status = Status.SettledRefund;
            recipient = record.depositor;
        }
        IERC20(record.settlementToken).safeTransfer(recipient, record.amount);
        emit PaymentSettled(
            globalPaymentId,
            recipient,
            record.settlementToken,
            record.amount,
            record.succeeded,
            false
        );
    }

    function scheduleEmergencyRefund(bytes32 globalPaymentId) external onlyOwner nonReentrant {
        Deposit storage record = s_deposits[globalPaymentId];
        if (record.status != Status.RequestSent) revert InvalidStatus();
        uint256 availableAt = block.timestamp + emergencyDelay;
        emergencyRefundAvailableAt[globalPaymentId] = availableAt;
        emit EmergencyRefundScheduled(globalPaymentId, availableAt);
    }

    function executeEmergencyRefund(bytes32 globalPaymentId) external nonReentrant {
        Deposit storage record = s_deposits[globalPaymentId];
        uint256 availableAt = emergencyRefundAvailableAt[globalPaymentId];
        if (record.status != Status.RequestSent || availableAt == 0) revert InvalidStatus();
        if (block.timestamp < availableAt) revert EmergencyDelayActive();

        record.status = Status.EmergencyRefund;
        delete emergencyRefundAvailableAt[globalPaymentId];
        IERC20(record.settlementToken).safeTransfer(record.depositor, record.amount);
        emit PaymentSettled(
            globalPaymentId,
            record.depositor,
            record.settlementToken,
            record.amount,
            false,
            true
        );
    }

    function setHubRoute(uint64 newSelector, address newGateway) external onlyOwner {
        if (newSelector == 0 || newGateway == address(0)) revert InvalidConfiguration();
        uint64 previousSelector = hubChainSelector;
        address previousGateway = hubGateway;
        hubChainSelector = newSelector;
        hubGateway = newGateway;
        emit HubRouteUpdated(previousSelector, previousGateway, newSelector, newGateway);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override nonReentrant {
        if (message.destTokenAmounts.length != 0 || usedResultMessageIds[message.messageId]) {
            revert InvalidMessage();
        }
        address sender = abi.decode(message.sender, (address));
        OmnichainMessageCodec.Result memory result = OmnichainMessageCodec.decodeResult(message.data);
        Deposit storage record = s_deposits[result.globalPaymentId];
        if (
            message.sourceChainSelector != record.hubChainSelector ||
            sender != record.hubGateway ||
            record.hubChainSelector == localChainSelector
        ) revert InvalidCounterpart();
        usedResultMessageIds[message.messageId] = true;
        _recordResult(result, message.messageId);
    }

    function _recordResult(
        OmnichainMessageCodec.Result memory result,
        bytes32 messageId
    ) private {
        Deposit storage record = s_deposits[result.globalPaymentId];
        if (record.status != Status.RequestSent) revert InvalidStatus();
        if (
            result.originChainSelector != localChainSelector ||
            result.originSpoke != address(this) ||
            result.purchaseId != record.purchaseId ||
            result.artifactHash != record.artifactHash ||
            result.destinationPuzzle != record.destinationPuzzle ||
            result.amount != record.amount ||
            result.warpNonce == bytes32(0)
        ) revert InvalidMessage();

        record.status = Status.ResultReceived;
        record.resultMessageId = messageId;
        record.warpNonce = result.warpNonce;
        record.succeeded = result.succeeded;
        emit ResultReceived(result.globalPaymentId, messageId, result.warpNonce, result.succeeded);
    }

    function _request(
        address token,
        bytes32 localPaymentId,
        bytes32 purchaseId,
        bytes32 artifactHash,
        bytes32 collectionId,
        bytes32 deedLauncherId,
        bytes32 vaultLauncherId,
        bytes32 destinationPuzzle,
        uint256 amount,
        uint256 quantity,
        uint64 quoteExpiresAt,
        address depositor
    ) private view returns (OmnichainMessageCodec.Request memory request) {
        if (
            !isSupportedToken(token) ||
            localPaymentId == bytes32(0) ||
            purchaseId == bytes32(0) ||
            artifactHash == bytes32(0) ||
            collectionId == bytes32(0) ||
            deedLauncherId == bytes32(0) ||
            vaultLauncherId == bytes32(0) ||
            destinationPuzzle == bytes32(0) ||
            amount == 0 ||
            quantity == 0 ||
            quantity > MAX_DELIVERY_QUANTITY ||
            quoteExpiresAt <= block.timestamp ||
            quoteExpiresAt > block.timestamp + 30 minutes ||
            depositor == address(0)
        ) revert InvalidPayment();
        request = OmnichainMessageCodec.Request({
            originChainSelector: localChainSelector,
            originSpoke: address(this),
            depositor: depositor,
            settlementToken: token,
            localPaymentId: localPaymentId,
            globalPaymentId: deriveGlobalPaymentId(
                token,
                localPaymentId,
                purchaseId,
                artifactHash
            ),
            purchaseId: purchaseId,
            artifactHash: artifactHash,
            collectionId: collectionId,
            deedLauncherId: deedLauncherId,
            vaultLauncherId: vaultLauncherId,
            destinationPuzzle: destinationPuzzle,
            amount: amount,
            quantity: quantity,
            quoteExpiresAt: quoteExpiresAt,
            hubChainSelector: hubChainSelector,
            hubGateway: hubGateway
        });
    }

    function _ccipMessage(
        OmnichainMessageCodec.Request memory request
    ) private view returns (Client.EVM2AnyMessage memory) {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(request.hubGateway),
            data: OmnichainMessageCodec.encodeRequest(request),
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

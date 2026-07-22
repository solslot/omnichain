// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

interface ISolslotRecoverableSafe {
    enum Operation {
        Call,
        DelegateCall
    }

    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isModuleEnabled(address module) external view returns (bool);
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external returns (bool success);
    function swapOwner(address previousOwner, address oldOwner, address newOwner) external;
}

/// @notice Seven-day, guardian-initiated recovery for the slot-0 Owner Identity Safe.
contract SolslotOwnerRecovery {
    error ActiveRecoveryExists();
    error ApprovalAlreadyRecorded();
    error InvalidBinding();
    error InvalidRecovery();
    error RecoveryAlreadyBound();
    error RecoveryDelayActive();
    error RecoveryNotApproved();
    error SafeStateChanged();
    error UnauthorizedRecoveryActor();

    uint256 public constant RECOVERY_DELAY_SECONDS = 7 days;
    address private constant SENTINEL_OWNERS = address(0x1);

    struct RecoveryRequest {
        bytes32 id;
        address oldOwner;
        address replacementOwner;
        uint64 executeAfter;
        uint8 coadminApprovals;
        bool replacementAccepted;
    }

    address public immutable initializer;
    address public immutable secp256k1Guardian;
    address public immutable coadminOne;
    address public immutable coadminTwo;
    bytes32 public immutable blsGuardianCommitment;
    address public ownerIdentitySafe;
    uint256 public recoveryNonce;
    RecoveryRequest private activeRecovery;

    event OwnerIdentitySafeBound(address indexed safe);
    event RecoveryInitiated(
        bytes32 indexed recoveryId,
        address indexed oldOwner,
        address indexed replacementOwner,
        uint256 executeAfter
    );
    event RecoveryApproved(bytes32 indexed recoveryId, address indexed coadmin);
    event RecoveryAccepted(bytes32 indexed recoveryId, address indexed replacementOwner);
    event RecoveryCancelled(bytes32 indexed recoveryId);
    event RecoveryExecuted(bytes32 indexed recoveryId, address indexed oldOwner, address indexed replacementOwner);

    constructor(
        address initializer_,
        address secp256k1Guardian_,
        address coadminOne_,
        address coadminTwo_,
        bytes32 blsGuardianCommitment_
    ) {
        if (
            initializer_ == address(0) || secp256k1Guardian_ == address(0)
                || coadminOne_ == address(0) || coadminTwo_ == address(0)
                || blsGuardianCommitment_ == bytes32(0)
                || secp256k1Guardian_ == coadminOne_ || secp256k1Guardian_ == coadminTwo_
                || coadminOne_ == coadminTwo_
        ) revert InvalidBinding();
        initializer = initializer_;
        secp256k1Guardian = secp256k1Guardian_;
        coadminOne = coadminOne_;
        coadminTwo = coadminTwo_;
        blsGuardianCommitment = blsGuardianCommitment_;
    }

    function bindOwnerIdentitySafe(address safe) external {
        if (msg.sender != initializer || safe == address(0) || safe.code.length == 0) {
            revert InvalidBinding();
        }
        if (ownerIdentitySafe != address(0)) revert RecoveryAlreadyBound();
        ownerIdentitySafe = safe;
        emit OwnerIdentitySafeBound(safe);
    }

    function recovery() external view returns (RecoveryRequest memory) {
        return activeRecovery;
    }

    function initiateRecovery(address replacementOwner) external returns (bytes32 recoveryId) {
        if (msg.sender != secp256k1Guardian) revert UnauthorizedRecoveryActor();
        if (activeRecovery.id != bytes32(0)) revert ActiveRecoveryExists();
        address oldOwner = _currentOwner();
        if (
            replacementOwner == address(0) || replacementOwner == oldOwner
                || replacementOwner == secp256k1Guardian || replacementOwner == coadminOne
                || replacementOwner == coadminTwo || replacementOwner == ownerIdentitySafe
        ) revert InvalidRecovery();
        uint256 nonce = ++recoveryNonce;
        recoveryId = keccak256(
            abi.encode(block.chainid, address(this), ownerIdentitySafe, oldOwner, replacementOwner, nonce)
        );
        uint64 executeAfter = uint64(block.timestamp + RECOVERY_DELAY_SECONDS);
        activeRecovery = RecoveryRequest(recoveryId, oldOwner, replacementOwner, executeAfter, 0, false);
        emit RecoveryInitiated(recoveryId, oldOwner, replacementOwner, executeAfter);
    }

    function approveRecovery(bytes32 recoveryId) external {
        RecoveryRequest storage request = activeRecovery;
        if (request.id == bytes32(0) || request.id != recoveryId) revert InvalidRecovery();
        uint8 approval = 0;
        if (msg.sender == coadminOne) approval = 1;
        else if (msg.sender == coadminTwo) approval = 2;
        else revert UnauthorizedRecoveryActor();
        if (request.coadminApprovals & approval != 0) revert ApprovalAlreadyRecorded();
        request.coadminApprovals |= approval;
        emit RecoveryApproved(recoveryId, msg.sender);
    }

    function acceptRecovery(bytes32 recoveryId) external {
        RecoveryRequest storage request = activeRecovery;
        if (request.id == bytes32(0) || request.id != recoveryId) revert InvalidRecovery();
        if (msg.sender != request.replacementOwner) revert UnauthorizedRecoveryActor();
        request.replacementAccepted = true;
        emit RecoveryAccepted(recoveryId, msg.sender);
    }

    function cancelRecovery(bytes32 recoveryId) external {
        if (msg.sender != secp256k1Guardian) revert UnauthorizedRecoveryActor();
        // slither-disable-next-line incorrect-equality
        if (activeRecovery.id == bytes32(0) || activeRecovery.id != recoveryId) revert InvalidRecovery();
        delete activeRecovery;
        emit RecoveryCancelled(recoveryId);
    }

    function executeRecovery(bytes32 recoveryId) external {
        RecoveryRequest memory request = activeRecovery;
        // slither-disable-next-line incorrect-equality
        if (request.id == bytes32(0) || request.id != recoveryId) revert InvalidRecovery();
        if (request.coadminApprovals != 3 || !request.replacementAccepted) revert RecoveryNotApproved();
        if (block.timestamp < request.executeAfter) revert RecoveryDelayActive();
        if (_currentOwner() != request.oldOwner) revert SafeStateChanged();
        ISolslotRecoverableSafe safe = ISolslotRecoverableSafe(ownerIdentitySafe);
        if (!safe.isModuleEnabled(address(this))) revert SafeStateChanged();

        delete activeRecovery;
        bytes memory payload = abi.encodeCall(
            ISolslotRecoverableSafe.swapOwner,
            (SENTINEL_OWNERS, request.oldOwner, request.replacementOwner)
        );
        // The request is already deleted and this bound Safe call can only swap its own owner.
        // slither-disable-next-line reentrancy-events
        if (!safe.execTransactionFromModule(ownerIdentitySafe, 0, payload, ISolslotRecoverableSafe.Operation.Call)) {
            revert SafeStateChanged();
        }
        if (_currentOwner() != request.replacementOwner) revert SafeStateChanged();
        emit RecoveryExecuted(recoveryId, request.oldOwner, request.replacementOwner);
    }

    function _currentOwner() private view returns (address) {
        address safeAddress = ownerIdentitySafe;
        if (safeAddress == address(0)) revert InvalidBinding();
        ISolslotRecoverableSafe safe = ISolslotRecoverableSafe(safeAddress);
        address[] memory owners = safe.getOwners();
        if (owners.length != 1 || safe.getThreshold() != 1) revert SafeStateChanged();
        return owners[0];
    }
}

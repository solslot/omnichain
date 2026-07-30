// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

interface ISolslotRecoveryFreezeV3 {
    function isChangeActive() external view returns (bool);
}

/// @notice Immutable Safe-topology guard with a recovery-wide transaction freeze.
contract SolslotAuthorityGuardV3 {
    enum Operation {
        Call,
        DelegateCall
    }

    error DelegateCallBlocked();
    error GuardAlreadyBound();
    error GuardNotBound();
    error InvalidBinding();
    error InvalidSafeCaller();
    error RecoveryFreezeActive();
    error SafeConfigurationBlocked();

    address public immutable initializer;
    address public immutable signMessageLibrary;
    address public immutable recoveryCoordinator;
    address public authoritySafe;

    bytes4 private constant SIGN_MESSAGE = bytes4(keccak256("signMessage(bytes)"));
    bytes4 private constant ERC165_INTERFACE = 0x01ffc9a7;
    bytes4 private constant SAFE_GUARD_INTERFACE = 0xe6d7a83a;
    bytes4 private constant APPROVE_ROUTINE =
        bytes4(keccak256("approveRoutineByRoot(bytes32)"));
    bytes4 private constant APPROVE_LOST =
        bytes4(keccak256("approveLostKeyByPeer(bytes32)"));
    bytes4 private constant APPROVE_RECOVERY_KIT =
        bytes4(keccak256("approveRecoveryKitByRoot(bytes32)"));
    bytes4 private constant CANCEL_ROUTINE =
        bytes4(keccak256("cancelRoutineByRoot(bytes32)"));
    bytes4 private constant CANCEL_LOST =
        bytes4(keccak256("cancelLostKeyByPeer(bytes32)"));
    bytes4 private constant CANCEL_RECOVERY_KIT =
        bytes4(keccak256("cancelRecoveryKitByRoot(bytes32)"));
    bytes4 private constant CONFIRM_CONVERGENCE =
        bytes4(keccak256("confirmCrossChainConvergence(bytes32,bytes32)"));
    bytes4 private constant APPROVE_ROLLBACK =
        bytes4(keccak256("approveRollbackByRoot(bytes32,bytes32)"));
    bytes4 private constant ENABLE_MODULE = bytes4(keccak256("enableModule(address)"));
    bytes4 private constant DISABLE_MODULE =
        bytes4(keccak256("disableModule(address,address)"));
    bytes4 private constant SET_GUARD = bytes4(keccak256("setGuard(address)"));
    bytes4 private constant SET_MODULE_GUARD =
        bytes4(keccak256("setModuleGuard(address,address)"));
    bytes4 private constant SET_FALLBACK_HANDLER =
        bytes4(keccak256("setFallbackHandler(address)"));
    bytes4 private constant ADD_OWNER =
        bytes4(keccak256("addOwnerWithThreshold(address,uint256)"));
    bytes4 private constant REMOVE_OWNER =
        bytes4(keccak256("removeOwner(address,address,uint256)"));
    bytes4 private constant SWAP_OWNER =
        bytes4(keccak256("swapOwner(address,address,address)"));
    bytes4 private constant CHANGE_THRESHOLD =
        bytes4(keccak256("changeThreshold(uint256)"));
    bytes4 private constant CHANGE_SINGLETON =
        bytes4(keccak256("changeMasterCopy(address)"));
    bytes4 private constant SETUP = bytes4(
        keccak256(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)"
        )
    );

    event AuthoritySafeBound(address indexed safe);

    constructor(
        address initializer_,
        address signMessageLibrary_,
        address recoveryCoordinator_
    ) {
        if (
            initializer_ == address(0) || signMessageLibrary_ == address(0)
                || recoveryCoordinator_ == address(0)
                || signMessageLibrary_.code.length == 0
                || recoveryCoordinator_.code.length == 0
                || signMessageLibrary_ == recoveryCoordinator_
        ) revert InvalidBinding();
        initializer = initializer_;
        signMessageLibrary = signMessageLibrary_;
        recoveryCoordinator = recoveryCoordinator_;
    }

    function bindAuthoritySafe(address safe) external {
        if (
            msg.sender != initializer || safe == address(0) || safe.code.length == 0
                || safe == signMessageLibrary || safe == recoveryCoordinator
        ) revert InvalidBinding();
        if (authoritySafe != address(0)) revert GuardAlreadyBound();
        authoritySafe = safe;
        emit AuthoritySafeBound(safe);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == ERC165_INTERFACE || interfaceId == SAFE_GUARD_INTERFACE;
    }

    function checkTransaction(
        address to,
        uint256,
        bytes calldata data,
        Operation operation,
        uint256,
        uint256,
        uint256,
        address,
        address payable,
        bytes calldata,
        address
    ) external view {
        address safe = authoritySafe;
        if (safe == address(0)) revert GuardNotBound();
        if (msg.sender != safe) revert InvalidSafeCaller();
        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);

        if (ISolslotRecoveryFreezeV3(recoveryCoordinator).isChangeActive()) {
            if (
                operation != Operation.Call || to != recoveryCoordinator
                    || !_isRecoverySelector(selector)
            ) revert RecoveryFreezeActive();
            return;
        }
        if (operation == Operation.DelegateCall) {
            if (to != signMessageLibrary || selector != SIGN_MESSAGE) {
                revert DelegateCallBlocked();
            }
            return;
        }
        if (to == safe && _changesSafeConfiguration(selector)) {
            revert SafeConfigurationBlocked();
        }
    }

    function checkAfterExecution(bytes32, bool) external view {
        if (authoritySafe == address(0)) revert GuardNotBound();
        if (msg.sender != authoritySafe) revert InvalidSafeCaller();
    }

    function _isRecoverySelector(bytes4 selector) private pure returns (bool) {
        return selector == APPROVE_ROUTINE || selector == APPROVE_LOST
            || selector == APPROVE_RECOVERY_KIT
            || selector == CANCEL_ROUTINE || selector == CANCEL_LOST
            || selector == CANCEL_RECOVERY_KIT
            || selector == CONFIRM_CONVERGENCE || selector == APPROVE_ROLLBACK;
    }

    function _changesSafeConfiguration(bytes4 selector) private pure returns (bool) {
        return selector == ENABLE_MODULE || selector == DISABLE_MODULE
            || selector == SET_GUARD || selector == SET_MODULE_GUARD
            || selector == SET_FALLBACK_HANDLER || selector == ADD_OWNER
            || selector == REMOVE_OWNER || selector == SWAP_OWNER
            || selector == CHANGE_THRESHOLD || selector == CHANGE_SINGLETON
            || selector == SETUP;
    }
}

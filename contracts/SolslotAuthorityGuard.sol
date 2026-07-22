// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/// @notice Freezes one authority Safe's topology while retaining Safe message signing.
/// @dev Safe calls this contract using the canonical Guard interface.
contract SolslotAuthorityGuard {
    enum Operation {
        Call,
        DelegateCall
    }

    error GuardAlreadyBound();
    error GuardNotBound();
    error InvalidBinding();
    error InvalidSafeCaller();
    error SafeConfigurationBlocked();
    error DelegateCallBlocked();

    address public immutable initializer;
    address public immutable signMessageLibrary;
    address public authoritySafe;

    bytes4 private constant SIGN_MESSAGE = bytes4(keccak256("signMessage(bytes)"));
    bytes4 private constant ERC165_INTERFACE = 0x01ffc9a7;
    bytes4 private constant SAFE_GUARD_INTERFACE = 0xe6d7a83a;
    bytes4 private constant ENABLE_MODULE = bytes4(keccak256("enableModule(address)"));
    bytes4 private constant DISABLE_MODULE = bytes4(keccak256("disableModule(address,address)"));
    bytes4 private constant SET_GUARD = bytes4(keccak256("setGuard(address)"));
    bytes4 private constant SET_MODULE_GUARD = bytes4(keccak256("setModuleGuard(address,address)"));
    bytes4 private constant SET_FALLBACK_HANDLER = bytes4(keccak256("setFallbackHandler(address)"));
    bytes4 private constant ADD_OWNER = bytes4(keccak256("addOwnerWithThreshold(address,uint256)"));
    bytes4 private constant REMOVE_OWNER = bytes4(keccak256("removeOwner(address,address,uint256)"));
    bytes4 private constant SWAP_OWNER = bytes4(keccak256("swapOwner(address,address,address)"));
    bytes4 private constant CHANGE_THRESHOLD = bytes4(keccak256("changeThreshold(uint256)"));
    bytes4 private constant CHANGE_SINGLETON = bytes4(keccak256("changeMasterCopy(address)"));
    bytes4 private constant SETUP = bytes4(keccak256("setup(address[],uint256,address,bytes,address,address,uint256,address)"));

    event AuthoritySafeBound(address indexed safe);

    constructor(address initializer_, address signMessageLibrary_) {
        if (initializer_ == address(0) || signMessageLibrary_ == address(0)) {
            revert InvalidBinding();
        }
        initializer = initializer_;
        signMessageLibrary = signMessageLibrary_;
    }

    function bindAuthoritySafe(address safe) external {
        if (msg.sender != initializer || safe == address(0) || safe.code.length == 0) {
            revert InvalidBinding();
        }
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
        if (operation == Operation.DelegateCall) {
            if (to != signMessageLibrary || selector != SIGN_MESSAGE) revert DelegateCallBlocked();
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

    function _changesSafeConfiguration(bytes4 selector) private pure returns (bool) {
        return selector == ENABLE_MODULE || selector == DISABLE_MODULE || selector == SET_GUARD
            || selector == SET_MODULE_GUARD || selector == SET_FALLBACK_HANDLER
            || selector == ADD_OWNER || selector == REMOVE_OWNER || selector == SWAP_OWNER
            || selector == CHANGE_THRESHOLD || selector == CHANGE_SINGLETON || selector == SETUP;
    }
}

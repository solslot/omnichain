// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

interface IMockSafeGuard {
    enum Operation {
        Call,
        DelegateCall
    }

    function checkTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures,
        address msgSender
    ) external view;
}

contract MockSafe {
    bytes32 private constant FALLBACK_HANDLER_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;
    bytes32 private constant GUARD_SLOT =
        0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;

    address[] private s_owners;
    uint256 private immutable i_threshold;
    mapping(address => bool) private s_modules;

    constructor(address[] memory owners, uint256 threshold) {
        s_owners = owners;
        i_threshold = threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return s_owners;
    }

    function getThreshold() external view returns (uint256) {
        return i_threshold;
    }

    function setFallbackHandler(address handler) external {
        bytes32 slot = FALLBACK_HANDLER_SLOT;
        assembly {
            sstore(slot, handler)
        }
    }

    function setGuard(address guard) external {
        bytes32 slot = GUARD_SLOT;
        assembly {
            sstore(slot, guard)
        }
    }

    function enableModule(address module) external {
        s_modules[module] = true;
    }

    function isModuleEnabled(address module) external view returns (bool) {
        return s_modules[module];
    }

    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        uint8
    ) external returns (bool success) {
        require(s_modules[msg.sender], "module not enabled");
        (success,) = to.call{value: value}(data);
    }

    function swapOwner(address previousOwner, address oldOwner, address newOwner) external {
        require(msg.sender == address(this), "only self");
        require(previousOwner == address(0x1), "bad predecessor");
        require(s_owners.length == 1 && s_owners[0] == oldOwner, "wrong owner");
        s_owners[0] = newOwner;
    }

    function checkGuard(address guard, address to, bytes calldata data, uint8 operation) external view {
        IMockSafeGuard(guard).checkTransaction(
            to,
            0,
            data,
            IMockSafeGuard.Operation(operation),
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            "",
            msg.sender
        );
    }

    function delegateSetup(address setup, bytes calldata data) external {
        (bool success,) = setup.delegatecall(data);
        require(success, "setup failed");
    }

    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool success, bytes memory result) = target.call(data);
        require(success, "mock Safe call failed");
        return result;
    }
}

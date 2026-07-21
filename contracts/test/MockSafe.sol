// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

contract MockSafe {
    address[] private s_owners;
    uint256 private immutable i_threshold;

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

    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool success, bytes memory result) = target.call(data);
        require(success, "mock Safe call failed");
        return result;
    }
}

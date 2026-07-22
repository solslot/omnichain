// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract SolslotAlphaTimelock is TimelockController {
    error AuthorityConfigurationFrozen();
    error InvalidMinimumDelay();

    uint256 public constant REQUIRED_MINIMUM_DELAY = 1 days;

    constructor(
        uint256 minimumDelay,
        address[] memory proposers,
        address[] memory executors
    ) TimelockController(minimumDelay, proposers, executors, address(0)) {
        if (minimumDelay != REQUIRED_MINIMUM_DELAY) revert InvalidMinimumDelay();
    }

    function grantRole(bytes32, address) public pure override {
        revert AuthorityConfigurationFrozen();
    }

    function revokeRole(bytes32, address) public pure override {
        revert AuthorityConfigurationFrozen();
    }

    function renounceRole(bytes32, address) public pure override {
        revert AuthorityConfigurationFrozen();
    }

    function updateDelay(uint256) external pure override {
        revert AuthorityConfigurationFrozen();
    }
}

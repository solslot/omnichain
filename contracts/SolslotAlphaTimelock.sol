// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract SolslotAlphaTimelock is TimelockController {
    constructor(
        uint256 minimumDelay,
        address[] memory proposers,
        address[] memory executors
    ) TimelockController(minimumDelay, proposers, executors, address(0)) {}
}

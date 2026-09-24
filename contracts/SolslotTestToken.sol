// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Valueless, freely mintable fixtures for Solslot's Testnet11 release.
/// @dev This contract cannot represent issuer USDC/USDT. Its fixture ID and
/// deployment bytecode must be pinned by the payment release evidence.
contract SolslotTestToken is ERC20 {
    bytes32 public constant TEST_ASSET_DOMAIN = keccak256("solslot-testnet11-valueless-v1");
    // Set only by the constructor. A shared runtime lets deployment review
    // pin the exact bytecode before either fixture is deployed.
    bytes32 public fixtureId;
    uint256 public constant FAUCET_AMOUNT = 10_000 * 10 ** 6;
    uint256 public constant FAUCET_INTERVAL = 1 hours;
    mapping(address => uint256) public nextClaimAt;

    constructor(bool usdt) ERC20(usdt ? "Solslot Test USDT" : "Solslot Test USDC", usdt ? "TEST-USDT" : "TEST-USDC") {
        fixtureId = keccak256(bytes(usdt ? "TEST-USDT" : "TEST-USDC"));
    }

    function decimals() public pure override returns (uint8) { return 6; }

    function claim() external {
        require(block.timestamp >= nextClaimAt[msg.sender], "Test faucet cooldown");
        nextClaimAt[msg.sender] = block.timestamp + FAUCET_INTERVAL;
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}

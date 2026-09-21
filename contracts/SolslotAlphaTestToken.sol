// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Valueless alpha payment tokens. Not SGT, USDC, dollars, or a claim
/// on assets. Anyone can use the faucet; its cooldown is not Sybil resistance.
/// Base mainnet transactions still require real ETH for network fees.
contract SolslotAlphaTestToken is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 10_000_000 * 10 ** 6;
    uint256 public constant FAUCET_AMOUNT = 1_000_000 * 10 ** 6;
    uint256 public constant FAUCET_COOLDOWN = 1 days;
    mapping(address => uint256) public nextClaimAt;

    error FaucetCooldown(uint256 availableAt);
    event TestTokensClaimed(address indexed recipient, uint256 amount, uint256 nextClaimAt);

    constructor(address initialRecipient) ERC20("Solslot Alpha Test Token", "TEST-SOLS") {
        _mint(initialRecipient, INITIAL_SUPPLY);
    }

    function decimals() public pure override returns (uint8) { return 6; }

    /// @notice Free test tokens, with a real ETH transaction fee on Base.
    function claim() external {
        uint256 availableAt = nextClaimAt[msg.sender];
        if (block.timestamp < availableAt) revert FaucetCooldown(availableAt);
        uint256 next = block.timestamp + FAUCET_COOLDOWN;
        nextClaimAt[msg.sender] = next;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit TestTokensClaimed(msg.sender, FAUCET_AMOUNT, next);
    }
}

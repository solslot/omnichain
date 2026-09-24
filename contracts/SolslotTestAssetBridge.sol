// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IWarpPortal} from "./interfaces/IWarpPortal.sol";
import {SolslotTestToken} from "./SolslotTestToken.sol";

/// @notice Escrow for the two valueless Base fixtures used with Chia Testnet11.
/// @dev This is not an issuer stablecoin bridge and cannot custody native SOLS.
/// The portal authenticates the validator quorum. The patched Chia burner must
/// bind the released CAT to this bridge, token and portal launcher.
/// Route coordinates and limits are constructor-bound. Deployment starts paused.
contract SolslotTestAssetBridge is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant ERC20_UNITS_PER_CAT_MOJO = 1_000;
    bytes3 public constant CHIA_CHAIN = 0x786368; // xch
    bool public constant TEST_ONLY = true;
    uint256 public constant CHIA_NETWORK = 11;
    bytes32 public constant TEST_ASSET_DOMAIN = keccak256("solslot-testnet11-valueless-v1");

    IWarpPortal public immutable portal;
    address public immutable usdc;
    address public immutable usdt;
    bytes32 public immutable tokenRuntimeHash;
    bytes32 public immutable portalLauncherId;
    bytes32 public immutable mintPuzzleHash;
    bytes32 public immutable burnPuzzleHash;
    uint64 public immutable maxTransferMojos;
    uint64 public immutable maxOutstandingMojos;
    uint256 public immutable maxMessageToll;

    // Includes deposits waiting for Chia issuance; excludes confirmed releases.
    // A donation does not add a liability or authorize a mint/release.
    mapping(address => uint64) public outstandingMojos;
    mapping(bytes32 => bool) public usedBurnNonces;
    uint256 public depositSequence;

    event DepositLocked(uint256 indexed sequence, address indexed token, address indexed sender,
        bytes32 chiaReceiver, uint64 catMojos, uint256 erc20Units);
    event BurnReleased(bytes32 indexed nonce, address indexed token, address indexed receiver,
        uint64 catMojos, uint256 erc20Units);

    error InvalidConfiguration();
    error UnsupportedAsset();
    error InvalidMessage();
    error InvalidCounterpart();
    error TransferLimit();
    error OutstandingLimit();
    error InsufficientLiability();
    error UnbackedLiability();
    error BalanceDelta();
    error Replay();
    error TollLimit();

    constructor(address governance, address portalAddress, address testUsdc, address testUsdt,
        bytes32 chiaPortalLauncher, bytes32 minter, bytes32 burner,
        uint64 transferLimitMojos, uint64 outstandingLimitMojos, uint256 tollLimit) {
        if (governance == address(0) || portalAddress.code.length == 0 ||
            testUsdc == testUsdt || chiaPortalLauncher == bytes32(0) ||
            minter == bytes32(0) || burner == bytes32(0) || minter == burner ||
            transferLimitMojos == 0 || outstandingLimitMojos < transferLimitMojos)
            revert InvalidConfiguration();
        tokenRuntimeHash = keccak256(type(SolslotTestToken).runtimeCode);
        _checkFixture(testUsdc, keccak256("TEST-USDC"));
        _checkFixture(testUsdt, keccak256("TEST-USDT"));
        portal = IWarpPortal(portalAddress);
        usdc = testUsdc;
        usdt = testUsdt;
        portalLauncherId = chiaPortalLauncher;
        mintPuzzleHash = minter;
        burnPuzzleHash = burner;
        maxTransferMojos = transferLimitMojos;
        maxOutstandingMojos = outstandingLimitMojos;
        maxMessageToll = tollLimit;
        _transferOwnership(governance);
        _pause();
    }

    /// @notice Governance may stop both directions, but cannot withdraw escrow
    /// or alter asset identities/limits. Resume only after reconciliation.
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function bridgeToChia(address tokenAddress, bytes32 receiver, uint64 catMojos)
        external payable whenNotPaused nonReentrant {
        IERC20 token = _asset(tokenAddress);
        _amount(catMojos);
        if (receiver == bytes32(0)) revert InvalidMessage();
        uint256 toll = portal.messageToll();
        if (toll > maxMessageToll || msg.value != toll) revert TollLimit();
        uint256 next = uint256(outstandingMojos[tokenAddress]) + catMojos;
        if (next > maxOutstandingMojos) revert OutstandingLimit();
        uint256 beforeBalance = token.balanceOf(address(this));
        if (beforeBalance < uint256(outstandingMojos[tokenAddress]) * ERC20_UNITS_PER_CAT_MOJO)
            revert UnbackedLiability();
        uint256 units = uint256(catMojos) * ERC20_UNITS_PER_CAT_MOJO;
        outstandingMojos[tokenAddress] = uint64(next);
        token.safeTransferFrom(msg.sender, address(this), units);
        if (token.balanceOf(address(this)) != beforeBalance + units) revert BalanceDelta();
        bytes32[] memory contents = new bytes32[](3);
        contents[0] = bytes32(uint256(uint160(tokenAddress)));
        contents[1] = receiver;
        contents[2] = bytes32(uint256(catMojos));
        uint256 sequence = ++depositSequence;
        portal.sendMessage{value: toll}(CHIA_CHAIN, mintPuzzleHash, contents);
        emit DepositLocked(sequence, tokenAddress, msg.sender, receiver, catMojos, units);
    }

    function receiveMessage(bytes32 nonce, bytes3 sourceChain, bytes32 source, bytes32[] calldata contents)
        external whenNotPaused nonReentrant {
        if (msg.sender != address(portal) || sourceChain != CHIA_CHAIN || source != burnPuzzleHash)
            revert InvalidCounterpart();
        if (nonce == bytes32(0) || contents.length != 3 ||
            uint256(contents[0]) >> 160 != 0 || uint256(contents[1]) >> 160 != 0 ||
            uint256(contents[2]) > type(uint64).max) revert InvalidMessage();
        if (usedBurnNonces[nonce]) revert Replay();
        address tokenAddress = address(uint160(uint256(contents[0])));
        IERC20 token = _asset(tokenAddress);
        address receiver = address(uint160(uint256(contents[1])));
        if (receiver == address(0) || receiver == address(this)) revert InvalidMessage();
        uint64 catMojos = uint64(uint256(contents[2]));
        _amount(catMojos);
        uint64 outstanding = outstandingMojos[tokenAddress];
        if (catMojos > outstanding) revert InsufficientLiability();
        uint256 beforeBalance = token.balanceOf(address(this));
        if (beforeBalance < uint256(outstanding) * ERC20_UNITS_PER_CAT_MOJO) revert UnbackedLiability();
        uint256 receiverBalance = token.balanceOf(receiver);
        uint256 units = uint256(catMojos) * ERC20_UNITS_PER_CAT_MOJO;
        usedBurnNonces[nonce] = true;
        outstandingMojos[tokenAddress] = outstanding - catMojos;
        token.safeTransfer(receiver, units);
        if (token.balanceOf(address(this)) != beforeBalance - units ||
            token.balanceOf(receiver) != receiverBalance + units) revert BalanceDelta();
        emit BurnReleased(nonce, tokenAddress, receiver, catMojos, units);
    }

    function _checkFixture(address tokenAddress, bytes32 fixture) private view {
        if (tokenAddress.codehash != tokenRuntimeHash) revert UnsupportedAsset();
        SolslotTestToken token = SolslotTestToken(tokenAddress);
        if (token.decimals() != 6 || token.fixtureId() != fixture ||
            token.TEST_ASSET_DOMAIN() != TEST_ASSET_DOMAIN) revert UnsupportedAsset();
    }

    function _asset(address tokenAddress) private view returns (IERC20) {
        if ((tokenAddress != usdc && tokenAddress != usdt) || tokenAddress.codehash != tokenRuntimeHash)
            revert UnsupportedAsset();
        return IERC20(tokenAddress);
    }

    function _amount(uint64 amount) private view {
        if (amount == 0 || amount > maxTransferMojos) revert TransferLimit();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IWarpPortal} from "./interfaces/IWarpPortal.sol";

/// @notice Valueless Base representation of the native Testnet11 SOLS CAT.
/// @dev Only an authenticated lock on Chia can mint. This has no faucet and is
/// distinct from the TEST-SOLS checkout fixture. One unit is one native CAT mojo.
contract SolslotTestSols is ERC20, Ownable2Step, Pausable, ReentrancyGuard {
    bool public constant TEST_ONLY = true;
    uint256 public constant CHIA_NETWORK = 11;
    bytes3 public constant CHIA_CHAIN = 0x786368;
    IWarpPortal public immutable portal;
    bytes32 public immutable portalLauncherId;
    bytes32 public immutable nativeSolsAssetId;
    bytes32 public immutable lockerPuzzleHash;
    bytes32 public immutable unlockerPuzzleHash;
    uint64 public immutable maxTransferMojos;
    uint64 public immutable maxSupplyMojos;
    uint256 public immutable maxMessageToll;
    mapping(bytes32 => bool) public usedLockNonces;

    error InvalidConfiguration();
    error InvalidMessage();
    error InvalidCounterpart();
    error Replay();
    error AmountLimit();
    error SupplyLimit();
    error TollLimit();
    event LockMinted(bytes32 indexed nonce, address indexed receiver, uint64 catMojos);
    event ReturnBurned(address indexed sender, bytes32 indexed receiver, uint64 catMojos);

    constructor(address governance, address portalAddress, bytes32 chiaPortalLauncher,
        bytes32 solsAssetId, bytes32 locker, bytes32 unlocker,
        uint64 transferLimitMojos, uint64 supplyLimitMojos, uint256 tollLimit)
        ERC20("Solslot Test Wrapped Sols", "TEST-wSOLS") {
        if (governance == address(0) || portalAddress.code.length == 0 ||
            chiaPortalLauncher == bytes32(0) || solsAssetId == bytes32(0) ||
            locker == bytes32(0) || unlocker == bytes32(0) || locker == unlocker ||
            transferLimitMojos == 0 || supplyLimitMojos < transferLimitMojos)
            revert InvalidConfiguration();
        portal = IWarpPortal(portalAddress);
        portalLauncherId = chiaPortalLauncher;
        nativeSolsAssetId = solsAssetId;
        lockerPuzzleHash = locker;
        unlockerPuzzleHash = unlocker;
        maxTransferMojos = transferLimitMojos;
        maxSupplyMojos = supplyLimitMojos;
        maxMessageToll = tollLimit;
        _transferOwnership(governance);
        _pause();
    }

    function decimals() public pure override returns (uint8) { return 3; }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function receiveMessage(bytes32 nonce, bytes3 sourceChain, bytes32 source, bytes32[] calldata contents)
        external whenNotPaused nonReentrant {
        if (msg.sender != address(portal) || sourceChain != CHIA_CHAIN || source != lockerPuzzleHash)
            revert InvalidCounterpart();
        if (nonce == bytes32(0) || contents.length != 2 || uint256(contents[0]) >> 160 != 0 ||
            uint256(contents[1]) > type(uint64).max) revert InvalidMessage();
        if (usedLockNonces[nonce]) revert Replay();
        address receiver = address(uint160(uint256(contents[0])));
        if (receiver == address(0) || receiver == address(this)) revert InvalidMessage();
        uint64 amount = uint64(uint256(contents[1]));
        _amount(amount);
        if (totalSupply() + amount > maxSupplyMojos) revert SupplyLimit();
        usedLockNonces[nonce] = true;
        _mint(receiver, amount);
        emit LockMinted(nonce, receiver, amount);
    }

    function bridgeBack(bytes32 receiver, uint64 catMojos) external payable whenNotPaused nonReentrant {
        if (receiver == bytes32(0)) revert InvalidMessage();
        _amount(catMojos);
        uint256 toll = portal.messageToll();
        if (toll > maxMessageToll || msg.value != toll) revert TollLimit();
        _burn(msg.sender, catMojos);
        bytes32[] memory contents = new bytes32[](2);
        contents[0] = receiver;
        contents[1] = bytes32(uint256(catMojos));
        portal.sendMessage{value: toll}(CHIA_CHAIN, unlockerPuzzleHash, contents);
        emit ReturnBurned(msg.sender, receiver, catMojos);
    }

    function _amount(uint64 value) private view {
        if (value == 0 || value > maxTransferMojos) revert AmountLimit();
    }

    // An emergency pause also stops transfers of the wrapped test token.
    function _beforeTokenTransfer(address from, address to, uint256 amount) internal override whenNotPaused {
        super._beforeTokenTransfer(from, to, amount);
    }
}

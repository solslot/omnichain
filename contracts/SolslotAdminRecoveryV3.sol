// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

interface ISolslotIdentitySafeV3 {
    enum Operation {
        Call,
        DelegateCall
    }

    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isModuleEnabled(address module) external view returns (bool);
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external returns (bool success);
    function swapOwner(address previousOwner, address oldOwner, address newOwner) external;
}

/// @notice Cross-chain key-change coordinator for the three fixed administrator identities.
/// @dev This module can only swap one owner on one pre-bound 1-of-1 Identity Safe.
///      It deliberately remains active after the EVM swap until the root authority records
///      the matching Chia receipt, keeping every privileged Safe frozen in the interim.
contract SolslotAdminRecoveryV3 is EIP712 {
    error ActiveChangeExists();
    error ApprovalAlreadyRecorded();
    error ChangeDelayActive();
    error ChangeExpired();
    error ChangeNotReady();
    error InvalidBinding();
    error InvalidIntent();
    error SafeStateChanged();
    error TopologyAlreadyBound();
    error TopologyNotBound();
    error UnauthorizedActor();

    uint64 public constant ROUTINE_DELAY_SECONDS = 1 days;
    uint64 public constant LOST_KEY_DELAY_SECONDS = 7 days;
    address private constant SENTINEL_OWNERS = address(0x1);
    bytes32 private constant LOST_KEY_PREPARE_TYPEHASH =
        keccak256("SolslotLostKeyPrepare(bytes32 intentHash)");
    bytes32 private constant RECOVERY_GUARDIAN_ACCEPT_TYPEHASH =
        keccak256("SolslotRecoveryGuardianAccept(bytes32 intentHash)");
    bytes32 private constant RECOVERY_GUARDIAN_VETO_TYPEHASH =
        keccak256("SolslotRecoveryGuardianVeto(bytes32 intentHash)");

    enum ChangeKind {
        NONE,
        ROUTINE,
        LOST,
        RECOVERY_KIT
    }

    enum ChangePhase {
        NONE,
        PREPARED,
        EVM_EXECUTED
    }

    struct AdminKeyChangeIntentV1 {
        uint8 slot;
        ChangeKind kind;
        address oldDailyEvmKey;
        address newDailyEvmKey;
        bytes oldDailyChiaKey;
        bytes newDailyChiaKey;
        address oldRecoveryGuardian;
        address newRecoveryGuardian;
        bytes oldRecoveryBlsKey;
        bytes newRecoveryBlsKey;
        bytes32[3] identityLauncherIds;
        address[3] identitySafes;
        bytes32 authorityLauncherId;
        address coadminSafe;
        address rootSafe;
        string chiaNetwork;
        uint256 evmChainId;
        bytes32 sourceManifestHash;
        uint256 nonce;
        uint64 expiresAt;
        uint64 recoveryKeyRevision;
    }

    struct ActiveChange {
        bytes32 intentHash;
        ChangeKind kind;
        ChangePhase phase;
        uint8 slot;
        address oldDailyEvmKey;
        address newDailyEvmKey;
        bytes32 oldDailyChiaKeyHash;
        bytes32 newDailyChiaKeyHash;
        address oldRecoveryGuardian;
        address newRecoveryGuardian;
        bytes32 oldRecoveryBlsCommitment;
        bytes32 newRecoveryBlsCommitment;
        bytes32 chiaCancellationReceiptHash;
        uint64 executeAfter;
        uint64 expiresAt;
        uint64 recoveryKeyRevision;
        uint8 peerApprovalMask;
        uint8 peerCancellationMask;
        bool rootApproved;
        bool replacementAccepted;
        bool recoveryGuardianAccepted;
        bool rollbackRootApproved;
    }

    address public immutable initializer;
    bytes32 public immutable authorityLauncherId;
    bytes32 public immutable chiaNetworkHash;
    bytes32 public immutable sourceManifestHash;
    bytes32[3] private s_identityLauncherIds;
    address[3] private s_recoveryGuardians;
    bytes32[3] private s_recoveryBlsCommitments;

    address[3] private s_identitySafes;
    address public coadminSafe;
    address public rootSafe;
    bool public topologyBound;
    uint256 public changeNonce;
    bytes32[3] private s_dailyChiaKeyHashes;
    uint64[3] private s_recoveryKeyRevisions;
    ActiveChange private s_activeChange;
    mapping(bytes32 => bool) public consumedIntent;
    mapping(bytes32 => bool) public consumedChiaReceipt;

    event AuthorityTopologyBound(
        address indexed rootSafe,
        address indexed coadminSafe,
        address identitySafe0,
        address identitySafe1,
        address identitySafe2
    );
    event KeyChangePrepared(
        bytes32 indexed intentHash,
        uint8 indexed slot,
        ChangeKind kind,
        address oldDailyEvmKey,
        address newDailyEvmKey,
        uint64 executeAfter
    );
    event AuthorityApproved(bytes32 indexed intentHash, address indexed authority);
    event PeerApproved(bytes32 indexed intentHash, uint8 indexed peerSlot);
    event PeerCancellationRecorded(
        bytes32 indexed intentHash,
        uint8 indexed peerSlot
    );
    event ReplacementAccepted(bytes32 indexed intentHash, address indexed replacement);
    event RecoveryGuardianAccepted(
        bytes32 indexed intentHash,
        address indexed replacementGuardian
    );
    event KeyChangeVetoed(bytes32 indexed intentHash, address indexed actor);
    event EvmKeyChanged(
        bytes32 indexed intentHash,
        uint8 indexed slot,
        address oldDailyEvmKey,
        address newDailyEvmKey
    );
    event CrossChainConverged(
        bytes32 indexed intentHash,
        bytes32 indexed chiaReceiptHash,
        uint8 indexed slot
    );
    event RecoveryKitChanged(
        bytes32 indexed intentHash,
        uint8 indexed slot,
        address oldRecoveryGuardian,
        address newRecoveryGuardian,
        bytes32 oldRecoveryBlsCommitment,
        bytes32 newRecoveryBlsCommitment,
        uint64 newRevision
    );
    event ChiaCancellationRecorded(
        bytes32 indexed intentHash,
        bytes32 indexed chiaCancellationReceiptHash
    );
    event RollbackApproved(bytes32 indexed intentHash, address indexed actor);
    event EvmKeyChangeRolledBack(
        bytes32 indexed intentHash,
        uint8 indexed slot,
        address restoredDailyEvmKey
    );

    constructor(
        address initializer_,
        bytes32 authorityLauncherId_,
        bytes32[3] memory identityLauncherIds_,
        string memory chiaNetwork_,
        bytes32 sourceManifestHash_,
        bytes32[3] memory initialDailyChiaKeyHashes_,
        address[3] memory recoveryGuardians_,
        bytes32[3] memory recoveryBlsCommitments_
    ) EIP712("Solslot Admin Recovery", "1") {
        if (
            initializer_ == address(0) || authorityLauncherId_ == bytes32(0)
                || bytes(chiaNetwork_).length == 0 || sourceManifestHash_ == bytes32(0)
        ) revert InvalidBinding();
        for (uint8 slot = 0; slot < 3; ++slot) {
            if (
                identityLauncherIds_[slot] == bytes32(0)
                    || initialDailyChiaKeyHashes_[slot] == bytes32(0)
                    || recoveryGuardians_[slot] == address(0)
                    || recoveryBlsCommitments_[slot] == bytes32(0)
            ) revert InvalidBinding();
            for (uint8 other = 0; other < slot; ++other) {
                if (
                    identityLauncherIds_[slot] == identityLauncherIds_[other]
                        || recoveryGuardians_[slot] == recoveryGuardians_[other]
                ) revert InvalidBinding();
            }
        }
        initializer = initializer_;
        authorityLauncherId = authorityLauncherId_;
        chiaNetworkHash = keccak256(bytes(chiaNetwork_));
        sourceManifestHash = sourceManifestHash_;
        s_identityLauncherIds = identityLauncherIds_;
        s_dailyChiaKeyHashes = initialDailyChiaKeyHashes_;
        s_recoveryGuardians = recoveryGuardians_;
        s_recoveryBlsCommitments = recoveryBlsCommitments_;
        for (uint8 slot = 0; slot < 3; ++slot) {
            s_recoveryKeyRevisions[slot] = 1;
        }
    }

    function bindAuthorityTopology(
        address[3] calldata identitySafes_,
        address coadminSafe_,
        address rootSafe_
    ) external {
        if (msg.sender != initializer) revert UnauthorizedActor();
        if (topologyBound) revert TopologyAlreadyBound();
        if (
            coadminSafe_ == address(0) || rootSafe_ == address(0)
                || coadminSafe_.code.length == 0 || rootSafe_.code.length == 0
                || coadminSafe_ == rootSafe_
        ) revert InvalidBinding();
        address[3] memory dailyOwners;
        for (uint8 slot = 0; slot < 3; ++slot) {
            address safe = identitySafes_[slot];
            if (
                safe == address(0) || safe.code.length == 0 || safe == coadminSafe_
                    || safe == rootSafe_
            ) revert InvalidBinding();
            for (uint8 other = 0; other < slot; ++other) {
                if (safe == identitySafes_[other]) revert InvalidBinding();
            }
            _requireIdentitySafe(safe);
            if (!ISolslotIdentitySafeV3(safe).isModuleEnabled(address(this))) {
                revert InvalidBinding();
            }
            address dailyOwner = _currentOwner(safe);
            dailyOwners[slot] = dailyOwner;
            for (uint8 other = 0; other < 3; ++other) {
                if (dailyOwner == s_recoveryGuardians[other]) {
                    revert InvalidBinding();
                }
            }
            for (uint8 other = 0; other < slot; ++other) {
                if (dailyOwner == dailyOwners[other]) revert InvalidBinding();
            }
        }
        if (
            ISolslotIdentitySafeV3(coadminSafe_).isModuleEnabled(address(this))
                || ISolslotIdentitySafeV3(rootSafe_).isModuleEnabled(address(this))
        ) revert InvalidBinding();
        address[] memory coadminOwners =
            ISolslotIdentitySafeV3(coadminSafe_).getOwners();
        address[] memory rootOwners = ISolslotIdentitySafeV3(rootSafe_).getOwners();
        if (
            ISolslotIdentitySafeV3(coadminSafe_).getThreshold() != 1
                || !_sameTwoOwners(
                    coadminOwners,
                    identitySafes_[1],
                    identitySafes_[2]
                )
                || ISolslotIdentitySafeV3(rootSafe_).getThreshold() != 2
                || !_sameTwoOwners(rootOwners, identitySafes_[0], coadminSafe_)
        ) {
            revert InvalidBinding();
        }
        s_identitySafes = identitySafes_;
        coadminSafe = coadminSafe_;
        rootSafe = rootSafe_;
        topologyBound = true;
        emit AuthorityTopologyBound(
            rootSafe_,
            coadminSafe_,
            identitySafes_[0],
            identitySafes_[1],
            identitySafes_[2]
        );
    }

    function identityLauncherIds() external view returns (bytes32[3] memory) {
        return s_identityLauncherIds;
    }

    function identitySafes() external view returns (address[3] memory) {
        return s_identitySafes;
    }

    function dailyChiaKeyHashes() external view returns (bytes32[3] memory) {
        return s_dailyChiaKeyHashes;
    }

    function recoveryGuardians() external view returns (address[3] memory) {
        return s_recoveryGuardians;
    }

    function recoveryBlsCommitments() external view returns (bytes32[3] memory) {
        return s_recoveryBlsCommitments;
    }

    function recoveryKeyRevisions() external view returns (uint64[3] memory) {
        return s_recoveryKeyRevisions;
    }

    function activeChange() external view returns (ActiveChange memory) {
        return s_activeChange;
    }

    function isChangeActive() external view returns (bool) {
        return s_activeChange.intentHash != bytes32(0);
    }

    function hashIntent(AdminKeyChangeIntentV1 calldata intent) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("SolslotAdminKeyChangeIntentV1"),
                intent.slot,
                intent.kind,
                intent.oldDailyEvmKey,
                intent.newDailyEvmKey,
                keccak256(intent.oldDailyChiaKey),
                keccak256(intent.newDailyChiaKey),
                intent.oldRecoveryGuardian,
                intent.newRecoveryGuardian,
                keccak256(intent.oldRecoveryBlsKey),
                keccak256(intent.newRecoveryBlsKey),
                intent.identityLauncherIds,
                intent.identitySafes,
                intent.authorityLauncherId,
                intent.coadminSafe,
                intent.rootSafe,
                keccak256(bytes(intent.chiaNetwork)),
                intent.evmChainId,
                intent.sourceManifestHash,
                intent.nonce,
                intent.expiresAt,
                intent.recoveryKeyRevision
            )
        );
    }

    function prepareRoutine(AdminKeyChangeIntentV1 calldata intent) external returns (bytes32) {
        _requireTopology();
        _validateIntent(intent, ChangeKind.ROUTINE);
        if (msg.sender != intent.oldDailyEvmKey) revert UnauthorizedActor();
        return _prepare(intent, ROUTINE_DELAY_SECONDS);
    }

    function prepareLostKey(AdminKeyChangeIntentV1 calldata intent) external returns (bytes32) {
        _requireTopology();
        _validateIntent(intent, ChangeKind.LOST);
        if (msg.sender != s_recoveryGuardians[intent.slot]) revert UnauthorizedActor();
        return _prepare(intent, LOST_KEY_DELAY_SECONDS);
    }

    /// @notice Submit an exact lost-key intent authorized by the offline guardian.
    /// @dev The relayer pays gas but gains no authority: EIP-712 binds the signature
    ///      to this contract, this chain, and the complete intent hash.
    function prepareLostKeyWithSignature(
        AdminKeyChangeIntentV1 calldata intent,
        bytes calldata guardianSignature
    ) external returns (bytes32) {
        _requireTopology();
        _validateIntent(intent, ChangeKind.LOST);
        bytes32 intentHash = hashIntent(intent);
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(LOST_KEY_PREPARE_TYPEHASH, intentHash))
        );
        if (
            ECDSA.recover(digest, guardianSignature)
                != s_recoveryGuardians[intent.slot]
        ) revert UnauthorizedActor();
        return _prepare(intent, LOST_KEY_DELAY_SECONDS);
    }

    function lostKeyAuthorizationDigest(
        AdminKeyChangeIntentV1 calldata intent
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(LOST_KEY_PREPARE_TYPEHASH, hashIntent(intent))
            )
        );
    }

    function prepareRecoveryKit(
        AdminKeyChangeIntentV1 calldata intent
    ) external returns (bytes32) {
        _requireTopology();
        _validateIntent(intent, ChangeKind.RECOVERY_KIT);
        if (msg.sender != intent.oldDailyEvmKey) revert UnauthorizedActor();
        return _prepare(intent, ROUTINE_DELAY_SECONDS);
    }

    function approveRoutineByRoot(bytes32 intentHash) external {
        ActiveChange storage change = _active(intentHash);
        if (change.kind != ChangeKind.ROUTINE || msg.sender != rootSafe) {
            revert UnauthorizedActor();
        }
        if (change.rootApproved) revert ApprovalAlreadyRecorded();
        change.rootApproved = true;
        emit AuthorityApproved(intentHash, msg.sender);
    }

    function approveRecoveryKitByRoot(bytes32 intentHash) external {
        ActiveChange storage change = _active(intentHash);
        if (
            change.kind != ChangeKind.RECOVERY_KIT || msg.sender != rootSafe
        ) revert UnauthorizedActor();
        if (change.rootApproved) revert ApprovalAlreadyRecorded();
        change.rootApproved = true;
        emit AuthorityApproved(intentHash, msg.sender);
    }

    function approveLostKeyByPeer(bytes32 intentHash) external {
        ActiveChange storage change = _active(intentHash);
        if (change.kind != ChangeKind.LOST) revert UnauthorizedActor();
        uint8 peerSlot = _identitySafeSlot(msg.sender);
        if (peerSlot == change.slot) revert UnauthorizedActor();
        uint8 bit = uint8(1 << peerSlot);
        if (change.peerApprovalMask & bit != 0) revert ApprovalAlreadyRecorded();
        change.peerApprovalMask |= bit;
        emit PeerApproved(intentHash, peerSlot);
    }

    function acceptReplacement(bytes32 intentHash) external {
        ActiveChange storage change = _active(intentHash);
        if (msg.sender != change.newDailyEvmKey) revert UnauthorizedActor();
        if (change.replacementAccepted) revert ApprovalAlreadyRecorded();
        change.replacementAccepted = true;
        emit ReplacementAccepted(intentHash, msg.sender);
    }

    function acceptRecoveryGuardian(bytes32 intentHash) external {
        ActiveChange storage change = _active(intentHash);
        if (
            change.kind != ChangeKind.RECOVERY_KIT
                || msg.sender != change.newRecoveryGuardian
        ) revert UnauthorizedActor();
        _acceptRecoveryGuardian(change, intentHash, msg.sender);
    }

    /// @notice Record acceptance by a new offline recovery guardian without
    /// requiring that recovery-only account to hold gas.
    /// @dev The relayer gains no authority. EIP-712 binds the signature to this
    /// contract, this chain, and the exact active key-change intent.
    function acceptRecoveryGuardianWithSignature(
        bytes32 intentHash,
        bytes calldata guardianSignature
    ) external {
        ActiveChange storage change = _active(intentHash);
        if (change.kind != ChangeKind.RECOVERY_KIT) revert UnauthorizedActor();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(RECOVERY_GUARDIAN_ACCEPT_TYPEHASH, intentHash)
            )
        );
        address guardian = ECDSA.recover(digest, guardianSignature);
        if (guardian != change.newRecoveryGuardian) revert UnauthorizedActor();
        _acceptRecoveryGuardian(change, intentHash, guardian);
    }

    function recoveryGuardianAcceptanceDigest(
        bytes32 intentHash
    ) external view returns (bytes32) {
        ActiveChange storage change = _active(intentHash);
        if (change.kind != ChangeKind.RECOVERY_KIT) revert UnauthorizedActor();
        return _hashTypedDataV4(
            keccak256(
                abi.encode(RECOVERY_GUARDIAN_ACCEPT_TYPEHASH, intentHash)
            )
        );
    }

    /// @notice Cancel an exact recovery-kit replacement authorized by the
    /// existing offline recovery guardian, with gas paid by any relayer.
    function vetoByOldRecoveryGuardianWithSignature(
        bytes32 intentHash,
        bytes calldata guardianSignature
    ) external {
        ActiveChange storage change = _active(intentHash);
        if (
            change.kind != ChangeKind.RECOVERY_KIT
                || change.phase != ChangePhase.PREPARED
        ) revert UnauthorizedActor();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(RECOVERY_GUARDIAN_VETO_TYPEHASH, intentHash)
            )
        );
        address guardian = ECDSA.recover(digest, guardianSignature);
        if (guardian != change.oldRecoveryGuardian) revert UnauthorizedActor();
        _cancel(intentHash, guardian);
    }

    function recoveryGuardianVetoDigest(
        bytes32 intentHash
    ) external view returns (bytes32) {
        ActiveChange storage change = _active(intentHash);
        if (
            change.kind != ChangeKind.RECOVERY_KIT
                || change.phase != ChangePhase.PREPARED
        ) revert UnauthorizedActor();
        return _hashTypedDataV4(
            keccak256(
                abi.encode(RECOVERY_GUARDIAN_VETO_TYPEHASH, intentHash)
            )
        );
    }

    function _acceptRecoveryGuardian(
        ActiveChange storage change,
        bytes32 intentHash,
        address guardian
    ) private {
        if (change.recoveryGuardianAccepted) revert ApprovalAlreadyRecorded();
        change.recoveryGuardianAccepted = true;
        emit RecoveryGuardianAccepted(intentHash, guardian);
    }

    function vetoByOldKey(bytes32 intentHash) external {
        ActiveChange storage change = _active(intentHash);
        if (change.phase != ChangePhase.PREPARED || msg.sender != change.oldDailyEvmKey) {
            revert UnauthorizedActor();
        }
        _cancel(intentHash, msg.sender);
    }

    function vetoByOldRecoveryGuardian(bytes32 intentHash) external {
        ActiveChange storage change = _active(intentHash);
        if (
            change.kind != ChangeKind.RECOVERY_KIT
                || change.phase != ChangePhase.PREPARED
                || msg.sender != change.oldRecoveryGuardian
        ) revert UnauthorizedActor();
        _cancel(intentHash, msg.sender);
    }

    function cancelRoutineByRoot(bytes32 intentHash) external {
        ActiveChange storage change = _active(intentHash);
        if (
            change.kind != ChangeKind.ROUTINE || change.phase != ChangePhase.PREPARED
                || msg.sender != rootSafe
        ) revert UnauthorizedActor();
        _cancel(intentHash, msg.sender);
    }

    function cancelRecoveryKitByRoot(bytes32 intentHash) external {
        ActiveChange storage change = _active(intentHash);
        if (
            change.kind != ChangeKind.RECOVERY_KIT
                || change.phase != ChangePhase.PREPARED
                || msg.sender != rootSafe
        ) revert UnauthorizedActor();
        _cancel(intentHash, msg.sender);
    }

    function cancelLostKeyByPeer(bytes32 intentHash) external {
        ActiveChange storage change = _active(intentHash);
        if (change.kind != ChangeKind.LOST || change.phase != ChangePhase.PREPARED) {
            revert UnauthorizedActor();
        }
        uint8 peerSlot = _identitySafeSlot(msg.sender);
        if (peerSlot == change.slot) revert UnauthorizedActor();
        uint8 bit = uint8(1 << peerSlot);
        if (change.peerCancellationMask & bit != 0) revert ApprovalAlreadyRecorded();
        change.peerCancellationMask |= bit;
        emit PeerCancellationRecorded(intentHash, peerSlot);
        if (change.peerCancellationMask == _otherSlotsMask(change.slot)) {
            _cancel(intentHash, msg.sender);
        }
    }

    function executeEvmKeyChange(bytes32 intentHash) external {
        ActiveChange storage stored = _active(intentHash);
        ActiveChange memory change = stored;
        if (change.phase != ChangePhase.PREPARED) revert InvalidIntent();
        if (block.timestamp < change.executeAfter) revert ChangeDelayActive();
        if (block.timestamp > change.expiresAt) revert ChangeExpired();
        if (change.kind == ChangeKind.RECOVERY_KIT) {
            if (!change.rootApproved || !change.recoveryGuardianAccepted) {
                revert ChangeNotReady();
            }
        } else if (!change.replacementAccepted) {
            revert ChangeNotReady();
        }
        if (change.kind == ChangeKind.ROUTINE) {
            if (!change.rootApproved) revert ChangeNotReady();
        } else if (change.peerApprovalMask != _otherSlotsMask(change.slot)) {
            if (change.kind == ChangeKind.LOST) revert ChangeNotReady();
        }
        if (change.kind == ChangeKind.RECOVERY_KIT) {
            s_recoveryGuardians[change.slot] = change.newRecoveryGuardian;
            s_recoveryBlsCommitments[change.slot] =
                change.newRecoveryBlsCommitment;
            stored.phase = ChangePhase.EVM_EXECUTED;
            emit RecoveryKitChanged(
                intentHash,
                change.slot,
                change.oldRecoveryGuardian,
                change.newRecoveryGuardian,
                change.oldRecoveryBlsCommitment,
                change.newRecoveryBlsCommitment,
                change.recoveryKeyRevision + 1
            );
            return;
        }
        address safeAddress = s_identitySafes[change.slot];
        if (_currentOwner(safeAddress) != change.oldDailyEvmKey) revert SafeStateChanged();
        ISolslotIdentitySafeV3 safe = ISolslotIdentitySafeV3(safeAddress);
        if (!safe.isModuleEnabled(address(this))) revert SafeStateChanged();
        stored.phase = ChangePhase.EVM_EXECUTED;
        bytes memory payload = abi.encodeCall(
            ISolslotIdentitySafeV3.swapOwner,
            (SENTINEL_OWNERS, change.oldDailyEvmKey, change.newDailyEvmKey)
        );
        if (!safe.execTransactionFromModule(
            safeAddress,
            0,
            payload,
            ISolslotIdentitySafeV3.Operation.Call
        )) revert SafeStateChanged();
        if (_currentOwner(safeAddress) != change.newDailyEvmKey) revert SafeStateChanged();
        emit EvmKeyChanged(
            intentHash,
            change.slot,
            change.oldDailyEvmKey,
            change.newDailyEvmKey
        );
    }

    function confirmCrossChainConvergence(
        bytes32 intentHash,
        bytes32 chiaReceiptHash
    ) external {
        ActiveChange memory change = _active(intentHash);
        if (
            msg.sender != rootSafe || change.phase != ChangePhase.EVM_EXECUTED
                || chiaReceiptHash == bytes32(0) || consumedChiaReceipt[chiaReceiptHash]
        ) revert UnauthorizedActor();
        s_dailyChiaKeyHashes[change.slot] = change.newDailyChiaKeyHash;
        if (change.kind == ChangeKind.RECOVERY_KIT) {
            s_recoveryKeyRevisions[change.slot] =
                change.recoveryKeyRevision + 1;
        }
        consumedIntent[intentHash] = true;
        consumedChiaReceipt[chiaReceiptHash] = true;
        delete s_activeChange;
        emit CrossChainConverged(intentHash, chiaReceiptHash, change.slot);
    }

    function approveRollbackByRoot(
        bytes32 intentHash,
        bytes32 chiaCancellationReceiptHash
    ) external {
        ActiveChange storage change = _active(intentHash);
        if (
            msg.sender != rootSafe || change.phase != ChangePhase.EVM_EXECUTED
                || chiaCancellationReceiptHash == bytes32(0)
                || consumedChiaReceipt[chiaCancellationReceiptHash]
        ) {
            revert UnauthorizedActor();
        }
        if (change.rollbackRootApproved) revert ApprovalAlreadyRecorded();
        change.rollbackRootApproved = true;
        change.chiaCancellationReceiptHash = chiaCancellationReceiptHash;
        consumedChiaReceipt[chiaCancellationReceiptHash] = true;
        emit ChiaCancellationRecorded(intentHash, chiaCancellationReceiptHash);
        emit RollbackApproved(intentHash, msg.sender);
    }

    function executeRollback(bytes32 intentHash) external {
        ActiveChange memory change = _active(intentHash);
        if (
            change.phase != ChangePhase.EVM_EXECUTED || !change.rollbackRootApproved
        ) revert ChangeNotReady();
        if (change.chiaCancellationReceiptHash == bytes32(0)) {
            revert ChangeNotReady();
        }
        if (change.kind == ChangeKind.RECOVERY_KIT) {
            if (
                s_recoveryGuardians[change.slot]
                    != change.newRecoveryGuardian
                    || s_recoveryBlsCommitments[change.slot]
                        != change.newRecoveryBlsCommitment
            ) revert SafeStateChanged();
            s_recoveryGuardians[change.slot] =
                change.oldRecoveryGuardian;
            s_recoveryBlsCommitments[change.slot] =
                change.oldRecoveryBlsCommitment;
        } else {
            address safeAddress = s_identitySafes[change.slot];
            if (_currentOwner(safeAddress) != change.newDailyEvmKey) {
                revert SafeStateChanged();
            }
            bytes memory payload = abi.encodeCall(
                ISolslotIdentitySafeV3.swapOwner,
                (SENTINEL_OWNERS, change.newDailyEvmKey, change.oldDailyEvmKey)
            );
            if (!ISolslotIdentitySafeV3(safeAddress).execTransactionFromModule(
                safeAddress,
                0,
                payload,
                ISolslotIdentitySafeV3.Operation.Call
            )) revert SafeStateChanged();
            if (_currentOwner(safeAddress) != change.oldDailyEvmKey) {
                revert SafeStateChanged();
            }
        }
        consumedIntent[intentHash] = true;
        delete s_activeChange;
        emit EvmKeyChangeRolledBack(intentHash, change.slot, change.oldDailyEvmKey);
    }

    function _prepare(
        AdminKeyChangeIntentV1 calldata intent,
        uint64 delay
    ) private returns (bytes32 intentHash) {
        if (s_activeChange.intentHash != bytes32(0)) revert ActiveChangeExists();
        if (intent.nonce != changeNonce + 1) revert InvalidIntent();
        if (intent.expiresAt <= block.timestamp + delay) revert InvalidIntent();
        intentHash = hashIntent(intent);
        if (consumedIntent[intentHash]) revert InvalidIntent();
        changeNonce = intent.nonce;
        s_activeChange = ActiveChange({
            intentHash: intentHash,
            kind: intent.kind,
            phase: ChangePhase.PREPARED,
            slot: intent.slot,
            oldDailyEvmKey: intent.oldDailyEvmKey,
            newDailyEvmKey: intent.newDailyEvmKey,
            oldDailyChiaKeyHash: keccak256(intent.oldDailyChiaKey),
            newDailyChiaKeyHash: keccak256(intent.newDailyChiaKey),
            oldRecoveryGuardian: intent.oldRecoveryGuardian,
            newRecoveryGuardian: intent.newRecoveryGuardian,
            oldRecoveryBlsCommitment: keccak256(intent.oldRecoveryBlsKey),
            newRecoveryBlsCommitment: keccak256(intent.newRecoveryBlsKey),
            chiaCancellationReceiptHash: bytes32(0),
            executeAfter: uint64(block.timestamp) + delay,
            expiresAt: intent.expiresAt,
            recoveryKeyRevision: intent.recoveryKeyRevision,
            peerApprovalMask: 0,
            peerCancellationMask: 0,
            rootApproved: false,
            replacementAccepted: false,
            recoveryGuardianAccepted: false,
            rollbackRootApproved: false
        });
        emit KeyChangePrepared(
            intentHash,
            intent.slot,
            intent.kind,
            intent.oldDailyEvmKey,
            intent.newDailyEvmKey,
            uint64(block.timestamp) + delay
        );
    }

    function _validateIntent(
        AdminKeyChangeIntentV1 calldata intent,
        ChangeKind expectedKind
    ) private view {
        if (
            intent.slot > 2 || intent.kind != expectedKind
                || intent.oldDailyEvmKey == address(0)
                || intent.newDailyEvmKey == address(0)
                || intent.oldDailyChiaKey.length != 33
                || intent.newDailyChiaKey.length != 33
                || keccak256(intent.oldDailyChiaKey) != s_dailyChiaKeyHashes[intent.slot]
                || intent.oldRecoveryGuardian
                    != s_recoveryGuardians[intent.slot]
                || intent.oldRecoveryBlsKey.length != 48
                || intent.newRecoveryBlsKey.length != 48
                || keccak256(intent.oldRecoveryBlsKey)
                    != s_recoveryBlsCommitments[intent.slot]
                || intent.authorityLauncherId != authorityLauncherId
                || intent.coadminSafe != coadminSafe
                || intent.rootSafe != rootSafe
                || keccak256(bytes(intent.chiaNetwork)) != chiaNetworkHash
                || intent.evmChainId != block.chainid
                || intent.sourceManifestHash != sourceManifestHash
                || intent.recoveryKeyRevision != s_recoveryKeyRevisions[intent.slot]
                || _currentOwner(s_identitySafes[intent.slot]) != intent.oldDailyEvmKey
        ) revert InvalidIntent();
        if (expectedKind == ChangeKind.RECOVERY_KIT) {
            if (
                intent.newDailyEvmKey != intent.oldDailyEvmKey
                    || keccak256(intent.newDailyChiaKey)
                        != s_dailyChiaKeyHashes[intent.slot]
                    || intent.newRecoveryGuardian == address(0)
                    || intent.newRecoveryGuardian
                        == intent.oldRecoveryGuardian
                    || keccak256(intent.newRecoveryBlsKey)
                        == keccak256(intent.oldRecoveryBlsKey)
            ) revert InvalidIntent();
        } else if (
            intent.newDailyEvmKey == intent.oldDailyEvmKey
                || keccak256(intent.newDailyChiaKey)
                    == s_dailyChiaKeyHashes[intent.slot]
                || intent.newRecoveryGuardian
                    != intent.oldRecoveryGuardian
                || keccak256(intent.newRecoveryBlsKey)
                    != keccak256(intent.oldRecoveryBlsKey)
        ) {
            revert InvalidIntent();
        }
        for (uint8 slot = 0; slot < 3; ++slot) {
            if (
                intent.identityLauncherIds[slot] != s_identityLauncherIds[slot]
                    || intent.identitySafes[slot] != s_identitySafes[slot]
            ) revert InvalidIntent();
            if (
                expectedKind == ChangeKind.RECOVERY_KIT
                    && (
                        intent.newRecoveryGuardian
                            == _currentOwner(s_identitySafes[slot])
                            || (
                                slot != intent.slot
                                    && (
                                        intent.newRecoveryGuardian
                                            == s_recoveryGuardians[slot]
                                            || keccak256(intent.newRecoveryBlsKey)
                                                == s_recoveryBlsCommitments[slot]
                                    )
                            )
                    )
            ) revert InvalidIntent();
        }
    }

    function _active(bytes32 intentHash) private view returns (ActiveChange storage change) {
        change = s_activeChange;
        if (
            intentHash == bytes32(0) || change.intentHash != intentHash
                || consumedIntent[intentHash]
        ) revert InvalidIntent();
    }

    function _cancel(bytes32 intentHash, address actor) private {
        consumedIntent[intentHash] = true;
        delete s_activeChange;
        emit KeyChangeVetoed(intentHash, actor);
    }

    function _identitySafeSlot(address actor) private view returns (uint8) {
        for (uint8 slot = 0; slot < 3; ++slot) {
            if (actor == s_identitySafes[slot]) return slot;
        }
        revert UnauthorizedActor();
    }

    function _otherSlotsMask(uint8 slot) private pure returns (uint8) {
        return uint8(7 ^ (1 << slot));
    }

    function _requireTopology() private view {
        if (!topologyBound) revert TopologyNotBound();
    }

    function _requireIdentitySafe(address safeAddress) private view {
        ISolslotIdentitySafeV3 safe = ISolslotIdentitySafeV3(safeAddress);
        address[] memory owners = safe.getOwners();
        if (
            owners.length != 1 || owners[0] == address(0)
                || safe.getThreshold() != 1
        ) revert InvalidBinding();
    }

    function _currentOwner(address safeAddress) private view returns (address) {
        _requireIdentitySafe(safeAddress);
        return ISolslotIdentitySafeV3(safeAddress).getOwners()[0];
    }

    function _sameTwoOwners(
        address[] memory observed,
        address expectedA,
        address expectedB
    ) private pure returns (bool) {
        return observed.length == 2 && expectedA != expectedB
            && (
                (observed[0] == expectedA && observed[1] == expectedB)
                    || (observed[0] == expectedB && observed[1] == expectedA)
            );
    }
}

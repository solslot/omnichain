// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

interface ISolslotOwnerSafeSetup {
    function enableModule(address module) external;
    function setGuard(address guard) external;
}

/// @notice Stateless Safe setup helper. It is used once via delegatecall from Safe.setup.
contract SolslotOwnerIdentitySetup {
    error InvalidSetupAddress();
    error SetupCallFailed();

    function configureOwner(address recoveryModule, address ownerGuard) external {
        _configureIdentity(recoveryModule, ownerGuard);
    }

    function configureIdentity(address recoveryModule, address identityGuard) external {
        _configureIdentity(recoveryModule, identityGuard);
    }

    function _configureIdentity(address recoveryModule, address identityGuard) private {
        if (recoveryModule == address(0) || identityGuard == address(0)) {
            revert InvalidSetupAddress();
        }
        (bool moduleEnabled,) = address(this).call(
            abi.encodeCall(ISolslotOwnerSafeSetup.enableModule, (recoveryModule))
        );
        if (!moduleEnabled) revert SetupCallFailed();
        (bool guardEnabled,) = address(this).call(
            abi.encodeCall(ISolslotOwnerSafeSetup.setGuard, (identityGuard))
        );
        if (!guardEnabled) revert SetupCallFailed();
    }

    function configureStatic(address authorityGuard) external {
        if (authorityGuard == address(0)) revert InvalidSetupAddress();
        (bool guardEnabled,) = address(this).call(
            abi.encodeCall(ISolslotOwnerSafeSetup.setGuard, (authorityGuard))
        );
        if (!guardEnabled) revert SetupCallFailed();
    }
}

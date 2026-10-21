// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ITokenMessengerV2
 * @notice Minimal interface for Circle TokenMessengerV2.
 *
 * depositForBurnWithHook signature verified from Circle official docs:
 * https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service
 *
 * Returns nothing (void) — confirmed from V2 ABI (V1 returned a uint64 nonce).
 */
interface ITokenMessengerV2 {
    /**
     * @notice Burn USDC and forward to destination via Circle Forwarding Service.
     * @param amount                Amount of USDC to burn (includes CCTP fee).
     * @param destinationDomain     CCTP destination domain.
     * @param mintRecipient         Destination address padded to bytes32.
     * @param burnToken             Source USDC token address.
     * @param destinationCaller     bytes32(0) = any caller on destination.
     * @param maxFee                Maximum fee in source-token base units.
     * @param minFinalityThreshold  1000 = fast, 2000 = standard.
     * @param hookData              Forwarding Service hook (static 32-byte value).
     */
    function depositForBurnWithHook(
        uint256 amount,
        uint32  destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32  minFinalityThreshold,
        bytes   calldata hookData
    ) external;
}

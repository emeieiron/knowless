// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISpookly
 * @notice Minimal interface for the Spookly escrow used by KnowlessCctpRouter.
 */
interface ISpookly {
    struct Link {
        address issuer;
        uint128 balance;
        uint128 feeBalance;
        uint64  expiry;
        bool    active;
    }

    function executePayment(
        address  signerAddress,
        address  recipient,
        uint128  amount,
        uint128  fee,
        address  feeRecipient,
        uint64   quoteExpiry,
        uint256  nonce,
        bytes calldata sig
    ) external;

    function getLinkInfo(address signerAddress) external view returns (Link memory);

    function usedNonces(address signerAddress, uint256 nonce) external view returns (bool);
}

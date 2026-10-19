// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title Spookly
 * @notice Spendable USDC links. An issuer locks principal + fee budget; the holder
 *         signs a PaymentAuth offline; a relay submits executePayment and earns the fee.
 *
 * SECURITY: feeRecipient and quoteExpiry are now part of the signed PaymentAuth struct.
 *   - feeRecipient: fee is paid ONLY to the address the holder authorised — a front-runner
 *     who substitutes themselves as msg.sender cannot redirect reimbursement.
 *   - quoteExpiry: the relay's fee quote has a short TTL; signed authorisations that
 *     outlive the quote cannot be used to claim a fee beyond that expiry.
 */
contract Spookly is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Link {
        address issuer;
        uint128 balance;
        uint128 feeBalance;
        uint64  expiry;
        bool    active;
    }

    IERC20 public immutable usdc;

    mapping(address => Link) public links;
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev PaymentAuth now includes feeRecipient (who receives the fee) and
    ///      quoteExpiry (when this authorisation stops being valid for relay use).
    bytes32 private constant _PAYMENT_AUTH_TYPEHASH =
        keccak256(
            "PaymentAuth(address signerAddress,address recipient,uint256 amount,uint256 fee,address feeRecipient,uint256 quoteExpiry,uint256 nonce,uint256 expiry,address contract_,uint256 chainId)"
        );
    bytes32 private constant _NAME_HASH    = keccak256("Spookly");
    bytes32 private constant _VERSION_HASH = keccak256("1");

    error ZeroSignerAddress();
    error SignerAlreadyRegistered();
    error ZeroAmount();
    error ExpiryInPast();
    error LinkNotActive();
    error LinkExpired();
    error ZeroRecipient();
    error SelfRecipient();
    error NonceUsed();
    error InsufficientBalance();
    error InsufficientFeeBalance();
    error InvalidSignature();
    error TransferFailed();
    error NotIssuer();
    error QuoteExpired();
    error WrongFeeRecipient();

    event LinkCreated(
        address indexed signerAddress,
        address indexed issuer,
        uint128 principal,
        uint128 feeBudget,
        uint64  expiry
    );

    event PaymentExecuted(
        address indexed signerAddress,
        address indexed recipient,
        uint128 amount,
        uint128 fee,
        address indexed feeRecipient,
        uint256 nonce
    );

    event LinkCancelled(address indexed signerAddress, address indexed issuer, uint128 refund);

    /// @param _usdc The USDC ERC-20 token address.
    constructor(address _usdc) {
        require(_usdc != address(0), "Zero USDC address");
        usdc = IERC20(_usdc);
    }

    /// @notice Creates and funds a new spendable link.
    function createLink(
        address signerAddress,
        uint128 principal,
        uint128 feeBudget,
        uint64  expiry
    ) external nonReentrant {
        if (signerAddress == address(0)) revert ZeroSignerAddress();
        if (links[signerAddress].issuer != address(0)) revert SignerAlreadyRegistered();
        if (principal == 0) revert ZeroAmount();
        if (expiry <= block.timestamp) revert ExpiryInPast();

        links[signerAddress] = Link({
            issuer:     msg.sender,
            balance:    principal,
            feeBalance: feeBudget,
            expiry:     expiry,
            active:     true
        });

        usdc.safeTransferFrom(msg.sender, address(this), uint256(principal) + uint256(feeBudget));
        emit LinkCreated(signerAddress, msg.sender, principal, feeBudget, expiry);
    }

    /// @notice Executes a signed payment.
    /// @param signerAddress  Link signer identity.
    /// @param recipient      Principal USDC recipient.
    /// @param amount         Principal in 6-decimal USDC.
    /// @param fee            Relayer fee in 6-decimal USDC (paid to feeRecipient).
    /// @param feeRecipient   Address authorised to receive the fee (bound in sig).
    /// @param quoteExpiry    UNIX timestamp after which this signed auth is invalid.
    /// @param nonce          Per-signerAddress replay-protection nonce.
    /// @param sig            EIP-712 signature over PaymentAuth.
    function executePayment(
        address  signerAddress,
        address  recipient,
        uint128  amount,
        uint128  fee,
        address  feeRecipient,
        uint64   quoteExpiry,
        uint256  nonce,
        bytes calldata sig
    ) external nonReentrant {
        Link storage link = links[signerAddress];

        if (!link.active)                              revert LinkNotActive();
        if (block.timestamp > link.expiry)             revert LinkExpired();
        if (block.timestamp > quoteExpiry)             revert QuoteExpired();
        if (recipient == address(0))                   revert ZeroRecipient();
        if (recipient == address(this))                revert SelfRecipient();
        if (amount == 0)                               revert ZeroAmount();
        if (usedNonces[signerAddress][nonce])          revert NonceUsed();
        if (link.balance < amount)                     revert InsufficientBalance();
        if (fee > 0 && link.feeBalance < fee)          revert InsufficientFeeBalance();
        // Enforce the authorised fee recipient — front-running cannot redirect the fee
        if (fee > 0 && feeRecipient != msg.sender)     revert WrongFeeRecipient();

        bytes32 structHash = keccak256(
            abi.encode(
                _PAYMENT_AUTH_TYPEHASH,
                signerAddress,
                recipient,
                uint256(amount),
                uint256(fee),
                feeRecipient,
                uint256(quoteExpiry),
                nonce,
                uint256(link.expiry),
                address(this),
                block.chainid
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        if (ECDSA.recover(digest, sig) != signerAddress) revert InvalidSignature();

        // Effects before interactions (checks-effects-interactions)
        usedNonces[signerAddress][nonce] = true;
        link.balance    -= amount;
        link.feeBalance -= fee;

        usdc.safeTransfer(recipient, amount);
        if (fee > 0) usdc.safeTransfer(feeRecipient, fee);

        emit PaymentExecuted(signerAddress, recipient, amount, fee, feeRecipient, nonce);
    }

    /// @notice Cancels a link and refunds all remaining funds to the issuer.
    function cancelLink(address signerAddress) external nonReentrant {
        Link storage link = links[signerAddress];
        if (msg.sender != link.issuer) revert NotIssuer();
        if (!link.active)              revert LinkNotActive();

        uint128 refund = link.balance + link.feeBalance;
        link.active     = false;
        link.balance    = 0;
        link.feeBalance = 0;

        usdc.safeTransfer(msg.sender, uint256(refund));
        emit LinkCancelled(signerAddress, msg.sender, refund);
    }

    /// @notice Returns stored state for a link.
    function getLinkInfo(address signerAddress) external view returns (Link memory) {
        return links[signerAddress];
    }

    /// @notice EIP-712 domain separator.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
    }

    receive() external payable { revert("No native value"); }
}

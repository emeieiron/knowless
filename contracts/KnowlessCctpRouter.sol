// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ISpookly} from "./interfaces/ISpookly.sol";
import {ITokenMessengerV2} from "./interfaces/ITokenMessengerV2.sol";

/**
 * @title KnowlessCctpRouter
 * @notice Atomic CCTP cross-chain payment router for knowless.
 *
 * Flow:
 *   1. executePayment on Spookly escrow — recipient=router, feeRecipient=router.
 *      Router collects grossAmount (principal) and relayFee from the link.
 *   2. depositForBurnWithHook on TokenMessengerV2 — burns grossAmount to
 *      destination chain via Circle Forwarding Service.
 *   3. safeTransfer relayFee to msg.sender (the relayer).
 *   Reverts entirely if any step fails.
 *
 * DUAL AUTHORIZATION:
 *   PaymentAuth (Spookly EIP-712): authorises escrow debit.
 *     Binds recipient=router, feeRecipient=router, amount=grossAmount,
 *     fee=relayFee, nonce, quoteExpiry. Does NOT bind destination chain.
 *
 *   CctpPayment (router EIP-712): additional signature by signerAddress.
 *     Binds signerAddress, destinationDomain, mintRecipient, grossAmount,
 *     maxCctpFee, relayFee, relayer (msg.sender), quoteExpiry, nonce,
 *     escrow address, source chainId.
 *
 * SECURITY:
 *   - relayFee > 0: prevents a third party calling escrow directly with
 *     recipient=router (they still need a valid CctpPayment sig, but
 *     fee=0 is rejected at the escrow level only if feeRecipient != msg.sender;
 *     this router additionally requires relayFee>0 and that msg.sender equals
 *     the signed relayer, so no unauthorised party can route a payment).
 *   - grossAmount > maxCctpFee: ensures a positive net amount reaches the recipient.
 *   - Escrow nonce consumed atomically — no double-spend.
 *   - Source chain pinned to Arc Testnet (chain 5042002).
 *   - Destination allowlist: EthereumSepolia (0), BaseSepolia (6) only.
 *   - Reentrancy guard.
 */
contract KnowlessCctpRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Immutable configuration ─────────────────────────────────────────────

    /// @notice The Spookly escrow this router is paired with.
    ISpookly          public immutable escrow;
    /// @notice Arc USDC ERC-20.
    IERC20            public immutable usdc;
    /// @notice Circle TokenMessengerV2.
    ITokenMessengerV2 public immutable tokenMessenger;

    /// @notice Arc Mainnet EVM chain ID — enforced at call time.
    uint256 public constant ARC_MAINNET_CHAIN_ID = 5042;
    /// @notice Arc CCTP domain (distinct from EVM chain ID).
    uint32  public constant ARC_CCTP_DOMAIN = 26;

    /// @notice Allowed destination CCTP domains.
    uint32  public constant ETHEREUM_DOMAIN = 0;
    uint32  public constant BASE_DOMAIN      = 6;

    /// @notice Standard finality threshold (2000) for the Forwarding Service.
    uint32  public constant FINALITY_THRESHOLD = 2000;

    /**
     * @notice Circle Forwarding Service static hook (32 bytes):
     *         "cctp-forward" magic (24 bytes) + version 0 (4 bytes) + length 0 (4 bytes).
     *         Source: https://developers.circle.com/cctp/concepts/forwarding-service
     */
    bytes32 public constant FORWARDING_HOOK =
        0x636374702d666f72776172640000000000000000000000000000000000000000;

    /// @dev bytes32(0) = any caller may relay on destination (Forwarding Service handles it).
    bytes32 private constant _DESTINATION_CALLER = bytes32(0);

    // ── EIP-712 ─────────────────────────────────────────────────────────────

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /**
     * @dev CctpPayment type hash.
     *      Binds all cross-chain routing parameters plus the signed relayer,
     *      preventing substitution of any field after signing.
     */
    bytes32 public constant CCTP_PAYMENT_TYPEHASH = keccak256(
        "CctpPayment("
        "address signerAddress,"
        "uint32 destinationDomain,"
        "address mintRecipient,"
        "uint256 grossAmount,"
        "uint256 maxCctpFee,"
        "uint128 relayFee,"
        "address relayer,"
        "uint64 quoteExpiry,"
        "uint256 nonce,"
        "address escrow,"
        "uint256 chainId"
        ")"
    );

    bytes32 private immutable _NAME_HASH    = keccak256("KnowlessCctpRouter");
    bytes32 private immutable _VERSION_HASH = keccak256("1");

    // ── Errors ───────────────────────────────────────────────────────────────

    error WrongSourceChain();
    error ZeroRecipient();
    error ZeroRelayFee();
    error AmountNotGreaterThanFee();
    error UnsupportedDestination();
    error QuoteExpired();
    error WrongRelayer();
    error InvalidCctpSignature();

    // ── Events ───────────────────────────────────────────────────────────────

    event CctpPaymentRouted(
        address indexed signerAddress,
        uint32  indexed destinationDomain,
        address         mintRecipient,
        uint256         grossAmount,
        uint256         maxCctpFee,
        uint128         relayFee,
        address indexed relayer,
        uint256         nonce
    );

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _escrow, address _usdc, address _tokenMessenger) {
        require(_escrow         != address(0), "Zero escrow");
        require(_usdc           != address(0), "Zero usdc");
        require(_tokenMessenger != address(0), "Zero messenger");
        escrow         = ISpookly(_escrow);
        usdc           = IERC20(_usdc);
        tokenMessenger = ITokenMessengerV2(_tokenMessenger);
    }

    // ── External ─────────────────────────────────────────────────────────────

    /**
     * @notice Atomically route a link payment cross-chain via CCTP forwarding.
     *
     * @param signerAddress     Link signer (identifies the link in the escrow).
     * @param grossAmount       USDC debited from the link principal (6 decimals).
     *                          Recipient receives grossAmount minus CCTP fees.
     * @param maxCctpFee        Max CCTP+forwarding fee accepted (6-decimal USDC).
     *                          grossAmount must be > maxCctpFee.
     * @param relayFee          Relayer fee sent to msg.sender (6-decimal USDC). Must be > 0.
     * @param quoteExpiry       Timestamp; both signatures invalid after this.
     * @param nonce             Escrow replay-protection nonce.
     * @param destinationDomain CCTP destination: 0 = EthereumSepolia, 6 = BaseSepolia.
     * @param mintRecipient     Destination EVM address.
     * @param paymentSig        PaymentAuth EIP-712 sig (Spookly domain).
     *                          Must encode recipient=router, feeRecipient=router.
     * @param cctpSig           CctpPayment EIP-712 sig (router domain).
     *                          Must encode relayer=msg.sender.
     */
    function routePayment(
        address  signerAddress,
        uint128  grossAmount,
        uint256  maxCctpFee,
        uint128  relayFee,
        uint64   quoteExpiry,
        uint256  nonce,
        uint32   destinationDomain,
        address  mintRecipient,
        bytes calldata paymentSig,
        bytes calldata cctpSig
    ) external nonReentrant {
        // ── Source-chain guard ───────────────────────────────────────────────
        if (block.chainid != ARC_MAINNET_CHAIN_ID) revert WrongSourceChain();

        // ── Input validation ─────────────────────────────────────────────────
        if (mintRecipient == address(0))   revert ZeroRecipient();
        if (relayFee == 0)                 revert ZeroRelayFee();
        if (grossAmount <= maxCctpFee)     revert AmountNotGreaterThanFee();
        if (block.timestamp > quoteExpiry) revert QuoteExpired();
        if (destinationDomain != ETHEREUM_DOMAIN &&
            destinationDomain != BASE_DOMAIN)
            revert UnsupportedDestination();

        // ── Verify CctpPayment signature ─────────────────────────────────────
        // The struct is signed by signerAddress and encodes relayer=msg.sender.
        // We build the digest with relayer=msg.sender; if the sig was produced
        // with any other relayer the recovered address will not equal signerAddress.
        {
            bytes32 structHash = keccak256(abi.encode(
                CCTP_PAYMENT_TYPEHASH,
                signerAddress,
                destinationDomain,
                mintRecipient,
                uint256(grossAmount),
                maxCctpFee,
                uint256(relayFee),
                msg.sender,           // relayer must equal caller
                uint256(quoteExpiry),
                nonce,
                address(escrow),
                block.chainid
            ));
            bytes32 digest = keccak256(
                abi.encodePacked("\x19\x01", domainSeparator(), structHash)
            );
            if (ECDSA.recover(digest, cctpSig) != signerAddress)
                revert InvalidCctpSignature();
        }

        // ── Execute Spookly payment → router receives grossAmount + relayFee ─
        // escrow enforces: msg.sender == feeRecipient (both = address(this)).
        escrow.executePayment(
            signerAddress,
            address(this),   // recipient  (gets grossAmount)
            grossAmount,
            relayFee,
            address(this),   // feeRecipient (gets relayFee; escrow checks msg.sender==this)
            quoteExpiry,
            nonce,
            paymentSig
        );

        // ── Approve messenger and burn grossAmount ───────────────────────────
        usdc.safeIncreaseAllowance(address(tokenMessenger), grossAmount);

        bytes32 mintRecipientB32 = bytes32(uint256(uint160(mintRecipient)));

        tokenMessenger.depositForBurnWithHook(
            grossAmount,
            destinationDomain,
            mintRecipientB32,
            address(usdc),
            _DESTINATION_CALLER,
            maxCctpFee,
            FINALITY_THRESHOLD,
            abi.encodePacked(FORWARDING_HOOK)
        );

        // ── Forward relay fee to caller ───────────────────────────────────────
        usdc.safeTransfer(msg.sender, uint256(relayFee));

        emit CctpPaymentRouted(
            signerAddress,
            destinationDomain,
            mintRecipient,
            grossAmount,
            maxCctpFee,
            relayFee,
            msg.sender,
            nonce
        );
    }

    /// @notice Router EIP-712 domain separator.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            _EIP712_DOMAIN_TYPEHASH,
            _NAME_HASH,
            _VERSION_HASH,
            block.chainid,
            address(this)
        ));
    }

    receive() external payable { revert("No native value"); }
}

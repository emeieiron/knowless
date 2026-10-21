// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Spookly} from "../Spookly.sol";
import {KnowlessCctpRouter} from "../KnowlessCctpRouter.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

// ── Mock TokenMessengerV2 ─────────────────────────────────────────────────────

/**
 * @dev Strict mock: records the last depositForBurnWithHook call, performs an
 *      actual transferFrom on burnToken (so router USDC balance genuinely
 *      reaches zero after a successful route), and can be forced to revert to
 *      exercise rollback atomicity.
 */
contract MockTokenMessengerV2 {
    struct BurnCall {
        uint256 amount;
        uint32  destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32  minFinalityThreshold;
        bytes   hookData;
    }

    BurnCall private _lastBurn;
    bool     public shouldRevert;
    uint256  public callCount;

    // sink for "burned" tokens — not address(0) so ERC-20 doesn't revert on mint
    address public constant BURN_SINK = address(0xdead);

    function lastBurn() external view returns (BurnCall memory) { return _lastBurn; }

    function setShouldRevert(bool v) external { shouldRevert = v; }

    function depositForBurnWithHook(
        uint256 amount,
        uint32  destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32  minFinalityThreshold,
        bytes   calldata hookData
    ) external {
        if (shouldRevert) revert("MockMessenger: forced revert");
        // Actually pull USDC from the caller (router) so its balance drops to zero
        IERC20(burnToken).transferFrom(msg.sender, BURN_SINK, amount);
        callCount++;
        _lastBurn = BurnCall({
            amount:               amount,
            destinationDomain:    destinationDomain,
            mintRecipient:        mintRecipient,
            burnToken:            burnToken,
            destinationCaller:    destinationCaller,
            maxFee:               maxFee,
            minFinalityThreshold: minFinalityThreshold,
            hookData:             hookData
        });
    }
}

// ── Test contract ─────────────────────────────────────────────────────────────

contract KnowlessCctpRouterTest is Test {
    // ── EIP-712 type strings ──────────────────────────────────────────────────
    bytes32 constant PAYMENT_AUTH_TYPEHASH = keccak256(
        "PaymentAuth(address signerAddress,address recipient,uint256 amount,uint256 fee,address feeRecipient,uint256 quoteExpiry,uint256 nonce,uint256 expiry,address contract_,uint256 chainId)"
    );
    bytes32 constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // ── Local domain constants — capture BEFORE any cheatcode, avoiding
    //    the "next-call" consumption pitfall with vm.prank/vm.expectRevert. ─────
    uint32 constant ETH_SEP  = 0;   // ETH_SEPOLIA_DOMAIN
    uint32 constant BASE_SEP = 6;   // BASE_SEPOLIA_DOMAIN

    // ── Actors ────────────────────────────────────────────────────────────────
    uint256 issuerKey   = 0xA1;
    uint256 signerKey   = 0xB2;
    uint256 relayerKey  = 0xC3;
    uint256 attackerKey = 0xD4;

    address issuer;
    address signer;
    address relayer;
    address attacker;
    address mintRecipient = address(0xBEEF);

    // ── Contracts ─────────────────────────────────────────────────────────────
    MockERC20            usdc;
    Spookly              escrow;
    KnowlessCctpRouter   router;
    MockTokenMessengerV2 messenger;

    // ── Link parameters ───────────────────────────────────────────────────────
    uint128 constant PRINCIPAL   = 10_000_000;  // 10 USDC
    uint128 constant FEE_BUDGET  =  1_000_000;  //  1 USDC
    uint64  LINK_EXPIRY;

    // ── Payment parameters ────────────────────────────────────────────────────
    uint128 constant GROSS_AMOUNT = 5_000_000;  // 5 USDC to burn
    uint256 constant MAX_CCTP_FEE =   100_000;  // 0.1 USDC max CCTP fee
    uint128 constant RELAY_FEE    =   200_000;  // 0.2 USDC relay fee
    uint256 constant NONCE        = 42;

    uint64  QUOTE_EXPIRY;

    function setUp() public {
        vm.chainId(5042002);

        issuer   = vm.addr(issuerKey);
        signer   = vm.addr(signerKey);
        relayer  = vm.addr(relayerKey);
        attacker = vm.addr(attackerKey);

        LINK_EXPIRY  = uint64(block.timestamp + 7 days);
        QUOTE_EXPIRY = uint64(block.timestamp + 5 minutes);

        usdc      = new MockERC20("USDC", "USDC", 6);
        escrow    = new Spookly(address(usdc));
        messenger = new MockTokenMessengerV2();
        router    = new KnowlessCctpRouter(address(escrow), address(usdc), address(messenger));

        // Fund issuer and create link
        usdc.mint(issuer, PRINCIPAL + FEE_BUDGET);
        vm.startPrank(issuer);
        usdc.approve(address(escrow), PRINCIPAL + FEE_BUDGET);
        escrow.createLink(signer, PRINCIPAL, FEE_BUDGET, LINK_EXPIRY);
        vm.stopPrank();

        // Verify local constants match contract
        assertEq(router.ETH_SEPOLIA_DOMAIN(),  ETH_SEP);
        assertEq(router.BASE_SEPOLIA_DOMAIN(), BASE_SEP);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// @dev Build and sign a PaymentAuth for the Spookly escrow.
    function _signPaymentAuth(
        uint256 sigKey,
        address _signer,
        address recipient,
        uint128 amount,
        uint128 fee,
        address feeRecipient,
        uint64  quoteExpiry,
        uint256 _nonce
    ) internal view returns (bytes memory) {
        Spookly.Link memory link = escrow.getLinkInfo(_signer);
        bytes32 domSep = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256("Spookly"),
            keccak256("1"),
            block.chainid,
            address(escrow)
        ));
        bytes32 structHash = keccak256(abi.encode(
            PAYMENT_AUTH_TYPEHASH,
            _signer,
            recipient,
            uint256(amount),
            uint256(fee),
            feeRecipient,
            uint256(quoteExpiry),
            _nonce,
            uint256(link.expiry),
            address(escrow),
            block.chainid
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sigKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Build and sign a CctpPayment for the router.
    function _signCctpPayment(
        uint256 sigKey,
        address _signer,
        uint32  destDomain,
        address _mintRecipient,
        uint128 grossAmount,
        uint256 maxCctpFee,
        uint128 relayFee,
        address _relayer,
        uint64  quoteExpiry,
        uint256 _nonce
    ) internal view returns (bytes memory) {
        bytes32 domSep = router.domainSeparator();
        bytes32 structHash = keccak256(abi.encode(
            router.CCTP_PAYMENT_TYPEHASH(),
            _signer,
            destDomain,
            _mintRecipient,
            uint256(grossAmount),
            maxCctpFee,
            uint256(relayFee),
            _relayer,
            uint256(quoteExpiry),
            _nonce,
            address(escrow),
            block.chainid
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sigKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Produce valid (paymentSig, cctpSig) pair for default parameters (ETH_SEP).
    function _validSigs() internal view returns (bytes memory paymentSig, bytes memory cctpSig) {
        paymentSig = _signPaymentAuth(
            signerKey, signer, address(router), GROSS_AMOUNT, RELAY_FEE,
            address(router), QUOTE_EXPIRY, NONCE
        );
        // ETH_SEP is a local constant — NOT a router call after prank
        cctpSig = _signCctpPayment(
            signerKey, signer, ETH_SEP, mintRecipient,
            GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE, relayer, QUOTE_EXPIRY, NONCE
        );
    }

    /// @dev Call routePayment as relayer with default parameters (ETH_SEP).
    ///      Uses local ETH_SEP constant — no external call after vm.prank.
    function _callRoute(bytes memory paymentSig, bytes memory cctpSig) internal {
        vm.prank(relayer);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE,
            ETH_SEP, mintRecipient,   // ETH_SEP is a local constant, not a getter call
            paymentSig, cctpSig
        );
    }

    // ── R1: Successful atomic debit / burn / relay fee ────────────────────────

    function test_R1_SuccessfulRoute() public {
        (bytes memory paymentSig, bytes memory cctpSig) = _validSigs();

        uint256 relayerBalBefore = usdc.balanceOf(relayer);

        // Expect emit — use local constant, no view call after expectEmit
        vm.expectEmit(true, true, false, true, address(router));
        emit KnowlessCctpRouter.CctpPaymentRouted(
            signer, ETH_SEP, mintRecipient,
            GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE, relayer, NONCE
        );

        _callRoute(paymentSig, cctpSig);

        // Escrow nonce consumed
        assertTrue(escrow.usedNonces(signer, NONCE));
        // Escrow link balances reduced
        Spookly.Link memory link = escrow.getLinkInfo(signer);
        assertEq(link.balance,    PRINCIPAL  - GROSS_AMOUNT);
        assertEq(link.feeBalance, FEE_BUDGET - RELAY_FEE);
        // Relay fee paid to relayer
        assertEq(usdc.balanceOf(relayer), relayerBalBefore + RELAY_FEE);
        // Messenger called once with correct params
        assertEq(messenger.callCount(), 1);
        MockTokenMessengerV2.BurnCall memory burn = messenger.lastBurn();
        assertEq(burn.amount,               GROSS_AMOUNT);
        assertEq(burn.destinationDomain,    ETH_SEP);
        assertEq(burn.mintRecipient,        bytes32(uint256(uint160(mintRecipient))));
        assertEq(burn.burnToken,            address(usdc));
        assertEq(burn.destinationCaller,    bytes32(0));
        assertEq(burn.maxFee,               MAX_CCTP_FEE);
        assertEq(burn.minFinalityThreshold, router.FINALITY_THRESHOLD());
        assertEq(keccak256(burn.hookData),  keccak256(abi.encodePacked(router.FORWARDING_HOOK())));
        // Router holds zero residual USDC (mock actually transfers out)
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_R1_BaseSepolia() public {
        bytes memory paymentSig = _signPaymentAuth(
            signerKey, signer, address(router), GROSS_AMOUNT, RELAY_FEE,
            address(router), QUOTE_EXPIRY, NONCE
        );
        // BASE_SEP is a local constant
        bytes memory cctpSig = _signCctpPayment(
            signerKey, signer, BASE_SEP, mintRecipient,
            GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE, relayer, QUOTE_EXPIRY, NONCE
        );
        vm.prank(relayer);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE,
            BASE_SEP, mintRecipient,
            paymentSig, cctpSig
        );
        assertEq(messenger.lastBurn().destinationDomain, BASE_SEP);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    // ── R2: Burn failure causes full rollback ─────────────────────────────────

    function test_R2_BurnFailureRollback() public {
        (bytes memory paymentSig, bytes memory cctpSig) = _validSigs();
        messenger.setShouldRevert(true);

        uint128 escrowBalBefore  = escrow.getLinkInfo(signer).balance;
        uint128 escrowFeeBefore  = escrow.getLinkInfo(signer).feeBalance;
        bool    nonceBefore      = escrow.usedNonces(signer, NONCE);
        uint256 relayerBalBefore = usdc.balanceOf(relayer);

        vm.prank(relayer);
        vm.expectRevert("MockMessenger: forced revert");
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE,
            ETH_SEP, mintRecipient,
            paymentSig, cctpSig
        );

        // Everything rolled back
        assertEq(escrow.getLinkInfo(signer).balance,    escrowBalBefore);
        assertEq(escrow.getLinkInfo(signer).feeBalance, escrowFeeBefore);
        assertEq(escrow.usedNonces(signer, NONCE),      nonceBefore);
        assertEq(usdc.balanceOf(relayer),               relayerBalBefore);
        assertEq(usdc.balanceOf(address(router)),       0);
    }

    // ── R3: Replay protection ─────────────────────────────────────────────────

    function test_R3_ReplayRejected() public {
        (bytes memory paymentSig, bytes memory cctpSig) = _validSigs();
        _callRoute(paymentSig, cctpSig);

        vm.prank(relayer);
        vm.expectRevert(Spookly.NonceUsed.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE,
            ETH_SEP, mintRecipient,
            paymentSig, cctpSig
        );
    }

    // ── R4: Wrong destination domain rejected (unsupported) ───────────────────

    function test_R4_WrongDomainRejected() public {
        uint32 badDomain = 99;
        bytes memory paymentSig = _signPaymentAuth(
            signerKey, signer, address(router), GROSS_AMOUNT, RELAY_FEE,
            address(router), QUOTE_EXPIRY, NONCE
        );
        bytes memory cctpSig = _signCctpPayment(
            signerKey, signer, badDomain, mintRecipient,
            GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE, relayer, QUOTE_EXPIRY, NONCE
        );
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.UnsupportedDestination.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE, badDomain, mintRecipient,
            paymentSig, cctpSig
        );
    }

    // ── R5: Zero recipient rejected ───────────────────────────────────────────

    function test_R5_ZeroRecipient() public {
        bytes memory paymentSig = _signPaymentAuth(
            signerKey, signer, address(router), GROSS_AMOUNT, RELAY_FEE,
            address(router), QUOTE_EXPIRY, NONCE
        );
        bytes memory cctpSig = _signCctpPayment(
            signerKey, signer, ETH_SEP, address(0),
            GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE, relayer, QUOTE_EXPIRY, NONCE
        );
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.ZeroRecipient.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE, ETH_SEP, address(0),
            paymentSig, cctpSig
        );
    }

    // ── R6: Wrong relayer (msg.sender != signed relayer) ─────────────────────

    function test_R6_WrongRelayer() public {
        (bytes memory paymentSig, bytes memory cctpSig) = _validSigs();
        // cctpSig binds relayer; attacker calls as themselves → digest mismatch
        vm.prank(attacker);
        vm.expectRevert(KnowlessCctpRouter.InvalidCctpSignature.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE, ETH_SEP, mintRecipient,
            paymentSig, cctpSig
        );
    }

    // ── R7: Tampered grossAmount rejected by CctpPayment sig ─────────────────

    function test_R7_TamperedAmount() public {
        (bytes memory paymentSig, bytes memory cctpSig) = _validSigs();
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.InvalidCctpSignature.selector);
        router.routePayment(
            signer, GROSS_AMOUNT + 1, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE, ETH_SEP, mintRecipient,
            paymentSig, cctpSig
        );
    }

    // ── R8: Tampered relayFee rejected by CctpPayment sig ────────────────────

    function test_R8_TamperedFee() public {
        (bytes memory paymentSig, bytes memory cctpSig) = _validSigs();
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.InvalidCctpSignature.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE + 1,
            QUOTE_EXPIRY, NONCE, ETH_SEP, mintRecipient,
            paymentSig, cctpSig
        );
    }

    // ── R9: Tampered nonce rejected ───────────────────────────────────────────

    function test_R9_TamperedNonce() public {
        (bytes memory paymentSig, bytes memory cctpSig) = _validSigs();
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.InvalidCctpSignature.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE + 1, ETH_SEP, mintRecipient,
            paymentSig, cctpSig
        );
    }

    // ── R10: Tampered mintRecipient rejected ──────────────────────────────────

    function test_R10_TamperedRecipient() public {
        (bytes memory paymentSig, bytes memory cctpSig) = _validSigs();
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.InvalidCctpSignature.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE, ETH_SEP, address(0xDEAD),
            paymentSig, cctpSig
        );
    }

    // ── R11: Invalid legacy PaymentAuth signature rejected by escrow ──────────

    function test_R11_InvalidPaymentSig() public {
        bytes memory badPaymentSig = _signPaymentAuth(
            attackerKey, signer, address(router), GROSS_AMOUNT, RELAY_FEE,
            address(router), QUOTE_EXPIRY, NONCE
        );
        bytes memory cctpSig = _signCctpPayment(
            signerKey, signer, ETH_SEP, mintRecipient,
            GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE, relayer, QUOTE_EXPIRY, NONCE
        );
        vm.prank(relayer);
        vm.expectRevert(Spookly.InvalidSignature.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE, ETH_SEP, mintRecipient,
            badPaymentSig, cctpSig
        );
    }

    // ── R12: Direct-escrow bypass gate — positive relayFee + WrongFeeRecipient ─
    //
    // Scenario: attacker observes a VALID PaymentAuth signed by signerKey with
    // recipient=router, feeRecipient=router, relayFee>0.  Attacker calls the
    // escrow directly (not through the router).  The escrow checks:
    //   fee > 0  →  require(msg.sender == feeRecipient)
    // Since feeRecipient=router and msg.sender=attacker, the escrow reverts
    // WrongFeeRecipient.  This proves positive relayFee is the caller gate that
    // prevents the router's second (CctpPayment) authorization from being bypassed.

    function test_R12_DirectEscrowBypassGate() public {
        // A VALID signer signature — recipient=router, feeRecipient=router, fee>0
        bytes memory validSig = _signPaymentAuth(
            signerKey,               // correct signer key
            signer, address(router), GROSS_AMOUNT, RELAY_FEE,
            address(router), QUOTE_EXPIRY, NONCE
        );

        uint256 issuerBalBefore  = usdc.balanceOf(address(escrow));
        bool    nonceBefore      = escrow.usedNonces(signer, NONCE);

        // Attacker tries to use this valid sig directly on the escrow
        vm.prank(attacker);
        vm.expectRevert(Spookly.WrongFeeRecipient.selector);
        escrow.executePayment(
            signer, address(router), GROSS_AMOUNT, RELAY_FEE,
            address(router),   // feeRecipient=router, but msg.sender=attacker
            QUOTE_EXPIRY, NONCE, validSig
        );

        // Escrow unchanged — no funds moved, nonce not consumed
        assertEq(usdc.balanceOf(address(escrow)), issuerBalBefore);
        assertEq(escrow.usedNonces(signer, NONCE), nonceBefore);
    }

    // ── R12b: Even with feeRecipient=attacker, valid sig requires recipient=attacker
    //
    // Attacker builds a valid sig with feeRecipient=attacker (so msg.sender==feeRecipient
    // check passes), but then recipient must also be attacker — they cannot set
    // recipient=router in a sig that passes, because signerKey is not known to attacker.
    // This tests that the escrow rejects the signature when the attacker uses their
    // own key to sign (they don't have signerKey).

    function test_R12b_DirectEscrowNoSignerKey() public {
        // Attacker signs with attackerKey (not signerKey) — feeRecipient=attacker
        // so the msg.sender check would pass, but signature recovery fails
        bytes memory attackerSig = _signPaymentAuth(
            attackerKey,             // wrong key
            signer, attacker, GROSS_AMOUNT, RELAY_FEE,
            attacker, QUOTE_EXPIRY, NONCE
        );

        vm.prank(attacker);
        vm.expectRevert(Spookly.InvalidSignature.selector);
        escrow.executePayment(
            signer, attacker, GROSS_AMOUNT, RELAY_FEE,
            attacker, QUOTE_EXPIRY, NONCE, attackerSig
        );
    }

    // ── R13: Zero relay fee rejected ─────────────────────────────────────────

    function test_R13_ZeroRelayFee() public {
        bytes memory paymentSig = _signPaymentAuth(
            signerKey, signer, address(router), GROSS_AMOUNT, 0,
            address(router), QUOTE_EXPIRY, NONCE
        );
        bytes memory cctpSig = _signCctpPayment(
            signerKey, signer, ETH_SEP, mintRecipient,
            GROSS_AMOUNT, MAX_CCTP_FEE, 0, relayer, QUOTE_EXPIRY, NONCE
        );
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.ZeroRelayFee.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, 0,
            QUOTE_EXPIRY, NONCE, ETH_SEP, mintRecipient,
            paymentSig, cctpSig
        );
    }

    // ── R14: grossAmount <= maxCctpFee rejected ───────────────────────────────

    function test_R14_AmountNotGreaterThanFee() public {
        uint128 tooSmall = uint128(MAX_CCTP_FEE); // equal, not greater
        bytes memory paymentSig = _signPaymentAuth(
            signerKey, signer, address(router), tooSmall, RELAY_FEE,
            address(router), QUOTE_EXPIRY, NONCE
        );
        bytes memory cctpSig = _signCctpPayment(
            signerKey, signer, ETH_SEP, mintRecipient,
            tooSmall, MAX_CCTP_FEE, RELAY_FEE, relayer, QUOTE_EXPIRY, NONCE
        );
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.AmountNotGreaterThanFee.selector);
        router.routePayment(
            signer, tooSmall, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE, ETH_SEP, mintRecipient,
            paymentSig, cctpSig
        );
    }

    // ── R15: Source chain != Arc Testnet rejected ─────────────────────────────

    function test_R15_WrongSourceChain() public {
        vm.chainId(1); // switch to Ethereum mainnet
        (bytes memory paymentSig, bytes memory cctpSig) = _validSigs();
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.WrongSourceChain.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE, ETH_SEP, mintRecipient,
            paymentSig, cctpSig
        );
    }

    // ── R16: Expired quoteExpiry rejected ─────────────────────────────────────

    function test_R16_QuoteExpired() public {
        uint64 pastExpiry = uint64(block.timestamp - 1);
        bytes memory paymentSig = _signPaymentAuth(
            signerKey, signer, address(router), GROSS_AMOUNT, RELAY_FEE,
            address(router), pastExpiry, NONCE
        );
        bytes memory cctpSig = _signCctpPayment(
            signerKey, signer, ETH_SEP, mintRecipient,
            GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE, relayer, pastExpiry, NONCE
        );
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.QuoteExpired.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            pastExpiry, NONCE, ETH_SEP, mintRecipient,
            paymentSig, cctpSig
        );
    }

    // ── R17: Domain separation — Spookly sig cannot be used as CctpPayment sig ─

    function test_R17_DomainSeparation() public {
        bytes memory paymentSig = _signPaymentAuth(
            signerKey, signer, address(router), GROSS_AMOUNT, RELAY_FEE,
            address(router), QUOTE_EXPIRY, NONCE
        );
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.InvalidCctpSignature.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE, ETH_SEP, mintRecipient,
            paymentSig, paymentSig   // same sig for both — wrong typehash/domain
        );
    }

    // ── R18: CctpPayment sig from attacker (not signerAddress) rejected ───────

    function test_R18_CctpSigWrongSigner() public {
        bytes memory paymentSig = _signPaymentAuth(
            signerKey, signer, address(router), GROSS_AMOUNT, RELAY_FEE,
            address(router), QUOTE_EXPIRY, NONCE
        );
        bytes memory badCctpSig = _signCctpPayment(
            attackerKey, signer, ETH_SEP, mintRecipient,
            GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE, relayer, QUOTE_EXPIRY, NONCE
        );
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.InvalidCctpSignature.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE, ETH_SEP, mintRecipient,
            paymentSig, badCctpSig
        );
    }

    // ── R19: Constant values ──────────────────────────────────────────────────

    function test_R19_Constants() public view {
        assertEq(router.ARC_TESTNET_CHAIN_ID(), 5042002);
        assertEq(router.ARC_CCTP_DOMAIN(),      26);
        assertEq(router.ETH_SEPOLIA_DOMAIN(),   ETH_SEP);
        assertEq(router.BASE_SEPOLIA_DOMAIN(),  BASE_SEP);
        assertEq(router.FINALITY_THRESHOLD(),   2000);
        assertEq(router.FORWARDING_HOOK(),
            0x636374702d666f72776172640000000000000000000000000000000000000000);
    }

    // ── R20: Router holds no residual USDC after success ─────────────────────

    function test_R20_NoResidualBalance() public {
        (bytes memory paymentSig, bytes memory cctpSig) = _validSigs();
        _callRoute(paymentSig, cctpSig);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    // ── R21: Tampered destinationDomain (domain 0→6 after signing) ───────────
    //
    // Sig was produced for ETH_SEP=0; caller passes BASE_SEP=6.
    // Router checks domain allowlist first (BASE_SEP passes), then verifies
    // CctpPayment sig with the actual caller-supplied domain.
    // Since domain is bound in the struct, recovered signer != signerAddress.

    function test_R21_TamperedDomain() public {
        // Sign for ETH_SEP (domain 0)
        bytes memory paymentSig = _signPaymentAuth(
            signerKey, signer, address(router), GROSS_AMOUNT, RELAY_FEE,
            address(router), QUOTE_EXPIRY, NONCE
        );
        bytes memory cctpSig = _signCctpPayment(
            signerKey, signer, ETH_SEP, mintRecipient,   // signed for 0
            GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE, relayer, QUOTE_EXPIRY, NONCE
        );
        // Submit with domain=6 — passes allowlist, fails sig
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.InvalidCctpSignature.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY, NONCE,
            BASE_SEP, mintRecipient,   // tampered: 0→6
            paymentSig, cctpSig
        );
    }

    // ── R22: Tampered maxCctpFee (still < grossAmount) ───────────────────────
    //
    // Caller supplies maxCctpFee=MAX_CCTP_FEE+1.  Still passes the
    // AmountNotGreaterThanFee guard (grossAmount > tampered fee), but the
    // CctpPayment digest bound the original MAX_CCTP_FEE, so sig fails.

    function test_R22_TamperedMaxCctpFee() public {
        (bytes memory paymentSig, bytes memory cctpSig) = _validSigs();
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.InvalidCctpSignature.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE + 1, RELAY_FEE,
            QUOTE_EXPIRY, NONCE, ETH_SEP, mintRecipient,
            paymentSig, cctpSig
        );
    }

    // ── R23: Tampered quoteExpiry (still future) ──────────────────────────────
    //
    // Caller supplies quoteExpiry+1.  Still future so QuoteExpired passes,
    // but CctpPayment digest bound the original quoteExpiry, so sig fails.

    function test_R23_TamperedQuoteExpiry() public {
        (bytes memory paymentSig, bytes memory cctpSig) = _validSigs();
        vm.prank(relayer);
        vm.expectRevert(KnowlessCctpRouter.InvalidCctpSignature.selector);
        router.routePayment(
            signer, GROSS_AMOUNT, MAX_CCTP_FEE, RELAY_FEE,
            QUOTE_EXPIRY + 1, NONCE, ETH_SEP, mintRecipient,
            paymentSig, cctpSig
        );
    }
}

// ── Spookly regression tests (bounded) ───────────────────────────────────────

contract SpooklyRegressionTest is Test {
    bytes32 constant PAYMENT_AUTH_TYPEHASH = keccak256(
        "PaymentAuth(address signerAddress,address recipient,uint256 amount,uint256 fee,address feeRecipient,uint256 quoteExpiry,uint256 nonce,uint256 expiry,address contract_,uint256 chainId)"
    );
    bytes32 constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    MockERC20  usdc;
    Spookly    escrow;

    uint256 issuerKey  = 0xE1;
    uint256 signerKey  = 0xE2;
    uint256 relayerKey = 0xE3;

    address issuer;
    address signer;
    address relayer;
    address recipient = address(0x1234);

    uint128 constant PRINCIPAL  = 5_000_000;
    uint128 constant FEE_BUDGET = 500_000;
    uint64  EXPIRY;
    uint64  QUOTE_EXPIRY;

    function setUp() public {
        vm.chainId(5042002);
        issuer  = vm.addr(issuerKey);
        signer  = vm.addr(signerKey);
        relayer = vm.addr(relayerKey);

        EXPIRY       = uint64(block.timestamp + 1 days);
        QUOTE_EXPIRY = uint64(block.timestamp + 5 minutes);

        usdc   = new MockERC20("USDC", "USDC", 6);
        escrow = new Spookly(address(usdc));

        usdc.mint(issuer, PRINCIPAL + FEE_BUDGET);
        vm.startPrank(issuer);
        usdc.approve(address(escrow), PRINCIPAL + FEE_BUDGET);
        escrow.createLink(signer, PRINCIPAL, FEE_BUDGET, EXPIRY);
        vm.stopPrank();
    }

    function _sign(
        uint256 key,
        address _signer,
        address _recipient,
        uint128 amount,
        uint128 fee,
        address feeRecipient,
        uint64  quoteExpiry,
        uint256 nonce
    ) internal view returns (bytes memory) {
        Spookly.Link memory link = escrow.getLinkInfo(_signer);
        bytes32 domSep = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256("Spookly"),
            keccak256("1"),
            block.chainid,
            address(escrow)
        ));
        bytes32 sh = keccak256(abi.encode(
            PAYMENT_AUTH_TYPEHASH,
            _signer, _recipient,
            uint256(amount), uint256(fee),
            feeRecipient, uint256(quoteExpiry),
            nonce, uint256(link.expiry),
            address(escrow), block.chainid
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domSep, sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_S1_NormalPayment() public {
        bytes memory sig = _sign(signerKey, signer, recipient, 1_000_000, 100_000, relayer, QUOTE_EXPIRY, 1);
        vm.prank(relayer);
        escrow.executePayment(signer, recipient, 1_000_000, 100_000, relayer, QUOTE_EXPIRY, 1, sig);
        assertEq(usdc.balanceOf(recipient), 1_000_000);
        assertEq(usdc.balanceOf(relayer),   100_000);
    }

    function test_S2_NonceReplayRejected() public {
        bytes memory sig = _sign(signerKey, signer, recipient, 1_000_000, 100_000, relayer, QUOTE_EXPIRY, 1);
        vm.prank(relayer); escrow.executePayment(signer, recipient, 1_000_000, 100_000, relayer, QUOTE_EXPIRY, 1, sig);
        vm.prank(relayer); vm.expectRevert(Spookly.NonceUsed.selector);
        escrow.executePayment(signer, recipient, 1_000_000, 100_000, relayer, QUOTE_EXPIRY, 1, sig);
    }

    function test_S3_WrongFeeRecipientRejected() public {
        bytes memory sig = _sign(signerKey, signer, recipient, 1_000_000, 100_000, relayer, QUOTE_EXPIRY, 2);
        address notRelayer = address(0xBAD);
        vm.prank(notRelayer); vm.expectRevert(Spookly.WrongFeeRecipient.selector);
        escrow.executePayment(signer, recipient, 1_000_000, 100_000, relayer, QUOTE_EXPIRY, 2, sig);
    }

    function test_S4_InvalidSigRejected() public {
        bytes memory badSig = _sign(0xDEAD, signer, recipient, 1_000_000, 100_000, relayer, QUOTE_EXPIRY, 3);
        vm.prank(relayer); vm.expectRevert(Spookly.InvalidSignature.selector);
        escrow.executePayment(signer, recipient, 1_000_000, 100_000, relayer, QUOTE_EXPIRY, 3, badSig);
    }

    function test_S5_CancelRefund() public {
        vm.prank(issuer);
        escrow.cancelLink(signer);
        assertEq(usdc.balanceOf(issuer), PRINCIPAL + FEE_BUDGET);
    }
}

// ── Solidity/TS EIP-712 interop fixture ──────────────────────────────────────
// Emits domainSeparator, structHash, and final digest for a fixed test vector
// so the TypeScript computeCctpPaymentDigest helper can be verified against
// real Solidity-computed output (not just two copies of the same JS encoding).

contract SolidityInteropFixture is Test {
    // Fixed deterministic router address (CREATE at nonce 0 from address(0x1000))
    address constant FIXTURE_ROUTER  = address(0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f);
    // Known private key (Foundry acct[1]) — unfunded, test fixture only
    uint256 constant FIXTURE_SIGNER_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    // Fixed message fields matching cctp.test.ts test vector
    // These values must match exactly what cctp.test.ts uses for the C6 test
    address  constant SIGNER_ADDR    = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    uint32   constant DEST_DOMAIN    = 0;     // ETH_SEPOLIA_DOMAIN
    address  constant MINT_RECIPIENT = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;
    uint256  constant GROSS_AMOUNT   = 5_000_000;
    uint256  constant MAX_CCTP_FEE   = 100_000;
    uint128  constant RELAY_FEE      = 200_000;
    address  constant RELAYER        = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
    uint64   constant QUOTE_EXPIRY   = 9_999_999_999;
    uint256  constant NONCE          = 42;
    address  constant ESCROW         = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    uint256  constant CHAIN_ID       = 5042002;

    bytes32 constant CCTP_PAYMENT_TYPEHASH = keccak256(
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

    bytes32 constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    function test_R24_SolidityInteropProof() public {
        // 1. Compute domain separator for the fixture router address and chain
        bytes32 domSep = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256("KnowlessCctpRouter"),
            keccak256("1"),
            CHAIN_ID,
            FIXTURE_ROUTER
        ));

        // 2. Compute struct hash for the fixed test vector
        bytes32 structHash = keccak256(abi.encode(
            CCTP_PAYMENT_TYPEHASH,
            SIGNER_ADDR,
            DEST_DOMAIN,
            MINT_RECIPIENT,
            GROSS_AMOUNT,
            MAX_CCTP_FEE,
            uint256(RELAY_FEE),
            RELAYER,
            uint256(QUOTE_EXPIRY),
            NONCE,
            ESCROW,
            CHAIN_ID
        ));

        // 3. Canonical EIP-712 digest
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domSep, structHash));

        // 4. Sign with the fixture key to verify the digest is correct
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(FIXTURE_SIGNER_KEY, digest);
        address recovered = ecrecover(digest, v, r, s);
        assertEq(recovered, SIGNER_ADDR, "ecrecover must recover SIGNER_ADDR from fixture sig");

        // 5. Emit values for the TS test to consume
        console.log("INTEROP_DOM_SEP:");
        console.logBytes32(domSep);
        console.log("INTEROP_STRUCT_HASH:");
        console.logBytes32(structHash);
        console.log("INTEROP_DIGEST:");
        console.logBytes32(digest);
        console.log("INTEROP_SIG_V:", uint256(v));
        console.logBytes32(r);
        console.logBytes32(s);
    }
}

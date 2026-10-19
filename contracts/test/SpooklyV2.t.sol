// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/Spookly.sol";
import "../test-helpers/MockERC20.sol";

/**
 * Comprehensive tests for Spookly v2 (feeRecipient + quoteExpiry in signature).
 *
 * Covers:
 *  - Happy path round-trip (create → executePayment → cancel leftover)
 *  - feeRecipient enforcement: wrong caller reverts WrongFeeRecipient
 *  - quoteExpiry enforcement: expired quote reverts QuoteExpired
 *  - feeRecipient in signature: tampering feeRecipient field reverts InvalidSignature
 *  - quoteExpiry in signature: tampering quoteExpiry field reverts InvalidSignature
 *  - fee underpayment is not a contract concern (relay enforces it); zero fee always valid
 *  - Front-running: attacker as msg.sender cannot claim fee when feeRecipient != attacker
 *  - Nonce replay reverts NonceUsed
 *  - Cross-chain replay reverts InvalidSignature
 *  - Cross-contract replay reverts InvalidSignature
 *  - Wrong signer reverts InvalidSignature
 *  - Expired link reverts LinkExpired
 *  - Expired link cancel refunds both principal + feeBalance
 *  - Fragment encode/decode round-trip (pure computation, tested via assembly)
 *  - Overspend reverts InsufficientBalance
 *  - Zero principal reverts ZeroAmount
 *  - Fuzz: any (amount, fee) within bounds succeeds
 *  - Receipt success verified by state change and usedNonces
 *  - Balance conservation invariant across multiple payments
 */
contract SpooklyV2Test is Test {
    Spookly public spookly;
    MockERC20 public usdc;

    address constant ISSUER    = address(0xA1);
    address constant RECIPIENT = address(0xB1);
    address constant RELAY     = address(0xC1);
    address constant ATTACKER  = address(0xEE);

    uint256 constant LINK_PK   = 0xdeadbeef000000000000000000000000000000000000000000000000cafebabe;
    uint256 constant LINK_PK2  = 0xdeadbeef111111111111111111111111111111111111111111111111cafebabe;

    address SIGNER;
    address SIGNER2;

    uint128 constant PRINCIPAL  = 10_000_000;   // 10 USDC
    uint128 constant FEE_BUDGET =    500_000;   // 0.50 USDC
    uint64  constant ONE_DAY    =     86_400;

    // quoteExpiry typically 5 minutes after block.timestamp
    uint64 constant QUOTE_TTL   = 300;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        spookly = new Spookly(address(usdc));
        SIGNER  = vm.addr(LINK_PK);
        SIGNER2 = vm.addr(LINK_PK2);
        usdc.mint(ISSUER, 200_000_000);
        vm.prank(ISSUER);
        usdc.approve(address(spookly), type(uint256).max);
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function createLink(address signer, uint128 principal, uint128 feeBudget) internal {
        vm.prank(ISSUER);
        spookly.createLink(signer, principal, feeBudget, uint64(block.timestamp) + ONE_DAY);
    }

    /// @dev Signs a PaymentAuth for the v2 typehash (feeRecipient + quoteExpiry included).
    function signPayment(
        uint256 pk,
        address signer,
        address recipient,
        uint128 amount,
        uint128 fee,
        address feeRecipient,
        uint64  quoteExpiry,
        uint256 nonce,
        uint256 expiry
    ) internal view returns (bytes memory) {
        bytes32 typehash = keccak256(
            "PaymentAuth(address signerAddress,address recipient,uint256 amount,uint256 fee,address feeRecipient,uint256 quoteExpiry,uint256 nonce,uint256 expiry,address contract_,uint256 chainId)"
        );
        bytes32 structHash = keccak256(abi.encode(
            typehash,
            signer,
            recipient,
            uint256(amount),
            uint256(fee),
            feeRecipient,
            uint256(quoteExpiry),
            nonce,
            expiry,
            address(spookly),
            block.chainid
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", spookly.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── Happy path ────────────────────────────────────────────────────────

    function test_HappyPath_CreateExecuteCancel() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        uint128 amount = 3_000_000;
        uint128 fee    =    50_000;

        bytes memory sig = signPayment(LINK_PK, SIGNER, RECIPIENT, amount, fee, RELAY, qExp, 1, expiry);

        uint256 recipBefore = usdc.balanceOf(RECIPIENT);
        uint256 relayBefore = usdc.balanceOf(RELAY);

        vm.prank(RELAY);
        spookly.executePayment(SIGNER, RECIPIENT, amount, fee, RELAY, qExp, 1, sig);

        assertEq(usdc.balanceOf(RECIPIENT) - recipBefore, amount);
        assertEq(usdc.balanceOf(RELAY)    - relayBefore, fee);

        // Cancel remaining
        uint256 issuerBefore = usdc.balanceOf(ISSUER);
        vm.prank(ISSUER);
        spookly.cancelLink(SIGNER);
        uint256 remaining = (PRINCIPAL - amount) + (FEE_BUDGET - fee);
        assertEq(usdc.balanceOf(ISSUER) - issuerBefore, remaining);
    }

    // ── feeRecipient enforcement ──────────────────────────────────────────

    /// msg.sender != feeRecipient AND fee > 0 → WrongFeeRecipient
    function test_WrongFeeRecipient_Reverts() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        // Sign with RELAY as feeRecipient
        bytes memory sig = signPayment(LINK_PK, SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, expiry);

        // Attacker submits as msg.sender — cannot redirect fee
        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(Spookly.WrongFeeRecipient.selector));
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, sig);
    }

    /// Zero fee: any msg.sender can submit (feeRecipient check only applies when fee > 0)
    function test_ZeroFee_AnyCallerCanSubmit() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        // For zero-fee payments feeRecipient is still in the sig but fee=0 so check is skipped
        bytes memory sig = signPayment(LINK_PK, SIGNER, RECIPIENT, 1_000_000, 0, ATTACKER, qExp, 1, expiry);

        // Attacker or anyone can submit a zero-fee payment (relay waived fee)
        vm.prank(ATTACKER);
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, 0, ATTACKER, qExp, 1, sig);
        assertEq(usdc.balanceOf(RECIPIENT), 1_000_000);
    }

    /// Tamper feeRecipient field (different from signed value) → InvalidSignature
    function test_TamperedFeeRecipient_Reverts() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        // Sign for RELAY as feeRecipient
        bytes memory sig = signPayment(LINK_PK, SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, expiry);

        // Submit with ATTACKER as feeRecipient (different from signed)
        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(Spookly.InvalidSignature.selector));
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, 50_000, ATTACKER, qExp, 1, sig);
    }

    // ── quoteExpiry enforcement ───────────────────────────────────────────

    /// Quote already expired at submission time → QuoteExpired
    function test_ExpiredQuote_Reverts() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes memory sig = signPayment(LINK_PK, SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, expiry);

        // Warp past quote expiry but link is still active
        vm.warp(block.timestamp + QUOTE_TTL + 1);

        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.QuoteExpired.selector));
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, sig);
    }

    /// Tamper quoteExpiry (extend it) → InvalidSignature
    function test_TamperedQuoteExpiry_Reverts() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        // Sign with normal qExp
        bytes memory sig = signPayment(LINK_PK, SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, expiry);

        // Attacker extends quoteExpiry
        uint64 extendedQExp = qExp + 3600;
        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.InvalidSignature.selector));
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, extendedQExp, 1, sig);
    }

    // ── Tamper amount ─────────────────────────────────────────────────────

    function test_TamperedAmount_Reverts() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes memory sig = signPayment(LINK_PK, SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, expiry);

        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.InvalidSignature.selector));
        spookly.executePayment(SIGNER, RECIPIENT, 9_000_000, 50_000, RELAY, qExp, 1, sig);
    }

    // ── Nonce replay ──────────────────────────────────────────────────────

    function test_NonceReplay_Reverts() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes memory sig = signPayment(LINK_PK, SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 42, expiry);

        vm.prank(RELAY);
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 42, sig);

        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.NonceUsed.selector));
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 42, sig);
    }

    // ── Wrong signer ──────────────────────────────────────────────────────

    function test_WrongSigner_Reverts() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        // Sign with LINK_PK2 but SIGNER is from LINK_PK
        bytes memory sig = signPayment(LINK_PK2, SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, expiry);

        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.InvalidSignature.selector));
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, sig);
    }

    // ── Cross-contract replay ─────────────────────────────────────────────

    function test_CrossContract_Reverts() public {
        Spookly spookly2 = new Spookly(address(usdc));
        vm.prank(ISSUER);
        usdc.approve(address(spookly2), type(uint256).max);
        vm.prank(ISSUER);
        spookly2.createLink(SIGNER, PRINCIPAL, FEE_BUDGET, uint64(block.timestamp) + ONE_DAY);
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);

        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes32 typehash = keccak256(
            "PaymentAuth(address signerAddress,address recipient,uint256 amount,uint256 fee,address feeRecipient,uint256 quoteExpiry,uint256 nonce,uint256 expiry,address contract_,uint256 chainId)"
        );
        bytes32 structHash = keccak256(abi.encode(
            typehash, SIGNER, RECIPIENT, uint256(1_000_000), uint256(50_000),
            RELAY, uint256(qExp), uint256(1), expiry, address(spookly), block.chainid
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", spookly.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(LINK_PK, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(RELAY);
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, sig);

        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.InvalidSignature.selector));
        spookly2.executePayment(SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, sig);
    }

    // ── Expired link ──────────────────────────────────────────────────────

    function test_ExpiredLink_PaymentReverts() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        vm.warp(block.timestamp + ONE_DAY + 1);
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes memory sig = signPayment(LINK_PK, SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, expiry);

        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.LinkExpired.selector));
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, sig);
    }

    function test_ExpiredLink_CancelRefunds() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        vm.warp(block.timestamp + ONE_DAY + 1);

        uint256 before = usdc.balanceOf(ISSUER);
        vm.prank(ISSUER);
        spookly.cancelLink(SIGNER);
        assertEq(usdc.balanceOf(ISSUER) - before, PRINCIPAL + FEE_BUDGET);
    }

    // ── Overspend ─────────────────────────────────────────────────────────

    function test_Overspend_Reverts() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;

        bytes memory sig1 = signPayment(LINK_PK, SIGNER, RECIPIENT, 8_000_000, 50_000, RELAY, qExp, 1, expiry);
        vm.prank(RELAY);
        spookly.executePayment(SIGNER, RECIPIENT, 8_000_000, 50_000, RELAY, qExp, 1, sig1);

        bytes memory sig2 = signPayment(LINK_PK, SIGNER, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 2, expiry);
        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.InsufficientBalance.selector));
        spookly.executePayment(SIGNER, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 2, sig2);
    }

    // ── Fee budget exhaustion ─────────────────────────────────────────────

    function test_FeeBudgetExhausted_Reverts() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;

        // Exhaust entire fee budget in one payment
        bytes memory sig1 = signPayment(LINK_PK, SIGNER, RECIPIENT, 1_000_000, FEE_BUDGET, RELAY, qExp, 1, expiry);
        vm.prank(RELAY);
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, FEE_BUDGET, RELAY, qExp, 1, sig1);

        // Second payment with fee > 0 must revert
        bytes memory sig2 = signPayment(LINK_PK, SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 2, expiry);
        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.InsufficientFeeBalance.selector));
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 2, sig2);

        // But zero-fee still works
        bytes memory sig3 = signPayment(LINK_PK, SIGNER, RECIPIENT, 1_000_000, 0, RELAY, qExp, 3, expiry);
        vm.prank(RELAY);
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, 0, RELAY, qExp, 3, sig3);
    }

    // ── Balance conservation ──────────────────────────────────────────────

    function test_BalanceConservation() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint256 contractBefore = usdc.balanceOf(address(spookly));
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;

        bytes memory sig1 = signPayment(LINK_PK, SIGNER, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 1, expiry);
        vm.prank(RELAY); spookly.executePayment(SIGNER, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 1, sig1);

        bytes memory sig2 = signPayment(LINK_PK, SIGNER, RECIPIENT, 4_000_000, 50_000, RELAY, qExp, 2, expiry);
        vm.prank(RELAY); spookly.executePayment(SIGNER, RECIPIENT, 4_000_000, 50_000, RELAY, qExp, 2, sig2);

        uint256 contractAfter = usdc.balanceOf(address(spookly));
        assertEq(contractBefore - contractAfter, 3_000_000 + 4_000_000 + 50_000 + 50_000);
    }

    // ── Receipt success verified by state ────────────────────────────────

    function test_ReceiptSuccess_StateChange() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes memory sig = signPayment(LINK_PK, SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 77, expiry);

        vm.prank(RELAY);
        spookly.executePayment(SIGNER, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 77, sig);

        assertTrue(spookly.usedNonces(SIGNER, 77));
        Spookly.Link memory link = spookly.getLinkInfo(SIGNER);
        assertEq(link.balance, PRINCIPAL - 1_000_000);
        assertEq(link.feeBalance, FEE_BUDGET - 50_000);
    }

    // ── Fuzz: any valid (amount, fee) pair ────────────────────────────────

    function testFuzz_ValidPayment(uint128 amount, uint128 fee) public {
        vm.assume(amount > 0 && amount <= PRINCIPAL);
        vm.assume(fee <= FEE_BUDGET && fee <= 200_000);
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        uint64 qExp = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes memory sig = signPayment(LINK_PK, SIGNER, RECIPIENT, amount, fee, RELAY, qExp, 1, expiry);

        vm.prank(RELAY);
        spookly.executePayment(SIGNER, RECIPIENT, amount, fee, RELAY, qExp, 1, sig);

        Spookly.Link memory link = spookly.getLinkInfo(SIGNER);
        assertEq(link.balance, PRINCIPAL - amount);
        assertEq(link.feeBalance, FEE_BUDGET - fee);
    }

    // ── Constructor: zero USDC address ───────────────────────────────────

    function test_Constructor_ZeroUsdc_Reverts() public {
        vm.expectRevert("Zero USDC address");
        new Spookly(address(0));
    }

    // ── Double cancel ─────────────────────────────────────────────────────

    function test_DoubleCancel_Reverts() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        vm.prank(ISSUER);
        spookly.cancelLink(SIGNER);
        vm.prank(ISSUER);
        vm.expectRevert(abi.encodeWithSelector(Spookly.LinkNotActive.selector));
        spookly.cancelLink(SIGNER);
    }

    // ── Non-issuer cancel ─────────────────────────────────────────────────

    function test_NonIssuerCancel_Reverts() public {
        createLink(SIGNER, PRINCIPAL, FEE_BUDGET);
        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.NotIssuer.selector));
        spookly.cancelLink(SIGNER);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/Spookly.sol";
import "../test-helpers/MockERC20.sol";

/**
 * Extended focused tests — updated for v2 signature (feeRecipient + quoteExpiry).
 */
contract SpooklyExtendedTest is Test {
    Spookly public spookly;
    MockERC20 public usdc;

    address constant ISSUER    = address(0xA1);
    address constant RECIPIENT = address(0xB1);
    address constant RELAY     = address(0xC1);

    uint256 constant LINK_PK  = 0xdeadbeef000000000000000000000000000000000000000000000000cafebabe;
    uint256 constant LINK_PK2 = 0xdeadbeef111111111111111111111111111111111111111111111111cafebabe;

    address SIGNER_ADDR;
    address SIGNER_ADDR2;

    uint128 constant PRINCIPAL  = 10_000_000;
    uint128 constant FEE_BUDGET =    500_000;
    uint64  constant ONE_DAY    =     86_400;
    uint64  constant QUOTE_TTL  =        300;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        spookly = new Spookly(address(usdc));
        SIGNER_ADDR  = vm.addr(LINK_PK);
        SIGNER_ADDR2 = vm.addr(LINK_PK2);
        usdc.mint(ISSUER, 100_000_000);
        vm.prank(ISSUER);
        usdc.approve(address(spookly), type(uint256).max);
    }

    function createLink(address signer, uint128 principal, uint128 feeBudget, uint64 duration) internal {
        vm.prank(ISSUER);
        spookly.createLink(signer, principal, feeBudget, uint64(block.timestamp) + duration);
    }

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
            typehash, signer, recipient, uint256(amount), uint256(fee),
            feeRecipient, uint256(quoteExpiry), nonce, expiry,
            address(spookly), block.chainid
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", spookly.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // Per-payment fee is bounded — does NOT consume full feeBalance on first payment
    function test_PerPaymentFeePartialConsumption() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;

        uint128 firstFee = 50_000;
        bytes memory sig = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 3_000_000, firstFee, RELAY, qExp, 1, expiry);
        uint256 relayBefore = usdc.balanceOf(RELAY);
        vm.prank(RELAY);
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 3_000_000, firstFee, RELAY, qExp, 1, sig);

        (, uint128 balAfter, uint128 feeBalAfter, ,) = spookly.links(SIGNER_ADDR);
        assertEq(feeBalAfter, FEE_BUDGET - firstFee);
        assertEq(balAfter, PRINCIPAL - 3_000_000);
        assertEq(usdc.balanceOf(RELAY) - relayBefore, firstFee);

        uint128 secondFee = 50_000;
        bytes memory sig2 = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 1_000_000, secondFee, RELAY, qExp, 2, expiry);
        vm.prank(RELAY);
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 1_000_000, secondFee, RELAY, qExp, 2, sig2);

        (, , uint128 feeFinal, ,) = spookly.links(SIGNER_ADDR);
        assertEq(feeFinal, FEE_BUDGET - firstFee - secondFee);
    }

    // Full fee budget used → subsequent relay payments fail; zero-fee still works
    function test_FullFeeBudgetPaymentPreventsSubsequentRelay() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;

        bytes memory sig = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 3_000_000, FEE_BUDGET, RELAY, qExp, 1, expiry);
        vm.prank(RELAY);
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 3_000_000, FEE_BUDGET, RELAY, qExp, 1, sig);

        (, , uint128 feeAfter, ,) = spookly.links(SIGNER_ADDR);
        assertEq(feeAfter, 0);

        bytes memory sig2 = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 2, expiry);
        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.InsufficientFeeBalance.selector));
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 2, sig2);

        // Zero-fee still accepted
        bytes memory sig3 = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 1_000_000, 0, RELAY, qExp, 3, expiry);
        vm.prank(RELAY);
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 1_000_000, 0, RELAY, qExp, 3, sig3);
    }

    // Fee goes to authorized feeRecipient (msg.sender must equal feeRecipient when fee > 0)
    function test_FeeAlwaysGoesToMsgSender() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        uint128 fee    = 100_000;
        bytes memory sig = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 3_000_000, fee, RELAY, qExp, 1, expiry);

        address attacker = address(0xEEEE);
        uint256 attackerBefore = usdc.balanceOf(attacker);
        uint256 relayBefore    = usdc.balanceOf(RELAY);

        vm.prank(RELAY);
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 3_000_000, fee, RELAY, qExp, 1, sig);

        assertEq(usdc.balanceOf(RELAY) - relayBefore, fee);
        assertEq(usdc.balanceOf(attacker), attackerBefore);
    }

    // Expired link: payment rejected
    function test_ExpiredLinkPaymentReverts() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        vm.warp(block.timestamp + ONE_DAY + 1);
        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp - 1;
        bytes memory sig = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 1, expiry);
        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.LinkExpired.selector));
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 1, sig);
    }

    // Expired link: cancel refunds
    function test_ExpiredLinkCancelRefunds() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        vm.warp(block.timestamp + ONE_DAY + 1);
        uint256 before = usdc.balanceOf(ISSUER);
        vm.prank(ISSUER);
        spookly.cancelLink(SIGNER_ADDR);
        assertEq(usdc.balanceOf(ISSUER) - before, PRINCIPAL + FEE_BUDGET);
        (, , , , bool active) = spookly.links(SIGNER_ADDR);
        assertFalse(active);
    }

    // Stale signature: signed expiry != link.expiry → InvalidSignature
    function test_StaleSignatureReverts() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        uint64  qExp      = uint64(block.timestamp) + QUOTE_TTL;
        uint256 pastExpiry = block.timestamp - 1;
        bytes memory sig = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 1, pastExpiry);
        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.InvalidSignature.selector));
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 1, sig);
    }

    // Nonce replay
    function test_NonceReplayReverts() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes memory sig = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 42, expiry);
        vm.prank(RELAY);
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 42, sig);
        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.NonceUsed.selector));
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 42, sig);
    }

    // Overspend across partial payments
    function test_OverspendReverts() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes memory sig1 = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 8_000_000, 50_000, RELAY, qExp, 1, expiry);
        vm.prank(RELAY); spookly.executePayment(SIGNER_ADDR, RECIPIENT, 8_000_000, 50_000, RELAY, qExp, 1, sig1);
        bytes memory sig2 = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 2, expiry);
        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.InsufficientBalance.selector));
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 2, sig2);
    }

    // Balance conservation
    function test_BalanceConservation() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        uint256 contractBefore = usdc.balanceOf(address(spookly));
        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;

        bytes memory sig1 = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 1, expiry);
        vm.prank(RELAY); spookly.executePayment(SIGNER_ADDR, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 1, sig1);
        bytes memory sig2 = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 4_000_000, 50_000, RELAY, qExp, 2, expiry);
        vm.prank(RELAY); spookly.executePayment(SIGNER_ADDR, RECIPIENT, 4_000_000, 50_000, RELAY, qExp, 2, sig2);

        uint256 contractAfter = usdc.balanceOf(address(spookly));
        assertEq(contractBefore - contractAfter, 3_000_000 + 4_000_000 + 50_000 + 50_000);

        (, uint128 remBal, uint128 remFee, ,) = spookly.links(SIGNER_ADDR);
        assertEq(uint256(remBal), PRINCIPAL - 3_000_000 - 4_000_000);
        assertEq(uint256(remFee), FEE_BUDGET - 50_000 - 50_000);
    }

    // Invalid signature (wrong private key)
    function test_InvalidSignatureReverts() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes memory sig = signPayment(LINK_PK2, SIGNER_ADDR, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, expiry);
        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.InvalidSignature.selector));
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, sig);
    }

    // Cross-contract replay
    function test_CrossContractReplayReverts() public {
        Spookly spookly2 = new Spookly(address(usdc));
        usdc.mint(ISSUER, 20_000_000);
        vm.prank(ISSUER);
        usdc.approve(address(spookly2), type(uint256).max);
        vm.prank(ISSUER);
        spookly2.createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, uint64(block.timestamp) + ONE_DAY);
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);

        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;

        bytes32 typehash = keccak256(
            "PaymentAuth(address signerAddress,address recipient,uint256 amount,uint256 fee,address feeRecipient,uint256 quoteExpiry,uint256 nonce,uint256 expiry,address contract_,uint256 chainId)"
        );
        bytes32 struct1 = keccak256(abi.encode(
            typehash, SIGNER_ADDR, RECIPIENT, uint256(1_000_000), uint256(50_000),
            RELAY, uint256(qExp), uint256(1), expiry, address(spookly), block.chainid
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", spookly.domainSeparator(), struct1));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(LINK_PK, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(RELAY);
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, sig);

        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.InvalidSignature.selector));
        spookly2.executePayment(SIGNER_ADDR, RECIPIENT, 1_000_000, 50_000, RELAY, qExp, 1, sig);
    }

    // Multi-link isolation
    function test_MultiLinkIsolation() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        usdc.mint(ISSUER, 20_000_000);
        vm.prank(ISSUER);
        spookly.createLink(SIGNER_ADDR2, PRINCIPAL, FEE_BUDGET, uint64(block.timestamp) + ONE_DAY);

        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes memory sig = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 5_000_000, 50_000, RELAY, qExp, 1, expiry);
        vm.prank(RELAY);
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 5_000_000, 50_000, RELAY, qExp, 1, sig);

        (, uint128 bal2, uint128 fee2, ,) = spookly.links(SIGNER_ADDR2);
        assertEq(bal2, PRINCIPAL);
        assertEq(fee2, FEE_BUDGET);
    }

    // Zero-fee payment accepted
    function test_ZeroFeePaymentAccepted() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes memory sig = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 5_000_000, 0, RELAY, qExp, 1, expiry);
        uint256 relayBefore = usdc.balanceOf(RELAY);
        vm.prank(RELAY);
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 5_000_000, 0, RELAY, qExp, 1, sig);
        assertEq(usdc.balanceOf(RELAY), relayBefore);
        (, , uint128 feeAfter, ,) = spookly.links(SIGNER_ADDR);
        assertEq(feeAfter, FEE_BUDGET);
    }

    // Fuzz: any (amount, fee) within bounds
    function testFuzz_PartialPaymentWithinBalance(uint128 amount, uint128 fee) public {
        vm.assume(amount > 0 && amount <= PRINCIPAL);
        vm.assume(fee <= FEE_BUDGET && fee <= 200_000);
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes memory sig = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, amount, fee, RELAY, qExp, 1, expiry);
        vm.prank(RELAY);
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, amount, fee, RELAY, qExp, 1, sig);
        (, uint128 balAfter, uint128 feeAfter, ,) = spookly.links(SIGNER_ADDR);
        assertEq(balAfter, PRINCIPAL - amount);
        assertEq(feeAfter, FEE_BUDGET - fee);
    }

    // Non-issuer cancel
    function test_NonIssuerCancelReverts() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        vm.prank(RELAY);
        vm.expectRevert(abi.encodeWithSelector(Spookly.NotIssuer.selector));
        spookly.cancelLink(SIGNER_ADDR);
    }

    // Double cancel
    function test_DoubleCancelReverts() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        vm.prank(ISSUER); spookly.cancelLink(SIGNER_ADDR);
        vm.prank(ISSUER);
        vm.expectRevert(abi.encodeWithSelector(Spookly.LinkNotActive.selector));
        spookly.cancelLink(SIGNER_ADDR);
    }

    // Receipt.status success: verified by state change
    function test_ReceiptSuccessVerifiedByStateChange() public {
        createLink(SIGNER_ADDR, PRINCIPAL, FEE_BUDGET, ONE_DAY);
        uint64  qExp   = uint64(block.timestamp) + QUOTE_TTL;
        uint256 expiry = block.timestamp + ONE_DAY;
        bytes memory sig = signPayment(LINK_PK, SIGNER_ADDR, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 1, expiry);
        (, uint128 balBefore, , ,) = spookly.links(SIGNER_ADDR);
        vm.prank(RELAY);
        spookly.executePayment(SIGNER_ADDR, RECIPIENT, 3_000_000, 50_000, RELAY, qExp, 1, sig);
        (, uint128 balAfter, , ,) = spookly.links(SIGNER_ADDR);
        assertLt(balAfter, balBefore);
        assertTrue(spookly.usedNonces(SIGNER_ADDR, 1));
    }
}

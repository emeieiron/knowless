// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Spookly} from "../Spookly.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

// ---------------------------------------------------------------------------
// Reentrancy attack helpers
// ---------------------------------------------------------------------------

/// @dev A malicious ERC-20 that re-enters executePayment on transfer.
contract ReentrantToken is MockERC20 {
    Spookly public target;
    bytes public reentrantCall;
    bool public reentering;

    constructor() MockERC20("Reentrant", "RENT", 6) {}

    function setTarget(Spookly _target, bytes calldata _call) external {
        target = _target;
        reentrantCall = _call;
    }

    /// @dev Override transfer to re-enter on first call.
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (!reentering) {
            reentering = true;
            (bool ok,) = address(target).call(reentrantCall);
            require(!ok, "Reentrancy succeeded - guard missing");
            reentering = false;
        }
        return super.transfer(to, amount);
    }
}

// ---------------------------------------------------------------------------
// Main test contract
// ---------------------------------------------------------------------------

contract SpooklyTest is Test {
    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint256 internal constant SIGNER_PK   = 0xA11CE;
    uint256 internal constant SIGNER_PK_2 = 0xB0B;
    uint256 internal constant WRONG_PK    = 0xDEAD;

    uint128 internal constant PRINCIPAL  = 1_000e6;
    uint128 internal constant FEE_BUDGET =    10e6;
    uint64  internal constant EXPIRY_OFFSET = 1 days;
    uint64  internal constant QUOTE_TTL     = 300;  // 5 minutes

    // v2 typehash — includes feeRecipient and quoteExpiry
    bytes32 internal constant PAYMENT_AUTH_TYPEHASH =
        keccak256(
            "PaymentAuth(address signerAddress,address recipient,uint256 amount,uint256 fee,address feeRecipient,uint256 quoteExpiry,uint256 nonce,uint256 expiry,address contract_,uint256 chainId)"
        );
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    Spookly   internal spookly;
    MockERC20 internal usdc;

    address internal issuer   = makeAddr("issuer");
    address internal alice    = makeAddr("alice");
    address internal relayer  = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    address internal signerAddr;
    address internal signerAddr2;
    uint64  internal expiry;
    uint64  internal qExp;  // quote expiry (block.timestamp + QUOTE_TTL)

    // -----------------------------------------------------------------------
    // Setup
    // -----------------------------------------------------------------------

    function setUp() public {
        signerAddr  = vm.addr(SIGNER_PK);
        signerAddr2 = vm.addr(SIGNER_PK_2);
        expiry = uint64(block.timestamp + EXPIRY_OFFSET);
        qExp   = uint64(block.timestamp + QUOTE_TTL);

        usdc    = new MockERC20("Mock USDC", "mUSDC", 6);
        spookly = new Spookly(address(usdc));

        usdc.mint(issuer, 100_000e6);
        vm.prank(issuer);
        usdc.approve(address(spookly), type(uint256).max);
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    function _buildDigest(
        address _signer,
        address _recipient,
        uint128 _amount,
        uint128 _fee,
        address _feeRecipient,
        uint64  _quoteExpiry,
        uint256 _nonce,
        uint64  _expiry,
        address _contract,
        uint256 _chainId
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            PAYMENT_AUTH_TYPEHASH,
            _signer,
            _recipient,
            uint256(_amount),
            uint256(_fee),
            _feeRecipient,
            uint256(_quoteExpiry),
            _nonce,
            uint256(_expiry),
            _contract,
            _chainId
        ));
        return keccak256(abi.encodePacked("\x19\x01", spookly.domainSeparator(), structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _createDefaultLink() internal {
        vm.prank(issuer);
        spookly.createLink(signerAddr, PRINCIPAL, FEE_BUDGET, expiry);
    }

    /// Build a valid sig with relayer as feeRecipient and qExp as quoteExpiry.
    function _validSig(address recipient, uint128 amount, uint128 fee, uint256 nonce)
        internal view returns (bytes memory)
    {
        bytes32 digest = _buildDigest(
            signerAddr, recipient, amount, fee,
            relayer, qExp, nonce, expiry, address(spookly), block.chainid
        );
        return _sign(SIGNER_PK, digest);
    }

    // =======================================================================
    // 1. DEPLOYMENT & INITIALIZATION
    // =======================================================================

    function test_Constructor_StoresUSDC() public view {
        assertEq(address(spookly.usdc()), address(usdc));
    }

    function test_Constructor_RevertsOnZeroUSDC() public {
        vm.expectRevert("Zero USDC address");
        new Spookly(address(0));
    }

    // =======================================================================
    // 2. createLink – happy path
    // =======================================================================

    function test_CreateLink_HappyPath() public {
        vm.expectEmit(true, true, false, true, address(spookly));
        emit Spookly.LinkCreated(signerAddr, issuer, PRINCIPAL, FEE_BUDGET, expiry);
        vm.prank(issuer);
        spookly.createLink(signerAddr, PRINCIPAL, FEE_BUDGET, expiry);
        assertEq(usdc.balanceOf(address(spookly)), PRINCIPAL + FEE_BUDGET);
        assertEq(usdc.balanceOf(issuer), 100_000e6 - PRINCIPAL - FEE_BUDGET);
    }

    function test_CreateLink_LinkStoredCorrectly() public {
        _createDefaultLink();
        Spookly.Link memory link = spookly.getLinkInfo(signerAddr);
        assertEq(link.issuer, issuer);
        assertEq(link.balance, PRINCIPAL);
        assertEq(link.feeBalance, FEE_BUDGET);
        assertEq(link.expiry, expiry);
        assertTrue(link.active);
    }

    function test_CreateLink_RevertsZeroSignerAddress() public {
        vm.prank(issuer);
        vm.expectRevert(Spookly.ZeroSignerAddress.selector);
        spookly.createLink(address(0), PRINCIPAL, FEE_BUDGET, expiry);
    }

    function test_CreateLink_RevertsZeroAmount() public {
        vm.prank(issuer);
        vm.expectRevert(Spookly.ZeroAmount.selector);
        spookly.createLink(signerAddr, 0, FEE_BUDGET, expiry);
    }

    function test_CreateLink_RevertsExpiryInPast() public {
        vm.prank(issuer);
        vm.expectRevert(Spookly.ExpiryInPast.selector);
        spookly.createLink(signerAddr, PRINCIPAL, FEE_BUDGET, uint64(block.timestamp));
    }

    function test_CreateLink_RevertsExpiryInPast_PastTimestamp() public {
        vm.prank(issuer);
        vm.expectRevert(Spookly.ExpiryInPast.selector);
        spookly.createLink(signerAddr, PRINCIPAL, FEE_BUDGET, uint64(block.timestamp - 1));
    }

    function test_CreateLink_RevertsSignerAlreadyRegistered() public {
        _createDefaultLink();
        vm.prank(issuer);
        vm.expectRevert(Spookly.SignerAlreadyRegistered.selector);
        spookly.createLink(signerAddr, PRINCIPAL, FEE_BUDGET, expiry);
    }

    function test_CreateLink_ZeroFeebudgetAllowed() public {
        vm.prank(issuer);
        spookly.createLink(signerAddr, PRINCIPAL, 0, expiry);
        assertEq(spookly.getLinkInfo(signerAddr).feeBalance, 0);
    }

    // =======================================================================
    // 3. getLinkInfo
    // =======================================================================

    function test_GetLinkInfo_UnregisteredReturnsZero() public {
        Spookly.Link memory link = spookly.getLinkInfo(makeAddr("nobody"));
        assertEq(link.issuer, address(0));
        assertEq(link.balance, 0);
        assertFalse(link.active);
    }

    // =======================================================================
    // 4. domainSeparator
    // =======================================================================

    function test_DomainSeparator_MatchesExpected() public view {
        bytes32 expected = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256("Spookly"),
            keccak256("1"),
            block.chainid,
            address(spookly)
        ));
        assertEq(spookly.domainSeparator(), expected);
    }

    // =======================================================================
    // 5. executePayment – happy path
    // =======================================================================

    function test_ExecutePayment_HappyPath() public {
        _createDefaultLink();
        uint128 amount = 100e6;
        uint128 fee    = 1e6;
        uint256 nonce  = 1;
        bytes memory sig = _validSig(alice, amount, fee, nonce);

        vm.expectEmit(true, true, false, true, address(spookly));
        emit Spookly.PaymentExecuted(signerAddr, alice, amount, fee, relayer, nonce);

        vm.prank(relayer);
        spookly.executePayment(signerAddr, alice, amount, fee, relayer, qExp, nonce, sig);

        assertEq(usdc.balanceOf(alice),   amount);
        assertEq(usdc.balanceOf(relayer), fee);
        Spookly.Link memory link = spookly.getLinkInfo(signerAddr);
        assertEq(link.balance,    PRINCIPAL  - amount);
        assertEq(link.feeBalance, FEE_BUDGET - fee);
        assertTrue(spookly.usedNonces(signerAddr, nonce));
    }

    function test_ExecutePayment_ZeroFeeAllowed() public {
        _createDefaultLink();
        bytes memory sig = _validSig(alice, 50e6, 0, 42);
        vm.prank(relayer);
        spookly.executePayment(signerAddr, alice, 50e6, 0, relayer, qExp, 42, sig);
        assertEq(usdc.balanceOf(alice), 50e6);
        assertEq(usdc.balanceOf(relayer), 0);
    }

    // =======================================================================
    // 6. Partial spend
    // =======================================================================

    function test_PartialSpend_BalanceDecrementsCorrectly() public {
        _createDefaultLink();
        { bytes memory s = _validSig(alice, 300e6, 2e6, 1); vm.prank(relayer); spookly.executePayment(signerAddr, alice, 300e6, 2e6, relayer, qExp, 1, s); }
        { bytes memory s = _validSig(alice, 200e6, 3e6, 2); vm.prank(relayer); spookly.executePayment(signerAddr, alice, 200e6, 3e6, relayer, qExp, 2, s); }
        { bytes memory s = _validSig(alice, 400e6, 4e6, 3); vm.prank(relayer); spookly.executePayment(signerAddr, alice, 400e6, 4e6, relayer, qExp, 3, s); }
        Spookly.Link memory link = spookly.getLinkInfo(signerAddr);
        assertEq(link.balance,    PRINCIPAL  - 300e6 - 200e6 - 400e6);
        assertEq(link.feeBalance, FEE_BUDGET - 2e6 - 3e6 - 4e6);
        assertEq(usdc.balanceOf(alice),   900e6);
        assertEq(usdc.balanceOf(relayer), 9e6);
    }

    // =======================================================================
    // 7. Expiry
    // =======================================================================

    function test_Expiry_PaymentFailsAfterExpiry() public {
        _createDefaultLink();
        vm.warp(expiry + 1);
        bytes memory sig = _validSig(alice, 100e6, 1e6, 1);
        // qExp also needs to be valid — refresh it
        qExp = uint64(block.timestamp + QUOTE_TTL);
        bytes32 digest = _buildDigest(signerAddr, alice, 100e6, 1e6, relayer, qExp, 1, expiry, address(spookly), block.chainid);
        bytes memory sig2 = _sign(SIGNER_PK, digest);
        vm.prank(relayer);
        vm.expectRevert(Spookly.LinkExpired.selector);
        spookly.executePayment(signerAddr, alice, 100e6, 1e6, relayer, qExp, 1, sig2);
    }

    function test_Expiry_CancelSucceedsAfterExpiry() public {
        _createDefaultLink();
        vm.warp(expiry + 1);
        uint256 before = usdc.balanceOf(issuer);
        vm.prank(issuer);
        spookly.cancelLink(signerAddr);
        assertEq(usdc.balanceOf(issuer), before + PRINCIPAL + FEE_BUDGET);
    }

    function test_Expiry_PaymentAtExactExpiryTimestamp_Succeeds() public {
        _createDefaultLink();
        vm.warp(expiry);
        // qExp must be in the future
        qExp = uint64(block.timestamp + QUOTE_TTL);
        bytes32 digest = _buildDigest(signerAddr, alice, 100e6, 1e6, relayer, qExp, 1, expiry, address(spookly), block.chainid);
        bytes memory sig = _sign(SIGNER_PK, digest);
        vm.prank(relayer);
        spookly.executePayment(signerAddr, alice, 100e6, 1e6, relayer, qExp, 1, sig);
        assertEq(usdc.balanceOf(alice), 100e6);
    }

    // =======================================================================
    // 8. Replay prevention
    // =======================================================================

    function test_Replay_SameNonceFails() public {
        _createDefaultLink();
        bytes memory sig = _validSig(alice, 100e6, 1e6, 99);
        vm.prank(relayer);
        spookly.executePayment(signerAddr, alice, 100e6, 1e6, relayer, qExp, 99, sig);
        vm.prank(relayer);
        vm.expectRevert(Spookly.NonceUsed.selector);
        spookly.executePayment(signerAddr, alice, 100e6, 1e6, relayer, qExp, 99, sig);
    }

    function test_Replay_DifferentNonceSucceeds() public {
        _createDefaultLink();
        bytes memory sig1 = _validSig(alice, 100e6, 1e6, 1);
        bytes memory sig2 = _validSig(alice, 100e6, 1e6, 2);
        vm.prank(relayer); spookly.executePayment(signerAddr, alice, 100e6, 1e6, relayer, qExp, 1, sig1);
        vm.prank(relayer); spookly.executePayment(signerAddr, alice, 100e6, 1e6, relayer, qExp, 2, sig2);
        assertEq(usdc.balanceOf(alice), 200e6);
    }

    // =======================================================================
    // 9. Wrong signer
    // =======================================================================

    function test_WrongSigner_RevertsInvalidSignature() public {
        _createDefaultLink();
        bytes32 digest = _buildDigest(signerAddr, alice, 100e6, 1e6, relayer, qExp, 1, expiry, address(spookly), block.chainid);
        bytes memory badSig = _sign(WRONG_PK, digest);
        vm.prank(relayer);
        vm.expectRevert(Spookly.InvalidSignature.selector);
        spookly.executePayment(signerAddr, alice, 100e6, 1e6, relayer, qExp, 1, badSig);
    }

    // =======================================================================
    // 10. Edge cases
    // =======================================================================

    function test_ExecutePayment_RevertsZeroAmount() public {
        _createDefaultLink();
        bytes memory sig = _validSig(alice, 0, 0, 1);
        vm.prank(relayer);
        vm.expectRevert(Spookly.ZeroAmount.selector);
        spookly.executePayment(signerAddr, alice, 0, 0, relayer, qExp, 1, sig);
    }

    function test_ExecutePayment_RevertsZeroRecipient() public {
        _createDefaultLink();
        bytes32 digest = _buildDigest(signerAddr, address(0), 100e6, 1e6, relayer, qExp, 1, expiry, address(spookly), block.chainid);
        bytes memory sig = _sign(SIGNER_PK, digest);
        vm.prank(relayer);
        vm.expectRevert(Spookly.ZeroRecipient.selector);
        spookly.executePayment(signerAddr, address(0), 100e6, 1e6, relayer, qExp, 1, sig);
    }

    function test_ExecutePayment_RevertsSelfRecipient() public {
        _createDefaultLink();
        bytes32 digest = _buildDigest(signerAddr, address(spookly), 100e6, 1e6, relayer, qExp, 1, expiry, address(spookly), block.chainid);
        bytes memory sig = _sign(SIGNER_PK, digest);
        vm.prank(relayer);
        vm.expectRevert(Spookly.SelfRecipient.selector);
        spookly.executePayment(signerAddr, address(spookly), 100e6, 1e6, relayer, qExp, 1, sig);
    }

    function test_ExecutePayment_RevertsZeroSignerAddress_LinkNotActive() public {
        bytes memory sig = _validSig(alice, 100e6, 1e6, 1);
        vm.prank(relayer);
        vm.expectRevert(Spookly.LinkNotActive.selector);
        spookly.executePayment(address(0), alice, 100e6, 1e6, relayer, qExp, 1, sig);
    }

    // =======================================================================
    // 11. Fee accounting
    // =======================================================================

    function test_FeeAccounting_FeeGoesToCaller() public {
        _createDefaultLink();
        uint128 fee = 5e6;
        bytes memory sig = _validSig(alice, 100e6, fee, 1);
        uint256 before = usdc.balanceOf(relayer);
        vm.prank(relayer);
        spookly.executePayment(signerAddr, alice, 100e6, fee, relayer, qExp, 1, sig);
        assertEq(usdc.balanceOf(relayer), before + fee);
    }

    function test_FeeAccounting_FeeDeductedFromFeeBalance() public {
        _createDefaultLink();
        uint128 fee = 3e6;
        bytes memory sig = _validSig(alice, 100e6, fee, 1);
        vm.prank(relayer);
        spookly.executePayment(signerAddr, alice, 100e6, fee, relayer, qExp, 1, sig);
        assertEq(spookly.getLinkInfo(signerAddr).feeBalance, FEE_BUDGET - fee);
    }

    // =======================================================================
    // 12. cancelLink
    // =======================================================================

    function test_CancelLink_ReclainsBalanceAndFeeBalance() public {
        _createDefaultLink();
        uint256 before = usdc.balanceOf(issuer);
        vm.expectEmit(true, true, false, true, address(spookly));
        emit Spookly.LinkCancelled(signerAddr, issuer, PRINCIPAL + FEE_BUDGET);
        vm.prank(issuer);
        spookly.cancelLink(signerAddr);
        assertEq(usdc.balanceOf(issuer), before + PRINCIPAL + FEE_BUDGET);
        assertEq(usdc.balanceOf(address(spookly)), 0);
    }

    function test_CancelLink_LinkInactiveAfter() public {
        _createDefaultLink();
        vm.prank(issuer);
        spookly.cancelLink(signerAddr);
        Spookly.Link memory link = spookly.getLinkInfo(signerAddr);
        assertFalse(link.active);
        assertEq(link.balance,    0);
        assertEq(link.feeBalance, 0);
    }

    function test_CancelLink_PartialRefundAfterSpend() public {
        _createDefaultLink();
        bytes memory sig = _validSig(alice, 100e6, 2e6, 1);
        vm.prank(relayer);
        spookly.executePayment(signerAddr, alice, 100e6, 2e6, relayer, qExp, 1, sig);
        uint256 before = usdc.balanceOf(issuer);
        vm.prank(issuer);
        spookly.cancelLink(signerAddr);
        assertEq(usdc.balanceOf(issuer), before + (PRINCIPAL - 100e6) + (FEE_BUDGET - 2e6));
    }

    // =======================================================================
    // 13. Double cancel
    // =======================================================================

    function test_DoubleCancel_SecondReverts() public {
        _createDefaultLink();
        vm.prank(issuer); spookly.cancelLink(signerAddr);
        vm.prank(issuer);
        vm.expectRevert(Spookly.LinkNotActive.selector);
        spookly.cancelLink(signerAddr);
    }

    // =======================================================================
    // 14. cancelLink – not issuer
    // =======================================================================

    function test_CancelLink_RevertsNotIssuer() public {
        _createDefaultLink();
        vm.prank(stranger);
        vm.expectRevert(Spookly.NotIssuer.selector);
        spookly.cancelLink(signerAddr);
    }

    // =======================================================================
    // 15. Overspend / over-fee-budget
    // =======================================================================

    function test_Overspend_RevertsInsufficientBalance() public {
        _createDefaultLink();
        uint128 tooMuch = PRINCIPAL + 1;
        bytes memory sig = _validSig(alice, tooMuch, 0, 1);
        vm.prank(relayer);
        vm.expectRevert(Spookly.InsufficientBalance.selector);
        spookly.executePayment(signerAddr, alice, tooMuch, 0, relayer, qExp, 1, sig);
    }

    function test_OverFeeBudget_RevertsInsufficientFeeBalance() public {
        _createDefaultLink();
        uint128 bigFee = FEE_BUDGET + 1;
        bytes memory sig = _validSig(alice, 100e6, bigFee, 1);
        vm.prank(relayer);
        vm.expectRevert(Spookly.InsufficientFeeBalance.selector);
        spookly.executePayment(signerAddr, alice, 100e6, bigFee, relayer, qExp, 1, sig);
    }

    // =======================================================================
    // 16. Reentrancy protection
    // =======================================================================

    function test_Reentrancy_ExecutePaymentIsGuarded() public {
        ReentrantToken rToken = new ReentrantToken();
        Spookly rSpookly = new Spookly(address(rToken));
        rToken.mint(issuer, 100_000e6);
        vm.prank(issuer);
        rToken.approve(address(rSpookly), type(uint256).max);
        uint64 rExpiry = uint64(block.timestamp + 1 days);
        uint64 rQExp   = uint64(block.timestamp + QUOTE_TTL);
        vm.prank(issuer);
        rSpookly.createLink(signerAddr, PRINCIPAL, FEE_BUDGET, rExpiry);

        // Build reentrant call (second executePayment with nonce=2)
        bytes32 struct2 = keccak256(abi.encode(
            PAYMENT_AUTH_TYPEHASH,
            signerAddr, alice, uint256(50e6), uint256(0), relayer,
            uint256(rQExp), uint256(2), uint256(rExpiry), address(rSpookly), block.chainid
        ));
        bytes32 dig2 = keccak256(abi.encodePacked("\x19\x01", rSpookly.domainSeparator(), struct2));
        bytes memory sig2 = _sign(SIGNER_PK, dig2);
        bytes memory payload = abi.encodeCall(
            rSpookly.executePayment, (signerAddr, alice, 50e6, 0, relayer, rQExp, 2, sig2)
        );
        rToken.setTarget(rSpookly, payload);

        bytes32 struct1 = keccak256(abi.encode(
            PAYMENT_AUTH_TYPEHASH,
            signerAddr, alice, uint256(50e6), uint256(0), relayer,
            uint256(rQExp), uint256(1), uint256(rExpiry), address(rSpookly), block.chainid
        ));
        bytes32 dig1 = keccak256(abi.encodePacked("\x19\x01", rSpookly.domainSeparator(), struct1));
        bytes memory sig1 = _sign(SIGNER_PK, dig1);

        vm.prank(relayer);
        rSpookly.executePayment(signerAddr, alice, 50e6, 0, relayer, rQExp, 1, sig1);
        assertEq(rToken.balanceOf(alice), 50e6);
    }

    // =======================================================================
    // 17. Isolation
    // =======================================================================

    function test_Isolation_TwoLinksIndependent() public {
        vm.prank(issuer);
        spookly.createLink(signerAddr, PRINCIPAL, FEE_BUDGET, expiry);
        address issuer2 = makeAddr("issuer2");
        usdc.mint(issuer2, 100_000e6);
        vm.prank(issuer2);
        usdc.approve(address(spookly), type(uint256).max);
        vm.prank(issuer2);
        spookly.createLink(signerAddr2, PRINCIPAL, FEE_BUDGET, expiry);

        bytes memory sig1 = _validSig(alice, 200e6, 2e6, 1);
        vm.prank(relayer);
        spookly.executePayment(signerAddr, alice, 200e6, 2e6, relayer, qExp, 1, sig1);

        Spookly.Link memory l2 = spookly.getLinkInfo(signerAddr2);
        assertEq(l2.balance,    PRINCIPAL);
        assertEq(l2.feeBalance, FEE_BUDGET);

        bytes32 d2 = _buildDigest(signerAddr2, alice, 300e6, 3e6, relayer, qExp, 1, expiry, address(spookly), block.chainid);
        bytes memory sig2 = _sign(SIGNER_PK_2, d2);
        vm.prank(relayer);
        spookly.executePayment(signerAddr2, alice, 300e6, 3e6, relayer, qExp, 1, sig2);

        assertEq(spookly.getLinkInfo(signerAddr2).balance, PRINCIPAL - 300e6);
    }

    // =======================================================================
    // 18. Arc unit conversion
    // =======================================================================

    function test_ArcUnits_SixDecimalPrecision() public {
        vm.prank(issuer);
        spookly.createLink(signerAddr, 1e6, 0, expiry);
        bytes memory sig = _validSig(alice, 1e6, 0, 1);
        vm.prank(relayer);
        spookly.executePayment(signerAddr, alice, 1e6, 0, relayer, qExp, 1, sig);
        assertEq(usdc.balanceOf(alice), 1e6);
        assertEq(usdc.decimals(), 6);
    }

    function test_ArcUnits_SubCentPrecision() public {
        vm.prank(issuer);
        spookly.createLink(signerAddr, 1, 0, expiry);
        bytes memory sig = _validSig(alice, 1, 0, 1);
        vm.prank(relayer);
        spookly.executePayment(signerAddr, alice, 1, 0, relayer, qExp, 1, sig);
        assertEq(usdc.balanceOf(alice), 1);
    }

    // =======================================================================
    // 19. receive() reverts
    // =======================================================================

    function test_Receive_NativeValueReverts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok, bytes memory data) = address(spookly).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(data, abi.encodeWithSignature("Error(string)", "No native value"));
    }

    function test_Receive_ZeroValueReverts() public {
        vm.prank(alice);
        (bool ok,) = address(spookly).call{value: 0}("");
        assertFalse(ok);
    }

    // =======================================================================
    // 20. Cross-chain / cross-contract replay
    // =======================================================================

    function test_CrossChain_WrongChainIdFails() public {
        _createDefaultLink();
        uint256 wrongChain = block.chainid + 1;
        bytes32 digest = _buildDigest(signerAddr, alice, 100e6, 1e6, relayer, qExp, 1, expiry, address(spookly), wrongChain);
        bytes memory sig = _sign(SIGNER_PK, digest);
        vm.prank(relayer);
        vm.expectRevert(Spookly.InvalidSignature.selector);
        spookly.executePayment(signerAddr, alice, 100e6, 1e6, relayer, qExp, 1, sig);
    }

    function test_CrossContract_WrongContractAddressFails() public {
        _createDefaultLink();
        address wrongContract = makeAddr("wrong");
        bytes32 digest = _buildDigest(signerAddr, alice, 100e6, 1e6, relayer, qExp, 1, expiry, wrongContract, block.chainid);
        bytes memory sig = _sign(SIGNER_PK, digest);
        vm.prank(relayer);
        vm.expectRevert(Spookly.InvalidSignature.selector);
        spookly.executePayment(signerAddr, alice, 100e6, 1e6, relayer, qExp, 1, sig);
    }

    function test_CrossChain_TamperedAmountFails() public {
        _createDefaultLink();
        bytes32 digest = _buildDigest(signerAddr, alice, 100e6, 1e6, relayer, qExp, 1, expiry, address(spookly), block.chainid);
        bytes memory sig = _sign(SIGNER_PK, digest);
        vm.prank(relayer);
        vm.expectRevert(Spookly.InvalidSignature.selector);
        spookly.executePayment(signerAddr, alice, 200e6, 1e6, relayer, qExp, 1, sig);
    }

    // =======================================================================
    // 21. Fuzz
    // =======================================================================

    function testFuzz_ExecutePayment_AmountAndFee(uint128 fuzzAmount, uint128 fuzzFee, uint256 fuzzNonce) public {
        fuzzAmount = uint128(bound(fuzzAmount, 1, PRINCIPAL));
        fuzzFee    = uint128(bound(fuzzFee, 0, FEE_BUDGET));
        _createDefaultLink();
        bytes32 digest = _buildDigest(signerAddr, alice, fuzzAmount, fuzzFee, relayer, qExp, fuzzNonce, expiry, address(spookly), block.chainid);
        bytes memory sig = _sign(SIGNER_PK, digest);
        vm.prank(relayer);
        spookly.executePayment(signerAddr, alice, fuzzAmount, fuzzFee, relayer, qExp, fuzzNonce, sig);
        assertEq(usdc.balanceOf(alice),   fuzzAmount);
        assertEq(usdc.balanceOf(relayer), fuzzFee);
    }

    function testFuzz_CreateLink_ExpiryMustBeFuture(uint64 fuzzExpiry) public {
        if (fuzzExpiry <= block.timestamp) {
            vm.prank(issuer);
            vm.expectRevert(Spookly.ExpiryInPast.selector);
            spookly.createLink(signerAddr, PRINCIPAL, FEE_BUDGET, fuzzExpiry);
        } else {
            vm.prank(issuer);
            spookly.createLink(signerAddr, PRINCIPAL, FEE_BUDGET, fuzzExpiry);
            assertTrue(spookly.getLinkInfo(signerAddr).active);
        }
    }

    function testFuzz_Overspend_AlwaysReverts(uint128 excess) public {
        excess = uint128(bound(excess, 1, type(uint128).max - PRINCIPAL));
        _createDefaultLink();
        uint128 tooMuch = PRINCIPAL + excess;
        bytes memory sig = _validSig(alice, tooMuch, 0, 1);
        vm.prank(relayer);
        vm.expectRevert(Spookly.InsufficientBalance.selector);
        spookly.executePayment(signerAddr, alice, tooMuch, 0, relayer, qExp, 1, sig);
    }

    // =======================================================================
    // 22. executePayment on inactive link
    // =======================================================================

    function test_ExecutePayment_RevertsOnInactiveLink() public {
        _createDefaultLink();
        vm.prank(issuer);
        spookly.cancelLink(signerAddr);
        bytes memory sig = _validSig(alice, 100e6, 1e6, 1);
        vm.prank(relayer);
        vm.expectRevert(Spookly.LinkNotActive.selector);
        spookly.executePayment(signerAddr, alice, 100e6, 1e6, relayer, qExp, 1, sig);
    }

    // =======================================================================
    // 23. Invariant – contract balance conservation
    // =======================================================================

    function test_Invariant_ContractBalanceConservation() public {
        address issuer2 = makeAddr("issuer2b");
        usdc.mint(issuer2, 100_000e6);
        vm.prank(issuer2);
        usdc.approve(address(spookly), type(uint256).max);
        vm.prank(issuer);
        spookly.createLink(signerAddr, PRINCIPAL, FEE_BUDGET, expiry);
        vm.prank(issuer2);
        spookly.createLink(signerAddr2, 500e6, 5e6, expiry);

        bytes memory sig1 = _validSig(alice, 200e6, 2e6, 1);
        vm.prank(relayer);
        spookly.executePayment(signerAddr, alice, 200e6, 2e6, relayer, qExp, 1, sig1);

        Spookly.Link memory l1 = spookly.getLinkInfo(signerAddr);
        Spookly.Link memory l2 = spookly.getLinkInfo(signerAddr2);
        uint256 sumOfLinks = uint256(l1.balance) + uint256(l1.feeBalance) + uint256(l2.balance) + uint256(l2.feeBalance);
        assertEq(usdc.balanceOf(address(spookly)), sumOfLinks);
    }
}

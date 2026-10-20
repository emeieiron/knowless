/** Parser/formatter pipeline tests for QR scan→review amount prefill. No DOM, camera, or browser coverage. */

// oxlint-disable no-floating-promises, no-unsafe-assignment, no-unsafe-member-access

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePaymentRequest } from '../lib/parsePaymentRequest.js'
import { formatUnits } from 'viem'
import { ARC_TESTNET_USDC } from '../lib/contract.js'

// These tests exercise the pure parsing and amount-formatting pipeline
// that feeds the PayScreen review state, without mounting the full component
// (which requires wagmi/ConnectKit providers and camera APIs).
// The mounted scan→review flow is: QrScanner.onScan(text) → parsePaymentRequest(text)
// → formatUnits(result.amountUsdc, 6) → setAmountStr.
// We test that pipeline directly with the production functions.

const CHAIN = 5042002
const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

void describe('scan→review parser/formatter pipeline (no DOM mount)', () => {
  void it('QR1: uint256=123456 → amountStr 0.123456 (not 0.12)', () => {
    const qr = `ethereum:${ARC_TESTNET_USDC}@${CHAIN}/transfer?address=${RECIPIENT}&uint256=123456`
    const result = parsePaymentRequest(qr)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.amountUsdc, 123456n)
    // Simulate what PayScreen does: formatUnits(amountUsdc, 6)
    const amountStr = formatUnits(result.amountUsdc, 6)
    assert.equal(amountStr, '0.123456')
  })

  void it('QR2: uint256=1 → amountStr 0.000001 (one base unit)', () => {
    const qr = `ethereum:${ARC_TESTNET_USDC}@${CHAIN}/transfer?address=${RECIPIENT}&uint256=1`
    const result = parsePaymentRequest(qr)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.amountUsdc, 1n)
    const amountStr = formatUnits(result.amountUsdc, 6)
    assert.equal(amountStr, '0.000001')
  })

  void it('QR3: 2.5e6 → amountStr 2.5 USDC', () => {
    const qr = `ethereum:${ARC_TESTNET_USDC}@${CHAIN}/transfer?address=${RECIPIENT}&uint256=2.5e6`
    const result = parsePaymentRequest(qr)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.amountUsdc, 2500000n)
    const amountStr = formatUnits(result.amountUsdc, 6)
    assert.equal(amountStr, '2.5')
  })

  void it('QR4: bad QR → ok:false, no amount produced', () => {
    const result = parsePaymentRequest('https://example.com/pay?amount=1')
    assert.equal(result.ok, false)
  })

  void it('QR5: scan callback returns true (accepted) only on valid QR, false on invalid', () => {
    // Simulate QrScanner.onScan returning false for invalid, true for valid
    let lastMode = 'scan'
    const makeScanCallback = () => (text: string): boolean => {
      const result = parsePaymentRequest(text)
      if (!result.ok) return false   // keep scanning
      lastMode = 'review'
      return true
    }
    const onScan = makeScanCallback()
    // Invalid QR — keep scanning
    const r1 = onScan('not-a-qr')
    assert.equal(r1, false)
    assert.equal(lastMode, 'scan')
    // Valid QR — transition to review, no submission
    const validQr = `ethereum:${ARC_TESTNET_USDC}@${CHAIN}/transfer?address=${RECIPIENT}&uint256=1000000`
    const r2 = onScan(validQr)
    assert.equal(r2, true)
    assert.equal(lastMode, 'review')
  })
})

// These are explicitly the limits of this test file.
// Full mounted PayScreen testing (with wagmi/ConnectKit/camera) requires a browser.
// No payment submission occurs here — the Pay button is never clicked.

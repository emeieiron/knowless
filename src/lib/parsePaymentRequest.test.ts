/**
 * parsePaymentRequest — focused parser tests.
 *
 * Cases:
 *   PR1  Raw 0x address — accepted, checksummed
 *   PR2  Raw address with whitespace — trimmed and accepted
 *   PR3  Arc token QR — ethereum:<token>[@5042002]/transfer?address=<recipient>&uint256=<amount>
 *   PR4  Arc token QR exact amount — 6-decimal USDC base units round-trip
 *   PR5  Wrong chain in EIP-681 — rejected
 *   PR6  Wrong token contract — rejected
 *   PR7  USDC contract as recipient — rejected
 *   PR8  Malformed/hostile payload — generic reject, no panic
 *   PR9  ethereum:<address> direct — accepted
 *   PR10 ethereum:pay-<address>@5042002 — accepted
 *   PR11 Scientific notation uint256 — correct bigint
 *   PR12 Float uint256 — rejected (not integral)
 *   PR13 Unsupported function name — rejected
 *   PR14 Oversize input — rejected
 *   PR15 Exponent overflow — rejected
 */

// oxlint-disable no-floating-promises, no-unsafe-assignment, no-unsafe-member-access
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePaymentRequest } from './parsePaymentRequest.js'
import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC } from './contract.js'

// Known checksummed addresses (unfunded, deterministic)
const ADDR_A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const ADDR_B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const USDC   = ARC_TESTNET_USDC                     // 0x360000...
const CHAIN  = ARC_TESTNET_CHAIN_ID                  // 5042002

describe('parsePaymentRequest', () => {
  it('PR1: raw 0x address — accepted and checksummed', () => {
    const r = parsePaymentRequest(ADDR_A)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.recipient, ADDR_A)
    assert.equal(r.amountUsdc, undefined)
  })

  it('PR2: raw address with leading/trailing whitespace — trimmed', () => {
    const r = parsePaymentRequest(`  ${ADDR_A}  `)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.recipient, ADDR_A)
  })

  it('PR3: ethereum:<recipient> direct — accepted', () => {
    const r = parsePaymentRequest(`ethereum:${ADDR_A}`)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.recipient, ADDR_A)
    assert.equal(r.amountUsdc, undefined)
  })

  it('PR4: ethereum:pay-<recipient>@<chainId> — accepted', () => {
    const r = parsePaymentRequest(`ethereum:pay-${ADDR_A}@${CHAIN}`)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.recipient, ADDR_A)
  })

  it('PR5: USDC transfer QR — exact 6-decimal amount', () => {
    // 1.500000 USDC = 1_500_000 base units
    const r = parsePaymentRequest(
      `ethereum:${USDC}@${CHAIN}/transfer?address=${ADDR_B}&uint256=1500000`
    )
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.recipient, ADDR_B)
    assert.equal(r.amountUsdc, 1_500_000n)
  })

  it('PR6: USDC transfer QR without @chainId — accepted (chain not specified)', () => {
    const r = parsePaymentRequest(
      `ethereum:${USDC}/transfer?address=${ADDR_B}&uint256=500000`
    )
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.recipient, ADDR_B)
    assert.equal(r.amountUsdc, 500_000n)
  })

  it('PR7: wrong chain — rejected with chain mention', () => {
    const r = parsePaymentRequest(`ethereum:${ADDR_A}@1`)
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /chain/i)
  })

  it('PR8: wrong token contract in /transfer — rejected', () => {
    // Use a non-USDC token address
    const wrongToken = ADDR_A
    const r = parsePaymentRequest(
      `ethereum:${wrongToken}/transfer?address=${ADDR_B}&uint256=1000000`
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /token|USDC/i)
  })

  it('PR9: USDC contract as recipient — rejected', () => {
    const r = parsePaymentRequest(
      `ethereum:${USDC}@${CHAIN}/transfer?address=${USDC}&uint256=1000000`
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /recipient/i)
  })

  it('PR10: malformed/hostile payload — generic error, no throw', () => {
    const payloads = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://example.com/pay?to=0xabcd',
      '0x' + 'g'.repeat(40),   // invalid hex
      '',
    ]
    for (const p of payloads) {
      const r = parsePaymentRequest(p)
      assert.equal(r.ok, false, `Expected rejection for: ${p.slice(0, 30)}`)
    }
  })

  it('PR11: scientific notation uint256 — 1e+6 = 1000000n', () => {
    const r = parsePaymentRequest(
      `ethereum:${USDC}@${CHAIN}/transfer?address=${ADDR_B}&uint256=1e+6`
    )
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.amountUsdc, 1_000_000n)
  })

  it('PR12: float uint256 — rejected', () => {
    const r = parsePaymentRequest(
      `ethereum:${USDC}/transfer?address=${ADDR_B}&uint256=1.5`
    )
    assert.equal(r.ok, false)
  })

  it('PR13: unsupported EIP-681 function — rejected', () => {
    const r = parsePaymentRequest(
      `ethereum:${ADDR_A}/approve?spender=${ADDR_B}&uint256=1000000`
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /unsupported|function/i)
  })

  it('PR14: oversize input — rejected', () => {
    const r = parsePaymentRequest('0x' + 'a'.repeat(3000))
    assert.equal(r.ok, false)
  })

  it('PR15: exponent overflow — rejected', () => {
    const r = parsePaymentRequest(
      `ethereum:${USDC}/transfer?address=${ADDR_B}&uint256=1e+31`
    )
    assert.equal(r.ok, false)
  })

  it('PR17: decimal coefficient 2.5e6 → 2500000n', () => {
    const qr = `ethereum:${ARC_TESTNET_USDC}@${CHAIN}/transfer?address=${ADDR_A}&uint256=2.5e6`
    const r = parsePaymentRequest(qr)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.amountUsdc, 2500000n)
  })

  it('PR18: decimal coefficient 2.5e1 → 25n (integral result accepted)', () => {
    const qr = `ethereum:${ARC_TESTNET_USDC}@${CHAIN}/transfer?address=${ADDR_A}&uint256=2.5e1`
    const r = parsePaymentRequest(qr)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.amountUsdc, 25n)
  })

  it('PR18b: decimal coefficient 2.5e0 → fractional result rejected (0.5 < 1 base unit)', () => {
    const qr = `ethereum:${ARC_TESTNET_USDC}@${CHAIN}/transfer?address=${ADDR_A}&uint256=2.5e0`
    const r = parsePaymentRequest(qr)
    assert.equal(r.ok, false)
  })

  it('PR19: uint256=123456 → exactly 123456n base units', () => {
    const qr = `ethereum:${ARC_TESTNET_USDC}@${CHAIN}/transfer?address=${ADDR_A}&uint256=123456`
    const r = parsePaymentRequest(qr)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.amountUsdc, 123456n)
  })

  it('PR20: uint256=1 → exactly 1n base unit', () => {
    const qr = `ethereum:${ARC_TESTNET_USDC}@${CHAIN}/transfer?address=${ADDR_A}&uint256=1`
    const r = parsePaymentRequest(qr)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.amountUsdc, 1n)
  })

  it('PR21: unsupported function — generic message, function name not echoed', () => {
    const qr = `ethereum:${ADDR_A}/approve?address=${ADDR_B}&uint256=1000000`
    const r = parsePaymentRequest(qr)
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.ok(!r.error.toLowerCase().includes('approve'), 'function name must not appear in error')
  })

  it('PR16: mixed-case address in QR — checksummed on output', () => {
    const lower = ADDR_A.toLowerCase()
    const r = parsePaymentRequest(`ethereum:${lower}@${CHAIN}`)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.recipient, ADDR_A)   // checksummed
  })
})

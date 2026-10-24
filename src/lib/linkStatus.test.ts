/**
 * Pure decision tests for deriveLinkStatus.
 * Tests the exact state logic used by LinkCard without mounting components.
 * Not browser/camera/wallet coverage.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { deriveLinkStatus } from './linkStatus.js'
import type { ChainInfo, LinkStatusInput } from './linkStatus.js'

const NOW = 1_700_000_000
const FUTURE = NOW + 7200          // 2h from now
const PAST   = NOW - 100           // already expired

const active = (balance = 1_000_000n, expiry = BigInt(FUTURE)): ChainInfo =>
  ({ balance, feeBalance: 50_000n, expiry, active: true })

const closed = (): ChainInfo =>
  ({ balance: 0n, feeBalance: 0n, expiry: BigInt(PAST), active: false })

const base = (overrides: Partial<LinkStatusInput> = {}): LinkStatusInput => ({
  hasTxHash: true,
  chainInfo: active(),
  isLoading: false,
  isFetching: false,
  isError: false,
  isCancelSuccess: false,
  cancelInFlight: false,
  nowSec: NOW,
  ...overrides,
})

describe('deriveLinkStatus', () => {
  // D1 — Draft (no txHash)
  test('D1 draft: no txHash -> draft phase, no actions', () => {
    const r = deriveLinkStatus(base({ hasTxHash: false, chainInfo: null }))
    assert.equal(r.phase, 'draft')
    assert.equal(r.canCancel, false)
    assert.equal(r.canShare, false)
    assert.equal(r.statusLabel, 'Draft')
  })

  // D2 — Draft even if chain returns zero (default contract record)
  test('D2 draft with zero chain data stays draft, not Closed', () => {
    const r = deriveLinkStatus(base({ hasTxHash: false, chainInfo: closed() }))
    assert.equal(r.phase, 'draft')
    assert.equal(r.isClosed, false)
    assert.notEqual(r.statusLabel, 'Closed')
  })

  // D3 — First load (isLoading) -> loading phase, no actions
  test('D3 first load -> loading phase', () => {
    const r = deriveLinkStatus(base({ chainInfo: null, isLoading: true }))
    assert.equal(r.phase, 'loading')
    assert.equal(r.canCancel, false)
    assert.equal(r.canShare, false)
  })

  // D4 — Error, no data -> error_no_data phase
  test('D4 error without retained data -> error phase, no fabricated status', () => {
    const r = deriveLinkStatus(base({ chainInfo: null, isError: true }))
    assert.equal(r.phase, 'error_no_data')
    assert.equal(r.statusLabel, '')
    assert.equal(r.canCancel, false)
  })

  // D5 — Active link: canCancel+canShare, no reclaimNotice
  test('D5 active non-expired link: canCancel=true, canShare=true', () => {
    const r = deriveLinkStatus(base())
    assert.equal(r.phase, 'ready')
    assert.equal(r.canCancel, true)
    assert.equal(r.canShare, true)
    assert.equal(r.showReclaimNotice, false)
    assert.equal(r.isClosed, false)
  })

  // D6 — Closed (inactive, zero balance) -> "Closed", not "Spent"
  test('D6 inactive zero balance -> Closed, never Spent', () => {
    const r = deriveLinkStatus(base({ chainInfo: closed() }))
    assert.equal(r.statusLabel, 'Closed')
    assert.equal(r.isClosed, true)
    assert.equal(r.canCancel, false)
    assert.equal(r.canShare, false)
  })

  // D7 — Expired + active -> Expired label, showReclaimNotice=true, canCancel=true
  test('D7 expired active: reclaim notice shown, cancel allowed', () => {
    const r = deriveLinkStatus(base({ chainInfo: active(500_000n, BigInt(PAST)) }))
    assert.equal(r.statusLabel, 'Expired')
    assert.equal(r.isExpired, true)
    assert.equal(r.showReclaimNotice, true)
    assert.equal(r.canCancel, true)
    assert.equal(r.canShare, false)   // expired = no share
  })

  // D8 — Background refetch with retained data: showUpdating, actions preserved
  test('D8 background refetch: showUpdating=true, actions preserved', () => {
    const r = deriveLinkStatus(base({ isFetching: true }))
    assert.equal(r.showUpdating, true)
    assert.equal(r.canCancel, true)
    assert.equal(r.phase, 'ready')
  })

  // D9 — Error with retained data: stale notice, actions disabled
  test('D9 error with retained data: stale notice shown, actions disabled', () => {
    const r = deriveLinkStatus(base({ isError: true }))
    assert.equal(r.showStaleNotice, true)
    assert.equal(r.actionsDisabled, true)
    assert.equal(r.canCancel, false)
    assert.equal(r.phase, 'ready')
  })

  // D10 — cancelInFlight: suppress reclaim notice and active actions
  test('D10 cancel in flight: suppresses reclaim notice and active actions', () => {
    const r = deriveLinkStatus(base({
      chainInfo: active(500_000n, BigInt(PAST)),
      cancelInFlight: true,
    }))
    assert.equal(r.showReclaimNotice, false)
    assert.equal(r.canCancel, false)
  })

  // D11 — isCancelSuccess: label=Cancelled, no actions
  test('D11 cancel confirmed: label=Cancelled, no actions', () => {
    const r = deriveLinkStatus(base({ isCancelSuccess: true }))
    assert.equal(r.statusLabel, 'Cancelled')
    assert.equal(r.canCancel, false)
    assert.equal(r.canShare, false)
  })

  // D12 — Initial disconnected-before-restoration: chainInfo null, not loading, no error -> loading
  // (IssuerDashboard shows skeleton during reconnecting; LinkCard also shows skeleton on null data)
  test('D12 unresolved chain state (null, not loading): stays neutral, no fabricated status', () => {
    // This tests the case where wagmi has data=undefined but isLoading=false
    // (e.g., the query hasn't started yet due to enabled=false or during account init)
    const r = deriveLinkStatus(base({ chainInfo: null, isLoading: false, isError: false }))
    // With no data and no loading, no status should be fabricated
    assert.equal(r.canCancel, false)
    assert.equal(r.canShare, false)
    assert.equal(r.statusLabel, '')
  })
})

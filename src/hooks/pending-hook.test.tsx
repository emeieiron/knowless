// oxlint-disable require-await
/**
 * pending-hook.test.tsx — mounted usePendingIntent tests using real React + happy-dom.
 *
 * PH1: storage write failure → saveIntent returns error, persistError set, NO relay POST
 * PH2: transport timeout → same nonce/sig/body survives remount (no new signer)
 * PH3: stored txHash → immediate 'pending' receiptStatus on mount
 * PH4: receipt after >6 min → confirmed by matching PaymentExecuted event (not dropped)
 * PH5: StrictMode double-invoke + pollNow; OLD response resolves null WHILE NEW is still
 *      pending, THEN new resolves to matching receipt → success (not stalled by old gen)
 * PH6: eth_chainId wrong → stays 'pending' even with perfect matching receipt
 * PH7: eth_chainId correct + matching receipt → success
 * PH8: absent eth_chainId response → stays 'pending'
 */

import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import React from 'react'
import { renderHook, act, cleanup } from '@testing-library/react'
import type { RenderHookResult } from '@testing-library/react'
import type { Address, Hex } from 'viem'
import { keccak256, toBytes, encodeAbiParameters } from 'viem'

// ── DOM setup ─────────────────────────────────────────────────────────────────
const happyWindow = new Window({ url: 'https://localhost/' })
;(globalThis as Record<string, unknown>).window      = happyWindow
;(globalThis as Record<string, unknown>).document    = happyWindow.document
;(globalThis as Record<string, unknown>).sessionStorage = happyWindow.sessionStorage
;(globalThis as Record<string, unknown>).localStorage   = happyWindow.localStorage
;(globalThis as Record<string, unknown>).navigator   = happyWindow.navigator
;(globalThis as Record<string, unknown>).DOMException = happyWindow.DOMException
;(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) => {
  setTimeout(() => cb(Date.now()), 0); return 0
}
;(globalThis as Record<string, unknown>).cancelAnimationFrame = () => { /**/ }

// ── Import the real hook AFTER DOM registration ───────────────────────────────
import {
  usePendingIntent,
  intentKey,
  type PendingIntent,
} from './usePendingIntent.js'

// ── Constants ─────────────────────────────────────────────────────────────────
const SIGNER: Address        = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const RECIPIENT: Address     = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const FEE_RECIPIENT: Address = '0xcccccccccccccccccccccccccccccccccccccccc'
const CONTRACT: Address      = '0xdddddddddddddddddddddddddddddddddddddddd'
const TX_HASH: Hex           = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
const CHAIN_ID = 5042002
const RPC_URL  = 'https://rpc.testnet.arc.io'

const PAYMENT_EXECUTED_SIG   = 'PaymentExecuted(address,address,uint128,uint128,address,uint256)'
const PAYMENT_EXECUTED_TOPIC = keccak256(toBytes(PAYMENT_EXECUTED_SIG))

function addrTopic(addr: string): string {
  return '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase()
}

function makeIntent(overrides: Partial<PendingIntent> = {}): Omit<PendingIntent, 'submittedAt'> {
  return {
    signerAddress:   SIGNER,
    recipient:       RECIPIENT,
    amount:          1_000_000n,
    fee:             250_000n,
    feeRecipient:    FEE_RECIPIENT,
    quoteExpiry:     BigInt(Math.floor(Date.now() / 1000) + 600),
    quoteToken:      'test.token.abc',
    nonce:           42n,
    sig:             ('0x' + 'ab'.repeat(65)) as Hex,
    txHash:          null,
    chainId:         CHAIN_ID,
    contractAddress: CONTRACT,
    ...overrides,
  }
}

function makeStoredIntent(overrides: Record<string, unknown> = {}) {
  return {
    signerAddress:   SIGNER,
    recipient:       RECIPIENT,
    amount:          '1000000',
    fee:             '250000',
    feeRecipient:    FEE_RECIPIENT,
    quoteExpiry:     '9999999999',
    quoteToken:      'test.token',
    nonce:           '42',
    sig:             '0x' + 'ab'.repeat(65),
    txHash:          TX_HASH,
    chainId:         CHAIN_ID,
    contractAddress: CONTRACT,
    submittedAt:     Date.now(),
    ...overrides,
  }
}

function makeMatchingReceipt(overrides: Record<string, unknown> = {}) {
  const logData = encodeAbiParameters(
    [{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }],
    [1_000_000n, 250_000n, 42n],
  )
  return {
    status:          '0x1',
    to:              CONTRACT,
    transactionHash: TX_HASH,
    logs: [{
      address: CONTRACT,
      topics: [
        PAYMENT_EXECUTED_TOPIC,
        addrTopic(SIGNER),
        addrTopic(RECIPIENT),
        addrTopic(FEE_RECIPIENT),
      ],
      data: logData,
    }],
    blockNumber: '0x1',
    ...overrides,
  }
}

type FetchResponse = { result?: unknown; error?: unknown }

function makeMockFetch(responses: {
  chainId?: FetchResponse | 'throw' | 'pending'
  receipt?: FetchResponse | 'throw' | 'pending'
}) {
  return async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse((typeof init?.body === 'string' ? init.body : '') || '{}') as { method?: string }
    const method = body.method ?? ''

    if (method === 'eth_chainId') {
      const r = responses.chainId
      if (r === 'throw') throw new Error('network error')
      if (r === 'pending') return new Response(JSON.stringify({ result: null, error: 'unavailable' }), { status: 200 })
      return new Response(JSON.stringify(r ?? { result: '0x' + CHAIN_ID.toString(16) }), { status: 200 })
    }

    if (method === 'eth_getTransactionReceipt') {
      const r = responses.receipt
      if (r === 'throw') throw new Error('network error')
      if (r === 'pending') return new Response(JSON.stringify({ result: null }), { status: 200 })
      return new Response(JSON.stringify(r ?? { result: null }), { status: 200 })
    }

    return new Response(JSON.stringify({ result: null }), { status: 200 })
  }
}

interface FetchCall { method: string }
let fetchCalls: FetchCall[] = []
let originalFetch: typeof global.fetch

function wrapFetch(impl: (_url: unknown, init?: RequestInit) => Promise<Response>) {
  global.fetch = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    try {
      const body = JSON.parse((typeof init?.body === 'string' ? init.body : '') || '{}') as { method?: string }
      fetchCalls.push({ method: body.method ?? '' })
    } catch { /* ignore */ }
    return impl(url, init)
  })
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }

// ── Test suite ────────────────────────────────────────────────────────────────
void describe('usePendingIntent mounted hook', () => {
  // Unmounted hook refs; cleaned up in afterEach
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeHooks: Array<RenderHookResult<unknown, unknown>> = []

  void before(() => {
    originalFetch = global.fetch
  })

  void afterEach(async () => {
    // Unmount all active harnesses to stop pending loops BEFORE restoring fetch.
    // This prevents a deferred RPC callback from running against the next test's mock.
    for (const h of activeHooks) {
      try { h.unmount() } catch { /* ignore if already unmounted */ }
    }
    activeHooks.length = 0
    await act(async () => { await sleep(20) }) // flush any pending timers
    global.fetch = originalFetch
    sessionStorage.clear()
  })

  void it('PH1: storage failure → saveIntent returns error, persistError set, zero relay POSTs', async () => {
    fetchCalls = []
    let postCalls = 0

    wrapFetch(async () => {
      postCalls++
      return new Response(JSON.stringify({ txHash: TX_HASH }), { status: 200 })
    })

    const realStorage = (globalThis as Record<string, unknown>).sessionStorage as Storage
    const throwingStorage = new Proxy(realStorage, {
      get(target, prop) {
        if (prop === 'setItem') {
          return (_key: string, _value: string) => { throw new Error('QuotaExceededError') }
        }
        const val = (target as unknown as Record<string, unknown>)[prop as string]
        return (typeof val === 'function' ? val.bind(target) : val) as unknown
      },
    });
    (globalThis as Record<string, unknown>).sessionStorage = throwingStorage

    const hook = renderHook(() => usePendingIntent(SIGNER, RPC_URL, CONTRACT))
    activeHooks.push(hook)

    let persistErr: string | null = null
    await act(async () => { persistErr = hook.result.current.saveIntent(makeIntent()) })

    // Restore real sessionStorage before assertions
    ;(globalThis as Record<string, unknown>).sessionStorage = realStorage

    assert.ok(persistErr !== null, 'saveIntent should return error string')
    assert.ok(hook.result.current.persistError !== null, 'persistError should be set')
    assert.equal(hook.result.current.intent, null, 'intent should not be set after storage failure')
    assert.equal(postCalls, 0, 'zero relay POSTs should have been made')
  })

  void it('PH2: transport timeout → same nonce/sig/body survives remount', async () => {
    const hook1 = renderHook(() => usePendingIntent(SIGNER, RPC_URL, CONTRACT))
    activeHooks.push(hook1)

    let err: string | null = null
    act(() => { err = hook1.result.current.saveIntent(makeIntent({ nonce: 999n })) })
    assert.equal(err, null, 'saveIntent should succeed')

    const savedIntent = hook1.result.current.intent
    assert.ok(savedIntent !== null)
    assert.equal(savedIntent.nonce, 999n)

    hook1.unmount()
    // Remove from active (already unmounted)
    const idx = activeHooks.indexOf(hook1)
    if (idx >= 0) activeHooks.splice(idx, 1)

    const hook2 = renderHook(() => usePendingIntent(SIGNER, RPC_URL, CONTRACT))
    activeHooks.push(hook2)
    await act(async () => { await sleep(10) })

    const recovered = hook2.result.current.intent
    assert.ok(recovered !== null, 'intent should be recovered from sessionStorage after remount')
    assert.equal(recovered.nonce, 999n, 'nonce must be identical after remount')
    assert.equal(recovered.sig, savedIntent.sig, 'sig must be identical after remount')
    assert.equal(recovered.signerAddress, SIGNER, 'signerAddress must be identical')
    assert.equal(recovered.txHash, null, 'txHash should still be null — not submitted')
  })

  void it('PH3: stored txHash → immediate pending receiptStatus on mount', async () => {
    sessionStorage.setItem(intentKey(SIGNER), JSON.stringify(makeStoredIntent()))

    wrapFetch(makeMockFetch({
      chainId: { result: '0x' + CHAIN_ID.toString(16) },
      receipt: 'pending',
    }))

    const hook = renderHook(() => usePendingIntent(SIGNER, RPC_URL, CONTRACT))
    activeHooks.push(hook)

    assert.equal(hook.result.current.receiptStatus, 'pending', 'receiptStatus should be immediately pending')
    assert.equal(hook.result.current.intent?.txHash, TX_HASH, 'txHash should be loaded from storage')
  })

  void it('PH4: receipt after >6 min → confirmed by matching PaymentExecuted event', async () => {
    sessionStorage.setItem(intentKey(SIGNER), JSON.stringify(
      makeStoredIntent({ submittedAt: Date.now() - 7 * 60 * 1000 })
    ))

    wrapFetch(makeMockFetch({
      chainId: { result: '0x' + CHAIN_ID.toString(16) },
      receipt: { result: makeMatchingReceipt() },
    }))

    const hook = renderHook(() => usePendingIntent(SIGNER, RPC_URL, CONTRACT))
    activeHooks.push(hook)

    let attempts = 0
    while (hook.result.current.receiptStatus !== 'success' && attempts < 30) {
      await act(async () => { await sleep(50) })
      attempts++
    }

    assert.equal(hook.result.current.receiptStatus, 'success',
      `should confirm old intent with matching receipt (attempts: ${attempts})`)
    assert.equal(hook.result.current.receiptTxHash, TX_HASH)
  })

  void it('PH5: StrictMode + pollNow; old null response resolves while new still pending, then new matching receipt → success', async () => {
    fetchCalls = []

    // ALL receipt calls are queued as deferred promises.
    // This prevents any receipt call from completing before we explicitly unblock it,
    // so we can assert the intermediate "not yet success" state.
    const receiptQueue: Array<(result: unknown) => void> = []

    wrapFetch(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((typeof init?.body === 'string' ? init.body : '') || '{}') as { method?: string }
      if (body.method === 'eth_chainId') {
        return new Response(JSON.stringify({ result: '0x' + CHAIN_ID.toString(16) }), { status: 200 })
      }
      // eth_getTransactionReceipt — block until explicitly unblocked
      const result = await new Promise<unknown>(r => { receiptQueue.push(r) })
      return new Response(JSON.stringify({ result }), { status: 200 })
    })

    sessionStorage.setItem(intentKey(SIGNER), JSON.stringify(makeStoredIntent()))

    // StrictMode wrapper — React double-invokes effects in dev mode
    const hook = renderHook(
      () => usePendingIntent(SIGNER, RPC_URL, CONTRACT),
      { wrapper: ({ children }) => React.createElement(React.StrictMode, null, children) },
    )
    activeHooks.push(hook)

    // Allow old generation's receipt call to queue up
    await act(async () => { await sleep(50) })
    assert.ok(receiptQueue.length >= 1, `old generation must have queued a receipt call (got ${receiptQueue.length})`)

    // Trigger new generation via pollNow on the SAME hook instance
    act(() => { hook.result.current.pollNow() })
    // Let new generation queue its receipt call
    await act(async () => { await sleep(50) })

    // Resolve the OLD generation's receipt → null (cancelled generation, result should be discarded)
    await act(async () => {
      const oldResolver = receiptQueue.shift()
      if (oldResolver) oldResolver(null)
      await sleep(30)
    })

    // Hook must NOT be 'success' yet — old null result must be discarded
    // New generation's receipt call is STILL pending (unreleased in the queue)
    assert.notEqual(hook.result.current.receiptStatus, 'success',
      'should NOT succeed from the old (cancelled) generation\'s null result')

    // Now resolve the NEW generation's receipt → matching receipt
    await act(async () => {
      const newResolver = receiptQueue.shift()
      if (newResolver) newResolver(makeMatchingReceipt())
      await sleep(30)
    })

    // Also unblock any further poll rounds
    await act(async () => {
      while (receiptQueue.length > 0) {
        receiptQueue.shift()!(makeMatchingReceipt())
      }
      await sleep(30)
    })

    let attempts = 0
    while (hook.result.current.receiptStatus !== 'success' && attempts < 40) {
      // Unblock any outstanding receipt calls while polling
      await act(async () => {
        while (receiptQueue.length > 0) {
          receiptQueue.shift()!(makeMatchingReceipt())
        }
        await sleep(50)
      })
      attempts++
    }

    assert.equal(hook.result.current.receiptStatus, 'success',
      `new generation must confirm after its receipt resolves (attempts: ${attempts})`)
    assert.ok(fetchCalls.some(c => c.method === 'eth_chainId'), 'eth_chainId must be called')
  })

  void it('PH6: eth_chainId wrong → stays pending even with perfect matching receipt', async () => {
    fetchCalls = []
    sessionStorage.setItem(intentKey(SIGNER), JSON.stringify(makeStoredIntent()))

    wrapFetch(makeMockFetch({
      chainId: { result: '0x1' }, // wrong chain
      receipt: { result: makeMatchingReceipt() },
    }))

    const hook = renderHook(() => usePendingIntent(SIGNER, RPC_URL, CONTRACT))
    activeHooks.push(hook)

    await act(async () => { await sleep(300) })

    assert.equal(hook.result.current.receiptStatus, 'pending',
      'Wrong chain must keep receiptStatus pending')
    const chainIdCalls = fetchCalls.filter(c => c.method === 'eth_chainId')
    assert.ok(chainIdCalls.length > 0, 'eth_chainId must have been called')
  })

  void it('PH7: eth_chainId correct + matching receipt → success', async () => {
    fetchCalls = []
    sessionStorage.setItem(intentKey(SIGNER), JSON.stringify(makeStoredIntent()))

    wrapFetch(makeMockFetch({
      chainId: { result: '0x' + CHAIN_ID.toString(16) },
      receipt: { result: makeMatchingReceipt() },
    }))

    const hook = renderHook(() => usePendingIntent(SIGNER, RPC_URL, CONTRACT))
    activeHooks.push(hook)

    let attempts = 0
    while (hook.result.current.receiptStatus !== 'success' && attempts < 30) {
      await act(async () => { await sleep(50) })
      attempts++
    }

    assert.equal(hook.result.current.receiptStatus, 'success',
      `Correct chain + matching receipt must confirm (attempts: ${attempts})`)
    assert.ok(fetchCalls.some(c => c.method === 'eth_chainId'), 'eth_chainId must be called')
  })

  void it('PH8: absent eth_chainId response → stays pending', async () => {
    sessionStorage.setItem(intentKey(SIGNER), JSON.stringify(makeStoredIntent()))

    wrapFetch(makeMockFetch({
      chainId: 'pending', // null/error response — chain unverifiable
      receipt: { result: makeMatchingReceipt() },
    }))

    const hook = renderHook(() => usePendingIntent(SIGNER, RPC_URL, CONTRACT))
    activeHooks.push(hook)

    await act(async () => { await sleep(300) })

    assert.equal(hook.result.current.receiptStatus, 'pending',
      'Absent chain ID must keep receiptStatus pending')
  })

  // Run @testing-library cleanup after the whole suite too
  void after(() => {
    cleanup()
    global.fetch = originalFetch
  })
})

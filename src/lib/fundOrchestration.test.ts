// oxlint-disable no-floating-promises
/**
 * fundOrchestration.test.ts
 * Tests the actual exported orchestration helpers used by FundFromChain.
 * Mock EIP-1193 providers injected — no live transactions, browser, or wallet.
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import {
  obtainProvider, switchAndVerify, verifyChain, hasSourceEth,
  assertConnectorUnchanged,
  persistApproval, loadApproval, clearApproval, approvalKey,
  ProviderUnavailableError, ChainMismatchError, SwitchUnsupportedError,
  ConnectorChangedError,
} from './fundOrchestration.js'

// ── sessionStorage polyfill ────────────────────────────────────────────────

const _ss: Record<string, string> = {}
const ssMock = {
  getItem:    (k: string) => _ss[k] ?? null,
  setItem:    (k: string, v: string) => { _ss[k] = v },
  removeItem: (k: string) => { delete _ss[k] },
  get length() { return Object.keys(_ss).length },
  key:        (i: number) => Object.keys(_ss)[i] ?? null,
  clear:      () => { for (const k of Object.keys(_ss)) delete _ss[k] },
}
Object.defineProperty(globalThis, 'sessionStorage', {
  value: ssMock, writable: true, configurable: true,
})

// ── Mock helpers ───────────────────────────────────────────────────────────

const ACCT_A = '0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA' as const
const ACCT_B = '0xbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb' as const

function makeProvider(chainId: number, ethBalance = '0x1') {
  let currentChain = chainId
  return {
    setChain: (c: number) => { currentChain = c },
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x' + currentChain.toString(16)
      if (method === 'eth_getBalance') return ethBalance
      throw new Error(`unmocked: ${method}`)
    },
  }
}

function makeMockConfig(
  connectors: Array<{ uid: string; accounts: readonly [string]; getProvider: () => Promise<unknown> }>,
  currentUid?: string,
) {
  const conns = new Map(connectors.map(c => [
    c.uid, { connector: c, accounts: c.accounts, chainId: 1, status: 'connected' },
  ]))
  return {
    state: {
      connections: conns,
      current: currentUid ?? (connectors.length ? connectors[0].uid : null),
      status: 'connected',
    },
  } as unknown as import('wagmi').Config
}

// ── Approval persistence ───────────────────────────────────────────────────

describe('approval persistence', () => {
  before(() => ssMock.clear())

  it('O1: persist and load approval hash', () => {
    const hash = ('0x' + 'ab'.repeat(32)) as `0x${string}`
    persistApproval(ACCT_A, 11155111, hash)
    assert.equal(loadApproval(ACCT_A, 11155111), hash)
  })

  it('O2: load returns null when absent', () => {
    assert.equal(loadApproval(ACCT_A, 84532), null)
  })

  it('O3: clearApproval removes persisted hash', () => {
    const hash = ('0x' + 'cd'.repeat(32)) as `0x${string}`
    persistApproval(ACCT_A, 11155111, hash)
    clearApproval(ACCT_A, 11155111)
    assert.equal(loadApproval(ACCT_A, 11155111), null)
  })

  it('O4: separate keys for different accounts', () => {
    ssMock.clear()
    const h1 = ('0x' + 'aa'.repeat(32)) as `0x${string}`
    const h2 = ('0x' + 'bb'.repeat(32)) as `0x${string}`
    persistApproval(ACCT_A, 11155111, h1)
    persistApproval(ACCT_B, 11155111, h2)
    assert.equal(loadApproval(ACCT_A, 11155111), h1)
    assert.equal(loadApproval(ACCT_B, 11155111), h2)
    assert.equal(loadApproval(ACCT_A, 84532), null)
  })

  it('O5: approvalKey includes lowercase account and chainId', () => {
    const key = approvalKey(ACCT_A.toUpperCase(), 11155111)
    assert.equal(key, `knowless:fund:approval:${ACCT_A.toLowerCase()}:11155111`)
  })
})

// ── verifyChain ────────────────────────────────────────────────────────────

describe('verifyChain', () => {
  it('O6: returns true when provider already on correct chain', async () => {
    const p = makeProvider(11155111)
    assert.equal(await verifyChain(p as never, 11155111, 1, 0), true)
  })

  it('O7: returns false when provider on wrong chain', async () => {
    const p = makeProvider(84532)
    assert.equal(await verifyChain(p as never, 11155111, 1, 0), false)
  })

  it('O8: resolves true when chain changes mid-retry', async () => {
    const p = makeProvider(1)
    setTimeout(() => p.setChain(11155111), 150)
    assert.equal(await verifyChain(p as never, 11155111, 5, 100), true)
  })
})

// ── hasSourceEth ───────────────────────────────────────────────────────────

describe('hasSourceEth', () => {
  it('O9: returns true when balance non-zero', async () => {
    const p = makeProvider(11155111, '0xde0b6b3a7640000')
    assert.equal(await hasSourceEth(p as never, ACCT_A), true)
  })

  it('O10: returns false when balance is zero', async () => {
    const p = makeProvider(11155111, '0x0')
    assert.equal(await hasSourceEth(p as never, ACCT_A), false)
  })

  it('O11: provider error with "chain" in message propagates — not silently caught', async () => {
    const p = {
      request: async () => {
        throw new Error('Request Arguments: chain: Ethereum Sepolia (id: 11155111)')
      },
    }
    let threw = false
    try { await hasSourceEth(p as never, ACCT_A) } catch (e) {
      threw = true
      assert.ok((e as Error).message.includes('chain'), `expected "chain" in message`)
    }
    assert.ok(threw, 'expected error to be thrown')
  })
})

// ── switchAndVerify ────────────────────────────────────────────────────────

describe('switchAndVerify', () => {
  it('O12: already on correct chain — switch never called', async () => {
    const p = makeProvider(11155111)
    let called = false
    await switchAndVerify(p as never, 11155111, 'Ethereum Sepolia', async () => { called = true })
    assert.equal(called, false)
  })

  it('O13: switch called when on wrong chain; chain updates', async () => {
    const p = makeProvider(1)
    let called = false
    await switchAndVerify(p as never, 11155111, 'Ethereum Sepolia',
      async ({ chainId }) => { called = true; p.setChain(chainId) })
    assert.equal(called, true)
    assert.equal(await verifyChain(p as never, 11155111, 1, 0), true)
  })

  it('O14: switch resolves before chainId updates — still verifies with retry', async () => {
    const p = makeProvider(1)
    await switchAndVerify(p as never, 11155111, 'Ethereum Sepolia',
      async ({ chainId }) => { setTimeout(() => p.setChain(chainId), 200) })
    // no assertion needed — would have thrown ChainMismatchError if it failed
  })

  it('O15: user rejection (code 4001) — re-throws original error', async () => {
    const p = makeProvider(1)
    const userReject = Object.assign(new Error('User rejected'), { code: 4001, name: 'UserRejectedRequestError' })
    const err = await switchAndVerify(p as never, 11155111, 'Ethereum Sepolia',
      async () => { throw userReject }).catch(e => e)
    assert.equal((err as { code: number }).code, 4001)
  })

  it('O16: switch unsupported (4902) — throws SwitchUnsupportedError', async () => {
    const p = makeProvider(1)
    const err = await switchAndVerify(p as never, 11155111, 'Ethereum Sepolia',
      async () => { throw Object.assign(new Error('Unsupported'), { code: 4902, name: 'SwitchChainError' }) }
    ).catch(e => e)
    assert.ok(err instanceof SwitchUnsupportedError, `got: ${(err as Error).constructor?.name}`)
  })

  it('O17: switch fails and chain stays wrong — throws ChainMismatchError', async () => {
    const p = makeProvider(1)  // stays on wrong chain
    const err = await switchAndVerify(p as never, 11155111, 'Ethereum Sepolia',
      async () => { throw Object.assign(new Error('failed'), { code: -1 }) }
    ).catch(e => e)
    assert.ok(err instanceof ChainMismatchError, `got: ${(err as Error).constructor?.name}`)
  })

  it('O18: only the passed provider is used — alternate installed wallet ignored', async () => {
    const selected = makeProvider(1)    // selected connector — wrong chain
    const other    = makeProvider(11155111)  // other wallet — already on target (irrelevant)
    let switchCalled = false
    await switchAndVerify(selected as never, 11155111, 'Ethereum Sepolia',
      async ({ chainId }) => { switchCalled = true; selected.setChain(chainId) })
    assert.equal(switchCalled, true)
    void other  // other wallet never consulted
  })
})

// ── assertConnectorUnchanged ───────────────────────────────────────────────

describe('assertConnectorUnchanged', () => {
  it('O19: empty connections — throws ConnectorChangedError', () => {
    const emptyConfig = makeMockConfig([])
    assert.throws(
      () => assertConnectorUnchanged(emptyConfig, 'uid-1', ACCT_A),
      ConnectorChangedError,
    )
  })

  it('O20: two connections, CURRENT is second; switching current UID throws', () => {
    // Two installed wallets; user selected uid-B (second)
    const wallet1 = { uid: 'uid-A', accounts: [ACCT_B] as const, getProvider: async () => ({}) }
    const wallet2 = { uid: 'uid-B', accounts: [ACCT_A] as const, getProvider: async () => ({}) }
    const cfgSelected2 = makeMockConfig([wallet1, wallet2], 'uid-B')
    // Correct: current is uid-B with ACCT_A — passes
    assert.doesNotThrow(() => assertConnectorUnchanged(cfgSelected2, 'uid-B', ACCT_A))
    // After user switches to uid-A, current changes — must throw
    const cfgSwitchedTo1 = makeMockConfig([wallet1, wallet2], 'uid-A')
    assert.throws(() => assertConnectorUnchanged(cfgSwitchedTo1, 'uid-B', ACCT_A), ConnectorChangedError)
    // uid-A (first wallet, ACCT_B) was never the selected connection — using it throws
    assert.throws(() => assertConnectorUnchanged(cfgSelected2, 'uid-A', ACCT_B), ConnectorChangedError)
  })
})

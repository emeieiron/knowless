/**
 * receipt-validator.test.ts
 *
 * Behavioral tests for:
 *   (A) validateReceipt / pollAndValidateReceipt (receiptValidator.ts)
 *   (B) Relay nonce reservation — a timed-out uncertain broadcast must block
 *       a different transaction from re-using the same relay nonce.
 *   (C) Journal hydration fail-closed on corrupt entries.
 *   (D) HTTP boundary — journal write failure returns 5xx, zero broadcasts.
 *   (E) Fee safety — conservative ceiling quote, actual-sig estimate at broadcast,
 *       reject if cost exceeds maxFee rather than clamping.
 *
 * No live RPC. All transport I/O is injected.
 *
 * Test list:
 *  RV1.  Positive: exact matching receipt + PaymentExecuted log → 'success'
 *  RV2.  Reverted receipt (status 0x0) → 'failed'
 *  RV3.  Wrong contract address in receipt.to → 'failed'
 *  RV4.  txHash mismatch → 'failed'
 *  RV5.  No matching PaymentExecuted log (empty logs) → 'failed'
 *  RV6.  Matching topic but wrong signerAddress in log → 'failed'
 *  RV7.  Matching topic but wrong amount in decoded data → 'failed'
 *  RV8.  Receipt present but wrong feeRecipient → 'failed'
 *  RV9.  Receipt from wrong nonce → 'failed'
 *  RV10. Network error (fetch throws) → 'pending'
 *  RV11. RPC null result (not mined) → 'pending'
 *  RV12. RPC returns error field → 'pending'
 *  RV13. Receipt arrived after 5+ min elapsed — still validates by event content
 *  RV14. pollAndValidateReceipt: HTTP 500 from RPC → 'pending'
 *
 *  NR1.  Timeout then stale RPC nonce then different request: NO second tx at same relay nonce
 *  NR2.  Identical retry after broadcast timeout returns same txHash/rawTx
 *  NR3.  Relay wallet getNonce failure → zero broadcasts, 503
 *  NR4.  After markConfirmed, nonce is released and new intent can proceed
 *
 *  JH1.  Missing required field → journalError set, no crash
 *  JH2.  Bad intentKey (not 64-char hex) → journalError set
 *  JH3.  relayKey inconsistent with signerAddress/nonce → journalError set
 *  JH4.  Journal at capacity: writeNew throws, zero broadcasts
 *
 *  FS1.  buildQuote uses QUOTE_GAS_CEILING (no estimate call needed)
 *  FS2.  Broadcast-time estimate too expensive → 503, zero broadcasts
 *  FS3.  Broadcast-time estimate uses real sig params (fee != 0)
 */

// oxlint-disable require-await -- test stubs implement async interfaces without real async bodies

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeAbiParameters, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex, Address } from 'viem'

import {
  validateReceipt, pollAndValidateReceipt, PAYMENT_EXECUTED_TOPIC,
  type RpcReceipt, type RpcLog, type IntentForValidation, type ReceiptValidationConfig,
} from '../../src/lib/receiptValidator.js'
import { RelayJournal } from '../relay-journal.js'
import {
  RelayCore, signQuote, type RelayTransport, type RelayRequest, type OnChainReceipt,
  type LinkInfo, type EstimateGasParams, type ExecuteParams,
} from '../relay-core.js'

// ── Shared fixtures ───────────────────────────────────────────────────────────

const CONTRACT = '0xbe223821c0925e87cde1ca397fdce253a8ce7b22' as Address // arc-studio-allow-onchain-literal
const CONTRACT_LC = CONTRACT.toLowerCase()
const CHAIN_ID = 5042002

const SIGNER      = '0x1111111111111111111111111111111111111111' as Address
const RECIPIENT   = '0x2222222222222222222222222222222222222222' as Address
const AMOUNT      = 2_000_000n
const FEE         = 120_000n
const NONCE       = 99n
const _QUOTE_EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 3600)
const TX_HASH     = ('0x' + 'aa'.repeat(32)) as Hex

// Relay test fixtures
const TEST_PK   = '0x' + 'ab'.repeat(32) as Hex
const TEST_ACCT = privateKeyToAccount(TEST_PK)
const RELAY_ADDR = TEST_ACCT.address

const CFG: ReceiptValidationConfig = {
  contractAddress: CONTRACT,
  chainId: CHAIN_ID,
}

const INTENT: IntentForValidation = {
  signerAddress: SIGNER,
  recipient: RECIPIENT,
  feeRecipient: RELAY_ADDR,
  amount: AMOUNT,
  fee: FEE,
  nonce: NONCE,
  txHash: TX_HASH,
}

// ── Log builder ───────────────────────────────────────────────────────────────

/** Build an ABI-encoded PaymentExecuted log data field. */
function buildLogData(amount: bigint, fee: bigint, nonce: bigint): Hex {
  return encodeAbiParameters(
    [{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }],
    [amount, fee, nonce],
  )
}

/** Pad an address to a 32-byte hex topic. */
function addrTopic(addr: string): string {
  return '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase()
}

function makeMatchingLog(
  override?: Partial<{
    address: string
    topic0: string
    signer: string
    recipient: string
    feeRecipient: string
    amount: bigint
    fee: bigint
    nonce: bigint
  }>
): RpcLog {
  const o = override ?? {}
  return {
    address: o.address ?? CONTRACT_LC,
    topics: [
      o.topic0 ?? PAYMENT_EXECUTED_TOPIC,
      addrTopic(o.signer ?? SIGNER),
      addrTopic(o.recipient ?? RECIPIENT),
      addrTopic(o.feeRecipient ?? RELAY_ADDR),
    ],
    data: buildLogData(
      o.amount ?? AMOUNT,
      o.fee ?? FEE,
      o.nonce ?? NONCE,
    ),
  }
}

function makeReceipt(override?: Partial<RpcReceipt>, logOverride?: Partial<Parameters<typeof makeMatchingLog>[0]>): RpcReceipt {
  return {
    status: '0x1',
    to: CONTRACT_LC,
    transactionHash: TX_HASH,
    logs: [makeMatchingLog(logOverride)],
    blockNumber: '0x100',
    ...(override ?? {}),
  }
}

// ── Relay test helpers ────────────────────────────────────────────────────────

function mkTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'spookly-rv-'))
}

function makeRelayCfg(journalDir: string) {
  return {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    relayAddress: RELAY_ADDR,
    privateKey: TEST_PK,
    maxFeeUsdc: 200_000n,
    feeMarginUsdc: 10_000n,
    quoteTtlS: 300,
    arcGasFloor: 20_000_000_000n,
    journalDir,
  }
}

interface TransportCounts {
  sendRawTransactionCalls: number
  lastRawTx?: Hex
  getNonceCalls: number
  estimateContractGasCalls: number
  lastEstimateParams?: EstimateGasParams
}

function makeOkTransport(counts: TransportCounts, opts?: {
  nonceValue?: number
  sendRawThrows?: boolean
  sendRawThrowsOnce?: boolean
  getNonceThrows?: boolean
  gasEstimateValue?: bigint
}): RelayTransport {
  let throwOnce = opts?.sendRawThrowsOnce ?? false
  return {
    async getGasPrice() { return 20_000_000_000n },
    async getNonce(_a: Address) {
      counts.getNonceCalls++
      if (opts?.getNonceThrows) throw new Error('RPC: connection refused')
      return opts?.nonceValue ?? 7
    },
    async estimateContractGas(p: EstimateGasParams) {
      counts.estimateContractGasCalls++
      counts.lastEstimateParams = p
      return opts?.gasEstimateValue ?? 150_000n
    },
    async simulateExecutePayment(_p: ExecuteParams) { /* ok */ },
    async getLinkInfo(_sa: Address): Promise<LinkInfo> {
      return {
        issuer: RELAY_ADDR,
        balance: 10_000_000n,
        feeBalance: 500_000n,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
        active: true,
      }
    },
    async getUsedNonce(_s: Address, _n: bigint) { return false },
    async sendRawTransaction(raw: Hex): Promise<Hex> {
      counts.sendRawTransactionCalls++
      counts.lastRawTx = raw
      if (opts?.sendRawThrows) throw new Error('connection timeout')
      if (throwOnce) {
        throwOnce = false
        throw new Error('connection timeout')
      }
      return keccak256(raw)
    },
    async getTransactionReceipt(_txHash: Hex): Promise<OnChainReceipt | null> {
      return null  // not yet mined — keeps intent in pending state
    },
  }
}

function makeValidRelayRequest(core: RelayCore, opts?: {
  signerOverride?: Address
  nonceOverride?: bigint
  feeOverride?: bigint
}): RelayRequest {
  const signer = opts?.signerOverride ?? SIGNER
  const nonce = opts?.nonceOverride ?? NONCE
  const fee   = opts?.feeOverride ?? FEE
  const quoteExp = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const payload = {
    signerAddress: signer.toLowerCase(),
    quotedFee: fee.toString(),
    feeRecipient: RELAY_ADDR.toLowerCase(),
    quoteExpiry: Number(quoteExp),
    issuedAt: Math.floor(Date.now() / 1000),
  }
  const quoteToken = signQuote(payload, core.hmacSecret)
  return {
    signerAddress: signer,
    recipient: RECIPIENT,
    amount: AMOUNT,
    fee,
    feeRecipient: RELAY_ADDR,
    quoteExpiry: quoteExp,
    nonce,
    sig: ('0x' + 'cc'.repeat(65)) as Hex,
    chainId: CHAIN_ID,
    quoteToken,
  }
}

// ── A. Receipt validator ──────────────────────────────────────────────────────

void describe('A. validateReceipt', () => {
  void it('RV1: exact matching receipt + event → ok: true', () => {
    const r = validateReceipt(makeReceipt(), INTENT, CFG)
    assert.ok(r.ok, `should be ok, got ok=${String(r.ok)}`)
    if (r.ok) assert.equal(r.blockNumber, 0x100n)
  })

  void it('RV2: reverted receipt (status 0x0) → ok: false', () => {
    const r = validateReceipt(makeReceipt({ status: '0x0' }), INTENT, CFG)
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.reason, /reverted/)
  })

  void it('RV3: wrong contract address in receipt.to → ok: false', () => {
    const r = validateReceipt(makeReceipt({ to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }), INTENT, CFG)
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.reason, /contract/)
  })

  void it('RV4: txHash mismatch → ok: false', () => {
    const r = validateReceipt(
      makeReceipt({ transactionHash: ('0x' + 'bb'.repeat(32)) }),
      INTENT, CFG,
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.reason, /txHash/)
  })

  void it('RV5: no logs → ok: false', () => {
    const r = validateReceipt(makeReceipt({ logs: [] }), INTENT, CFG)
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.reason, /PaymentExecuted/)
  })

  void it('RV6: wrong signerAddress in log topics → ok: false', () => {
    const wrongSigner = '0x9999999999999999999999999999999999999999'
    const r = validateReceipt(
      makeReceipt({}, { signer: wrongSigner }),
      INTENT, CFG,
    )
    assert.equal(r.ok, false)
  })

  void it('RV7: wrong amount in decoded log data → ok: false', () => {
    const r = validateReceipt(
      makeReceipt({}, { amount: AMOUNT + 1n }),
      INTENT, CFG,
    )
    assert.equal(r.ok, false)
  })

  void it('RV8: wrong feeRecipient in log topics → ok: false', () => {
    const r = validateReceipt(
      makeReceipt({}, { feeRecipient: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
      INTENT, CFG,
    )
    assert.equal(r.ok, false)
  })

  void it('RV9: wrong nonce in decoded log data → ok: false', () => {
    const r = validateReceipt(
      makeReceipt({}, { nonce: NONCE + 1n }),
      INTENT, CFG,
    )
    assert.equal(r.ok, false)
  })

  void it('RV13: receipt arriving after 5+ min elapsed still validates by event content', () => {
    // Simulate an intent that was submitted 6 minutes ago
    const oldIntent: IntentForValidation = {
      ...INTENT,
      // submittedAt is not part of IntentForValidation — validate based purely on fields
    }
    // The validator has no timer logic — it only checks event content
    const r = validateReceipt(makeReceipt(), oldIntent, CFG)
    assert.ok(r.ok, 'receipt after >5min must still validate by event fields, not time')
  })
})

// ── pollAndValidateReceipt with mock fetch ───────────────────────────────────

// We test the fetch-level paths by providing a mock global fetch
function mockFetch(fn: (url: unknown, init?: RequestInit) => Promise<unknown>): void {
  global.fetch = fn as unknown as typeof global.fetch
}

// Method-aware fetch stub: responds to eth_chainId with the configured chain ID,
// then routes eth_getTransactionReceipt to the provided handler.
// This ensures negative-path pollAndValidateReceipt tests actually reach the receipt
// validator rather than short-circuiting at the chain-check step.
function makeMethodAwareFetch(
  chainId: string,
  receiptHandler: () => unknown,
): void {
  global.fetch = (async (_url: unknown, init: RequestInit | undefined) => {
    const body = JSON.parse((typeof (init?.body) === 'string' ? init.body : '') || '{}') as { method?: string }
    if (body.method === 'eth_chainId') {
      if (chainId === '__throw__') throw new Error('chain error')
      return { ok: true, json: async () => ({ result: chainId }) }
    }
    const result = receiptHandler()
    if (result === 'throw') throw new Error('ECONNREFUSED')
    if (result === 'http500') return { ok: false, status: 500 }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, ...(result as object) }) }
  }) as unknown as typeof global.fetch
}

void describe('A2. pollAndValidateReceipt network paths', () => {
  void it('RV10: network error (fetch throws on receipt call) → pending', async () => {
    const orig = global.fetch
    // Supply valid chainId; receipt call throws → pending
    makeMethodAwareFetch('0x' + CHAIN_ID.toString(16), () => 'throw')
    try {
      const result = await pollAndValidateReceipt(
        'http://localhost:9999/', TX_HASH, INTENT, CFG,
      )
      assert.equal(result, 'pending')
    } finally {
      global.fetch = orig
    }
  })

  void it('RV11: RPC null result (tx not mined) → pending', async () => {
    const orig = global.fetch
    // Supply valid chainId; receipt call returns null (not mined)
    makeMethodAwareFetch('0x' + CHAIN_ID.toString(16), () => ({ result: null }))
    try {
      const result = await pollAndValidateReceipt(
        'http://localhost:9999/', TX_HASH, INTENT, CFG,
      )
      assert.equal(result, 'pending')
    } finally {
      global.fetch = orig
    }
  })

  void it('RV12: RPC returns error field → pending', async () => {
    const orig = global.fetch
    // Supply valid chainId; receipt call returns RPC error
    makeMethodAwareFetch('0x' + CHAIN_ID.toString(16), () => ({ error: { code: -32000, message: 'not found' } }))
    try {
      const result = await pollAndValidateReceipt(
        'http://localhost:9999/', TX_HASH, INTENT, CFG,
      )
      assert.equal(result, 'pending')
    } finally {
      global.fetch = orig
    }
  })

  void it('RV14: HTTP 500 from RPC (receipt call) → pending', async () => {
    const orig = global.fetch
    // Supply valid chainId; receipt call returns 500
    makeMethodAwareFetch('0x' + CHAIN_ID.toString(16), () => 'http500')
    try {
      const result = await pollAndValidateReceipt(
        'http://localhost:9999/', TX_HASH, INTENT, CFG,
      )
      assert.equal(result, 'pending')
    } finally {
      global.fetch = orig
    }
  })

  void it('RV15: valid matching receipt + log → success', async () => {
    const receipt = makeReceipt()
    const orig = global.fetch
    // Must handle both eth_chainId (returns correct chain) and eth_getTransactionReceipt
    mockFetch(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((typeof (init?.body) === 'string' ? init.body : '') || '{}') as { method?: string }
      if (body.method === 'eth_chainId') {
        return { ok: true, json: async () => ({ result: '0x' + CHAIN_ID.toString(16) }) }
      }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: receipt }) }
    })
    try {
      const result = await pollAndValidateReceipt(
        'http://localhost:9999/', TX_HASH, INTENT, CFG,
      )
      assert.equal(result, 'success')
    } finally {
      global.fetch = orig
    }
  })

  void it('RV17: eth_chainId returns wrong chain → pending even with perfect receipt', async () => {
    const receipt = makeReceipt()
    const orig = global.fetch
    let chainIdCalled = false
    mockFetch(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((typeof (init?.body) === 'string' ? init.body : '') || '{}') as { method?: string }
      if (body.method === 'eth_chainId') {
        chainIdCalled = true
        return { ok: true, json: async () => ({ result: '0x1' }) }  // Ethereum mainnet — wrong
      }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: receipt }) }
    })
    try {
      const result = await pollAndValidateReceipt(
        'http://localhost:9999/', TX_HASH, INTENT, CFG,
      )
      assert.equal(result, 'pending', 'wrong chain must keep result pending')
      assert.ok(chainIdCalled, 'eth_chainId must have been called')
    } finally {
      global.fetch = orig
    }
  })

  void it('RV18: eth_chainId throws → pending', async () => {
    const receipt = makeReceipt()
    const orig = global.fetch
    mockFetch(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((typeof (init?.body) === 'string' ? init.body : '') || '{}') as { method?: string }
      if (body.method === 'eth_chainId') throw new Error('timeout')
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: receipt }) }
    })
    try {
      const result = await pollAndValidateReceipt(
        'http://localhost:9999/', TX_HASH, INTENT, CFG,
      )
      assert.equal(result, 'pending', 'eth_chainId failure must keep pending')
    } finally {
      global.fetch = orig
    }
  })

  void it('RV19: eth_chainId 500 → pending', async () => {
    const orig = global.fetch
    mockFetch(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((typeof (init?.body) === 'string' ? init.body : '') || '{}') as { method?: string }
      if (body.method === 'eth_chainId') return { ok: false, status: 500 }
      return { ok: true, json: async () => ({ result: null }) }
    })
    try {
      const result = await pollAndValidateReceipt(
        'http://localhost:9999/', TX_HASH, INTENT, CFG,
      )
      assert.equal(result, 'pending', 'eth_chainId 500 must keep pending')
    } finally {
      global.fetch = orig
    }
  })

  void it('RV20: confirmed revert with correct chain → failed', async () => {
    const revertReceipt: RpcReceipt = {
      status: '0x0', to: CONTRACT_LC, transactionHash: TX_HASH, logs: [], blockNumber: '0x100',
    }
    const orig = global.fetch
    mockFetch(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((typeof (init?.body) === 'string' ? init.body : '') || '{}') as { method?: string }
      if (body.method === 'eth_chainId') {
        return { ok: true, json: async () => ({ result: '0x' + CHAIN_ID.toString(16) }) }
      }
      return { ok: true, json: async () => ({ result: revertReceipt }) }
    })
    try {
      const result = await pollAndValidateReceipt(
        'http://localhost:9999/', TX_HASH, INTENT, CFG,
      )
      assert.equal(result, 'failed', 'confirmed revert with correct chain must be failed')
    } finally {
      global.fetch = orig
    }
  })

  void it('RV16: receipt with wrong contract → pending (uncertain; supplies correct chainId to reach receipt check)', async () => {
    // A receipt for the wrong contract means we have no proof about THIS tx.
    // Supplies correct eth_chainId so this test actually reaches the contract-address check.
    const receipt = makeReceipt({ to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
    const orig = global.fetch
    mockFetch(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((typeof (init?.body) === 'string' ? init.body : '') || '{}') as { method?: string }
      if (body.method === 'eth_chainId') {
        return { ok: true, json: async () => ({ result: '0x' + CHAIN_ID.toString(16) }) }
      }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: receipt }) }
    })
    try {
      const result = await pollAndValidateReceipt(
        'http://localhost:9999/', TX_HASH, INTENT, CFG,
      )
      assert.equal(result, 'pending')
    } finally {
      global.fetch = orig
    }
  })
})

// ── B. Nonce reservation ──────────────────────────────────────────────────────

void describe('B. Relay nonce reservation', () => {
  function cleanup(dir: string) { try { rmSync(dir, { recursive: true, force: true }) } catch { /**/ } }

  void it('NR1: timeout then stale RPC nonce then DIFFERENT intent → no second tx at same relay nonce', async () => {
    const dir = mkTmpDir()
    try {
      const journal = new RelayJournal(dir)
      const core = new RelayCore(makeRelayCfg(dir), journal)
      const counts: TransportCounts = { sendRawTransactionCalls: 0, getNonceCalls: 0, estimateContractGasCalls: 0 }

      // First request: broadcast throws (timeout)
      const transport = makeOkTransport(counts, { sendRawThrows: true, nonceValue: 5 })
      const req1 = makeValidRelayRequest(core)
      const r1 = await core.enqueueRelay(req1, transport)
      assert.equal(r1.status, 202, `first request should return 202, got ${r1.status}`)
      assert.equal(counts.sendRawTransactionCalls, 1, 'broadcast was attempted once')

      // Now nonce 5 is reserved in-memory (relayKey for req1)
      // A different intent arrives: different signerAddress to avoid being classified
      // as a conflicting intent under the SAME relayKey — use a fresh signer
      const SIGNER2 = '0x3333333333333333333333333333333333333333' as Address
      const counts2: TransportCounts = { sendRawTransactionCalls: 0, getNonceCalls: 0, estimateContractGasCalls: 0 }
      // RPC still reports nonce=5 (stale, pending tx not yet mined)
      const transport2 = makeOkTransport(counts2, { nonceValue: 5 })
      const req2 = makeValidRelayRequest(core, { signerOverride: SIGNER2, nonceOverride: 1n })
      const r2 = await core.enqueueRelay(req2, transport2)

      // The relay nonce 5 is reserved — the core must BLOCK a new tx at that nonce
      // and return 503 rather than signing a second raw transaction
      assert.equal(r2.status, 503,
        `second request should get 503 (reserved nonce), got ${r2.status}: ${JSON.stringify(r2.body)}`)
      assert.equal(counts2.sendRawTransactionCalls, 0, 'no second broadcast should occur')
    } finally { cleanup(dir) }
  })

  void it('NR2: identical retry after broadcast timeout → same txHash and rawTx bytes', async () => {
    const dir = mkTmpDir()
    try {
      const journal = new RelayJournal(dir)
      const core = new RelayCore(makeRelayCfg(dir), journal)
      const counts: TransportCounts = { sendRawTransactionCalls: 0, getNonceCalls: 0, estimateContractGasCalls: 0 }

      // First attempt: broadcast throws
      const transport1 = makeOkTransport(counts, { sendRawThrows: true, nonceValue: 3 })
      const req = makeValidRelayRequest(core)
      const r1 = await core.enqueueRelay(req, transport1)
      assert.equal(r1.status, 202)
      const hash1 = (r1.body as { txHash: string }).txHash
      const rawTx1 = counts.lastRawTx

      // Retry with the SAME request (journaled entry → idempotent hit, same txHash)
      const counts2: TransportCounts = { sendRawTransactionCalls: 0, getNonceCalls: 0, estimateContractGasCalls: 0 }
      const transport2 = makeOkTransport(counts2, { nonceValue: 3 })
      const r2 = await core.enqueueRelay(req, transport2)

      // Must return SAME txHash, never prepare a new transaction.
      // _reconcileAndRetry checks receipt (null=not mined), then re-sends the saved rawTx.
      // The rawTx sent must be IDENTICAL to the one originally persisted.
      const hash2 = (r2.body as { txHash: string }).txHash
      assert.equal(hash2, hash1, 'retry must return the SAME txHash')
      // Re-broadcast of the saved raw tx is expected (recovery path, not a new tx)
      assert.equal(counts2.sendRawTransactionCalls, 1, 'retry re-broadcasts the saved raw tx once')
      assert.equal(counts2.lastRawTx, rawTx1, 'retried raw tx must be identical to originally persisted bytes')

      // Recovery path: a new RelayCore instance on the same journal re-broadcasts the saved rawTx
      const counts3: TransportCounts = { sendRawTransactionCalls: 0, getNonceCalls: 0, estimateContractGasCalls: 0 }
      const transport3 = makeOkTransport(counts3, { nonceValue: 3 })
      const journal2 = new RelayJournal(dir)
      const core2 = new RelayCore(makeRelayCfg(dir), journal2)
      await core2.recoverPending(transport3)

      assert.equal(counts3.sendRawTransactionCalls, 1, 'recovery must attempt exactly one broadcast')
      assert.equal(counts3.lastRawTx, rawTx1, 'recovery must send the IDENTICAL raw transaction bytes')
    } finally { cleanup(dir) }
  })

  void it('NR3: relay wallet getNonce throws → zero broadcasts, 503 returned', async () => {
    const dir = mkTmpDir()
    try {
      const journal = new RelayJournal(dir)
      const core = new RelayCore(makeRelayCfg(dir), journal)
      const counts: TransportCounts = { sendRawTransactionCalls: 0, getNonceCalls: 0, estimateContractGasCalls: 0 }
      const transport = makeOkTransport(counts, { getNonceThrows: true })
      const req = makeValidRelayRequest(core)
      const r = await core.enqueueRelay(req, transport)

      assert.equal(r.status, 503, `expected 503 on nonce failure, got ${r.status}`)
      assert.equal(counts.sendRawTransactionCalls, 0, 'zero broadcasts on nonce failure')
      assert.equal(counts.getNonceCalls, 1, 'getNonce was called once')
      // Journal must be empty — no entry should have been written
      assert.equal(journal.getByRelayKey(`${SIGNER.toLowerCase()}:${NONCE.toString()}`), undefined)
    } finally { cleanup(dir) }
  })

  void it('NR4: markConfirmed releases reservation; new intent at same nonce can proceed', async () => {
    const dir = mkTmpDir()
    try {
      const journal = new RelayJournal(dir)
      const core = new RelayCore(makeRelayCfg(dir), journal)
      const counts: TransportCounts = { sendRawTransactionCalls: 0, getNonceCalls: 0, estimateContractGasCalls: 0 }

      // First broadcast times out — nonce 3 reserved
      const transport1 = makeOkTransport(counts, { sendRawThrows: true, nonceValue: 3 })
      const req1 = makeValidRelayRequest(core)
      await core.enqueueRelay(req1, transport1)

      const relayKey1 = `${SIGNER.toLowerCase()}:${NONCE.toString()}`
      // Confirm via markConfirmed (simulating receipt validation)
      core.markConfirmed(relayKey1, 12345)

      // Now use a different signer so the relayKey is distinct
      const SIGNER3 = '0x5555555555555555555555555555555555555555' as Address
      const counts2: TransportCounts = { sendRawTransactionCalls: 0, getNonceCalls: 0, estimateContractGasCalls: 0 }
      // RPC nonce is still 3 — but reservation was released
      const transport2 = makeOkTransport(counts2, { nonceValue: 3 })
      const req2 = makeValidRelayRequest(core, { signerOverride: SIGNER3, nonceOverride: 1n })
      const r2 = await core.enqueueRelay(req2, transport2)

      assert.equal(r2.status, 202, `expected 202 after nonce release, got ${r2.status}: ${JSON.stringify(r2.body)}`)
      assert.equal(counts2.sendRawTransactionCalls, 1, 'new intent should broadcast once')
    } finally { cleanup(dir) }
  })
})

// ── C. Journal hydration fail-closed ─────────────────────────────────────────

void describe('C. Journal hydration fail-closed', () => {
  void it('JH1: missing required field sets journalError', () => {
    const dir = mkTmpDir()
    try {
      // Write a corrupt entry missing 'txHash'
      const bad = {
        intentKey: 'a'.repeat(64),
        relayKey: `${SIGNER.toLowerCase()}:42`,
        signerAddress: SIGNER.toLowerCase(),
        recipient: RECIPIENT.toLowerCase(),
        amount: '1000000', fee: '100000', feeRecipient: RELAY_ADDR.toLowerCase(),
        quoteExpiry: '9999999999', nonce: '42', sig: '0x' + 'cc'.repeat(65),
        relayNonce: 7, chainId: CHAIN_ID,
        contractAddress: CONTRACT.toLowerCase(),
        rawTx: '0x01',
        // txHash intentionally omitted
        status: 'pending', createdAt: Date.now(), updatedAt: Date.now(),
      }
      writeFileSync(join(dir, `${SIGNER.toLowerCase()}:42.json`), JSON.stringify(bad))
      const journal = new RelayJournal(dir)
      assert.ok(journal.journalError, 'journalError must be set on corrupt entry')
      assert.match(journal.journalError, /txHash|missing/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  void it('JH2: intentKey not 64-char hex → journalError set', () => {
    const dir = mkTmpDir()
    try {
      const bad = {
        intentKey: 'not-hex',  // invalid
        relayKey: `${SIGNER.toLowerCase()}:43`,
        signerAddress: SIGNER.toLowerCase(),
        recipient: RECIPIENT.toLowerCase(),
        amount: '1000000', fee: '100000', feeRecipient: RELAY_ADDR.toLowerCase(),
        quoteExpiry: '9999999999', nonce: '43', sig: '0x' + 'cc'.repeat(65),
        relayNonce: 7, chainId: CHAIN_ID,
        contractAddress: CONTRACT.toLowerCase(),
        rawTx: '0x01', txHash: '0x' + 'ab'.repeat(32),
        status: 'pending', createdAt: Date.now(), updatedAt: Date.now(),
      }
      writeFileSync(join(dir, `${SIGNER.toLowerCase()}:43.json`), JSON.stringify(bad))
      const journal = new RelayJournal(dir)
      assert.ok(journal.journalError, 'journalError set for invalid intentKey')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  void it('JH3: relayKey inconsistent with signerAddress/nonce → journalError set', () => {
    const dir = mkTmpDir()
    try {
      const intentKey = keccak256(toBytes('test')).slice(2)  // 64-char hex
      const bad = {
        intentKey,
        relayKey: `0xdeadbeef:99`,  // wrong — inconsistent with signerAddress
        signerAddress: SIGNER.toLowerCase(),  // different from relayKey prefix
        recipient: RECIPIENT.toLowerCase(),
        amount: '1000000', fee: '100000', feeRecipient: RELAY_ADDR.toLowerCase(),
        quoteExpiry: '9999999999', nonce: '44', sig: '0x' + 'cc'.repeat(65),
        relayNonce: 7, chainId: CHAIN_ID,
        contractAddress: CONTRACT.toLowerCase(),
        rawTx: '0x01', txHash: '0x' + 'ab'.repeat(32),
        status: 'pending', createdAt: Date.now(), updatedAt: Date.now(),
      }
      writeFileSync(join(dir, 'inconsistent.json'), JSON.stringify(bad))
      const journal = new RelayJournal(dir)
      assert.ok(journal.journalError, 'journalError set for inconsistent relayKey')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  void it('JH4: journal at capacity — writeNew throws, zero broadcasts', async () => {
    // Write one valid journal entry, then monkey-patch writeNew to simulate capacity,
    // and verify no broadcast occurs when the journal refuses the write.
    const dir = mkTmpDir()
    try {
      const journal = new RelayJournal(dir)
      let broadcastCalled = false

      const transport: RelayTransport = {
        async getGasPrice() { return 20_000_000_000n },
        async getNonce(_a: Address) { return 8 },
        async estimateContractGas(_p: EstimateGasParams) { return 150_000n },
        async simulateExecutePayment(_p: ExecuteParams) { /* ok */ },
        async getLinkInfo(_sa: Address): Promise<LinkInfo> {
          return { issuer: RELAY_ADDR, balance: 10_000_000n, feeBalance: 500_000n,
            expiry: BigInt(Math.floor(Date.now() / 1000) + 3600), active: true }
        },
        async getUsedNonce() { return false },
        async sendRawTransaction(_r: Hex): Promise<Hex> {
          broadcastCalled = true
          return ('0x' + 'aa'.repeat(32)) as Hex
        },
        async getTransactionReceipt(_: Hex): Promise<OnChainReceipt | null> { return null },
      }

      // Monkey-patch writeNew to throw (simulates at-capacity)
      ;(journal as unknown as Record<string, unknown>).writeNew = () => {
        throw new Error('[journal] at capacity — cannot write new entry')
      }

      const core = new RelayCore(makeRelayCfg(dir), journal)
      const req = makeValidRelayRequest(core)

      // enqueueRelay propagates the journal error — expect it to throw
      let threw = false
      try {
        await core.enqueueRelay(req, transport)
      } catch { threw = true }

      assert.ok(threw, 'enqueueRelay must propagate journal capacity error')
      assert.ok(!broadcastCalled, 'zero broadcasts when journal writeNew throws')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── D. HTTP boundary: journal write failure ───────────────────────────────────

void describe('D. HTTP handler error isolation (via RelayCore)', () => {
  void it('D1: journal writeNew throws → no broadcast, result propagates as error', async () => {
    const dir = mkTmpDir()
    try {
      const journal = new RelayJournal(dir)
      const core = new RelayCore(makeRelayCfg(dir), journal)
      let broadcastCalled = false

      const transport: RelayTransport = {
        async getGasPrice() { return 20_000_000_000n },
        async getNonce(_a: Address) { return 11 },
        async estimateContractGas(_p: EstimateGasParams) { return 150_000n },
        async simulateExecutePayment(_p: ExecuteParams) { /* ok */ },
        async getLinkInfo(_sa: Address): Promise<LinkInfo> {
          return { issuer: RELAY_ADDR, balance: 10_000_000n, feeBalance: 500_000n,
            expiry: BigInt(Math.floor(Date.now() / 1000) + 3600), active: true }
        },
        async getUsedNonce() { return false },
        async sendRawTransaction(): Promise<Hex> {
          broadcastCalled = true
          return ('0x' + '00'.repeat(32)) as Hex
        },
        async getTransactionReceipt(_: Hex): Promise<OnChainReceipt | null> { return null },
      }

      // Stub writeNew to throw
      ;(journal as unknown as Record<string, unknown>).writeNew = () => {
        throw new Error('disk full')
      }

      let threw = false
      try {
        await core.enqueueRelay(makeValidRelayRequest(core), transport)
      } catch { threw = true }

      assert.ok(!broadcastCalled, 'broadcast must NOT have been called')
      assert.ok(threw, 'enqueueRelay must propagate the journal error')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── E. Fee safety ─────────────────────────────────────────────────────────────

void describe('E. Fee safety', () => {
  void it('FS1: buildQuote uses QUOTE_GAS_CEILING (no estimateContractGas call)', async () => {
    const dir = mkTmpDir()
    try {
      const journal = new RelayJournal(dir)
      const core = new RelayCore(makeRelayCfg(dir), journal)
      const counts: TransportCounts = { sendRawTransactionCalls: 0, getNonceCalls: 0, estimateContractGasCalls: 0 }
      const transport = makeOkTransport(counts)
      const result = await core.buildQuote(SIGNER, transport)
      assert.equal(counts.estimateContractGasCalls, 0, 'buildQuote must NOT call estimateContractGas')
      assert.ok(result.quotedFee > 0n, 'quotedFee must be positive')
      // The fee is computed from QUOTE_GAS_CEILING=250000 * gasPrice=20gwei / 10^12
      // = 250000 * 20e9 / 1e12 = 5 USDC-6 + margin. Just check it's in a sane range.
      assert.ok(result.quotedFee <= 200_000n, `quotedFee ${result.quotedFee} exceeds maxFeeUsdc 200000`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  void it('FS2: broadcast-time gas cost exceeds maxFeeUsdc → 503, zero broadcasts', async () => {
    const dir = mkTmpDir()
    try {
      const journal = new RelayJournal(dir)
      const core = new RelayCore(makeRelayCfg(dir), journal)
      const counts: TransportCounts = { sendRawTransactionCalls: 0, getNonceCalls: 0, estimateContractGasCalls: 0 }
      // Return a massive gas estimate that exceeds maxFeeUsdc (200_000 USDC-6)
      // gasLimit = 10_000_000 gas * 20 gwei = 0.2 ETH = 200_000 USDC-6 exactly at ceiling.
      // Use gasEstimate=11_000_000 to push over maxFeeUsdc
      const transport = makeOkTransport(counts, { gasEstimateValue: 11_000_000n })
      const req = makeValidRelayRequest(core)
      const r = await core.enqueueRelay(req, transport)

      assert.equal(r.status, 503,
        `expected 503 on excessive gas cost, got ${r.status}: ${JSON.stringify(r.body)}`)
      assert.equal(counts.sendRawTransactionCalls, 0, 'no broadcast on excessive cost')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  void it('FS3: broadcast-time estimate call uses actual fee (non-zero, real sig)', async () => {
    const dir = mkTmpDir()
    try {
      const journal = new RelayJournal(dir)
      const core = new RelayCore(makeRelayCfg(dir), journal)
      const counts: TransportCounts = { sendRawTransactionCalls: 0, getNonceCalls: 0, estimateContractGasCalls: 0 }
      const transport = makeOkTransport(counts)
      const req = makeValidRelayRequest(core, { feeOverride: FEE })
      await core.enqueueRelay(req, transport)

      // The broadcast-time estimateContractGas call must pass the actual fee (non-zero)
      // and the real sig — not a zeroed-out simulation
      assert.equal(counts.estimateContractGasCalls, 1, 'estimateContractGas called once at broadcast time')
      assert.ok(counts.lastEstimateParams, 'estimateContractGas params were captured')
      if (counts.lastEstimateParams) {
        assert.equal(counts.lastEstimateParams.fee, FEE,
          'estimateContractGas must use actual fee, not zero')
        assert.notEqual(counts.lastEstimateParams.sig, '0x' + '00'.repeat(65),
          'estimateContractGas must use actual sig, not all-zeros')
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

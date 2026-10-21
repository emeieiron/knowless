/**
 * relay-do.ts — SQLite-backed Durable Object for the knowless relay.
 *
 * Imports all codec, fingerprinting, HMAC, ABI encoding, and receipt
 * validation from server/relay-codec.ts (no fs imports — Worker-safe).
 *
 * ONE instance per chain+contract+relayAddress triple (keyed by RELAY_DO_KEY).
 * All signing requests for the funded relay wallet route through this single
 * DO instance, providing:
 *   • Serialized nonce allocation via a JS promise queue (_queue)
 *   • Durable persist-before-broadcast via SQLite storage
 *   • Exact-byte crash replay on restart
 *
 * CONCURRENCY MODEL
 * ─────────────────
 * The DO is single-threaded within JS execution. BUT: the JS event loop can
 * interleave requests at `await` boundaries. We serialize all signing work
 * through a single promise queue (_queue), so that:
 *   1. Only one request holds the signing lock at a time
 *   2. The nonce read + reserve + sign + persist sequence is uninterruptable
 *
 * PERSIST-BEFORE-BROADCAST SEQUENCE
 * ───────────────────────────────────
 *   1. HMAC quote verification (reject bad/expired tokens)
 *   2. Idempotency check: existing intentKey → return early or exact-byte retry
 *   3. Nonce conflict: relayKey already in non-terminal state → 409
 *   4. On-chain reads: getLinkInfo + getUsedNonce (fail-closed)
 *   5. Simulation: simulateExecutePayment (fail-closed)
 *   6. Relay nonce: getTransactionCount → check in-DO reserved set
 *   7. Stale-fee guard: current gas price × gasLimit vs signed fee
 *   8. Sign raw transaction → keccak256(rawTx) = txHash (deterministic)
 *   9. setAlarm (arm recovery BEFORE persist; 503 if alarm scheduling fails)
 *  10. INSERT full JournalEntry into SQLite (throws on failure → abort)
 *  11. Broadcast: eth_sendRawTransaction (failure = keep 'pending', nonce held)
 *  12. UPDATE status → 'broadcast'
 *
 * ALARM-DRIVEN RECONCILIATION
 * ────────────────────────────
 * After broadcast the DO schedules an alarm. The alarm:
 *   • Finds all entries with rawTx set and status in (pending, broadcast)
 *   • Calls eth_getTransactionReceipt for each
 *   • On success (0x1): verifies PaymentExecuted event, marks 'confirmed'
 *   • On revert (0x0): marks 'failed'
 *   • On null receipt: keeps pending, reschedules alarm
 *
 * STORAGE SCHEMA (SQLite)
 * ────────────────────────
 * Table: relay_journal (PRIMARY KEY intentKey)
 *   intentKey      TEXT  — sha256(all 8 intent fields)
 *   relayKey       TEXT  — signerAddress:nonce (idempotency key)
 *   signerAddress  TEXT
 *   recipient      TEXT
 *   amount         TEXT  — decimal string
 *   fee            TEXT
 *   feeRecipient   TEXT
 *   quoteExpiry    TEXT
 *   nonce          TEXT  — signer's contract nonce (decimal string)
 *   sig            TEXT  — EIP-712 signature
 *   relayNonce     INTEGER — relay wallet nonce used
 *   chainId        INTEGER
 *   contractAddress TEXT
 *   rawTx          TEXT  — 0x-hex signed tx (set before broadcast)
 *   txHash         TEXT  — keccak256(rawTx)
 *   status         TEXT  — 'pending'|'broadcast'|'confirmed'|'failed'
 *   createdAt      INTEGER
 *   updatedAt      INTEGER
 *   receiptBlockNumber INTEGER
 *   errorMsg       TEXT
 *
 * Table: relay_state
 *   key TEXT PRIMARY KEY, value TEXT
 *   — stores: config_fingerprint for cross-restart identity check
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { type Hex, type Address, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  type JournalEntry, type JournalStatus,
  makeIntentKey, makeRelayKey, encodeExecutePayment,
  deriveHmacSecret, signQuote, verifyQuote,
  checkPaymentExecutedLog, validateEntryDeep,
  type QuotePayload,
} from '../server/relay-codec.js'
import {
  type CctpJournalEntry, type CctpJournalStatus,
  makeCctpIntentKey, encodeCctpRoutePayment,
  signCctpQuote, verifyCctpQuote,
  type CctpQuotePayload,
  CCTP_SCHEMA_SQL, CCTP_QUOTE_GAS_CEILING, ARC_USDC_SCALE as CCTP_USDC_SCALE,
  ARC_GAS_FLOOR as CCTP_GAS_FLOOR,
  SUPPORTED_CCTP_DEST_DOMAINS,
  checkCctpPaymentRoutedLog,
  fetchIrisFee, pollCctpMessage,
  validateRouterImmutables,
  CCTP_FEE_BUFFER_MIN,
  verifyDestinationReceipt,
  ARC_TOKEN_MESSENGER_V2,
  DEST_CHAIN_CONFIGS,
} from './cctp-relay-do.js'

// ── Env bindings ──────────────────────────────────────────────────────────

export interface RelayDOEnv {
  RELAY_PRIVATE_KEY: string      // Wrangler secret
  RELAY_CHAIN_ID?: string        // default '5042002'
  RELAY_CONTRACT_ADDRESS: string
  RELAY_HMAC_SECRET?: string     // optional override; derived from key if absent
  RELAY_MAX_FEE_USDC?: string    // default '200000' (0.20 USDC, 6-dec)
  RELAY_FEE_MARGIN_USDC?: string // default '50000'
  RELAY_QUOTE_TTL_S?: string     // default '300'
  /** Optional RPC URL override — used in tests to inject a mock server. */
  RELAY_RPC_URL?: string
  /** Optional Iris API base URL override — used in tests to inject a mock Iris server. */
  RELAY_IRIS_BASE_URL?: string
  /**
   * KnowlessCctpRouter deployed address on Arc Testnet.
   * CCTP endpoints fail closed (503) when absent or invalid.
   */
  RELAY_CCTP_ROUTER_ADDRESS?: string
}

// ── Minimal RPC call ───────────────────────────────────────────────────────

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`)
  const json = await res.json() as { result?: unknown; error?: { message: string } }
  if (json.error) throw new Error(`RPC: ${json.error.message}`)
  return json.result
}

// ── Conservative gas ceiling ──────────────────────────────────────────────
const QUOTE_GAS_CEILING = 250_000n
const ARC_GAS_FLOOR     = 20_000_000_000n // 20 Gwei
const ARC_USDC_SCALE    = 1_000_000_000_000n // 1e12 (18-dec → 6-dec)
const MAX_QUEUE_DEPTH   = 64

// ── DB row type (SQLite columns → TS) ────────────────────────────────────

interface DBRow {
  intentKey: string
  relayKey: string
  signerAddress: string
  recipient: string
  amount: string
  fee: string
  feeRecipient: string
  quoteExpiry: string
  nonce: string
  sig: string
  relayNonce: number
  chainId: number
  contractAddress: string
  rawTx: string | null
  txHash: string | null
  status: JournalStatus
  createdAt: number
  updatedAt: number
  receiptBlockNumber: number | null
  errorMsg: string | null
}

function rowToEntry(row: DBRow): JournalEntry {
  return {
    intentKey: row.intentKey,
    relayKey: row.relayKey,
    signerAddress: row.signerAddress,
    recipient: row.recipient,
    amount: row.amount,
    fee: row.fee,
    feeRecipient: row.feeRecipient,
    quoteExpiry: row.quoteExpiry,
    nonce: row.nonce,
    sig: row.sig,
    relayNonce: row.relayNonce,
    chainId: row.chainId,
    contractAddress: row.contractAddress,
    rawTx: row.rawTx ?? '',
    txHash: row.txHash ?? '',
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    receiptBlockNumber: row.receiptBlockNumber ?? undefined,
  }
}

// ── Durable Object ─────────────────────────────────────────────────────────

export class RelayDO {
  readonly state: DurableObjectState
  readonly env: RelayDOEnv

  #schemaReady  = false
  #initError: string | null = null
  #rpcUrl       = ''
  #chainId      = 5042002
  #contractAddress = '' as Address
  #relayAddress    = '' as Address
  #maxFeeUsdc      = 200000n
  #feeMarginUsdc   = 50000n
  #quoteTtlS       = 300
  #hmacSecret      = ''
  #privateKey      = '' as Hex
  #irisBaseUrl     = ''  // optional test override for Iris API base URL

  // Single promise queue — serializes signing across all concurrent requests
  #queue: Promise<unknown> = Promise.resolve()
  #queueDepth = 0

  // Reserved relay nonces (populated from DB on init; live in memory).
  // Key: relay wallet nonce. Value: relayKey holding the reservation.
  // SHARED across legacy (relay_journal) and CCTP (cctp_journal) — one EOA nonce pool.
  #reservedNonces = new Map<number, string>()

  // Stable DO identity key: keccak256(chainId:contractAddress:relayAddress).
  // Exposed so relay-worker.ts can derive the same key from env vars without
  // needing an account object (avoids importing private key in the worker router).
  #doIdentityKey = ''

  // ── CCTP fields ────────────────────────────────────────────────────────────
  /** KnowlessCctpRouter address. Empty string = CCTP disabled (fail-closed). */
  #cctpRouterAddress = '' as Address | ''
  /** Readiness check result: null = not yet checked, string = error, true = ok */
  #cctpReadinessResult: null | true | string = null
  /** USDC address on Arc (read from relay contract during init for CCTP verification). */
  #usdcAddress = '' as Address | ''

  /**
   * Stable DO key: chain + relay ACCOUNT ADDRESS only.
   * Matches relay-worker.ts derivation exactly.
   * Contract address lives in the persisted config_fingerprint —
   * a contract change routes to the SAME DO and fails the fingerprint check.
   */
  static deriveDoKey(chainId: number, relayAddress: string): string {
    const raw = `do-key:relay:${chainId}:${relayAddress.toLowerCase()}`
    return bytesToHex(sha256(new TextEncoder().encode(raw)))
  }

  constructor(state: DurableObjectState, env: RelayDOEnv) {
    this.state = state
    this.env = env
    // Kick off async init (schema + restore reservations + identity check)
    this.state.blockConcurrencyWhile(() => this.#asyncInit())
  }

  // ── Initialization ──────────────────────────────────────────────────────

  async #asyncInit(): Promise<void> {
    try {
      const pk = this.env.RELAY_PRIVATE_KEY as Hex
      if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk))
        throw new Error('RELAY_PRIVATE_KEY not set or invalid')
      this.#privateKey = pk

      const account = privateKeyToAccount(pk)
      this.#relayAddress = account.address
      this.#chainId = parseInt(this.env.RELAY_CHAIN_ID ?? '5042002', 10)
      this.#contractAddress = this.env.RELAY_CONTRACT_ADDRESS as Address
      if (!this.#contractAddress || !/^0x[0-9a-fA-F]{40}$/.test(this.#contractAddress))
        throw new Error('RELAY_CONTRACT_ADDRESS not set or invalid')

      this.#maxFeeUsdc = BigInt(this.env.RELAY_MAX_FEE_USDC ?? '200000')
      this.#feeMarginUsdc = BigInt(this.env.RELAY_FEE_MARGIN_USDC ?? '50000')
      this.#quoteTtlS = parseInt(this.env.RELAY_QUOTE_TTL_S ?? '300', 10)
      this.#hmacSecret = this.env.RELAY_HMAC_SECRET ?? deriveHmacSecret(pk)
      this.#rpcUrl = this.env.RELAY_RPC_URL ?? 'https://rpc.testnet.arc.io' // arc-studio-allow-onchain-literal
      this.#irisBaseUrl = this.env.RELAY_IRIS_BASE_URL ?? ''
      this.#doIdentityKey = RelayDO.deriveDoKey(this.#chainId, this.#relayAddress)

      // Create schema — legacy tables + CCTP extension
      this.state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS relay_journal (
          intentKey       TEXT PRIMARY KEY,
          relayKey        TEXT NOT NULL UNIQUE,
          signerAddress   TEXT NOT NULL,
          recipient       TEXT NOT NULL,
          amount          TEXT NOT NULL,
          fee             TEXT NOT NULL,
          feeRecipient    TEXT NOT NULL,
          quoteExpiry     TEXT NOT NULL,
          nonce           TEXT NOT NULL,
          sig             TEXT NOT NULL,
          relayNonce      INTEGER,
          chainId         INTEGER NOT NULL,
          contractAddress TEXT NOT NULL,
          rawTx           TEXT,
          txHash          TEXT,
          status          TEXT NOT NULL DEFAULT 'pending',
          createdAt       INTEGER NOT NULL,
          updatedAt       INTEGER NOT NULL,
          receiptBlockNumber INTEGER,
          errorMsg        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_status      ON relay_journal(status);
        CREATE INDEX IF NOT EXISTS idx_relayKey    ON relay_journal(relayKey);
        CREATE TABLE IF NOT EXISTS relay_state (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        ${CCTP_SCHEMA_SQL}
      `)

      // Config fingerprint: chain + contract + relayAddress.
      // Stored on first activation; mismatch on any subsequent activation
      // (wrong key, wrong chain, wrong contract) blocks all requests globally.
      const cfgFpRaw = `${this.#chainId}:${this.#contractAddress.toLowerCase()}:${this.#relayAddress.toLowerCase()}`
      const cfgFp = bytesToHex(sha256(new TextEncoder().encode(cfgFpRaw)))
      const storedRows = [...this.state.storage.sql.exec<{ value: string }>(
        `SELECT value FROM relay_state WHERE key='config_fingerprint'`
      )]
      if (storedRows.length > 0) {
        if (storedRows[0].value !== cfgFp) {
          throw new Error(
            `Config mismatch: stored fingerprint ${storedRows[0].value} != current ${cfgFp}. ` +
            `Relay wallet, chain, or contract changed without a coordinated cutover.`
          )
        }
      } else {
        this.state.storage.sql.exec(
          `INSERT INTO relay_state (key, value) VALUES ('config_fingerprint', ?)`, cfgFp
        )
      }

      // Hydrate ALL rows from the journal — not just pending/non-null.
      // Apply shallow + deep identity validation to every row.
      // Any malformed, contradictory, wrong-chain/contract/sender row blocks
      // the DO globally: fail closed, never silently skip.
      const allRows = [...this.state.storage.sql.exec<DBRow>(
        `SELECT * FROM relay_journal ORDER BY createdAt ASC`
      )]

      // Shallow checks: shape, keccak256 match, status validity, fingerprint
      const knownStatuses = new Set(['pending', 'broadcast', 'confirmed', 'failed'])
      // Track relay nonces seen per status to detect contradictory duplicates
      const nonceToRelayKey = new Map<number, string>()

      for (const row of allRows) {
        // Shape: required fields must be non-empty strings
        const required = ['intentKey','relayKey','signerAddress','recipient','amount',
                          'fee','feeRecipient','quoteExpiry','nonce','sig','status',
                          'contractAddress'] as const
        for (const f of required) {
          if (!row[f] || typeof row[f] !== 'string') {
            throw new Error(`Journal row missing required field '${f}' (intentKey: ${row.intentKey ?? 'unknown'})`)
          }
        }
        if (!knownStatuses.has(row.status)) {
          throw new Error(`Journal row has unknown status '${row.status}' (intentKey: ${row.intentKey})`)
        }

        // Chain + contract must match current config
        if (row.chainId !== this.#chainId) {
          throw new Error(
            `Journal row chainId ${row.chainId} !== config ${this.#chainId} (intentKey: ${row.intentKey})`
          )
        }
        if (row.contractAddress.toLowerCase() !== this.#contractAddress.toLowerCase()) {
          throw new Error(
            `Journal row contractAddress ${row.contractAddress} !== config (intentKey: ${row.intentKey})`
          )
        }

        // Non-terminal rows with rawTx=null are indeterminate — block globally
        const terminal = row.status === 'confirmed' || row.status === 'failed'
        if (!terminal && (row.rawTx === null || row.txHash === null)) {
          throw new Error(
            `Non-terminal row missing rawTx/txHash (intentKey: ${row.intentKey}). ` +
            `Crash before signing — manual operator resolution required.`
          )
        }

        // intentKey must hash to what's stored
        const recomputed = makeIntentKey(
          row.signerAddress, row.nonce,
          row.recipient, row.amount, row.fee,
          row.feeRecipient, row.quoteExpiry, row.sig,
        )
        if (recomputed !== row.intentKey) {
          throw new Error(
            `Journal row intentKey mismatch: stored ${row.intentKey} != computed ${recomputed}`
          )
        }

        // Contradictory nonce: two different non-terminal rows sharing a relay nonce
        if (!terminal && row.relayNonce !== null) {
          const existing = nonceToRelayKey.get(row.relayNonce)
          if (existing && existing !== row.relayKey) {
            throw new Error(
              `Duplicate relay nonce ${row.relayNonce} for two unresolved entries: ` +
              `${existing} and ${row.relayKey}`
            )
          }
          nonceToRelayKey.set(row.relayNonce, row.relayKey)
        }

        // Deep validation for all rows with rawTx (terminal or not)
        if (row.rawTx) {
          const entry = rowToEntry(row)
          const label = `${entry.relayKey}.db`
          try {
            await validateEntryDeep(entry, this.#relayAddress, label)
          } catch (err) {
            throw new Error(
              `Deep identity check failed for ${label}: ${(err as Error).message}`
            )
          }
        }

        // Reserve nonce for non-terminal entries
        if (!terminal && row.relayNonce !== null) {
          this.#reservedNonces.set(row.relayNonce, row.relayKey)
        }
      }

      // Verify RPC is serving the expected chain before trusting any signed tx
      const rpcChainHex = await rpcCall(this.#rpcUrl, 'eth_chainId', []) as string
      const rpcChain = parseInt(rpcChainHex, 16)
      if (rpcChain !== this.#chainId) {
        throw new Error(
          `RPC chain ID mismatch: expected ${this.#chainId}, got ${rpcChain}. ` +
          `Wrong RPC endpoint configured.`
        )
      }

      // CCTP router address — optional; CCTP endpoints fail closed if absent
      const cctpRouterRaw = this.env.RELAY_CCTP_ROUTER_ADDRESS ?? ''
      if (cctpRouterRaw && /^0x[0-9a-fA-F]{40}$/.test(cctpRouterRaw)) {
        this.#cctpRouterAddress = cctpRouterRaw as Address
      }
      // USDC address — derived from RELAY_CONTRACT_ADDRESS (we know Arc USDC from chain)
      // Hard-coded Arc Testnet USDC; validated during CCTP readiness check
      this.#usdcAddress = '0x3600000000000000000000000000000000000000' as Address

      // Hydrate CCTP rows — full deep validation, shares #reservedNonces with legacy rows.
      const cctpNonTerminalStatuses = `('pending','broadcast','cctp_source_confirmed','cctp_mint_pending')`

      const knownCctpStatuses = new Set([
        'pending','broadcast','cctp_source_confirmed','cctp_mint_pending',
        'cctp_mint_confirmed','cctp_mint_failed','failed',
      ])

      // Full hydration query — all columns needed for deep validation
      const allCctpRows = [...this.state.storage.sql.exec<CctpJournalEntry>(
        `SELECT * FROM cctp_journal ORDER BY createdAt ASC`
      )]

      for (const row of allCctpRows) {
        if (!knownCctpStatuses.has(row.status)) {
          throw new Error(
            `cctp_journal row has unknown status '${row.status}' (key: ${row.cctpIntentKey})`
          )
        }
        if (row.chainId !== this.#chainId) {
          throw new Error(
            `cctp_journal row chainId ${row.chainId} !== config ${this.#chainId} (key: ${row.cctpIntentKey})`
          )
        }
        // routerAddress must match configured CCTP router (not self-validated from DB)
        if (this.#cctpRouterAddress && row.routerAddress.toLowerCase() !== (this.#cctpRouterAddress as string).toLowerCase()) {
          throw new Error(
            `cctp_journal row routerAddress ${row.routerAddress} !== configured router ${this.#cctpRouterAddress} (key: ${row.cctpIntentKey})`
          )
        }
        // Non-terminal cctp rows with rawTx=null are indeterminate
        const cctpTerminal = row.status === 'cctp_mint_confirmed' ||
                             row.status === 'cctp_mint_failed' ||
                             row.status === 'failed'
        if (!cctpTerminal && (!row.rawTx || !row.txHash)) {
          throw new Error(
            `cctp_journal non-terminal row missing rawTx/txHash (key: ${row.cctpIntentKey}).`
          )
        }
        // Deep identity: recompute cctpIntentKey from stored fields
        const recomputed = makeCctpIntentKey(
          row.signerAddress, row.escrowNonce, row.destinationDomain,
          row.mintRecipient, row.grossAmount, row.maxCctpFee,
          row.relayFee, row.quoteExpiry,
          row.paymentSig, row.cctpSig,
        )
        if (recomputed !== row.cctpIntentKey) {
          throw new Error(
            `cctp_journal row cctpIntentKey mismatch: stored ${row.cctpIntentKey} != computed ${recomputed}`
          )
        }
        // Verify legacyRelayKey matches signerAddress:escrowNonce
        const expectedLegacyKey = makeRelayKey(row.signerAddress, row.escrowNonce)
        if (expectedLegacyKey !== row.legacyRelayKey) {
          throw new Error(
            `cctp_journal row legacyRelayKey mismatch: stored ${row.legacyRelayKey} != computed ${expectedLegacyKey}`
          )
        }
        // txHash must equal keccak256(rawTx) for rows with rawTx
        if (row.rawTx && row.txHash) {
          const computedHash = keccak256(row.rawTx as Hex)
          if (computedHash.toLowerCase() !== row.txHash.toLowerCase()) {
            throw new Error(
              `cctp_journal row txHash mismatch: stored ${row.txHash} != keccak256(rawTx) ${computedHash}`
            )
          }
        }
        // Check for nonce conflict with legacy journal (should not occur in practice)
        if (!cctpTerminal && row.relayNonce !== null) {
          const existing = this.#reservedNonces.get(row.relayNonce)
          if (existing && existing !== row.legacyRelayKey) {
            throw new Error(
              `cctp_journal relay nonce ${row.relayNonce} conflicts with ${existing} in relay_journal`
            )
          }
          this.#reservedNonces.set(row.relayNonce, row.legacyRelayKey)
        }
      }

      // Re-arm the alarm on cold start if there are any unresolved rows.
      // This ensures alarm-driven receipt reconciliation resumes after eviction/restart.
      const unresolvedLegacy = [...this.state.storage.sql.exec<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM relay_journal WHERE status IN ('pending','broadcast') AND rawTx IS NOT NULL`
      )]
      const unresolvedCctp = [...this.state.storage.sql.exec<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM cctp_journal WHERE status IN ${cctpNonTerminalStatuses} AND rawTx IS NOT NULL`
      )]
      const unresolvedCount = (unresolvedLegacy[0]?.cnt ?? 0) + (unresolvedCctp[0]?.cnt ?? 0)
      if (unresolvedCount > 0) {
        const existingAlarm = await this.state.storage.getAlarm()
        if (!existingAlarm) {
          await this.state.storage.setAlarm(Date.now() + 5_000)
        }
      }

      this.#schemaReady = true
    } catch (err) {
      this.#initError = (err instanceof Error) ? err.message : String(err)
      console.error('[relay-do] init error:', this.#initError)
    }
  }

  #assertReady(): void {
    if (!this.#schemaReady || this.#initError) {
      throw new Error(this.#initError ?? 'Relay not initialized.')
    }
  }

  // ── HTTP entry ──────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    if (!this.#schemaReady) {
      return Response.json(
        { error: this.#initError ?? 'Relay not initialized.' },
        { status: 503 }
      )
    }

    const url  = new URL(request.url)
    const path = url.pathname

    if (path === '/relay/health' && request.method === 'GET')
      return this.#handleHealth()
    if (path === '/relay/quote' && request.method === 'GET')
      return this.#handleQuote(url)
    if (path === '/relay' && request.method === 'POST')
      return this.#enqueueRelay(request)

    // ── CCTP endpoints ────────────────────────────────────────────────────
    if (path === '/relay/cctp/quote' && request.method === 'GET')
      return this.#handleCctpQuote(url)
    if (path === '/relay/cctp/submit' && request.method === 'POST')
      return this.#enqueueCctpSubmit(request)
    if (path === '/relay/cctp/status' && request.method === 'GET')
      return this.#handleCctpStatus(url)

    return Response.json({ error: 'Not found.' }, { status: 404 })
  }

  // ── Health ──────────────────────────────────────────────────────────────

  async #handleHealth(): Promise<Response> {
    const rows = [...this.state.storage.sql.exec<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM relay_journal WHERE status IN ('pending','broadcast')`
    )]
    const queueDepth = rows[0]?.cnt ?? 0

    // Stale: entries with rawTx=NULL pending > 5 minutes = crash before sign
    const stale = [...this.state.storage.sql.exec<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM relay_journal WHERE status='pending' AND rawTx IS NULL AND createdAt < ?`,
      Date.now() - 300_000,
    )]
    const staleCount = stale[0]?.cnt ?? 0

    const cctpRows = [...this.state.storage.sql.exec<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM cctp_journal WHERE status IN ('pending','broadcast','cctp_source_confirmed','cctp_mint_pending')`
    )]
    const cctpQueueDepth = cctpRows[0]?.cnt ?? 0

    // cctpEnabled: true only when router is configured AND readiness has been
    // verified (i.e. immutables confirmed on-chain). Mere address presence is not enough.
    const cctpEnabled = !!this.#cctpRouterAddress && this.#cctpReadinessResult === true

    return Response.json({
      ok: true,
      available: this.#schemaReady && !this.#initError,
      queueDepth,
      cctpQueueDepth,
      staleEntries: staleCount,
      inFlightQueue: this.#queueDepth,
      chainId: this.#chainId,
      relayWallet: this.#relayAddress,
      cctpEnabled,
      cctpRouterConfigured: !!this.#cctpRouterAddress,
      ...(this.#initError ? { error: this.#initError } : {}),
    })
  }

  // ── Quote ───────────────────────────────────────────────────────────────

  async #handleQuote(url: URL): Promise<Response> {
    try { this.#assertReady() } catch {
      return Response.json({ error: 'Relay not available.' }, { status: 503 })
    }

    const sa = url.searchParams.get('signerAddress') as Address | null
    if (!sa || !/^0x[0-9a-fA-F]{40}$/.test(sa))
      return Response.json({ error: 'Invalid signerAddress.' }, { status: 400 })

    // Verify link is active and has sufficient fee budget
    let linkActive = true
    let feeBalance = 0n
    try {
      const linkInfoHex = await rpcCall(this.#rpcUrl, 'eth_call', [{
        to: this.#contractAddress,
        data: this.#encodeLinkInfoCall(sa),
      }, 'latest']) as string
      const info = this.#decodeLinkInfo(linkInfoHex)
      linkActive = info.active
      feeBalance = info.feeBalance
    } catch {
      return Response.json({ error: 'RPC unavailable. Try again.' }, { status: 503 })
    }

    if (!linkActive)
      return Response.json({ error: 'Link is not active.' }, { status: 400 })
    if (feeBalance === 0n)
      return Response.json({ error: 'Link has zero fee budget.' }, { status: 400 })

    // Gas estimate (conservative ceiling, no real sig available at quote time)
    let gasPrice: bigint
    try {
      const gp = await rpcCall(this.#rpcUrl, 'eth_gasPrice', []) as string
      gasPrice = BigInt(gp)
    } catch { gasPrice = ARC_GAS_FLOOR }
    if (gasPrice < ARC_GAS_FLOOR) gasPrice = ARC_GAS_FLOOR

    const gasCost18 = QUOTE_GAS_CEILING * gasPrice
    const gasCost6  = (gasCost18 + ARC_USDC_SCALE - 1n) / ARC_USDC_SCALE
    const quotedFee = gasCost6 + this.#feeMarginUsdc

    if (quotedFee > this.#maxFeeUsdc) {
      return Response.json({
        error: `Gas cost (${quotedFee}) exceeds relay max (${this.#maxFeeUsdc}).`,
        quotedFee: quotedFee.toString(),
        maxFee: this.#maxFeeUsdc.toString(),
      }, { status: 503 })
    }

    if (quotedFee > feeBalance) {
      return Response.json({
        error: 'insufficient_fee_budget',
        quotedFee: quotedFee.toString(),
        feeBalance: feeBalance.toString(),
      }, { status: 400 })
    }

    const now = Math.floor(Date.now() / 1000)
    const quoteExpiry = now + this.#quoteTtlS

    const payload: QuotePayload = {
      signerAddress: sa.toLowerCase(),
      quotedFee: quotedFee.toString(),
      feeRecipient: this.#relayAddress.toLowerCase(),
      quoteExpiry,
      issuedAt: now,
    }
    const quoteToken = signQuote(payload, this.#hmacSecret)

    return Response.json({
      quotedFee: quotedFee.toString(),
      feeRecipient: this.#relayAddress,
      quoteExpiry,
      feeBalance: feeBalance.toString(),
      quoteToken,
      gasEstimate: QUOTE_GAS_CEILING.toString(),
      gasPrice: gasPrice.toString(),
    })
  }

  // ── Relay POST (enqueue) ────────────────────────────────────────────────

  #enqueueRelay(request: Request): Promise<Response> {
    if (this.#queueDepth >= MAX_QUEUE_DEPTH) {
      return Promise.resolve(
        Response.json({ error: 'Relay queue at capacity — try again later.' }, { status: 503 })
      )
    }
    this.#queueDepth++
    const task = (): Promise<Response> => {
      const p = this.#handleRelay(request)
      p.then(() => { this.#queueDepth-- }, () => { this.#queueDepth-- })
      return p
    }
    const next = this.#queue.then(task, task) as Promise<Response>
    this.#queue = next.then(() => undefined, () => undefined)
    return next
  }

  async #handleRelay(request: Request): Promise<Response> {
    try { this.#assertReady() } catch {
      return Response.json({ error: 'Relay not available.' }, { status: 503 })
    }

    let body: Record<string, unknown>
    try {
      body = await request.json() as Record<string, unknown>
    } catch {
      return Response.json({ error: 'Invalid JSON.' }, { status: 400 })
    }

    const {
      signerAddress, recipient, amount: amountRaw, fee: feeRaw,
      feeRecipient, quoteExpiry: qeRaw, nonce: nonceRaw, sig,
      chainId, quoteToken,
    } = body

    // ── Field validation ────────────────────────────────────────────────
    if (typeof signerAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(signerAddress))
      return Response.json({ error: 'Invalid signerAddress.' }, { status: 400 })
    if (typeof recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(recipient))
      return Response.json({ error: 'Invalid recipient.' }, { status: 400 })
    if (typeof feeRecipient !== 'string' || feeRecipient.toLowerCase() !== this.#relayAddress.toLowerCase())
      return Response.json({ error: 'feeRecipient must be relay wallet.' }, { status: 400 })
    if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{128,132}$/.test(sig))
      return Response.json({ error: 'Invalid sig.' }, { status: 400 })
    if (typeof quoteToken !== 'string' || quoteToken.length < 10)
      return Response.json({ error: 'Missing quoteToken.' }, { status: 400 })
    if (chainId !== this.#chainId)
      return Response.json({ error: `Wrong chain. Expected ${this.#chainId}.` }, { status: 400 })

    let amount: bigint, fee: bigint, nonce: bigint, quoteExpiry: bigint
    try {
      amount = BigInt(String(amountRaw))
      fee = BigInt(String(feeRaw))
      nonce = BigInt(String(nonceRaw))
      quoteExpiry = BigInt(String(qeRaw))
    } catch {
      return Response.json({ error: 'amount/fee/nonce/quoteExpiry must be decimal strings.' }, { status: 400 })
    }
    if (amount <= 0n) return Response.json({ error: 'amount must be > 0.' }, { status: 400 })
    if (fee < 0n)    return Response.json({ error: 'fee must be >= 0.' }, { status: 400 })

    // ── HMAC quote verification ────────────────────────────────────────
    const relayKey  = makeRelayKey(signerAddress, nonce.toString())
    const intentKey = makeIntentKey(
      signerAddress, nonce.toString(),
      recipient as string, amount.toString(), fee.toString(),
      feeRecipient, quoteExpiry.toString(), sig as string,
    )

    // Check for existing entry first (idempotency)
    const existingRow = this.#getRow(intentKey)
    const existingByRelayKey = existingRow ? null : this.#getRowByRelayKey(relayKey)

    if (!existingRow) {
      // Fresh submission — full quote verification
      const qp = verifyQuote(quoteToken, this.#hmacSecret)
      if (!qp)
        return Response.json({ error: 'Invalid or tampered quoteToken.' }, { status: 401 })
      if (Math.floor(Date.now() / 1000) > qp.quoteExpiry)
        return Response.json({ error: 'Quote token expired. Fetch a new quote.' }, { status: 400 })
      if (qp.signerAddress !== signerAddress.toLowerCase())
        return Response.json({ error: 'quoteToken signerAddress mismatch.' }, { status: 400 })
      if (qp.feeRecipient !== feeRecipient.toLowerCase())
        return Response.json({ error: 'quoteToken feeRecipient mismatch.' }, { status: 400 })
      if (qp.quoteExpiry !== Number(quoteExpiry))
        return Response.json({ error: 'quoteToken quoteExpiry mismatch.' }, { status: 400 })
      const quotedFeeMin = BigInt(qp.quotedFee)
      if (fee < quotedFeeMin)
        return Response.json({ error: `fee ${fee} below required quote ${quotedFeeMin}.` }, { status: 400 })
      if (fee > this.#maxFeeUsdc)
        return Response.json({ error: `fee ${fee} exceeds max ${this.#maxFeeUsdc}.` }, { status: 400 })
    }

    // ── Idempotency: existing intent ───────────────────────────────────
    if (existingRow) {
      if (existingRow.status === 'confirmed')
        return Response.json({ txHash: existingRow.txHash, status: 'confirmed' }, { status: 200 })
      if (existingRow.status === 'failed')
        return Response.json({ error: 'Payment previously failed.', txHash: existingRow.txHash }, { status: 409 })
      if (existingRow.rawTx && existingRow.txHash) {
        // Known-hash retry: exact-byte re-broadcast
        try {
          await rpcCall(this.#rpcUrl, 'eth_sendRawTransaction', [existingRow.rawTx])
        } catch { /* already known — hash-deduplicated by node */ }
        return Response.json({ txHash: existingRow.txHash, status: existingRow.status }, { status: 202 })
      }
      // pending without rawTx: crashed before signing completed — fail closed.
      // We cannot re-sign: we don't know whether any broadcast attempt occurred
      // before the crash. The alarm cannot recover this either (no rawTx to replay).
      // The operator must inspect and manually resolve (or allow it to expire).
      return Response.json({
        error: 'Payment in indeterminate state (crash before signing). Resolve via admin before retrying.',
        intentKey: existingRow.intentKey,
      }, { status: 503 })
    }

    // ── Nonce conflict: same signer+nonce, different intent ────────────
    if (existingByRelayKey) {
      return Response.json({
        error: 'Conflicting intent: a different payment is already recorded for this signer+nonce.',
        existingTxHash: existingByRelayKey.txHash,
      }, { status: 409 })
    }

    // Cross-table conflict: same signer+nonce in cctp_journal (non-terminal)
    const cctpConflict = this.#getCctpRowByLegacyKey(relayKey)
    if (cctpConflict) {
      const cctpTerminal = cctpConflict.status === 'cctp_mint_confirmed' ||
                           cctpConflict.status === 'cctp_mint_failed' ||
                           cctpConflict.status === 'failed'
      if (!cctpTerminal) {
        return Response.json({
          error: 'Conflicting CCTP intent: this signer+nonce is already used by a CCTP route.',
          existingTxHash: cctpConflict.txHash,
        }, { status: 409 })
      }
    }

    // ── On-chain reads (fail-closed) ───────────────────────────────────
    let linkInfo: { active: boolean; balance: bigint; feeBalance: bigint; expiry: bigint }
    let nonceUsed: boolean
    try {
      const [linkHex, usedHex] = await Promise.all([
        rpcCall(this.#rpcUrl, 'eth_call', [{
          to: this.#contractAddress,
          data: this.#encodeLinkInfoCall(signerAddress as Address),
        }, 'latest']) as Promise<string>,
        rpcCall(this.#rpcUrl, 'eth_call', [{
          to: this.#contractAddress,
          data: this.#encodeUsedNonces(signerAddress as Address, nonce),
        }, 'latest']) as Promise<string>,
      ])
      linkInfo = this.#decodeLinkInfo(linkHex)
      nonceUsed = BigInt(usedHex || '0x0') !== 0n
    } catch {
      return Response.json({ error: 'RPC unavailable. Retry later.' }, { status: 503 })
    }

    if (nonceUsed)
      return Response.json({ error: 'Nonce already used on-chain.' }, { status: 409 })
    if (!linkInfo.active)
      return Response.json({ error: 'Link is not active.' }, { status: 400 })
    const nowS = BigInt(Math.floor(Date.now() / 1000))
    if (nowS >= linkInfo.expiry)
      return Response.json({ error: 'Link has expired.' }, { status: 400 })
    if (nowS >= quoteExpiry)
      return Response.json({ error: 'Quote has expired on submission.' }, { status: 400 })
    if (amount > linkInfo.balance)
      return Response.json({ error: `Amount ${amount} exceeds balance ${linkInfo.balance}.` }, { status: 400 })
    // Fee is paid from feeBalance, NOT from balance — separate buckets
    if (fee > linkInfo.feeBalance)
      return Response.json({ error: `Fee ${fee} exceeds feeBalance ${linkInfo.feeBalance}.` }, { status: 400 })

    // ── Simulation ─────────────────────────────────────────────────────
    try {
      await rpcCall(this.#rpcUrl, 'eth_call', [{
        to: this.#contractAddress,
        data: encodeExecutePayment(
          signerAddress as Address, recipient as Address,
          amount, fee,
          this.#relayAddress, quoteExpiry,
          nonce, sig as Hex,
        ),
        from: this.#relayAddress,
      }, 'latest'])
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      const safe = ['InvalidSignature','InsufficientBalance','NonceUsed','QuoteExpired','WrongFeeRecipient']
        .find(n => msg.includes(n)) ?? 'Simulation reverted'
      return Response.json({ error: `Simulation failed: ${safe}` }, { status: 400 })
    }

    // ── Relay wallet nonce ─────────────────────────────────────────────
    let rpcNonce: number
    try {
      const hex = await rpcCall(
        this.#rpcUrl, 'eth_getTransactionCount', [this.#relayAddress, 'pending']
      ) as string
      rpcNonce = parseInt(hex, 16)
    } catch {
      return Response.json({ error: 'RPC unavailable (nonce read). Retry later.' }, { status: 503 })
    }

    // Nonce reservation check: prevent double-nonce across concurrent holders
    if (this.#reservedNonces.has(rpcNonce)) {
      const holder = this.#reservedNonces.get(rpcNonce)!
      return Response.json({
        error: 'Relay nonce reserved for an unresolved tx. Retry after it confirms.',
        reservedBy: holder,
      }, { status: 503 })
    }

    // ── Gas price + stale-fee guard ────────────────────────────────────
    let gasPrice: bigint
    try {
      gasPrice = BigInt(await rpcCall(this.#rpcUrl, 'eth_gasPrice', []) as string)
    } catch { gasPrice = ARC_GAS_FLOOR }
    if (gasPrice < ARC_GAS_FLOOR) gasPrice = ARC_GAS_FLOOR

    // Use conservative ceiling — actual gas with real calldata usually lower.
    // Rejection if cost exceeds policy max; rejection if signed fee doesn't cover it.
    const gasLimit   = QUOTE_GAS_CEILING
    const gasCost18  = gasLimit * gasPrice
    const actualCost6 = (gasCost18 + ARC_USDC_SCALE - 1n) / ARC_USDC_SCALE
    const requiredFee = actualCost6 + this.#feeMarginUsdc

    if (actualCost6 > this.#maxFeeUsdc) {
      return Response.json({
        error: `Gas cost (${actualCost6}) exceeds relay max (${this.#maxFeeUsdc}). Retry later.`,
      }, { status: 503 })
    }
    if (fee < requiredFee) {
      return Response.json({
        error: `Signed fee (${fee}) no longer covers relay cost (${requiredFee}). Fetch a new quote.`,
        requiredFee: requiredFee.toString(),
      }, { status: 400 })
    }

    // ── Sign raw transaction ───────────────────────────────────────────
    const calldata = encodeExecutePayment(
      signerAddress as Address, recipient as Address,
      amount, fee,
      this.#relayAddress, quoteExpiry,
      nonce, sig as Hex,
    )

    const account = privateKeyToAccount(this.#privateKey)
    const rawTx = await account.signTransaction({
      to: this.#contractAddress,
      data: calldata,
      nonce: rpcNonce,
      gasPrice,
      gas: gasLimit,
      chainId: this.#chainId,
      type: 'legacy',
    })
    const txHash = keccak256(rawTx)

    // ── Persist BEFORE broadcast ───────────────────────────────────────
    const now2 = Date.now()
    const entry: JournalEntry = {
      intentKey, relayKey,
      signerAddress: signerAddress.toLowerCase(),
      recipient: (recipient as string).toLowerCase(),
      amount: amount.toString(),
      fee: fee.toString(),
      feeRecipient: feeRecipient.toLowerCase(),
      quoteExpiry: quoteExpiry.toString(),
      nonce: nonce.toString(),
      sig: sig as string,
      relayNonce: rpcNonce,
      chainId: this.#chainId,
      contractAddress: this.#contractAddress.toLowerCase(),
      rawTx,
      txHash,
      status: 'pending',
      createdAt: now2,
      updatedAt: now2,
    }

    // Arm recovery alarm BEFORE durable write — if scheduling fails, abort
    // before signing/persisting so there is no orphaned row without alarm coverage.
    try {
      const currentAlarm = await this.state.storage.getAlarm()
      if (!currentAlarm) {
        await this.state.storage.setAlarm(Date.now() + 15_000)
      }
    } catch (e) {
      console.error('[relay-do] alarm arm failed:', (e instanceof Error) ? e.constructor.name : 'unknown')
      return Response.json({ error: 'Storage error. Retry.' }, { status: 503 })
    }

    // Atomic INSERT — throws if duplicate intentKey (race guard).
    // No update path: pending-without-rawTx rows fail closed in #assertReady via init.
    try {
      this.state.storage.sql.exec(
        `INSERT INTO relay_journal
          (intentKey,relayKey,signerAddress,recipient,amount,fee,feeRecipient,quoteExpiry,
           nonce,sig,relayNonce,chainId,contractAddress,rawTx,txHash,status,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        intentKey, relayKey,
        entry.signerAddress, entry.recipient, entry.amount, entry.fee,
        entry.feeRecipient, entry.quoteExpiry, entry.nonce, entry.sig,
        rpcNonce, this.#chainId, entry.contractAddress,
        rawTx, txHash, 'pending', now2, now2,
      )
    } catch (e) {
      console.error('[relay-do] persist failed:', (e instanceof Error) ? e.constructor.name : 'unknown')
      return Response.json({ error: 'Storage error. Retry.' }, { status: 503 })
    }

    // Reserve nonce AFTER durable write
    this.#reservedNonces.set(rpcNonce, relayKey)

    // ── Broadcast ─────────────────────────────────────────────────────
    let broadcastOk = false
    try {
      await rpcCall(this.#rpcUrl, 'eth_sendRawTransaction', [rawTx])
      broadcastOk = true
    } catch (e) {
      const eName = e instanceof Error ? e.constructor.name : 'unknown'
      console.error('[relay-do] broadcast type:', eName, 'txHash:', txHash)
      // Status stays 'pending' — alarm will replay exact rawTx
    }

    if (broadcastOk) {
      this.state.storage.sql.exec(
        `UPDATE relay_journal SET status='broadcast', updatedAt=? WHERE intentKey=?`,
        Date.now(), intentKey,
      )
    }

    return Response.json({ txHash, status: 'pending' }, { status: 202 })
  }

  // ── Alarm: receipt reconciliation ──────────────────────────────────────
  // Serialized through the same queue as submit — prevents nonce races between
  // alarm-driven rebroadcast and concurrent incoming signing requests.

  alarm(): Promise<void> {
    if (!this.#schemaReady) return Promise.resolve()
    const task = (): Promise<void> => this.#runAlarm()
    const next = this.#queue.then(task, task) as Promise<void>
    this.#queue = next.then(() => undefined, () => undefined)
    return next
  }

  async #runAlarm(): Promise<void> {
    if (!this.#schemaReady) return

    // Check ALL entries with rawTx set that are still unresolved
    // (covers both 'broadcast' and 'pending' entries that have rawTx)
    const rows = [...this.state.storage.sql.exec<DBRow>(
      `SELECT * FROM relay_journal WHERE status IN ('pending','broadcast') AND rawTx IS NOT NULL AND txHash IS NOT NULL`
    )]

    let anyUnresolved = false

    for (const row of rows) {
      try {
        const receipt = await rpcCall(
          this.#rpcUrl, 'eth_getTransactionReceipt', [row.txHash]
        ) as Record<string, unknown> | null

        if (!receipt) {
          // No receipt — replay exact stored bytes for both 'pending' and 'broadcast'.
          // Never re-sign or reconstruct: rawTx is the durable source of truth.
          if (row.rawTx) {
            try {
              await rpcCall(this.#rpcUrl, 'eth_sendRawTransaction', [row.rawTx])
              if (row.status === 'pending') {
                this.state.storage.sql.exec(
                  `UPDATE relay_journal SET status='broadcast', updatedAt=? WHERE intentKey=?`,
                  Date.now(), row.intentKey,
                )
              }
            } catch { /* already known to node or nonce stale — keep status */ }
          }
          anyUnresolved = true
          continue
        }

        // Validate chain + contract match before accepting receipt evidence
        const receiptChainHex = await rpcCall(this.#rpcUrl, 'eth_chainId', []) as string
        const receiptChain = parseInt(receiptChainHex, 16)
        if (receiptChain !== this.#chainId) { anyUnresolved = true; continue }
        if ((receipt.to as string | null)?.toLowerCase() !== this.#contractAddress.toLowerCase()) {
          anyUnresolved = true; continue
        }
        if ((receipt.transactionHash as string).toLowerCase() !== row.txHash!.toLowerCase()) {
          anyUnresolved = true; continue
        }

        if (receipt.status === '0x0') {
          // Definitive on-chain failure
          this.state.storage.sql.exec(
            `UPDATE relay_journal SET status='failed', updatedAt=? WHERE intentKey=?`,
            Date.now(), row.intentKey,
          )
          this.#reservedNonces.delete(row.relayNonce)
          continue
        }

        if (receipt.status !== '0x1') { anyUnresolved = true; continue }

        // Success — verify PaymentExecuted event
        const entry = rowToEntry(row)
        const onchainReceipt = {
          status: receipt.status as string,
          to: receipt.to as string | null,
          transactionHash: receipt.transactionHash as string,
          logs: (receipt.logs ?? []) as Array<{ address: string; topics: string[]; data: string }>,
          blockNumber: receipt.blockNumber as string | undefined,
        }
        const vResult = checkPaymentExecutedLog(onchainReceipt, entry, this.#contractAddress)
        if (vResult.ok) {
          this.state.storage.sql.exec(
            `UPDATE relay_journal SET status='confirmed', receiptBlockNumber=?, updatedAt=? WHERE intentKey=?`,
            Number(vResult.blockNumber), Date.now(), row.intentKey,
          )
          this.#reservedNonces.delete(row.relayNonce)
        } else {
          // Mined but event mismatch — uncertain, keep pending
          anyUnresolved = true
        }
      } catch { anyUnresolved = true }
    }

    // ── CCTP alarm: source confirmation + mint monitoring ─────────────
    const cctpUnresolved = await this.#runCctpAlarm()

    // Re-schedule if still unresolved entries remain (legacy or CCTP)
    if (anyUnresolved || rows.length > 0 || cctpUnresolved) {
      await this.state.storage.setAlarm(Date.now() + 15_000)
    }
  }

  async #runCctpAlarm(): Promise<boolean> {
    let anyUnresolved = false

    // Source broadcast rows: check receipt
    const sourcePending = [...this.state.storage.sql.exec<{
      cctpIntentKey: string; txHash: string | null; rawTx: string | null
      legacyRelayKey: string; relayNonce: number
      signerAddress: string; destinationDomain: number
      mintRecipient: string; grossAmount: string; escrowNonce: string; status: string
    }>(
      `SELECT cctpIntentKey, txHash, rawTx, legacyRelayKey, relayNonce,
              signerAddress, destinationDomain, mintRecipient, grossAmount, escrowNonce, status
       FROM cctp_journal WHERE status IN ('pending','broadcast') AND rawTx IS NOT NULL AND txHash IS NOT NULL`
    )]

    for (const row of sourcePending) {
      try {
        const receipt = await rpcCall(
          this.#rpcUrl, 'eth_getTransactionReceipt', [row.txHash]
        ) as Record<string, unknown> | null

        if (!receipt) {
          if (row.rawTx) {
            try {
              await rpcCall(this.#rpcUrl, 'eth_sendRawTransaction', [row.rawTx])
              if (row.status === 'pending') {
                this.state.storage.sql.exec(
                  `UPDATE cctp_journal SET status='broadcast', updatedAt=? WHERE cctpIntentKey=?`,
                  Date.now(), row.cctpIntentKey,
                )
              }
            } catch { /* already known */ }
          }
          anyUnresolved = true
          continue
        }

        if (receipt.status === '0x0') {
          this.state.storage.sql.exec(
            `UPDATE cctp_journal SET status='failed', updatedAt=? WHERE cctpIntentKey=?`,
            Date.now(), row.cctpIntentKey,
          )
          this.#reservedNonces.delete(row.relayNonce)
          continue
        }

        if (receipt.status !== '0x1') { anyUnresolved = true; continue }

        // Source confirmed — verify CctpPaymentRouted event
        const fullEntry = this.#getCctpRow(row.cctpIntentKey)
        if (!fullEntry) { anyUnresolved = true; continue }

        const routerAddr = fullEntry.routerAddress
        const receiptForCheck = {
          status: receipt.status as string,
          to: receipt.to as string | null,
          transactionHash: receipt.transactionHash as string,
          logs: (receipt.logs ?? []) as Array<{ address: string; topics: string[]; data: string }>,
          blockNumber: receipt.blockNumber as string | undefined,
        }
        const sourceCheck = checkCctpPaymentRoutedLog(receiptForCheck, fullEntry, routerAddr, this.#contractAddress)
        if (!sourceCheck.ok) {
          anyUnresolved = true; continue
        }

        // Mark source confirmed; persist source txHash
        this.state.storage.sql.exec(
          `UPDATE cctp_journal SET status='cctp_source_confirmed',
           sourceTxHash=?, receiptBlockNumber=?, updatedAt=?
           WHERE cctpIntentKey=?`,
          row.txHash, Number(sourceCheck.blockNumber), Date.now(), row.cctpIntentKey,
        )
        this.#reservedNonces.delete(row.relayNonce)
        anyUnresolved = true  // still need destination
      } catch { anyUnresolved = true }
    }

    // Mint monitoring rows: poll Circle Messages API
    const mintPending = [...this.state.storage.sql.exec<{
      cctpIntentKey: string; sourceTxHash: string | null
      destinationDomain: number; mintRecipient: string
      grossAmount: string; maxCctpFee: string
    }>(
      `SELECT cctpIntentKey, sourceTxHash, destinationDomain, mintRecipient, grossAmount, maxCctpFee
       FROM cctp_journal WHERE status IN ('cctp_source_confirmed','cctp_mint_pending')`
    )]

    for (const row of mintPending) {
      if (!row.sourceTxHash) { anyUnresolved = true; continue }
      try {
        const msgResult = await pollCctpMessage(
          row.sourceTxHash, row.destinationDomain, row.mintRecipient,
          this.#cctpRouterAddress as string,
          this.#usdcAddress as string,
        )

        if (!msgResult || (msgResult as { error: string }).error) {
          anyUnresolved = true
          // Update to mint_pending if still source_confirmed
          this.state.storage.sql.exec(
            `UPDATE cctp_journal SET status='cctp_mint_pending', updatedAt=?
             WHERE cctpIntentKey=? AND status='cctp_source_confirmed'`,
            Date.now(), row.cctpIntentKey,
          )
          continue
        }

        const msg = msgResult as CctpMessageStatus
        if (msg.forwardTxHash) {
          // Destination forwarding hash available — verify destination receipt.
          // Trigger from forwardTxHash presence only; do not guess forwardState enum values.
          const destConfig = DEST_CHAIN_CONFIGS[row.destinationDomain]
          const fullRow = this.#getCctpRow(row.cctpIntentKey)
          let destVerified = false
          let verifiedNet: bigint | null = null

          if (destConfig && fullRow) {
            try {
              const destReceipt = await rpcCall(destConfig.rpcUrl, 'eth_getTransactionReceipt', [msg.forwardTxHash]) as Record<string, unknown> | null
              if (destReceipt) {
                const receiptForVerify = {
                  status: destReceipt.status as string,
                  transactionHash: destReceipt.transactionHash as string,
                  logs: (destReceipt.logs ?? []) as Array<{ address: string; topics: string[]; data: string }>,
                }
                // attestedNonce: bytes32 hex from Circle message (may be '0' pre-attestation)
                const attestedNonce = msg.attestedNonce.replace(/^0x/, '').padStart(64, '0')
                const vr = verifyDestinationReceipt(
                  receiptForVerify, fullRow,
                  destConfig.transmitterAddr,
                  destConfig.usdcAddr,
                  attestedNonce,
                  ARC_TOKEN_MESSENGER_V2,
                )
                if (vr.ok) {
                  destVerified = true
                  verifiedNet  = vr.netAmount
                }
                // else: receipt fetched but failed verification — keep monitoring
              }
              // null receipt: not yet mined on destination — keep monitoring
            } catch { /* dest RPC unavailable — keep monitoring */ }
          }

          if (destVerified && verifiedNet !== null) {
            this.state.storage.sql.exec(
              `UPDATE cctp_journal SET status='cctp_mint_confirmed',
               destTxHash=?, netAmountDelivered=?, updatedAt=?
               WHERE cctpIntentKey=?`,
              msg.forwardTxHash, verifiedNet.toString(), Date.now(), row.cctpIntentKey,
            )
          } else {
            // Messages API says complete but receipt not yet verifiable — keep monitoring
            anyUnresolved = true
            this.state.storage.sql.exec(
              `UPDATE cctp_journal SET status='cctp_mint_pending', updatedAt=?
               WHERE cctpIntentKey=? AND status='cctp_source_confirmed'`,
              Date.now(), row.cctpIntentKey,
            )
          }
        } else {
          // No forwardTxHash yet — still in progress
          this.state.storage.sql.exec(
            `UPDATE cctp_journal SET status='cctp_mint_pending', updatedAt=?
             WHERE cctpIntentKey=? AND status='cctp_source_confirmed'`,
            Date.now(), row.cctpIntentKey,
          )
          anyUnresolved = true
        }
      } catch { anyUnresolved = true }
    }

    return anyUnresolved
  }

  // ── DB helpers ──────────────────────────────────────────────────────────

  #getRow(intentKey: string): DBRow | null {
    const rows = [...this.state.storage.sql.exec<DBRow>(
      `SELECT * FROM relay_journal WHERE intentKey=?`, intentKey
    )]
    return rows[0] ?? null
  }

  #getRowByRelayKey(relayKey: string): DBRow | null {
    const rows = [...this.state.storage.sql.exec<DBRow>(
      `SELECT * FROM relay_journal WHERE relayKey=?`, relayKey
    )]
    return rows[0] ?? null
  }

  // ── ABI call helpers ────────────────────────────────────────────────────
  // getLinkInfo(address) returns (address issuer, uint128 balance, uint128 feeBalance, uint64 expiry, bool active)

  #encodeLinkInfoCall(addr: Address): string {
    // keccak256("getLinkInfo(address)")[0:4]
    const sigBytes = new TextEncoder().encode('getLinkInfo(address)')
    const hash = keccak256(sigBytes as unknown as Hex)
    const selector = hash.slice(0, 10)
    return selector + addr.toLowerCase().slice(2).padStart(64, '0')
  }

  #encodeUsedNonces(signerAddr: Address, nonce: bigint): string {
    // Deployed public mapping getter: usedNonces(address,uint256) returns (bool)
    // Verified live: arc testnet 0xbe22... → returns bool
    const sigBytes = new TextEncoder().encode('usedNonces(address,uint256)')
    const hash = keccak256(sigBytes as unknown as Hex)
    const selector = hash.slice(0, 10)
    const addrPad = signerAddr.toLowerCase().slice(2).padStart(64, '0')
    const noncePad = nonce.toString(16).padStart(64, '0')
    return selector + addrPad + noncePad
  }

  #decodeLinkInfo(hex: string): {
    active: boolean; balance: bigint; feeBalance: bigint; expiry: bigint
  } {
    // tuple: address(32) + balance(32) + feeBalance(32) + expiry(32) + active(32)
    if (!hex || hex.length < 322) return { active: false, balance: 0n, feeBalance: 0n, expiry: 0n }
    const data = hex.startsWith('0x') ? hex.slice(2) : hex
    const balance    = BigInt('0x' + (data.slice(64,  128) || '0'))
    const feeBalance = BigInt('0x' + (data.slice(128, 192) || '0'))
    const expiry     = BigInt('0x' + (data.slice(192, 256) || '0'))
    const active     = BigInt('0x' + (data.slice(256, 320) || '0')) !== 0n
    return { active, balance, feeBalance, expiry }
  }

  // ── CCTP DB helpers ─────────────────────────────────────────────────────

  #getCctpRow(cctpIntentKey: string): CctpJournalEntry | null {
    const rows = [...this.state.storage.sql.exec<Record<string, unknown>>(
      `SELECT * FROM cctp_journal WHERE cctpIntentKey=?`, cctpIntentKey
    )]
    return rows[0] ? (rows[0] as unknown as CctpJournalEntry) : null
  }

  #getCctpRowByLegacyKey(legacyRelayKey: string): CctpJournalEntry | null {
    const rows = [...this.state.storage.sql.exec<Record<string, unknown>>(
      `SELECT * FROM cctp_journal WHERE legacyRelayKey=?`, legacyRelayKey
    )]
    return rows[0] ? (rows[0] as unknown as CctpJournalEntry) : null
  }

  // ── CCTP readiness guard ─────────────────────────────────────────────────

  async #assertCctpReady(): Promise<string | null> {
    if (!this.#cctpRouterAddress)
      return 'CCTP relay not configured (RELAY_CCTP_ROUTER_ADDRESS not set).'
    if (this.#cctpReadinessResult === true) return null
    if (typeof this.#cctpReadinessResult === 'string') return this.#cctpReadinessResult

    // First check: validate router immutables
    const err = await validateRouterImmutables(
      this.#cctpRouterAddress,
      this.#contractAddress,
      this.#usdcAddress,
      this.#rpcUrl,
    )
    this.#cctpReadinessResult = err ?? true
    return err ?? null
  }

  // ── CCTP Quote ───────────────────────────────────────────────────────────

  async #handleCctpQuote(url: URL): Promise<Response> {
    try { this.#assertReady() } catch {
      return Response.json({ error: 'Relay not available.' }, { status: 503 })
    }

    const readinessErr = await this.#assertCctpReady()
    if (readinessErr)
      return Response.json({ error: readinessErr }, { status: 503 })

    // Validate query params
    const sa   = url.searchParams.get('signerAddress') as Address | null
    const dest = url.searchParams.get('destinationDomain')
    const mr   = url.searchParams.get('mintRecipient') as Address | null
    // Accept desiredNetAmount (UI) or grossAmount (smoke compat)
    const desiredNetStr = url.searchParams.get('desiredNetAmount')
    const grossAmtStr   = url.searchParams.get('grossAmount')
    const amtStr = desiredNetStr ?? grossAmtStr

    if (!sa || !/^0x[0-9a-fA-F]{40}$/.test(sa))
      return Response.json({ error: 'Invalid signerAddress.' }, { status: 400 })
    if (dest === null || !SUPPORTED_CCTP_DEST_DOMAINS.includes(Number(dest) as 0 | 6))
      return Response.json({ error: 'Unsupported destinationDomain (must be 0 or 6).' }, { status: 400 })
    if (!mr || !/^0x[0-9a-fA-F]{40}$/.test(mr))
      return Response.json({ error: 'Invalid mintRecipient.' }, { status: 400 })
    if (!amtStr || !/^\d+$/.test(amtStr))
      return Response.json({ error: 'Invalid amount (desiredNetAmount or grossAmount required, decimal integer).' }, { status: 400 })

    const destinationDomain = Number(dest) as 0 | 6
    let inputAmount: bigint
    try { inputAmount = BigInt(amtStr) } catch {
      return Response.json({ error: 'Amount must be a decimal integer.' }, { status: 400 })
    }
    if (inputAmount <= 0n)
      return Response.json({ error: 'Amount must be > 0.' }, { status: 400 })

    // Fetch Iris forwarding fees first — need maxCctpFee to compute gross
    // (both desiredNetAmount and grossAmount paths need fee first)
    const irisResultPre = await fetchIrisFee(destinationDomain, inputAmount, undefined, this.#irisBaseUrl || undefined)
    if (!irisResultPre.ok)
      return Response.json({ error: `CCTP fee unavailable: ${irisResultPre.reason}` }, { status: 503 })

    const { forwardFee: forwardFeePre } = irisResultPre
    const feeBufferPre = forwardFeePre / 100n
    const maxCctpFeePre = forwardFeePre + (feeBufferPre > CCTP_FEE_BUFFER_MIN ? feeBufferPre : CCTP_FEE_BUFFER_MIN)

    // If desiredNetAmount: gross = desiredNet + maxCctpFee (fee is NOT deducted from recipient amount)
    // If grossAmount (smoke compat): gross = as provided, validate > maxCctpFee
    let grossAmount: bigint
    if (desiredNetStr) {
      grossAmount = inputAmount + maxCctpFeePre
    } else {
      grossAmount = inputAmount
      if (grossAmount <= maxCctpFeePre)
        return Response.json({
          error: `grossAmount (${grossAmount}) is not greater than maxCctpFee (${maxCctpFeePre}).`,
        }, { status: 400 })
    }

    const maxCctpFee = maxCctpFeePre
    const minDestReceived = grossAmount - maxCctpFee

    // Verify link is active and has sufficient balance + fee budget
    let linkActive = true
    let linkBalance = 0n
    let linkFeeBalance = 0n
    try {
      const linkInfoHex = await rpcCall(this.#rpcUrl, 'eth_call', [{
        to: this.#contractAddress,
        data: this.#encodeLinkInfoCall(sa),
      }, 'latest']) as string
      const info = this.#decodeLinkInfo(linkInfoHex)
      linkActive     = info.active
      linkBalance    = info.balance
      linkFeeBalance = info.feeBalance
    } catch {
      return Response.json({ error: 'RPC unavailable. Try again.' }, { status: 503 })
    }

    if (!linkActive)
      return Response.json({ error: 'Link is not active.' }, { status: 400 })
    if (grossAmount > linkBalance)
      return Response.json({ error: `grossAmount ${grossAmount} exceeds link balance ${linkBalance}.` }, { status: 400 })

    // Relay fee: gas cost + margin (same policy as legacy, but higher gas ceiling)
    let gasPrice: bigint
    try {
      const gp = await rpcCall(this.#rpcUrl, 'eth_gasPrice', []) as string
      gasPrice = BigInt(gp)
    } catch { gasPrice = CCTP_GAS_FLOOR }
    if (gasPrice < CCTP_GAS_FLOOR) gasPrice = CCTP_GAS_FLOOR

    const gasCost18 = CCTP_QUOTE_GAS_CEILING * gasPrice
    const gasCost6  = (gasCost18 + CCTP_USDC_SCALE - 1n) / CCTP_USDC_SCALE
    const relayFee  = gasCost6 + this.#feeMarginUsdc

    if (relayFee > this.#maxFeeUsdc) {
      return Response.json({
        error: `Gas cost (${relayFee}) exceeds relay max (${this.#maxFeeUsdc}).`,
        relayFee: relayFee.toString(),
        maxFee: this.#maxFeeUsdc.toString(),
      }, { status: 503 })
    }

    if (relayFee > linkFeeBalance) {
      return Response.json({
        error: 'insufficient_fee_budget',
        relayFee: relayFee.toString(),
        feeBalance: linkFeeBalance.toString(),
      }, { status: 400 })
    }

    const now = Math.floor(Date.now() / 1000)
    const quoteExpiry = now + this.#quoteTtlS

    const payload: CctpQuotePayload = {
      t:                 'cctp-v1',
      signerAddress:     sa.toLowerCase(),
      destinationDomain,
      mintRecipient:     mr.toLowerCase(),
      grossAmount:       grossAmount.toString(),
      maxCctpFee:        maxCctpFee.toString(),
      relayFee:          relayFee.toString(),
      relayerAddress:    this.#relayAddress.toLowerCase(),
      quoteExpiry,
      issuedAt:          now,
      sourceChainId:     this.#chainId,
      escrowAddress:     this.#contractAddress.toLowerCase(),
      routerAddress:     (this.#cctpRouterAddress as string).toLowerCase(),
    }
    const quoteToken = signCctpQuote(payload, this.#hmacSecret)

    return Response.json({
      signerAddress:    sa,
      destinationDomain,
      mintRecipient:    mr,
      grossAmount:      grossAmount.toString(),
      maxCctpFee:       maxCctpFee.toString(),
      relayFee:         relayFee.toString(),
      minDestReceived:  minDestReceived.toString(),
      relayerAddress:   this.#relayAddress,
      quoteExpiry,
      quoteToken,
      routerAddress:    this.#cctpRouterAddress,
      gasEstimate:      CCTP_QUOTE_GAS_CEILING.toString(),
      gasPrice:         gasPrice.toString(),
    })
  }

  // ── CCTP Submit (enqueue) ────────────────────────────────────────────────

  #enqueueCctpSubmit(request: Request): Promise<Response> {
    if (this.#queueDepth >= MAX_QUEUE_DEPTH) {
      return Promise.resolve(
        Response.json({ error: 'Relay queue at capacity — try again later.' }, { status: 503 })
      )
    }
    this.#queueDepth++
    const task = (): Promise<Response> => {
      const p = this.#handleCctpSubmit(request)
      p.then(() => { this.#queueDepth-- }, () => { this.#queueDepth-- })
      return p
    }
    const next = this.#queue.then(task, task) as Promise<Response>
    this.#queue = next.then(() => undefined, () => undefined)
    return next
  }

  async #handleCctpSubmit(request: Request): Promise<Response> {
    try { this.#assertReady() } catch {
      return Response.json({ error: 'Relay not available.' }, { status: 503 })
    }
    const readinessErr = await this.#assertCctpReady()
    if (readinessErr)
      return Response.json({ error: readinessErr }, { status: 503 })

    let body: Record<string, unknown>
    try {
      body = await request.json() as Record<string, unknown>
    } catch {
      return Response.json({ error: 'Invalid JSON.' }, { status: 400 })
    }

    const {
      signerAddress, destinationDomain: destRaw, mintRecipient,
      grossAmount: grossRaw, maxCctpFee: maxFeeRaw, relayFee: relayFeeRaw,
      quoteExpiry: qeRaw, escrowNonce: nonceRaw,
      paymentSig, cctpSig, chainId, quoteToken,
    } = body

    // Field validation
    if (typeof signerAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(signerAddress))
      return Response.json({ error: 'Invalid signerAddress.' }, { status: 400 })
    if (typeof mintRecipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(mintRecipient))
      return Response.json({ error: 'Invalid mintRecipient.' }, { status: 400 })
    if (typeof paymentSig !== 'string' || !/^0x[0-9a-fA-F]{128,132}$/.test(paymentSig))
      return Response.json({ error: 'Invalid paymentSig.' }, { status: 400 })
    if (typeof cctpSig !== 'string' || !/^0x[0-9a-fA-F]{128,132}$/.test(cctpSig))
      return Response.json({ error: 'Invalid cctpSig.' }, { status: 400 })
    if (typeof quoteToken !== 'string' || quoteToken.length < 10)
      return Response.json({ error: 'Missing quoteToken.' }, { status: 400 })
    if (chainId !== this.#chainId)
      return Response.json({ error: `Wrong chain. Expected ${this.#chainId}.` }, { status: 400 })

    let grossAmount: bigint, maxCctpFee: bigint, relayFee: bigint
    let quoteExpiry: bigint, escrowNonce: bigint
    let destinationDomain: number
    try {
      grossAmount    = BigInt(String(grossRaw))
      maxCctpFee     = BigInt(String(maxFeeRaw))
      relayFee       = BigInt(String(relayFeeRaw))
      quoteExpiry    = BigInt(String(qeRaw))
      escrowNonce    = BigInt(String(nonceRaw))
      destinationDomain = Number(destRaw)
    } catch {
      return Response.json({ error: 'Numeric fields must be decimal strings.' }, { status: 400 })
    }

    if (!SUPPORTED_CCTP_DEST_DOMAINS.includes(destinationDomain as 0 | 6))
      return Response.json({ error: 'Unsupported destinationDomain.' }, { status: 400 })
    if (grossAmount <= 0n)
      return Response.json({ error: 'grossAmount must be > 0.' }, { status: 400 })
    if (relayFee <= 0n)
      return Response.json({ error: 'relayFee must be > 0.' }, { status: 400 })
    if (grossAmount <= maxCctpFee)
      return Response.json({ error: 'grossAmount must be > maxCctpFee.' }, { status: 400 })

    // Cross-table conflict key (same as legacy relayKey for escrow nonce)
    const legacyRelayKey = makeRelayKey(signerAddress, escrowNonce.toString())
    const cctpIntentKey  = makeCctpIntentKey(
      signerAddress, escrowNonce.toString(), destinationDomain,
      mintRecipient, grossAmount.toString(), maxCctpFee.toString(),
      relayFee.toString(), quoteExpiry.toString(),
      paymentSig, cctpSig,
    )

    // Idempotency: check existing CCTP row (exact same intent)
    const existingCctp = this.#getCctpRow(cctpIntentKey)

    // Same-table different-intent conflict: same signer+escrowNonce, different signatures/routing
    const cctpSameNonceConflict = !existingCctp ? this.#getCctpRowByLegacyKey(legacyRelayKey) : null

    // Check legacy cross-table conflict
    const legacyConflict = !existingCctp ? this.#getRow(legacyRelayKey) : null
    const legacyConflictByKey = !existingCctp ? this.#getRowByRelayKey(legacyRelayKey) : null

    if (!existingCctp) {
      // HMAC quote verification
      const qp = verifyCctpQuote(quoteToken, this.#hmacSecret)
      if (!qp)
        return Response.json({ error: 'Invalid or tampered quoteToken.' }, { status: 401 })
      if (Math.floor(Date.now() / 1000) > qp.quoteExpiry)
        return Response.json({ error: 'Quote token expired. Fetch a new CCTP quote.' }, { status: 400 })
      // Verify quote binds ALL routing fields
      if (qp.signerAddress     !== signerAddress.toLowerCase())
        return Response.json({ error: 'quoteToken signerAddress mismatch.' }, { status: 400 })
      if (qp.destinationDomain !== destinationDomain)
        return Response.json({ error: 'quoteToken destinationDomain mismatch.' }, { status: 400 })
      if (qp.mintRecipient     !== mintRecipient.toLowerCase())
        return Response.json({ error: 'quoteToken mintRecipient mismatch.' }, { status: 400 })
      if (qp.grossAmount       !== grossAmount.toString())
        return Response.json({ error: 'quoteToken grossAmount mismatch.' }, { status: 400 })
      if (qp.maxCctpFee        !== maxCctpFee.toString())
        return Response.json({ error: 'quoteToken maxCctpFee mismatch.' }, { status: 400 })
      if (qp.quoteExpiry       !== Number(quoteExpiry))
        return Response.json({ error: 'quoteToken quoteExpiry mismatch.' }, { status: 400 })
      if (qp.relayerAddress    !== this.#relayAddress.toLowerCase())
        return Response.json({ error: 'quoteToken relayerAddress mismatch.' }, { status: 400 })
      // Verify quote was issued for this chain, escrow and router
      if (qp.sourceChainId !== this.#chainId)
        return Response.json({ error: 'quoteToken sourceChainId mismatch.' }, { status: 400 })
      if (qp.escrowAddress !== this.#contractAddress.toLowerCase())
        return Response.json({ error: 'quoteToken escrowAddress mismatch.' }, { status: 400 })
      if (qp.routerAddress !== (this.#cctpRouterAddress as string).toLowerCase())
        return Response.json({ error: 'quoteToken routerAddress mismatch.' }, { status: 400 })

      const quotedRelayFee = BigInt(qp.relayFee)
      if (relayFee < quotedRelayFee)
        return Response.json({ error: `relayFee ${relayFee} below quoted ${quotedRelayFee}.` }, { status: 400 })
      if (relayFee > this.#maxFeeUsdc)
        return Response.json({ error: `relayFee ${relayFee} exceeds max ${this.#maxFeeUsdc}.` }, { status: 400 })
    }

    // Idempotency return
    if (existingCctp) {
      if (existingCctp.status === 'cctp_mint_confirmed')
        return Response.json({ txHash: existingCctp.txHash, status: 'cctp_mint_confirmed',
          destTxHash: existingCctp.destTxHash, netAmountDelivered: existingCctp.netAmountDelivered }, { status: 200 })
      if (existingCctp.status === 'cctp_mint_failed')
        return Response.json({ error: 'CCTP mint failed.', txHash: existingCctp.txHash }, { status: 409 })
      if (existingCctp.status === 'failed')
        return Response.json({ error: 'CCTP payment failed on source.', txHash: existingCctp.txHash }, { status: 409 })
      if (existingCctp.rawTx && existingCctp.txHash) {
        try {
          await rpcCall(this.#rpcUrl, 'eth_sendRawTransaction', [existingCctp.rawTx])
        } catch { /* already known */ }
        return Response.json({ txHash: existingCctp.txHash, status: existingCctp.status }, { status: 202 })
      }
      return Response.json({
        error: 'CCTP payment in indeterminate state (crash before signing).',
        cctpIntentKey: existingCctp.cctpIntentKey,
      }, { status: 503 })
    }

    // Same-table different-intent conflict: same signer+escrowNonce, different intent
    if (cctpSameNonceConflict) {
      const cctpTerminal = cctpSameNonceConflict.status === 'cctp_mint_confirmed' ||
                           cctpSameNonceConflict.status === 'cctp_mint_failed' ||
                           cctpSameNonceConflict.status === 'failed'
      if (!cctpTerminal) {
        return Response.json({
          error: 'Conflicting CCTP intent: a different CCTP payment is already recorded for this signer+escrowNonce.',
          existingTxHash: cctpSameNonceConflict.txHash,
        }, { status: 409 })
      }
    }

    // Cross-table conflict checks
    if (legacyConflict || legacyConflictByKey) {
      const row = legacyConflict ?? legacyConflictByKey!
      const terminal = row.status === 'confirmed' || row.status === 'failed'
      if (!terminal) {
        return Response.json({
          error: 'Conflicting legacy payment: this signer+nonce is in use by a direct Arc payment.',
          existingTxHash: row.txHash,
        }, { status: 409 })
      }
    }

    // On-chain validation
    let linkInfo: { active: boolean; balance: bigint; feeBalance: bigint; expiry: bigint }
    let nonceUsed: boolean
    try {
      const [linkHex, usedHex] = await Promise.all([
        rpcCall(this.#rpcUrl, 'eth_call', [{
          to: this.#contractAddress,
          data: this.#encodeLinkInfoCall(signerAddress as Address),
        }, 'latest']) as Promise<string>,
        rpcCall(this.#rpcUrl, 'eth_call', [{
          to: this.#contractAddress,
          data: this.#encodeUsedNonces(signerAddress as Address, escrowNonce),
        }, 'latest']) as Promise<string>,
      ])
      linkInfo  = this.#decodeLinkInfo(linkHex)
      nonceUsed = BigInt(usedHex || '0x0') !== 0n
    } catch {
      return Response.json({ error: 'RPC unavailable. Retry later.' }, { status: 503 })
    }

    if (nonceUsed)
      return Response.json({ error: 'Escrow nonce already used on-chain.' }, { status: 409 })
    if (!linkInfo.active)
      return Response.json({ error: 'Link is not active.' }, { status: 400 })
    const nowS = BigInt(Math.floor(Date.now() / 1000))
    if (nowS >= linkInfo.expiry)
      return Response.json({ error: 'Link has expired.' }, { status: 400 })
    if (nowS >= quoteExpiry)
      return Response.json({ error: 'Quote has expired on submission.' }, { status: 400 })
    if (grossAmount > linkInfo.balance)
      return Response.json({
        error: `grossAmount ${grossAmount} exceeds link balance ${linkInfo.balance}.`,
      }, { status: 400 })
    if (relayFee > linkInfo.feeBalance)
      return Response.json({
        error: `relayFee ${relayFee} exceeds feeBalance ${linkInfo.feeBalance}.`,
      }, { status: 400 })

    // Simulation: call routePayment on router
    const routerCalldata = encodeCctpRoutePayment(
      signerAddress as Address, grossAmount, maxCctpFee, relayFee,
      quoteExpiry, escrowNonce, destinationDomain,
      mintRecipient as Address, paymentSig as Hex, cctpSig as Hex,
    )
    try {
      await rpcCall(this.#rpcUrl, 'eth_call', [{
        to: this.#cctpRouterAddress,
        data: routerCalldata,
        from: this.#relayAddress,
      }, 'latest'])
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      const safe = [
        'InvalidSignature','InsufficientBalance','NonceUsed','QuoteExpired',
        'WrongFeeRecipient','WrongSourceChain','ZeroRecipient','ZeroRelayFee',
        'AmountNotGreaterThanFee','UnsupportedDestination','InvalidCctpSignature',
        'WrongRelayer',
      ].find(n => msg.includes(n)) ?? 'Simulation reverted'
      return Response.json({ error: `CCTP simulation failed: ${safe}` }, { status: 400 })
    }

    // Relay wallet nonce
    let rpcNonce: number
    try {
      const hex = await rpcCall(
        this.#rpcUrl, 'eth_getTransactionCount', [this.#relayAddress, 'pending']
      ) as string
      rpcNonce = parseInt(hex, 16)
    } catch {
      return Response.json({ error: 'RPC unavailable (nonce read). Retry later.' }, { status: 503 })
    }

    if (this.#reservedNonces.has(rpcNonce)) {
      const holder = this.#reservedNonces.get(rpcNonce)!
      return Response.json({
        error: 'Relay nonce reserved for an unresolved tx. Retry after it confirms.',
        reservedBy: holder,
      }, { status: 503 })
    }

    // Gas price + stale-fee guard
    let gasPrice: bigint
    try {
      gasPrice = BigInt(await rpcCall(this.#rpcUrl, 'eth_gasPrice', []) as string)
    } catch { gasPrice = CCTP_GAS_FLOOR }
    if (gasPrice < CCTP_GAS_FLOOR) gasPrice = CCTP_GAS_FLOOR

    const gasLimit   = CCTP_QUOTE_GAS_CEILING
    const gasCost18  = gasLimit * gasPrice
    const actualCost6 = (gasCost18 + CCTP_USDC_SCALE - 1n) / CCTP_USDC_SCALE
    const requiredRelayFee = actualCost6 + this.#feeMarginUsdc

    if (actualCost6 > this.#maxFeeUsdc)
      return Response.json({
        error: `Gas cost (${actualCost6}) exceeds relay max (${this.#maxFeeUsdc}). Retry later.`,
      }, { status: 503 })
    if (relayFee < requiredRelayFee)
      return Response.json({
        error: `relayFee (${relayFee}) no longer covers relay cost (${requiredRelayFee}). Fetch a new quote.`,
        requiredRelayFee: requiredRelayFee.toString(),
      }, { status: 400 })

    // Sign raw transaction (router contract, routePayment calldata)
    const account = privateKeyToAccount(this.#privateKey)
    const rawTx = await account.signTransaction({
      to: this.#cctpRouterAddress as Address,
      data: routerCalldata,
      nonce: rpcNonce,
      gasPrice,
      gas: gasLimit,
      chainId: this.#chainId,
      type: 'legacy',
    })
    const txHash = keccak256(rawTx)

    // Persist BEFORE broadcast (same sequence as legacy)
    const now2 = Date.now()

    try {
      const currentAlarm = await this.state.storage.getAlarm()
      if (!currentAlarm) {
        await this.state.storage.setAlarm(Date.now() + 15_000)
      }
    } catch {
      return Response.json({ error: 'Storage error (alarm). Retry.' }, { status: 503 })
    }

    try {
      this.state.storage.sql.exec(
        `INSERT INTO cctp_journal (
          cctpIntentKey, legacyRelayKey, signerAddress, destinationDomain, mintRecipient,
          grossAmount, maxCctpFee, relayFee, relayerAddress, quoteExpiry, escrowNonce,
          paymentSig, cctpSig, relayNonce, chainId, routerAddress,
          rawTx, txHash, status, createdAt, updatedAt
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        cctpIntentKey, legacyRelayKey,
        signerAddress.toLowerCase(), destinationDomain, mintRecipient.toLowerCase(),
        grossAmount.toString(), maxCctpFee.toString(), relayFee.toString(),
        this.#relayAddress.toLowerCase(), quoteExpiry.toString(), escrowNonce.toString(),
        paymentSig, cctpSig,
        rpcNonce, this.#chainId, (this.#cctpRouterAddress as string).toLowerCase(),
        rawTx, txHash, 'pending', now2, now2,
      )
    } catch (e) {
      console.error('[relay-do] cctp persist failed:', (e instanceof Error) ? e.constructor.name : 'unknown')
      return Response.json({ error: 'Storage error. Retry.' }, { status: 503 })
    }

    this.#reservedNonces.set(rpcNonce, legacyRelayKey)

    // Broadcast
    let broadcastOk = false
    try {
      await rpcCall(this.#rpcUrl, 'eth_sendRawTransaction', [rawTx])
      broadcastOk = true
    } catch (e) {
      const eName = e instanceof Error ? e.constructor.name : 'unknown'
      console.error('[relay-do] cctp broadcast type:', eName, 'txHash:', txHash)
    }

    if (broadcastOk) {
      this.state.storage.sql.exec(
        `UPDATE cctp_journal SET status='broadcast', updatedAt=? WHERE cctpIntentKey=?`,
        Date.now(), cctpIntentKey,
      )
    }

    return Response.json({ txHash, status: 'pending' }, { status: 202 })
  }

  // ── CCTP Status ──────────────────────────────────────────────────────────

  async #handleCctpStatus(url: URL): Promise<Response> {
    try { this.#assertReady() } catch {
      return Response.json({ error: 'Relay not available.' }, { status: 503 })
    }

    const txHash = url.searchParams.get('txHash')
    const cctpIntentKey = url.searchParams.get('cctpIntentKey')

    if (!txHash && !cctpIntentKey)
      return Response.json({ error: 'Provide txHash or cctpIntentKey.' }, { status: 400 })

    let row: CctpJournalEntry | null = null
    if (cctpIntentKey) {
      row = this.#getCctpRow(cctpIntentKey)
    } else if (txHash) {
      const rows = [...this.state.storage.sql.exec<CctpJournalEntry>(
        `SELECT * FROM cctp_journal WHERE txHash=?`, txHash
      )]
      row = rows[0] ?? null
    }

    if (!row)
      return Response.json({ error: 'CCTP payment not found.' }, { status: 404 })

    // Safe public status — never expose raw sigs or full journal
    return Response.json({
      status:            row.status,
      txHash:            row.txHash,
      sourceTxHash:      row.sourceTxHash,
      destTxHash:        row.destTxHash,
      netAmountDelivered: row.netAmountDelivered,
      destinationDomain: row.destinationDomain,
      mintRecipient:     row.mintRecipient,
      grossAmount:       row.grossAmount,
      maxCctpFee:        row.maxCctpFee,
      createdAt:         row.createdAt,
      updatedAt:         row.updatedAt,
      ...(row.errorMsg ? { errorMsg: row.errorMsg } : {}),
    })
  }
}

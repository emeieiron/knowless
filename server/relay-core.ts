/**
 * relay-core.ts — injectable relay logic (broadcast queue, HMAC, gas estimation).
 *
 * All external I/O (RPC calls, raw-tx broadcast) is injected via `RelayTransport`
 * so unit tests can stub them without starting a live RPC connection.
 *
 * PERSIST-BEFORE-BROADCAST INVARIANT
 * ────────────────────────────────────
 * The sequence inside _processRelay() is:
 *   1. Check intent/relay keys (idempotent hit → return recorded state)
 *   2. Check relay-nonce reservation (unresolved nonce → 503)
 *   3. Read on-chain link state and nonce (fail-closed)
 *   4. Simulate (fail-closed)
 *   5. Reserve relay wallet nonce (in-memory lock before alloc)
 *   6. Sign the raw transaction → derive txHash deterministically
 *   7. journal.writeNew(entry with status="pending", rawTx, txHash)  ← THROWS on failure
 *   8. Only if (7) succeeds: transport.sendRawTransaction(rawTx)
 *   9. journal.updateStatus → "broadcast"; release nonce reservation on confirmed/failed
 *  10. Return { txHash, status: "pending" }
 *
 * A crash between (7) and (8) leaves a "pending" entry with the full raw tx in
 * the journal. On next boot, recoverPending() re-sends it verbatim.
 * A crash between (8) and (9) leaves a "pending" entry; recovery re-sends the
 * identical raw tx — the node deduplicates by hash and returns the known hash.
 *
 * NONCE RESERVATION
 * ──────────────────
 * Once a relay nonce is committed (journal entry written), it is reserved until
 * the journal entry reaches 'confirmed' or 'failed'. While reserved, no new
 * allocation with that nonce is allowed — even if the RPC still reports the
 * pre-broadcast account nonce (which is normal for pending txs). This prevents
 * two raw transactions from sharing the same relay nonce after a timeout.
 *
 * FEE ESTIMATION
 * ──────────────
 * buildQuote uses a conservative upper-bound (QUOTE_GAS_CEILING, 250 000 gas)
 * rather than calling estimateGas with a zero-fee/all-zeros signature (which
 * would revert). The actual gas is estimated with the real signed calldata just
 * before broadcast; if the re-estimate exceeds maxFeeUsdc the relay rejects
 * rather than silently clamping.
 */

import {
  type Hex, type Address, keccak256,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { RelayJournal } from './relay-journal.js'
import {
  type JournalEntry,
  makeIntentKey, makeRelayKey, validateEntryDeep,
  deriveHmacSecret, signQuote, verifyQuote,
  encodeExecutePayment, checkPaymentExecutedLog,
  type QuotePayload, type OnChainReceipt,
} from './relay-codec.js'

// ── Types ─────────────────────────────────────────────────────────────────

export interface LinkInfo {
  issuer: Address
  balance: bigint
  feeBalance: bigint
  expiry: bigint
  active: boolean
}

// OnChainReceipt and encodeExecutePayment are imported from relay-codec.ts; re-export for callers
export type { OnChainReceipt }
export { encodeExecutePayment, deriveHmacSecret, signQuote, verifyQuote }

export interface RelayTransport {
  getGasPrice(): Promise<bigint>
  getNonce(address: Address): Promise<number>
  estimateContractGas(params: EstimateGasParams): Promise<bigint>
  simulateExecutePayment(params: ExecuteParams): Promise<void>
  getLinkInfo(signerAddress: Address): Promise<LinkInfo>
  getUsedNonce(signerAddress: Address, nonce: bigint): Promise<boolean>
  sendRawTransaction(rawTx: Hex): Promise<Hex>
  /** Fetch transaction receipt; returns null if not yet mined. Throws on RPC error. */
  getTransactionReceipt(txHash: Hex): Promise<OnChainReceipt | null>
}

export interface EstimateGasParams {
  contractAddress: Address
  signerAddress: Address
  recipient: Address
  amount: bigint
  fee: bigint
  feeRecipient: Address
  quoteExpiry: bigint
  nonce: bigint
  sig: Hex
}

export interface ExecuteParams {
  contractAddress: Address
  signerAddress: Address
  recipient: Address
  amount: bigint
  fee: bigint
  feeRecipient: Address
  quoteExpiry: bigint
  nonce: bigint
  sig: Hex
  from: Address
}

// QuotePayload is imported from relay-codec.ts
export type { QuotePayload }

export interface RelayRequest {
  signerAddress: Address
  recipient: Address
  amount: bigint
  fee: bigint
  feeRecipient: Address
  quoteExpiry: bigint
  nonce: bigint
  sig: Hex
  chainId: number
  quoteToken: string
}

export interface RelayResult {
  status: number
  body: Record<string, unknown>
}

export interface RelayConfig {
  chainId: number
  contractAddress: Address
  relayAddress: Address
  privateKey: Hex
  maxFeeUsdc: bigint
  feeMarginUsdc: bigint
  quoteTtlS: number
  arcGasFloor: bigint
  journalDir: string
  /** Optional override for maximum concurrent queue depth (default: 64). Useful for tests. */
  maxQueueDepth?: number
}

// Conservative gas upper bound used for quotes (no real sig available at quote time).
// Covers the full executePayment path including fee transfer + safety margin.
// Deliberately not a simulation result — a zero-sig sim would always revert.
const QUOTE_GAS_CEILING = 250_000n  // conservative upper bound for quoting

// ── RelayCore ─────────────────────────────────────────────────────────────

// Maximum concurrent queued+executing relay operations.
// Requests that arrive when the queue is full are rejected immediately rather
// than accumulating unbounded promises.
const MAX_QUEUE_DEPTH = 64

export class RelayCore {
  private readonly cfg: RelayConfig
  readonly journal: RelayJournal
  readonly hmacSecret: string
  private broadcastQueue: Promise<unknown> = Promise.resolve()
  private queueDepth = 0

  /**
   * Relay nonces that are currently reserved (committed to journal, but
   * whose journal entry has not yet reached 'confirmed' or 'failed').
   * Key: relayNonce (number). Value: relayKey that holds the reservation.
   *
   * Populated from journal on construction so restarts preserve reservations.
   */
  private readonly reservedNonces = new Map<number, string>()

  /**
   * RelayCore's own readiness gate — awaits both the journal's readinessPromise
   * AND its own per-entry deep validation against cfg.relayAddress/chainId/contractAddress.
   *
   * This gate runs regardless of how the journal was constructed (i.e. even if
   * the journal was injected without optional configuredRelayAddress). This prevents
   * a journal constructed without sender expectations from bypassing sender checks.
   */
  readonly readinessPromise: Promise<void>

  constructor(cfg: RelayConfig, journal: RelayJournal) {
    this.cfg = cfg
    this.journal = journal
    this.hmacSecret = deriveHmacSecret(cfg.privateKey)
    // Restore nonce reservations from persisted journal entries
    for (const entry of journal.getPendingEntries()) {
      this.reservedNonces.set(entry.relayNonce, entry.relayKey)
    }
    // Start own readiness validation — this runs in addition to, or instead of,
    // the journal's own validation (which may have been constructed without config).
    this.readinessPromise = this._runReadiness()
  }

  /**
   * RelayCore's own async readiness check.
   * Awaits the journal's readinessPromise, then re-validates every unresolved
   * entry against the CURRENT cfg.relayAddress, cfg.chainId, cfg.contractAddress
   * using validateEntryDeep.
   *
   * If the journal was already constructed with the same expectations, this is a
   * fast no-op (deep validation already passed). If the journal was constructed
   * without optional args (e.g. in a test that injects a fresh journal), this
   * provides the mandatory config-bound gate.
   *
   * Sets self._readinessError if any check fails — callers must use
   * _awaitReadiness() rather than reading the journal's available flag.
   */
  private _readinessError: string | null = null
  /** Non-null when RelayCore's own deep validation found an error. */
  get coreReadinessError(): string | null { return this._readinessError }

  private async _runReadiness(): Promise<void> {
    // First wait for journal's own promise (shallow + its own deep if configured)
    await this.journal.readinessPromise.catch(() => undefined)

    if (this.journal.journalError) {
      this._readinessError = this.journal.journalError
      return
    }

    // Now re-validate every pending/broadcast entry against current cfg.
    // This catches the case where the journal was constructed without optional args.
    for (const entry of this.journal.getPendingEntries()) {
      const filename = entry.relayKey.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json'

      // Config-level: chainId must match current deployment
      if (entry.chainId !== this.cfg.chainId) {
        this._readinessError = `[relay-core] entry chainId ${entry.chainId} !== cfg.chainId ${this.cfg.chainId} in ${filename}`
        console.error(`[relay-core] READINESS ERROR: ${this._readinessError}`)
        return
      }

      // Config-level: contractAddress must match current deployment
      if (entry.contractAddress.toLowerCase() !== this.cfg.contractAddress.toLowerCase()) {
        this._readinessError = `[relay-core] entry contractAddress ${entry.contractAddress} !== cfg.contractAddress ${this.cfg.contractAddress} in ${filename}`
        console.error(`[relay-core] READINESS ERROR: ${this._readinessError}`)
        return
      }

      // Deep identity: sender must be cfg.relayAddress
      try {
        await validateEntryDeep(entry, this.cfg.relayAddress, filename)
      } catch (err) {
        const msg = (err instanceof Error) ? err.message : String(err)
        this._readinessError = `[relay-core] deep identity check failed for ${filename}: ${msg}`
        console.error(`[relay-core] READINESS ERROR: ${this._readinessError}`)
        return
      }
    }
  }

  /** Await deep validation and refuse if journal is corrupt/unavailable. */
  private async _awaitReadiness(): Promise<RelayResult | null> {
    try {
      await this.readinessPromise
    } catch {
      return { status: 503, body: { error: 'Relay readiness check failed — relay unavailable.' } }
    }
    if (this._readinessError ?? this.journal.journalError) {
      return {
        status: 503,
        body: {
          error: 'Journal/relay error — relay unavailable until operator resolves corruption.',
        },
      }
    }
    return null
  }

  // ── Quote ────────────────────────────────────────────────────────────────

  async buildQuote(
    signerAddress: Address,
    transport: RelayTransport,
  ): Promise<{
    quotedFee: bigint; feeRecipient: Address; quoteExpiry: number
    quoteToken: string; gasEstimate: bigint; gasPrice: bigint; feeBalance: bigint
  }> {
    let linkInfo: LinkInfo
    try {
      linkInfo = await transport.getLinkInfo(signerAddress)
    } catch {
      throw Object.assign(new Error('RPC unavailable. Try again.'), { httpStatus: 503 })
    }
    if (!linkInfo.active)
      throw Object.assign(new Error('Link is not active.'), { httpStatus: 400 })
    if (linkInfo.balance === 0n)
      throw Object.assign(new Error('Link has zero balance.'), { httpStatus: 400 })

    const quoteExpiryS = Math.floor(Date.now() / 1000) + this.cfg.quoteTtlS
    const feeRecipient = this.cfg.relayAddress

    // Fee estimation at quote time uses a conservative gas ceiling (no real sig
    // available; zero-sig simulation always reverts). The actual gas will be
    // re-estimated with the real signed calldata just before broadcast.
    const { quotedFee, gasEstimate, gasPrice } = await this._estimateQuoteFee(transport)

    if (quotedFee > linkInfo.feeBalance) {
      throw Object.assign(
        new Error('insufficient_fee_budget'),
        { httpStatus: 400, extra: { quotedFee: quotedFee.toString(), feeBalance: linkInfo.feeBalance.toString() } },
      )
    }

    const payload: QuotePayload = {
      signerAddress: signerAddress.toLowerCase(),
      quotedFee: quotedFee.toString(),
      feeRecipient: feeRecipient.toLowerCase(),
      quoteExpiry: quoteExpiryS,
      issuedAt: Math.floor(Date.now() / 1000),
    }
    const quoteToken = signQuote(payload, this.hmacSecret)
    return { quotedFee, feeRecipient, quoteExpiry: quoteExpiryS, quoteToken, gasEstimate, gasPrice, feeBalance: linkInfo.feeBalance }
  }

  // ── Relay ────────────────────────────────────────────────────────────────

  async enqueueRelay(req: RelayRequest, transport: RelayTransport): Promise<RelayResult> {
    // Await deep validation and refuse if journal is corrupt/unavailable.
    const notReady = await this._awaitReadiness()
    if (notReady) return notReady

    const relayKey = makeRelayKey(req.signerAddress, req.nonce.toString())

    // Quote-token is required for NEW submissions; journaled entries bypass
    // HMAC re-verification (the tx is already signed — quote expiry is irrelevant).
    const journaledByRelayKey = this.journal.getByRelayKey(relayKey)
    const qp = verifyQuote(req.quoteToken, this.hmacSecret)

    if (!qp && !journaledByRelayKey) {
      return { status: 401, body: { error: 'Invalid or tampered quoteToken.' } }
    }
    if (!journaledByRelayKey) {
      // Full quote validation for fresh submissions
      if (Math.floor(Date.now() / 1000) > qp!.quoteExpiry)
        return { status: 400, body: { error: 'Quote token expired. Fetch a new quote.' } }
      if (qp!.signerAddress !== req.signerAddress.toLowerCase())
        return { status: 400, body: { error: 'quoteToken signerAddress mismatch.' } }
      if (qp!.feeRecipient !== req.feeRecipient.toLowerCase())
        return { status: 400, body: { error: 'quoteToken feeRecipient mismatch.' } }
      if (qp!.feeRecipient !== this.cfg.relayAddress.toLowerCase())
        return { status: 400, body: { error: 'feeRecipient must be the relay wallet.' } }
      if (qp!.quoteExpiry !== Number(req.quoteExpiry))
        return { status: 400, body: { error: 'quoteToken quoteExpiry mismatch.' } }
      const quotedFeeMin = BigInt(qp!.quotedFee)
      if (req.fee < quotedFeeMin)
        return { status: 400, body: { error: `fee ${req.fee} below required quote ${quotedFeeMin}.` } }
      if (req.fee > this.cfg.maxFeeUsdc)
        return { status: 400, body: { error: `fee ${req.fee} exceeds max ${this.cfg.maxFeeUsdc}.` } }
    }

    return this._enqueue(() => this._processRelay(req, transport))
  }

  // ── Recovery (called on boot) ────────────────────────────────────────────

  async recoverPending(transport: RelayTransport): Promise<void> {
    // Await RelayCore's own readiness (which includes journal + cfg-level + sender checks)
    await this.readinessPromise.catch(() => undefined)
    if (this.journal.journalError) {
      console.error('[relay] recoverPending skipped: journal has error:', this.journal.journalError)
      return
    }
    if (this._readinessError) {
      console.error('[relay] recoverPending skipped: relay-core readiness error:', this._readinessError)
      return
    }
    const pending = this.journal.getPendingEntries()
    if (pending.length === 0) return
    console.log(`[relay] recovering ${pending.length} pending journal entries`)
    for (const entry of pending) {
      await this._enqueue(() => this._recoverEntry(entry, transport))
    }
  }

  // ── Private: queue ───────────────────────────────────────────────────────

  private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const limit = this.cfg.maxQueueDepth ?? MAX_QUEUE_DEPTH
    if (this.queueDepth >= limit) {
      return Promise.reject(Object.assign(
        new Error('relay queue at capacity — try again later'),
        { httpStatus: 503 },
      ))
    }
    this.queueDepth++
    const task = (): Promise<T> => {
      const p = fn()
      p.then(() => { this.queueDepth-- }, () => { this.queueDepth-- })
      return p
    }
    const next = this.broadcastQueue.then(task, task)
    this.broadcastQueue = next.then(() => undefined, () => undefined)
    return next
  }

  /** Expose queue depth for health/readiness reporting */
  get currentQueueDepth(): number { return this.queueDepth }

  // ── Private: core relay handler ──────────────────────────────────────────

  private async _processRelay(req: RelayRequest, transport: RelayTransport): Promise<RelayResult> {
    const relayKey  = makeRelayKey(req.signerAddress, req.nonce.toString())
    const intentKey = makeIntentKey(
      req.signerAddress, req.nonce.toString(),
      req.recipient, req.amount.toString(), req.fee.toString(),
      req.feeRecipient, req.quoteExpiry.toString(), req.sig,
    )

    // ── 1. Intent-first lookup ────────────────────────────────────────────
    const byIntent = this.journal.getByIntentKey(intentKey)
    if (byIntent) {
      // Identical retry: if unresolved, re-send the SAME raw tx bytes.
      // Never prepare a new transaction for a recorded intent.
      if (byIntent.status === 'pending' || byIntent.status === 'broadcast') {
        return this._reconcileAndRetry(byIntent, transport)
      }
      return this._statusResponse(byIntent)
    }
    const byRelay = this.journal.getByRelayKey(relayKey)
    if (byRelay) {
      // Same signer+nonce, different intent fields — conflict
      return {
        status: 409,
        body: {
          error: 'Conflicting intent: a different payment is already recorded for this signer+nonce.',
          existingTxHash: byRelay.txHash,
        },
      }
    }

    // ── 2. On-chain reads — fail-closed ───────────────────────────────────
    let linkInfo: LinkInfo
    let nonceUsed: boolean
    try {
      ;[linkInfo, nonceUsed] = await Promise.all([
        transport.getLinkInfo(req.signerAddress),
        transport.getUsedNonce(req.signerAddress, req.nonce),
      ])
    } catch {
      return { status: 503, body: { error: 'RPC unavailable. Retry later.' } }
    }

    if (nonceUsed)
      return { status: 409, body: { error: 'Nonce already used on-chain.' } }
    if (!linkInfo.active)
      return { status: 400, body: { error: 'Link is not active.' } }
    const nowS = BigInt(Math.floor(Date.now() / 1000))
    if (nowS >= linkInfo.expiry)
      return { status: 400, body: { error: 'Link has expired.' } }
    if (nowS >= req.quoteExpiry)
      return { status: 400, body: { error: 'Quote has expired on submission.' } }
    if (req.amount > linkInfo.balance)
      return { status: 400, body: { error: `Amount ${req.amount} exceeds balance ${linkInfo.balance}.` } }
    if (req.fee > linkInfo.feeBalance)
      return { status: 400, body: { error: `Fee ${req.fee} exceeds feeBalance ${linkInfo.feeBalance}.` } }

    // ── 3. Simulate ───────────────────────────────────────────────────────
    try {
      await transport.simulateExecutePayment({
        contractAddress: this.cfg.contractAddress,
        signerAddress: req.signerAddress,
        recipient: req.recipient,
        amount: req.amount,
        fee: req.fee,
        feeRecipient: req.feeRecipient,
        quoteExpiry: req.quoteExpiry,
        nonce: req.nonce,
        sig: req.sig,
        from: this.cfg.relayAddress,
      })
    } catch (e) {
      const msg = (e instanceof Error) ? e.message : ''
      const safe = ['InvalidSignature','InsufficientBalance','NonceUsed','QuoteExpired','WrongFeeRecipient']
        .find(n => msg.includes(n)) ?? 'Simulation reverted'
      return { status: 400, body: { error: `Simulation failed: ${safe}` } }
    }

    // ── 4. Get relay wallet nonce — fail-closed ───────────────────────────
    let rpcNonce: number
    try {
      rpcNonce = await transport.getNonce(this.cfg.relayAddress)
    } catch {
      return { status: 503, body: { error: 'RPC unavailable (nonce read). Retry later.' } }
    }

    // ── 5. Nonce reservation check ────────────────────────────────────────
    // If the RPC nonce == a reserved nonce, the pending tx has not yet mined.
    // We must NOT allocate the same nonce to a new transaction: that would sign
    // two different raw txs with the same relay nonce.
    if (this.reservedNonces.has(rpcNonce)) {
      const holder = this.reservedNonces.get(rpcNonce)!
      return {
        status: 503,
        body: {
          error: 'Relay nonce is reserved for an unresolved pending transaction. Retry after the previous transaction confirms.',
          reservedBy: holder,
        },
      }
    }

    // ── 6. Sign the raw transaction ───────────────────────────────────────
    const calldata = encodeExecutePayment(
      req.signerAddress, req.recipient, req.amount, req.fee,
      req.feeRecipient, req.quoteExpiry, req.nonce, req.sig,
    )
    let gasPrice: bigint
    try { gasPrice = await transport.getGasPrice() } catch { gasPrice = this.cfg.arcGasFloor }
    if (gasPrice < this.cfg.arcGasFloor) gasPrice = this.cfg.arcGasFloor

    // Estimate gas with the REAL signed calldata (not a reverting zero-sig sim).
    // Use the conservative ceiling as fallback only if estimation fails.
    let gasLimit: bigint
    try {
      gasLimit = await transport.estimateContractGas({
        contractAddress: this.cfg.contractAddress,
        signerAddress: req.signerAddress,
        recipient: req.recipient,
        amount: req.amount,
        fee: req.fee,
        feeRecipient: req.feeRecipient,
        quoteExpiry: req.quoteExpiry,
        nonce: req.nonce,
        sig: req.sig,
      }) + 30_000n
    } catch {
      gasLimit = QUOTE_GAS_CEILING
    }

    // Enforce: actual gas cost + margin must not exceed policy max (reject, not clamp)
    // AND the signed fee must cover actual cost + margin (stale-quote guard).
    // If gas price rose between quote and submit, the signed fee may be insufficient.
    const gasCost18 = gasLimit * gasPrice
    const SCALE = 1_000_000_000_000n
    const actualCost6 = (gasCost18 + SCALE - 1n) / SCALE
    const requiredFee = actualCost6 + this.cfg.feeMarginUsdc
    if (actualCost6 > this.cfg.maxFeeUsdc) {
      return {
        status: 503,
        body: {
          error: `Estimated relay cost (${actualCost6}) exceeds policy maximum (${this.cfg.maxFeeUsdc}). Retry later.`,
        },
      }
    }
    // Stale-fee guard: the signed fee must cover the current required cost.
    // If gas price rose after the quote, require a new quote rather than
    // silently subsidizing the shortfall from the relay's own balance.
    if (req.fee < requiredFee) {
      return {
        status: 400,
        body: {
          error: `Signed fee (${req.fee}) no longer covers current relay cost (${requiredFee}). Fetch a new quote.`,
        },
      }
    }

    const account = privateKeyToAccount(this.cfg.privateKey)
    const rawTx = await account.signTransaction({
      to: this.cfg.contractAddress,
      data: calldata,
      nonce: rpcNonce,
      gasPrice,
      gas: gasLimit,
      chainId: this.cfg.chainId,
    })
    const txHash = keccak256(rawTx)

    // ── 7. Persist BEFORE broadcast (throws on write failure) ─────────────
    const entry: JournalEntry = {
      intentKey, relayKey,
      signerAddress: req.signerAddress.toLowerCase(),
      recipient: req.recipient.toLowerCase(),
      amount: req.amount.toString(),
      fee: req.fee.toString(),
      feeRecipient: req.feeRecipient.toLowerCase(),
      quoteExpiry: req.quoteExpiry.toString(),
      nonce: req.nonce.toString(),
      sig: req.sig,
      relayNonce: rpcNonce,
      chainId: this.cfg.chainId,
      contractAddress: this.cfg.contractAddress.toLowerCase(),
      rawTx,
      txHash,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    // writeNew throws on any filesystem failure — do NOT catch here.
    // If this throws, the nonce reservation is never set, no broadcast occurs.
    this.journal.writeNew(entry)

    // Reserve the nonce NOW (after journal write, before broadcast)
    this.reservedNonces.set(rpcNonce, relayKey)

    // ── 8. Broadcast ──────────────────────────────────────────────────────
    try {
      await transport.sendRawTransaction(rawTx)
    } catch (e) {
      // Sanitize error — never log message which may contain credential-bearing RPC URLs.
      const errType = e instanceof Error ? e.constructor.name : typeof e
      console.error(`[relay] broadcast error type=${errType} txHash=${txHash} (entry persisted, will retry)`)
      // Nonce stays reserved — cannot allocate another tx until this resolves
      return { status: 202, body: { txHash, status: 'pending', note: 'broadcast uncertain' } }
    }

    // ── 9. Mark broadcast ─────────────────────────────────────────────────
    try {
      this.journal.updateStatus(relayKey, 'broadcast')
    } catch (e) {
      console.error('[relay] journal updateStatus broadcast failed:', (e as Error).message)
    }

    return { status: 202, body: { txHash, status: 'pending' } }
  }

  // ── Private: reconcile + retry (identical retry path) ────────────────────

  /**
   * Called when an identical retry arrives for an unresolved (pending/broadcast)
   * journal entry. Checks the on-chain receipt first — if confirmed, marks it
   * and returns success; if reverted, marks it failed; if uncertain, re-sends
   * the IDENTICAL raw transaction (same bytes, same hash, same relay nonce).
   * Never prepares a new transaction.
   */
  private async _reconcileAndRetry(
    entry: JournalEntry,
    transport: RelayTransport,
  ): Promise<RelayResult> {
    // Check receipt first — fail-closed (RPC error = uncertain, keep pending)
    let receipt: OnChainReceipt | null = null
    try {
      receipt = await transport.getTransactionReceipt(entry.txHash as Hex)
    } catch {
      // RPC uncertain — proceed to re-broadcast the saved raw tx
    }

    if (receipt) {
      const txHashMatch = receipt.transactionHash.toLowerCase() === entry.txHash.toLowerCase()
      const contractMatch = (receipt.to ?? '').toLowerCase() === entry.contractAddress.toLowerCase()

      if (txHashMatch && contractMatch) {
        if (receipt.status === '0x0') {
          // Confirmed revert (exact 0x0) — mark failed, release nonce
          try {
            this.journal.updateStatus(entry.relayKey, 'failed')
            this.reservedNonces.delete(entry.relayNonce)
          } catch { /**/ }
          return { status: 400, body: { txHash: entry.txHash, status: 'failed', error: 'Payment definitively failed on-chain.', idempotent: true } }
        }
        // Unknown/malformed status (not '0x1', not '0x0') — uncertain, keep pending
        if (receipt.status !== '0x1') {
          return { status: 202, body: { txHash: entry.txHash, status: 'pending', note: 'receipt status uncertain', idempotent: true } }
        }

        // Successful receipt — verify PaymentExecuted event
        const vResult = checkPaymentExecutedLog(receipt, entry, this.cfg.contractAddress)
        if (vResult.ok) {
          try {
            this.journal.updateStatus(entry.relayKey, 'confirmed', { receiptBlockNumber: Number(vResult.blockNumber) })
            this.reservedNonces.delete(entry.relayNonce)
          } catch { /**/ }
          return { status: 200, body: { txHash: entry.txHash, status: 'confirmed', idempotent: true } }
        }
        // Mined success but event mismatch — uncertain, keep pending
      }
      // Wrong tx hash or contract in receipt — uncertain
    }

    // No receipt or uncertain — re-send identical raw tx
    this.reservedNonces.set(entry.relayNonce, entry.relayKey)
    try {
      await transport.sendRawTransaction(entry.rawTx as Hex)
      try { this.journal.updateStatus(entry.relayKey, 'broadcast') } catch { /**/ }
    } catch (e) {
      // Never log e.message — may contain credential-bearing RPC proxy URL.
      const errType = e instanceof Error ? e.constructor.name : typeof e
      // 'already known' check: use a safe string representation avoiding raw message
      const safeMsg = e instanceof Error ? String(e) : ''
      if (safeMsg.toLowerCase().includes('already known')) {
        try { this.journal.updateStatus(entry.relayKey, 'broadcast') } catch { /**/ }
      }
      console.error(`[relay] retry broadcast type=${errType} txHash=${entry.txHash}`)
      // All other errors: keep pending, nonce stays reserved
    }
    return { status: 202, body: { txHash: entry.txHash, status: 'pending', idempotent: true } }
  }

  // ── Private: recovery ────────────────────────────────────────────────────

  private async _recoverEntry(entry: JournalEntry, transport: RelayTransport): Promise<void> {
    console.log(`[relay] recovering entry relayKey=${entry.relayKey} txHash=${entry.txHash}`)
    // Ensure the reservation is set before attempting broadcast
    this.reservedNonces.set(entry.relayNonce, entry.relayKey)
    try {
      await transport.sendRawTransaction(entry.rawTx as Hex)
      this.journal.updateStatus(entry.relayKey, 'broadcast')
      console.log(`[relay] recovery broadcast ok txHash=${entry.txHash}`)
    } catch (e) {
      // Never log e.message — may contain credential-bearing RPC proxy URL.
      const errType = e instanceof Error ? e.constructor.name : typeof e
      const safeStr = e instanceof Error ? String(e) : ''
      if (safeStr.includes('already known')) {
        try { this.journal.updateStatus(entry.relayKey, 'broadcast') } catch { /**/ }
        console.log(`[relay] recovery: tx already known txHash=${entry.txHash}`)
      } else {
        // All other errors (nonce-too-low, timeout, etc.) — keep 'pending', nonce
        // stays reserved. Only confirmed receipt evidence may clear a reservation.
        console.error(`[relay] recovery broadcast uncertain type=${errType} txHash=${entry.txHash}`)
      }
    }
  }

  /**
   * Mark a journal entry as confirmed and release its relay nonce reservation.
   * Must be called only when a real PaymentExecuted receipt is verified.
   */
  markConfirmed(relayKey: string, receiptBlockNumber: number): void {
    const entry = this.journal.getByRelayKey(relayKey)
    if (!entry) return
    try {
      this.journal.updateStatus(relayKey, 'confirmed', { receiptBlockNumber })
      this.reservedNonces.delete(entry.relayNonce)
    } catch (e) {
      console.error('[relay] markConfirmed journal write failed:', (e as Error).message)
    }
  }

  /**
   * Mark a journal entry as definitively failed and release its relay nonce reservation.
   * Must be called only when the on-chain authorization expiry makes a second
   * authorization safe (link expired, nonce used by a different path, etc.).
   */
  markFailed(relayKey: string): void {
    const entry = this.journal.getByRelayKey(relayKey)
    if (!entry) return
    try {
      this.journal.updateStatus(relayKey, 'failed')
      this.reservedNonces.delete(entry.relayNonce)
    } catch (e) {
      console.error('[relay] markFailed journal write failed:', (e as Error).message)
    }
  }

  // ── Private: response helper ─────────────────────────────────────────────

  private _statusResponse(entry: JournalEntry): RelayResult {
    if (entry.status === 'confirmed') {
      return { status: 200, body: { txHash: entry.txHash, status: 'confirmed', idempotent: true } }
    }
    if (entry.status === 'failed') {
      return { status: 400, body: { txHash: entry.txHash, status: 'failed', error: 'Payment definitively failed.', idempotent: true } }
    }
    return { status: 202, body: { txHash: entry.txHash, status: 'pending', idempotent: true } }
  }

  // ── Private: fee estimation (quote-time) ──────────────────────────────────
  // Uses QUOTE_GAS_CEILING (documented upper bound) rather than a simulation
  // that would revert. The actual broadcast uses estimateContractGas with the
  // real signed calldata.

  private async _estimateQuoteFee(
    transport: RelayTransport,
  ): Promise<{ quotedFee: bigint; gasEstimate: bigint; gasPrice: bigint }> {
    let gasPrice: bigint
    try { gasPrice = await transport.getGasPrice() } catch { gasPrice = this.cfg.arcGasFloor }
    if (gasPrice < this.cfg.arcGasFloor) gasPrice = this.cfg.arcGasFloor

    const gasEstimate = QUOTE_GAS_CEILING

    const gasCost18 = gasEstimate * gasPrice
    const SCALE = 1_000_000_000_000n
    const gasCost6 = (gasCost18 + SCALE - 1n) / SCALE
    const requiredFee = gasCost6 + this.cfg.feeMarginUsdc

    // REJECT if required fee exceeds policy maximum — do NOT silently clamp.
    // Silently reducing the quoted fee below actual cost would cause the relay
    // to subsidize payments out of its own balance.
    if (requiredFee > this.cfg.maxFeeUsdc) {
      throw Object.assign(
        new Error(`Relay gas cost (${requiredFee}) exceeds configured max fee (${this.cfg.maxFeeUsdc}). Operator must raise RELAY_MAX_FEE_USDC or lower gas price.`),
        { httpStatus: 503 },
      )
    }

    return { quotedFee: requiredFee, gasEstimate, gasPrice }
  }
}

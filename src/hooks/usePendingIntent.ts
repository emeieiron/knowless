/**
 * Persists a signed payment intent (no private key) to sessionStorage so that
 * a page reload can recover the pending tx without creating a new payment authorization.
 *
 * Polling lifecycle: uses a per-effect generation number to avoid the shared-ref
 * stall that occurs in React StrictMode double-invocation:
 *   - On mount, a new generation is started.
 *   - The cleanup sets cancelled=true AND clears the active generation ref so the
 *     next effect (re-mount or dependency change) always starts a fresh generation.
 *   - A generation that is no longer the active one silently exits without
 *     resetting the active generation ref.
 * This ensures polling always resumes after a remount or dependency change.
 *
 * State machine:
 *   null               — no pending intent
 *   { txHash: null }   — signed but not yet submitted
 *   { txHash: '0x...' } — submitted; poll for receipt
 *
 * Receipt validation: uses pollAndValidateReceipt() from receiptValidator.ts.
 * See receiptValidator.ts for full validation rules.
 *
 * PERSISTENCE FAILURE: saveIntent() returns null on success, or an error string
 * on failure (e.g. storage quota). Caller MUST check before submitting.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Hex, Address } from 'viem'
import {
  pollAndValidateReceipt,
  type ReceiptValidationConfig,
} from '@/lib/receiptValidator'

export interface PendingIntent {
  signerAddress: Address
  recipient: Address
  amount: bigint
  fee: bigint
  feeRecipient: Address
  quoteExpiry: bigint
  quoteToken: string
  nonce: bigint
  sig: Hex
  txHash: Hex | null   // null = not yet submitted
  chainId: number
  contractAddress: Address  // configures receipt validation
  submittedAt: number  // ms timestamp
}

interface StoredIntent {
  signerAddress: string
  recipient: string
  amount: string
  fee: string
  feeRecipient: string
  quoteExpiry: string
  quoteToken: string
  nonce: string
  sig: string
  txHash: string | null
  chainId: number
  contractAddress: string
  submittedAt: number
}

export type ReceiptStatus = 'pending' | 'success' | 'failed'

interface UsePendingIntentResult {
  intent: PendingIntent | null
  receiptStatus: ReceiptStatus | null
  receiptTxHash: Hex | null
  persistError: string | null
  /**
   * Persist the intent to sessionStorage and set it in state.
   * Returns null on success, or an error message string on failure.
   * The caller MUST check the return value and abort submission if non-null.
   */
  saveIntent: (intent: Omit<PendingIntent, 'submittedAt'>) => string | null
  updateTxHash: (txHash: Hex) => void
  clearIntent: () => void
  /** Force an immediate poll cycle (increments a tick that the effect depends on). */
  pollNow: () => void
}

const STORAGE_KEY_PREFIX = 'spookly:pending-intent:'
const POLL_INTERVAL_MS   = 3_000

export function intentKey(signerAddress: Address): string {
  return `${STORAGE_KEY_PREFIX}${signerAddress.toLowerCase()}`
}

export function serialize(i: PendingIntent): StoredIntent {
  return {
    signerAddress:   i.signerAddress,
    recipient:       i.recipient,
    amount:          i.amount.toString(),
    fee:             i.fee.toString(),
    feeRecipient:    i.feeRecipient,
    quoteExpiry:     i.quoteExpiry.toString(),
    quoteToken:      i.quoteToken,
    nonce:           i.nonce.toString(),
    sig:             i.sig,
    txHash:          i.txHash,
    chainId:         i.chainId,
    contractAddress: i.contractAddress,
    submittedAt:     i.submittedAt,
  }
}

export function deserialize(s: StoredIntent): PendingIntent {
  return {
    signerAddress:   s.signerAddress as Address,
    recipient:       s.recipient as Address,
    amount:          BigInt(s.amount),
    fee:             BigInt(s.fee),
    feeRecipient:    s.feeRecipient as Address,
    quoteExpiry:     BigInt(s.quoteExpiry),
    quoteToken:      s.quoteToken ?? '',
    nonce:           BigInt(s.nonce),
    sig:             s.sig as Hex,
    txHash:          s.txHash as Hex | null,
    chainId:         s.chainId,
    contractAddress: (s.contractAddress ?? '') as Address,
    submittedAt:     s.submittedAt,
  }
}

export function loadStored(signerAddress: Address): PendingIntent | null {
  try {
    const raw = sessionStorage.getItem(intentKey(signerAddress))
    if (!raw) return null
    return deserialize(JSON.parse(raw) as StoredIntent)
  } catch { return null }
}

/**
 * Attempt to persist the intent to sessionStorage.
 * Returns null on success, or an error message string on failure.
 */
export function storeIntent(i: PendingIntent): string | null {
  try {
    sessionStorage.setItem(intentKey(i.signerAddress), JSON.stringify(serialize(i)))
    return null
  } catch (e) {
    return (e instanceof Error) ? e.message : 'sessionStorage write failed'
  }
}

export function clearStored(signerAddress: Address): void {
  try { sessionStorage.removeItem(intentKey(signerAddress)) }
  catch { /* ignore */ }
}

export function usePendingIntent(
  signerAddress: Address | null,
  rpcUrl: string,
  contractAddress: Address,
): UsePendingIntentResult {
  const [intent, setIntent] = useState<PendingIntent | null>(() =>
    signerAddress ? loadStored(signerAddress) : null
  )
  const [receiptStatus, setReceiptStatus]   = useState<ReceiptStatus | null>(
    // On mount: if a stored intent already has a txHash, immediately show pending
    () => signerAddress ? (loadStored(signerAddress)?.txHash ? 'pending' : null) : null
  )
  const [receiptTxHash, setReceiptTxHash]   = useState<Hex | null>(null)
  const [persistError,  setPersistError]    = useState<string | null>(null)
  const [pollTick, setPollTick]             = useState(0)

  /**
   * Two refs for polling lifecycle:
   *   seqRef   — monotonically increasing sequence counter; NEVER reset.
   *              Each effect invocation claims the next sequence number.
   *   activeGenRef — the sequence number of the currently-active poll loop.
   *              Set when a loop starts; cleared (set to 0) only when the owning
   *              loop exits or is cancelled.  An old loop checks that its own
   *              sequence is still active before mutating state or resetting the
   *              active-generation value.
   *
   * Because seqRef only ever increases, an old finaliser that runs after cleanup
   * will find activeGenRef.current !== its own gen and will NOT overwrite the
   * newer loop's active generation.
   */
  const seqRef       = useRef(0)   // monotonic, never reset
  const activeGenRef = useRef(0)   // which gen is currently running (0 = none)

  // Load from storage when signerAddress changes (page reload recovery).
  useEffect(() => {
    if (!signerAddress) { setIntent(null); setReceiptStatus(null); return }
    const stored = loadStored(signerAddress)
    setIntent(stored)
    setReceiptStatus(stored?.txHash ? 'pending' : null)
    setReceiptTxHash(null)
    setPersistError(null)
  // signerAddress is the only dependency that should reload from storage
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signerAddress])

  const pollNow = useCallback(() => setPollTick(t => t + 1), [])

  // Poll for receipt — validated against contract/intent fields.
  // Uses a generation counter to survive StrictMode double-invocation cleanly.
  useEffect(() => {
    if (!intent?.txHash) return
    if (receiptStatus === 'success' || receiptStatus === 'failed') return

    // Claim the next monotonic sequence number for this effect invocation.
    // seqRef is never reset, so an old finaliser can never reclaim a gen value
    // that belongs to a newer loop.
    const gen = seqRef.current + 1
    seqRef.current = gen
    activeGenRef.current = gen

    let cancelled = false

    const cfg: ReceiptValidationConfig = {
      contractAddress: intent.contractAddress || contractAddress,
      chainId: intent.chainId,
    }

    const forValidation = {
      signerAddress: intent.signerAddress,
      recipient: intent.recipient,
      feeRecipient: intent.feeRecipient,
      amount: intent.amount,
      fee: intent.fee,
      nonce: intent.nonce,
      txHash: intent.txHash,
    }

    const poll = async () => {
      while (!cancelled && activeGenRef.current === gen) {
        try {
          const result = await pollAndValidateReceipt(rpcUrl, intent.txHash as Hex, forValidation, cfg)
          if (cancelled || activeGenRef.current !== gen) break
          if (result === 'success') {
            setReceiptStatus('success')
            setReceiptTxHash(intent.txHash)
            clearStored(intent.signerAddress)
            break
          } else if (result === 'failed') {
            setReceiptStatus('failed')
            setReceiptTxHash(intent.txHash)
            break
          }
          // 'pending' → keep polling
        } catch { /* network error — keep polling */ }

        // Wait before next poll (also cancellable)
        await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS))
      }
      // Only clear the active generation if WE are still the active generation
      if (activeGenRef.current === gen) {
        activeGenRef.current = 0
      }
    }

    void poll()
    return () => {
      cancelled = true
      // Clear active generation so the next effect always starts fresh
      if (activeGenRef.current === gen) {
        activeGenRef.current = 0
      }
    }
  // pollTick allows force-poll; rpcUrl/contractAddress changes restart the loop
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.txHash, receiptStatus, pollTick, rpcUrl, contractAddress])

  const saveIntent = useCallback((newIntent: Omit<PendingIntent, 'submittedAt'>): string | null => {
    const full: PendingIntent = { ...newIntent, submittedAt: Date.now() }
    const err = storeIntent(full)
    if (err) {
      // Persistence failed — surface the error synchronously.
      // Do NOT call setIntent: caller must not proceed to network submission.
      setPersistError(err)
      return err
    }
    setIntent(full)
    setReceiptStatus(null)
    setReceiptTxHash(null)
    setPersistError(null)
    // activeGenRef.current stays as-is; the polling effect will not run until txHash
    // is set, at which point it claims a fresh seqRef generation.
    return null
  }, [])

  const updateTxHash = useCallback((txHash: Hex) => {
    setIntent(prev => {
      if (!prev) return prev
      const updated = { ...prev, txHash }
      const err = storeIntent(updated)
      if (err) setPersistError(err)
      return updated
    })
    setReceiptStatus('pending')
  }, [])

  const clearIntent = useCallback(() => {
    if (intent?.signerAddress) clearStored(intent.signerAddress)
    setIntent(null)
    setReceiptStatus(null)
    setReceiptTxHash(null)
    setPersistError(null)
    // seqRef is never reset; activeGenRef clears when the polling effect cleans up.
  }, [intent])

  return {
    intent, receiptStatus, receiptTxHash, persistError,
    saveIntent, updateTxHash, clearIntent, pollNow,
  }
}

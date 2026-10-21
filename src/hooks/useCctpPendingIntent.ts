/**
 * useCctpPendingIntent — persists and restores a CCTP cross-chain payout intent.
 *
 * Keyed by signerAddress (same as the link). One CCTP intent per link.
 * Separate from the legacy Arc-direct intent so neither overwrites the other.
 *
 * The signing key (privateKey) is NEVER persisted. Only public data is stored:
 * - both EIP-712 signatures (already public once submitted to relay)
 * - relay txHash and submitted status
 * - destination domain and mintRecipient
 *
 * Status polling is done at the component level; this hook only manages storage.
 */

import { useState, useCallback } from 'react'
import type { Address, Hex } from 'viem'

export type CctpPayoutStatus =
  | 'signing'             // generating signatures in-browser
  | 'submitting'          // sending to /relay/cctp/submit
  | 'pending'             // submitted, awaiting source broadcast
  | 'source_confirmed'    // source tx confirmed on Arc
  | 'mint_pending'        // Circle is forwarding to destination
  | 'mint_confirmed'      // destination delivery verified
  | 'mint_failed'         // forwarding/destination delivery failed
  | 'failed'              // terminal failure (source failed)

export interface CctpPayoutIntent {
  signerAddress:     string
  destinationDomain: number
  mintRecipient:     string
  grossAmount:       string   // decimal 6-dec USDC
  maxCctpFee:        string
  relayFee:          string
  escrowNonce:       string
  txHash:            string | null
  sourceTxHash:      string | null
  destTxHash:        string | null
  netAmountDelivered: string | null
  status:            CctpPayoutStatus
  quoteExpiry:       number
  routerAddress:     string
  relayerAddress:    string
  submitBody:        string | null  // JSON.stringify of exact /relay/cctp/submit payload
}

function storageKey(signerAddress: string): string {
  return `spookly:cctp-intent:${signerAddress.toLowerCase()}`
}

function loadFromStorage(signerAddress: string | null): CctpPayoutIntent | null {
  if (!signerAddress) return null
  try {
    const raw = sessionStorage.getItem(storageKey(signerAddress))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CctpPayoutIntent
    // Verify it's for this signer
    if (parsed.signerAddress.toLowerCase() !== signerAddress.toLowerCase()) return null
    return parsed
  } catch { return null }
}

function saveToStorage(intent: CctpPayoutIntent): string | null {
  try {
    sessionStorage.setItem(storageKey(intent.signerAddress), JSON.stringify(intent))
    return null
  } catch (e) {
    return (e as Error).message
  }
}

function removeFromStorage(signerAddress: string): void {
  try { sessionStorage.removeItem(storageKey(signerAddress)) } catch { /* ok */ }
}

export function useCctpPendingIntent(signerAddress: Address | null) {
  const [intent, setIntent] = useState<CctpPayoutIntent | null>(() =>
    loadFromStorage(signerAddress)
  )

  const saveIntent = useCallback((newIntent: CctpPayoutIntent): string | null => {
    const err = saveToStorage(newIntent)
    if (!err) setIntent(newIntent)
    return err
  }, [])

  const updateStatus = useCallback((
    txHash: string | null,
    status: CctpPayoutStatus,
    extra?: Partial<Pick<CctpPayoutIntent, 'sourceTxHash' | 'destTxHash' | 'netAmountDelivered'>>
  ) => {
    setIntent(prev => {
      if (!prev) return null
      const updated = { ...prev, txHash: txHash ?? prev.txHash, status, ...extra }
      saveToStorage(updated)
      return updated
    })
  }, [])

  const clearIntent = useCallback(() => {
    if (signerAddress) removeFromStorage(signerAddress)
    setIntent(null)
  }, [signerAddress])

  return { intent, saveIntent, updateStatus, clearIntent }
}

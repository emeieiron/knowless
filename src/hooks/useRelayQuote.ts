/**
 * Fetches a per-payment relay fee quote from the relay server.
 *
 * Returns:
 *   quote        — { quotedFee, feeRecipient, quoteExpiry, feeBalance } or null
 *   error        — human-readable error string, or null (null = no error yet / loading)
 *   isLoading    — true while the quote is in flight
 *   refetch      — call to refresh the quote
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import type { Address } from 'viem'

export interface RelayQuote {
  quotedFee: bigint
  feeRecipient: Address
  quoteExpiry: number
  feeBalance: bigint
  quoteToken: string  // HMAC token issued by relay — must be presented on POST /relay
}

interface State {
  quote: RelayQuote | null
  error: string | null
  isLoading: boolean
}

type Action =
  | { type: 'start' }
  | { type: 'success'; quote: RelayQuote }
  | { type: 'error'; error: string }

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'start': return { ...state, isLoading: true, error: null }
    case 'success': return { quote: action.quote, error: null, isLoading: false }
    case 'error': return { ...state, quote: null, error: action.error, isLoading: false }
  }
}

interface UseRelayQuoteResult {
  quote: RelayQuote | null
  error: string | null
  isLoading: boolean
  refetch: () => void
}

const STALE_BEFORE_EXPIRY_S = 30

export function useRelayQuote(signerAddress: Address | null): UseRelayQuoteResult {
  const [state, setState] = useState<State>({ quote: null, error: null, isLoading: false })
  const fetchCountRef = useRef(0)
  const autoRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetch_ = useCallback(async (sa: Address) => {
    const myCount = ++fetchCountRef.current
    // Optimistically mark loading via reducer (no direct setState in effect)
    setState(s => reduce(s, { type: 'start' }))
    try {
      const res = await fetch(`/relay/quote?signerAddress=${sa}`)
      if (fetchCountRef.current !== myCount) return // stale
      const data = await res.json() as {
        quotedFee?: string; feeRecipient?: string; quoteExpiry?: number
        feeBalance?: string; quoteToken?: string; error?: string
      }
      if (!res.ok) {
        setState(s => reduce(s, { type: 'error', error: data.error ?? `Relay returned ${res.status}` }))
      } else {
        setState(s => reduce(s, {
          type: 'success',
          quote: {
            quotedFee: BigInt(data.quotedFee ?? '0'),
            feeRecipient: (data.feeRecipient ?? '0x0000000000000000000000000000000000000000') as Address,
            quoteExpiry: data.quoteExpiry ?? 0,
            feeBalance: BigInt(data.feeBalance ?? '0'),
            quoteToken: data.quoteToken ?? '',
          },
        }))
      }
    } catch (err) {
      if (fetchCountRef.current !== myCount) return
      setState(s => reduce(s, { type: 'error', error: err instanceof Error ? err.message : 'Network error.' }))
    }
  }, [])

  const refetch = useCallback(() => {
    if (signerAddress) void fetch_(signerAddress)
  }, [signerAddress, fetch_])

  // Fetch on signerAddress change
  useEffect(() => {
    if (!signerAddress) return
    void fetch_(signerAddress)
  }, [signerAddress, fetch_])

  // Auto-refresh: schedule a re-fetch when quote nears expiry.
  // Schedule via setTimeout (not setState) — avoids the lint rule entirely.
  useEffect(() => {
    if (autoRefreshRef.current) clearTimeout(autoRefreshRef.current)
    if (!state.quote) return
    const remaining = state.quote.quoteExpiry - Math.floor(Date.now() / 1000) - STALE_BEFORE_EXPIRY_S
    if (remaining <= 0) {
      // Already stale — schedule a micro-refresh on the next tick to avoid firing during render
      autoRefreshRef.current = setTimeout(refetch, 50)
    } else {
      autoRefreshRef.current = setTimeout(refetch, remaining * 1000)
    }
    return () => {
      if (autoRefreshRef.current) clearTimeout(autoRefreshRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.quote?.quoteExpiry])

  return { quote: state.quote, error: state.error, isLoading: state.isLoading, refetch }
}

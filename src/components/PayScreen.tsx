/**
 * PayScreen — walletless holder payment screen.
 *
 * ARCHITECTURE:
 *   The holder never needs a wallet. All on-chain work is done by the relay server.
 *   The holder's browser:
 *     1. Reads the link fragment → derives signerAddress (no wallet, no network)
 *     2. Fetches a per-payment fee quote from /relay/quote
 *     3. Signs the EIP-712 PaymentAuth off-chain (in-browser secp256k1 using viem)
 *     4. Sends { signerAddress, recipient, amount, fee, nonce, sig, chainId } to /relay
 *     5. Persists the signed intent + txHash to sessionStorage (no private key stored)
 *     6. Polls /relay/health + eth_getTransactionReceipt until confirmed
 *
 * RELAY UNAVAILABLE:
 *   If RELAY_PRIVATE_KEY is not configured in the server, /relay returns 503.
 *   PayScreen renders an "unavailable" state that disables payment and explains what
 *   the operator must do. No wallet prompt, no silent conversion to self-relay.
 *
 * RECOVERY:
 *   On reload, the pending intent is loaded from sessionStorage. If txHash is set,
 *   polling resumes automatically. A new nonce is NEVER generated for a pending intent.
 *
 * RELAY ENDPOINT:
 *   Requests go to /relay (same-origin, proxied to port 4001 by Vite dev proxy).
 *   In production, the relay server must serve both the static frontend and /relay/* routes.
 *
 * NOTE: The private key from the URL fragment is used ONLY to sign in memory.
 *   It is never stored in sessionStorage, sent to the server, or logged.
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import { useReadContract } from 'wagmi'
import type { Address, Hex } from 'viem'
import { SPOOKLY_ABI, ARC_TESTNET_CHAIN_ID } from '../lib/contract'
import {
  decodeLinkFragment,
  deriveSignerAddress,
  signPaymentAuth,
  generateNonce,
  isValidAddress,
} from '../lib/crypto'
import {
  parseUsdcInput,
  formatUsdcFixed,
  formatExpiry,
  truncateAddress,
} from '../lib/format'
import { useRelayQuote } from '../hooks/useRelayQuote'

import { usePendingIntent } from '../hooks/usePendingIntent'

const ARC_EXPLORER = 'https://explorer.testnet.arc.io' // arc-studio-allow-onchain-literal
function buildTxExplorerUrl(_chainId: number, txHash: string): string {
  return `${ARC_EXPLORER}/tx/${txHash}`
}

interface PayScreenProps {
  fragment: string
  contractAddress: Address
  chainId: number
}

// Module-level: no impure calls in render
function epochSeconds(): number { return Math.floor(Date.now() / 1000) }

// Arc Testnet public RPC used only for receipt polling
const ARC_RPC = 'https://rpc.testnet.arc.io' // arc-studio-allow-onchain-literal

// Decode fragment once — pure, sync, called outside the React tree
function decodeFragment(fragment: string, chainId: number, contractAddress: Address): {
  ok: true; privateKey: Hex; signerAddress: Address
} | { ok: false; error: string } {
  if (!fragment) return { ok: false, error: 'Missing link data.' }
  let d: ReturnType<typeof decodeLinkFragment>
  try { d = decodeLinkFragment(fragment) }
  catch { return { ok: false, error: 'Malformed link key — could not decode fragment.' } }
  if (!d) return { ok: false, error: 'This link is malformed or the URL is incomplete.' }
  if (d.chainId !== chainId) return { ok: false, error: `This link is for chain ${d.chainId}, not the current network (${chainId}).` }
  if (d.contractAddress.toLowerCase() !== contractAddress.toLowerCase()) return { ok: false, error: 'This link belongs to a different contract.' }
  // deriveSignerAddress wraps privateKeyToAddress — decodeLinkFragment already validates key format
  // so this only throws on a truly corrupt key, surfaced as an error state rather than an exception
  let signerAddress: Address
  try {
    signerAddress = deriveSignerAddress(d.privateKey)
  } catch {
    return { ok: false, error: 'Malformed link — invalid private key in fragment.' }
  }
  return { ok: true, privateKey: d.privateKey, signerAddress }
}

export function PayScreen({ fragment, contractAddress, chainId }: PayScreenProps) {
  const decoded = useMemo(
    () => decodeFragment(fragment, chainId, contractAddress),
    [fragment, chainId, contractAddress]
  )
  const privateKey = decoded.ok ? decoded.privateKey : null
  const signerAddress: Address | null = decoded.ok ? decoded.signerAddress : null

  // Form state
  const [recipient, setRecipient] = useState('')
  const [amountStr, setAmountStr] = useState('')
  const [recipientError, setRecipientError] = useState('')
  const [amountError, setAmountError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  // Chain reads
  const { data: linkInfoRaw, isLoading: isLinkLoading, isError: isLinkError, refetch: refetchLink } = useReadContract({
    address: contractAddress,
    abi: SPOOKLY_ABI,
    functionName: 'getLinkInfo',
    args: signerAddress ? [signerAddress] : undefined,
    query: { enabled: !!signerAddress },
    chainId: ARC_TESTNET_CHAIN_ID,
  })
  const { data: domainSep, isError: isDomainSepError } = useReadContract({
    address: contractAddress,
    abi: SPOOKLY_ABI,
    functionName: 'domainSeparator',
    chainId: ARC_TESTNET_CHAIN_ID,
  })

  // Relay fee quote
  const { quote: feeQuote, error: quoteError, isLoading: isQuoteLoading, refetch: refetchQuote } = useRelayQuote(signerAddress)

  // Pending intent persistence + receipt polling
  const { intent, receiptStatus, receiptTxHash, saveIntent, updateTxHash, clearIntent } = usePendingIntent(signerAddress, ARC_RPC, contractAddress)

  // Derive link info
  const linkInfo = linkInfoRaw as { balance: bigint; feeBalance: bigint; expiry: bigint; active: boolean } | undefined
  const balance = linkInfo?.balance ?? 0n
  const expiryTs = linkInfo ? Number(linkInfo.expiry) : 0

  // Derived link states — pure from data
  const isLinkInvalid = !decoded.ok
  const isRpcError = !isLinkLoading && isLinkError && !linkInfo
  const isLinkInactive = !isLinkLoading && !!linkInfo && !linkInfo.active
  const isLinkExpired = !isLinkLoading && !!linkInfo && linkInfo.active && expiryTs > 0 && expiryTs < epochSeconds()
  const isLinkReady = !isLinkLoading && !!linkInfo && linkInfo.active && !isLinkExpired

  // Relay availability — determined from quote error (503 = not configured)
  const isRelayUnavailable = !!quoteError && !isQuoteLoading

  // Don't let incoming linkInfo refresh overwrite a terminal receipt state
  const isTerminal = receiptStatus === 'success' || receiptStatus === 'failed'

  // Refetch link info after successful payment to reflect updated balance
  useEffect(() => {
    if (receiptStatus === 'success') { void refetchLink() }
  }, [receiptStatus, refetchLink])

  const parsedAmount = parseUsdcInput(amountStr)

  const validate = useCallback(() => {
    let ok = true
    if (!recipient) { setRecipientError('Enter a recipient address'); ok = false }
    else if (!isValidAddress(recipient)) { setRecipientError('Enter a valid 0x address'); ok = false }
    else setRecipientError('')
    if (!amountStr) { setAmountError('Enter an amount'); ok = false }
    else if (parsedAmount === null) { setAmountError('Enter a valid USDC amount'); ok = false }
    else if (parsedAmount <= 0n) { setAmountError('Amount must be greater than 0'); ok = false }
    else if (parsedAmount > balance) { setAmountError(`Max: ${formatUsdcFixed(balance)} USDC`); ok = false }
    else setAmountError('')
    return ok
  }, [recipient, amountStr, parsedAmount, balance])

  // Submit payment — signs in-browser, sends to relay, persists intent
  const handlePay = useCallback(async () => {
    if (submitting || intent) return
    if (!validate()) return
    if (!privateKey || !signerAddress || parsedAmount === null || !domainSep) return
    if (!feeQuote) { setSubmitError('Waiting for fee quote. Try again.'); return }

    // Check quote expiry
    if (feeQuote.quoteExpiry < epochSeconds() + 30) {
      setSubmitError('Fee quote expired. Refreshing…')
      refetchQuote()
      return
    }

    setSubmitting(true)
    setSubmitError('')

    try {
      const nonce = generateNonce()
      const fee = feeQuote.quotedFee
      const feeRecipient = feeQuote.feeRecipient
      const quoteExpiry = BigInt(feeQuote.quoteExpiry)
      const quoteToken = feeQuote.quoteToken

      const sig = await signPaymentAuth(
        privateKey, contractAddress, signerAddress,
        recipient as Address, parsedAmount, fee,
        feeRecipient, quoteExpiry,
        nonce, BigInt(expiryTs), BigInt(chainId), domainSep
      )

      // Persist intent BEFORE sending to relay — so a crash/reload can recover.
      // saveIntent returns null on success or an error string on failure.
      // If persistence fails we MUST NOT submit: there would be no durable record
      // to recover from after a reload or lost response.
      const persistErr = saveIntent({
        signerAddress, recipient: recipient as Address,
        amount: parsedAmount, fee, feeRecipient, quoteExpiry, quoteToken,
        nonce, sig, txHash: null, chainId, contractAddress,
      })
      if (persistErr) {
        setSubmitError(`Cannot save intent: ${persistErr} — submission aborted. Free up browser storage and retry.`)
        setSubmitting(false)
        return
      }

      // Send to relay
      const res = await fetch('/relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signerAddress, recipient,
          amount: parsedAmount.toString(),
          fee: fee.toString(),
          feeRecipient,
          quoteExpiry: feeQuote.quoteExpiry.toString(),
          nonce: nonce.toString(),
          sig, chainId, quoteToken,
        }),
      })

      const data = await res.json() as { txHash?: string; status?: string; error?: string }

      if (!res.ok) {
        // Do NOT clear intent — same nonce can be retried
        setSubmitError(data.error ?? `Relay error (${res.status}). Retry or contact the link issuer.`)
        setSubmitting(false)
        return
      }

      if (data.txHash) {
        updateTxHash(data.txHash as Hex)
      }
      // txHash pending — polling starts automatically via usePendingIntent
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      setSubmitError(msg.includes('rejected') || msg.includes('cancel') ? 'Signing cancelled.' : `Error: ${msg.slice(0, 120)}`)
    } finally {
      setSubmitting(false)
    }
  }, [
    submitting, intent, validate, privateKey, signerAddress, parsedAmount,
    domainSep, feeQuote, refetchQuote, contractAddress, recipient, expiryTs,
    chainId, saveIntent, updateTxHash,
  ])

  // Retry a pending intent — works whether or not txHash is already known.
  // Posts the SAME signed fields/nonce/token; NEVER calls the signer or generates a new nonce.
  // If the relay already broadcast this tx it will return the SAME txHash (idempotent).
  // After a successful response, resumes receipt polling via updateTxHash.
  const handleRetryRelay = useCallback(async () => {
    if (!intent || submitting) return
    setSubmitting(true)
    setSubmitError('')
    try {
      const res = await fetch('/relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signerAddress: intent.signerAddress,
          recipient: intent.recipient,
          amount: intent.amount.toString(),
          fee: intent.fee.toString(),
          feeRecipient: intent.feeRecipient,
          quoteExpiry: intent.quoteExpiry.toString(),
          nonce: intent.nonce.toString(),
          sig: intent.sig,
          chainId: intent.chainId,
          quoteToken: intent.quoteToken,
        }),
      })
      const data = await res.json() as { txHash?: string; error?: string }
      if (data.txHash) {
        updateTxHash(data.txHash as Hex)
      } else {
        setSubmitError(data.error ?? `Relay error ${res.status}`)
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message.slice(0, 120) : 'Relay unreachable.')
    } finally {
      setSubmitting(false)
    }
  }, [intent, submitting, updateTxHash])

  // ── Render ─────────────────────────────────────────────────────────────

  if (isLinkInvalid) {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 gap-4 text-center">
        <span className="text-4xl" aria-hidden>👻</span>
        <p className="font-semibold text-xl display" style={{ color: 'var(--ink)' }}>Invalid link</p>
        <p className="text-sm max-w-xs" style={{ color: 'var(--muted)' }}>
          {!decoded.ok ? decoded.error : 'This link is malformed or unsupported.'}
        </p>
      </div>
    )
  }

  if (isLinkLoading && !isRpcError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh gap-4">
        <div className="w-8 h-8 rounded-full border-2 animate-spin"
          style={{ borderColor: 'var(--border-strong)', borderTopColor: 'transparent' }} aria-label="Loading" />
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading link…</p>
      </div>
    )
  }

  if (isRpcError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 gap-4 text-center">
        <span className="text-4xl" aria-hidden>🌐</span>
        <p className="font-semibold text-xl display" style={{ color: 'var(--ink)' }}>Network error</p>
        <p className="text-sm max-w-xs" style={{ color: 'var(--muted)' }}>Could not load link state. Check your connection.</p>
        <button type="button" onClick={() => { void refetchLink() }}
          className="rounded-xl px-4 py-2.5 font-medium text-sm"
          style={{ background: 'var(--accent)', color: '#fff', minHeight: '44px' }}>
          Retry
        </button>
      </div>
    )
  }

  if (isLinkInactive) {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 gap-4 text-center">
        <span className="text-4xl" aria-hidden>👻</span>
        <p className="font-semibold text-xl display" style={{ color: 'var(--ink)' }}>Link is closed</p>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>This link has been cancelled or fully spent.</p>
      </div>
    )
  }

  if (isLinkExpired) {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 gap-4 text-center">
        <span className="text-4xl" aria-hidden>👻</span>
        <p className="font-semibold text-xl display" style={{ color: 'var(--ink)' }}>Link has expired</p>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>The issuer can reclaim the unspent funds.</p>
      </div>
    )
  }

  // ── Success ──
  if (isTerminal && receiptStatus === 'success' && receiptTxHash) {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 gap-5 text-center reveal">
        <div className="w-16 h-16 rounded-full flex items-center justify-center text-2xl"
          style={{ background: 'rgba(26,128,71,0.1)' }} aria-hidden>✓</div>
        <p className="text-3xl font-bold tabular-nums display" style={{ color: 'var(--ink)' }}>
          Paid {intent?.amount !== undefined ? formatUsdcFixed(intent.amount) : ''} USDC
        </p>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Sent to {intent?.recipient ? truncateAddress(intent.recipient) : ''}
        </p>
        <a href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, receiptTxHash)}
          target="_blank" rel="noopener noreferrer"
          className="text-sm underline" style={{ color: 'var(--accent)' }}>
          View confirmed transaction
        </a>
      </div>
    )
  }

  // ── Failed ──
  if (receiptStatus === 'failed') {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 gap-4 text-center">
        <span className="text-4xl" aria-hidden>⚠️</span>
        <p className="font-semibold text-xl display" style={{ color: 'var(--ink)' }}>
          Transaction failed
        </p>
        <p className="text-sm max-w-xs" style={{ color: 'var(--muted)' }}>
          The transaction reverted on-chain. Your funds are safe.
        </p>
        {intent?.txHash && (
          <a href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, intent.txHash)}
            target="_blank" rel="noopener noreferrer"
            className="text-xs underline" style={{ color: 'var(--subtle)' }}>
            View transaction
          </a>
        )}
        <button type="button" onClick={() => { clearIntent(); refetchQuote() }}
          className="rounded-xl px-4 py-2.5 font-medium text-sm"
          style={{ background: 'var(--accent)', color: '#fff', minHeight: '44px' }}>
          Start over
        </button>
      </div>
    )
  }

  // ── Pending / submitting ──
  if (intent?.txHash && receiptStatus === 'pending') {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh px-6 gap-5 text-center">
        <div className="w-10 h-10 rounded-full border-2 animate-spin"
          style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} aria-label="Pending" />
        <p className="font-semibold text-lg display" style={{ color: 'var(--ink)' }}>Confirming…</p>
        <p className="text-sm max-w-xs" style={{ color: 'var(--muted)' }}>
          Your payment is pending on Arc Testnet. Do not close this tab.
        </p>
        <a href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, intent.txHash)}
          target="_blank" rel="noopener noreferrer"
          className="text-xs underline" style={{ color: 'var(--subtle)' }}>
          View pending tx
        </a>
        {submitError && (
          <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>{submitError}</p>
        )}
        <button type="button" onClick={() => { void handleRetryRelay() }}
          disabled={submitting}
          className="rounded-xl px-4 py-2 text-xs font-medium disabled:opacity-50"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--ink)', minHeight: '36px' }}>
          {submitting ? 'Checking…' : 'Re-check with relay'}
        </button>
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>
          Sends the same signed authorization — no new signature required.
        </p>
      </div>
    )
  }

  // ── Relay unavailable ──
  if (isRelayUnavailable && !feeQuote) {
    return (
      <div className="flex flex-col min-h-dvh">
        <header className="px-4 py-4 flex items-center gap-2"
          style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-lg" aria-hidden>👻</span>
          <span className="font-semibold display" style={{ color: 'var(--ink)' }}>Spookly</span>
        </header>
        <main className="flex-1 px-4 py-8 max-w-md mx-auto w-full space-y-5 reveal">
          <div className="rounded-2xl px-5 py-5"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <p className="text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--subtle)' }}>Available</p>
            <p className="text-4xl font-bold tabular-nums display" style={{ color: 'var(--ink)' }}>
              {isLinkReady ? formatUsdcFixed(balance) : '—'}
            </p>
            <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>USDC · {formatExpiry(expiryTs)}</p>
          </div>
          <div className="rounded-xl px-4 py-4"
            style={{ background: 'rgba(186,43,76,0.06)', border: '1px solid rgba(186,43,76,0.2)' }}>
            <p className="font-semibold text-sm mb-1" style={{ color: 'var(--danger)' }}>Relay not available</p>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Payment submission requires a configured relay server.
              Contact the person who sent you this link.
            </p>
            <p className="text-xs mt-2 mono" style={{ color: 'var(--subtle)' }}>
              Operator: set RELAY_PRIVATE_KEY in server environment and restart the relay.
            </p>
          </div>
          <button type="button" disabled
            className="w-full rounded-xl py-4 font-bold text-base opacity-40 cursor-not-allowed"
            style={{ background: 'var(--accent)', color: '#fff', minHeight: '56px' }}>
            Pay
          </button>
        </main>
      </div>
    )
  }

  // ── Unsubmitted pending intent (relay failed on first attempt) ──
  if (intent && !intent.txHash && !submitting) {
    return (
      <div className="flex flex-col min-h-dvh">
        <header className="px-4 py-4 flex items-center gap-2"
          style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-lg" aria-hidden>👻</span>
          <span className="font-semibold display" style={{ color: 'var(--ink)' }}>Spookly</span>
        </header>
        <main className="flex-1 px-4 py-6 max-w-md mx-auto w-full space-y-5 reveal">
          <div className="rounded-xl px-4 py-4"
            style={{ background: 'rgba(18,45,69,0.06)', border: '1px solid var(--border)' }}>
            <p className="font-semibold text-sm mb-1" style={{ color: 'var(--ink)' }}>Payment signed — waiting for relay</p>
            <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
              Sending {formatUsdcFixed(intent.amount)} USDC to {truncateAddress(intent.recipient)}.
              The relay will submit this transaction — no new signature needed.
            </p>
            {submitError && (
              <p role="alert" className="text-xs mb-3" style={{ color: 'var(--danger)' }}>{submitError}</p>
            )}
            <button type="button" onClick={() => { void handleRetryRelay() }}
              disabled={submitting}
              className="w-full rounded-xl py-3 font-semibold text-sm disabled:opacity-50"
              style={{ background: 'var(--accent)', color: '#fff', minHeight: '48px' }}>
              {submitting ? 'Retrying…' : 'Retry relay submission'}
            </button>
            <p className="text-xs mt-2 text-center" style={{ color: 'var(--subtle)' }}>
              Your payment is signed and can only be submitted once per authorization.
            </p>
          </div>
        </main>
      </div>
    )
  }

  // ── Normal payment form ──
  const isLoadingQuote = isQuoteLoading && !feeQuote
  const isSubmitting = submitting

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="px-4 py-4 flex items-center gap-2"
        style={{ borderBottom: '1px solid var(--border)' }}>
        <span className="text-lg" aria-hidden>👻</span>
        <span className="font-semibold display" style={{ color: 'var(--ink)' }}>Spookly</span>
      </header>

      <main className="flex-1 px-4 py-6 max-w-md mx-auto w-full space-y-5 reveal">
        {/* Balance card */}
        {isLinkReady && (
          <div className="rounded-2xl px-5 py-5 text-center"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <p className="text-xs uppercase tracking-wider mb-2"
              style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}>Available to spend</p>
            <p className="text-4xl font-bold tabular-nums display" style={{ color: 'var(--ink)' }}>
              {formatUsdcFixed(balance)}
            </p>
            <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>USDC</p>
            <p className="text-xs mt-2" style={{ color: 'var(--subtle)' }}>{formatExpiry(expiryTs)}</p>
          </div>
        )}

        {/* RPC error / domain sep error */}
        {isDomainSepError && (
          <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>
            Could not load contract domain separator — cannot sign. Check network.
          </p>
        )}

        {/* Recipient */}
        <div>
          <label htmlFor="pay-recipient" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--ink-2)' }}>
            Recipient address
          </label>
          <input
            id="pay-recipient" type="text" inputMode="text" placeholder="0x…"
            value={recipient}
            onChange={e => { setRecipient(e.target.value); setRecipientError('') }}
            disabled={isSubmitting}
            className="w-full rounded-xl px-4 py-3 mono outline-none"
            style={{
              background: 'var(--surface-muted)',
              border: `1px solid ${recipientError ? 'var(--danger)' : 'var(--border)'}`,
              color: 'var(--ink)', fontSize: '16px',
            }}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            aria-describedby={recipientError ? 'recipient-error' : undefined}
          />
          {recipientError && (
            <p id="recipient-error" role="alert" className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>
              {recipientError}
            </p>
          )}
        </div>

        {/* Amount */}
        <div>
          <label htmlFor="pay-amount" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--ink-2)' }}>
            Amount
          </label>
          <div className="flex items-center rounded-xl px-4 py-3 gap-2"
            style={{ background: 'var(--surface-muted)', border: `1px solid ${amountError ? 'var(--danger)' : 'var(--border)'}` }}>
            <input
              id="pay-amount" type="text" inputMode="decimal" placeholder="0.00"
              value={amountStr}
              onChange={e => { setAmountStr(e.target.value); setAmountError('') }}
              disabled={isSubmitting}
              className="flex-1 bg-transparent font-semibold outline-none tabular-nums display"
              style={{ color: 'var(--ink)', fontSize: '1.5rem', minWidth: 0 }}
              autoComplete="off" autoCorrect="off" spellCheck={false}
              aria-describedby={amountError ? 'pay-amount-error' : undefined}
            />
            <div className="flex flex-col items-end gap-0.5">
              <span className="font-medium text-sm" style={{ color: 'var(--muted)' }}>USDC</span>
              <button type="button" className="text-xs underline" style={{ color: 'var(--accent)', minHeight: '24px' }}
                onClick={() => setAmountStr(formatUsdcFixed(balance))}>
                Max
              </button>
            </div>
          </div>
          {amountError && (
            <p id="pay-amount-error" role="alert" className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>
              {amountError}
            </p>
          )}
        </div>

        {/* Per-payment fee quote */}
        <div className="rounded-xl px-4 py-3 text-xs"
          style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
          {isLoadingQuote ? (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full border animate-spin"
                style={{ borderColor: 'var(--border-strong)', borderTopColor: 'transparent' }} />
              <span style={{ color: 'var(--muted)' }}>Fetching relay fee…</span>
            </div>
          ) : feeQuote ? (
            <>
              <div className="flex justify-between">
                <span style={{ color: 'var(--muted)' }}>Relay fee (from fee budget)</span>
                <span className="tabular-nums font-medium" style={{ color: 'var(--ink-2)' }}>
                  {formatUsdcFixed(feeQuote.quotedFee)} USDC
                </span>
              </div>
              <div className="flex justify-between mt-1">
                <span style={{ color: 'var(--subtle)' }}>Fee budget remaining</span>
                <span className="tabular-nums" style={{ color: 'var(--subtle)' }}>
                  {formatUsdcFixed(feeQuote.feeBalance)} USDC
                </span>
              </div>
              <p className="mt-1" style={{ color: 'var(--subtle)' }}>
                Quote valid until {new Date(feeQuote.quoteExpiry * 1000).toLocaleTimeString()}
              </p>
            </>
          ) : (
            <p style={{ color: 'var(--danger)' }}>{quoteError ?? 'Quote unavailable'}</p>
          )}
        </div>

        {/* Submit error */}
        {submitError && (
          <p role="alert" aria-live="polite" className="text-xs" style={{ color: 'var(--danger)' }}>
            {submitError}
          </p>
        )}

        {/* Pay button */}
        <button
          type="button"
          onClick={() => { void handlePay() }}
          disabled={isSubmitting || isLoadingQuote || !feeQuote || parsedAmount === null || !recipient || isRelayUnavailable}
          className="w-full rounded-xl py-4 font-bold text-base transition-opacity disabled:opacity-40"
          style={{ background: 'var(--accent)', color: '#fff', minHeight: '56px' }}
          aria-busy={isSubmitting}>
          {isSubmitting ? 'Sending…'
            : isLoadingQuote ? 'Loading…'
              : parsedAmount !== null ? `Pay ${formatUsdcFixed(parsedAmount)} USDC`
                : 'Pay'}
        </button>

        <p className="text-xs text-center" style={{ color: 'var(--subtle)' }}>
          No wallet needed. Signed in your browser, submitted by the relay.
        </p>
      </main>
    </div>
  )
}

/**
 * LinkCard — issuer's per-link dashboard card.
 *
 * Status is derived from chain data via deriveLinkStatus (src/lib/linkStatus.ts).
 * No stored principal is shown as a current balance; no status is inferred before
 * chain data resolves. Drafts and loading states are rendered independently.
 */

import { useEffect, useRef, useState } from 'react'
import {
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useAccount,
  useSwitchChain,
} from 'wagmi'
import { Copy, Trash2, ExternalLink, Check, RefreshCw } from 'lucide-react'
import type { Address } from 'viem'
import { SPOOKLY_ABI, ARC_TESTNET_CHAIN_ID } from '../lib/contract'
import { buildLinkUrl } from '../lib/crypto'
import { formatUsdcFixed, formatExpiry, truncateAddress } from '../lib/format'
import type { StoredLink } from '../lib/storage'
import { classifyWriteError } from '../lib/writeError'
import { deriveLinkStatus } from '../lib/linkStatus'
import type { ChainInfo } from '../lib/linkStatus'

const ARC_EXPLORER = 'https://explorer.arc.io' // arc-studio-allow-onchain-literal
function buildTxExplorerUrl(_chainId: number, txHash: string): string {
  return `${ARC_EXPLORER}/tx/${txHash}`
}

function nowSeconds(): number { return Math.floor(Date.now() / 1000) }

interface LinkCardProps {
  link: StoredLink
  contractAddress: Address
  onCancelled: () => void
}

export function LinkCard({ link, contractAddress, onCancelled }: LinkCardProps) {
  const { chainId, address: connectedAccount } = useAccount()
  const { switchChain } = useSwitchChain()
  const isWrongChain = chainId !== ARC_TESTNET_CHAIN_ID

  const [copied, setCopied] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)

  // Scope retained data by chainId + contractAddress + signerAddress + connected account.
  // Account changes (or explicit disconnects) reset the ref via the key prop set by parent.
  const scopeKey = `${ARC_TESTNET_CHAIN_ID}:${contractAddress}:${link.signerAddress}:${connectedAccount ?? ''}`
  const retainedRef = useRef<(ChainInfo & { scopeKey: string }) | null>(null)

  const isDraft = !link.txHash

  const {
    data: linkInfo,
    isLoading,
    isFetching,
    isError,
    refetch: refetchLinkInfo,
  } = useReadContract({
    address: contractAddress,
    abi: SPOOKLY_ABI,
    functionName: 'getLinkInfo',
    args: [link.signerAddress],
    chainId: ARC_TESTNET_CHAIN_ID,
    // Don't fetch for drafts — they have no on-chain record yet
    query: { enabled: !isDraft },
  })

  const {
    writeContract: cancel,
    data: cancelHash,
    isPending: isCancelling,
    error: cancelError,
  } = useWriteContract()
  const {
    isLoading: isCancelConfirming,
    isSuccess: isCancelSuccess,
    isError: isCancelReceiptError,
    data: cancelReceipt,
    refetch: refetchCancelReceipt,
  } = useWaitForTransactionReceipt({ hash: cancelHash })

  useEffect(() => {
    if (!isCancelSuccess) return
    void refetchLinkInfo()
    onCancelled()
  }, [isCancelSuccess, refetchLinkInfo, onCancelled])

  // Retain confirmed chain data across background refetches; clear on scope change.
  const info = linkInfo as ChainInfo | undefined
  if (info !== undefined) {
    retainedRef.current = { ...info, scopeKey }
  }
  const retained = retainedRef.current?.scopeKey === scopeKey ? retainedRef.current : null

  // Use fresh data when available; fall back to retained during background refetch only.
  const resolvedInfo: ChainInfo | null = info ?? (isFetching && retained ? retained : null)

  // Cancel state machine
  const isCancelReverted    = cancelReceipt?.status === "reverted"
  const isCancelUnknown     = !!(cancelHash && isCancelReceiptError)
  const cancelInFlight      = !!(isCancelling || (cancelHash && !isCancelSuccess && !isCancelReceiptError))
  const cancelActionBlocked = isCancelling || isCancelConfirming || isCancelUnknown

  const st = deriveLinkStatus({
    hasTxHash: !isDraft,
    chainInfo: resolvedInfo,
    isLoading,
    isFetching,
    isError,
    isCancelSuccess,
    cancelInFlight,
    nowSec: nowSeconds(),
  })

  const linkUrl = buildLinkUrl(link.privateKey, contractAddress, ARC_TESTNET_CHAIN_ID)
  const chainBalance = resolvedInfo?.balance ?? null
  const chainFeeBalance = resolvedInfo?.feeBalance ?? null
  const expiry = resolvedInfo ? Number(resolvedInfo.expiry) : link.expiryTs

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(linkUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable */ }
  }

  const handleCancel = () => {
    if (isWrongChain) { switchChain({ chainId: ARC_TESTNET_CHAIN_ID }); return }
    cancel({
      address: contractAddress,
      abi: SPOOKLY_ABI,
      functionName: 'cancelLink',
      args: [link.signerAddress],
      chainId: ARC_TESTNET_CHAIN_ID,
    })
    setConfirmCancel(false)
  }

  // ── Draft ────────────────────────────────────────────────────────────────
  if (st.phase === 'draft') {
    return (
      <div className="rounded-2xl p-4 space-y-3"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xl font-bold tabular-nums display" style={{ color: 'var(--subtle)' }}>
              {link.principal} USDC
            </p>
            <p className="text-xs mt-0.5 mono" style={{ color: 'var(--subtle)' }}>
              {truncateAddress(link.signerAddress)}
            </p>
          </div>
          <span className="text-xs font-medium px-2 py-1 rounded-lg"
            style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
            Draft
          </span>
        </div>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Transaction pending — check your wallet to confirm.
        </p>
      </div>
    )
  }

  // ── Loading skeleton ─────────────────────────────────────────────────────
  if (st.phase === 'loading') {
    return (
      <div className="rounded-2xl p-4 space-y-3" aria-busy="true"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1.5">
            <div style={{ width: '120px', height: '28px', borderRadius: '6px', background: 'var(--surface-muted)' }}
              aria-hidden="true" />
            <div style={{ width: '80px', height: '14px', borderRadius: '4px', background: 'var(--surface-muted)' }}
              aria-hidden="true" />
          </div>
          <div style={{ width: '60px', height: '24px', borderRadius: '6px', background: 'var(--surface-muted)' }}
            aria-hidden="true" />
        </div>
        <p className="sr-only" role="status">Loading link…</p>
      </div>
    )
  }

  // ── Error, no retained data ──────────────────────────────────────────────
  if (st.phase === 'error_no_data') {
    return (
      <div className="rounded-2xl p-4 space-y-3"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
              {truncateAddress(link.signerAddress)}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--danger)' }}>
              Could not load link data.
            </p>
          </div>
          <button type="button" onClick={() => { void refetchLinkInfo() }}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium"
            style={{ background: 'var(--surface-muted)', color: 'var(--ink-2)', border: '1px solid var(--border)', minHeight: '36px' }}
            aria-label="Retry loading link data">
            <RefreshCw size={12} />
            Retry
          </button>
        </div>
        {link.txHash && (
          <a href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, link.txHash)}
            target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs" style={{ color: 'var(--subtle)' }}>
            <ExternalLink size={11} />
            View creation tx
          </a>
        )}
      </div>
    )
  }

  // ── Ready (chain data resolved or retained) ──────────────────────────────
  const displayBalance = chainBalance !== null ? formatUsdcFixed(chainBalance) : null

  return (
    <div className="rounded-2xl p-4 space-y-3"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>

      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xl font-bold tabular-nums display" style={{ color: 'var(--ink)' }}>
            {displayBalance !== null
              ? `${displayBalance} USDC`
              : <span style={{ color: 'var(--subtle)', fontSize: '0.85em' }}>— USDC</span>}
          </p>
          <p className="text-xs mt-0.5 mono" style={{ color: 'var(--subtle)' }}>
            {truncateAddress(link.signerAddress)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-xs font-medium px-2 py-1 rounded-lg"
            style={{ background: 'var(--surface-muted)', color: st.statusColor }}>
            {st.statusLabel}
          </span>
          {st.showUpdating && (
            <span className="text-xs" style={{ color: 'var(--subtle)' }}
              role="status" aria-live="polite">
              Updating…
            </span>
          )}
          {st.showStaleNotice && (
            <button type="button" onClick={() => { void refetchLinkInfo() }}
              className="flex items-center gap-1 text-xs"
              style={{ color: 'var(--muted)' }}
              aria-label="Retry loading link data">
              <RefreshCw size={11} />
              Retry
            </button>
          )}
        </div>
      </div>

      {/* Stale data notice */}
      {st.showStaleNotice && (
        <p className="text-xs" style={{ color: 'var(--muted)' }} role="status" aria-live="polite">
          Last known data — chain read failed. Financial actions disabled until refreshed.
        </p>
      )}

      {/* Fee budget */}
      {chainFeeBalance !== null && (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>
          Fee budget: {formatUsdcFixed(chainFeeBalance)} USDC
        </p>
      )}

      {/* Expired-but-active notice — only with confirmed fresh chain data, no cancel in flight */}
      {st.showReclaimNotice && (
        <div className="rounded-lg px-3 py-2 text-xs"
          style={{ background: 'rgba(186,43,76,0.06)', border: '1px solid rgba(186,43,76,0.2)' }}>
          <p style={{ color: 'var(--danger)' }}>
            This link has expired.
            {displayBalance !== null && displayBalance !== '0.00'
              ? ` Cancel it to reclaim the remaining ${displayBalance} USDC + fee budget.`
              : ' Cancel it to reclaim any remaining balance.'}
          </p>
        </div>
      )}

      {/* Cancel state notices */}
      {isCancelling && (
        <p className="text-sm text-center" style={{ color: 'var(--subtle)' }} role="status" aria-busy="true">Waiting for wallet confirmation…</p>
      )}
      {!isCancelling && cancelInFlight && (
        <p className="text-sm text-center" style={{ color: 'var(--subtle)' }} role="status" aria-busy="true">Cancellation pending…</p>
      )}
      {isCancelSuccess && (
        <p className="text-sm text-center" style={{ color: 'var(--success)' }} role="status">Cancellation confirmed.</p>
      )}
      {isCancelReverted && (
        <p className="text-sm text-center" style={{ color: 'var(--danger)' }} role="status">Cancellation reverted. Refresh and retry if needed.</p>
      )}
      {isCancelUnknown && (
        <div className="text-sm text-center" style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center' }}>
          <p style={{ color: 'var(--warning)' }} role="status">Could not confirm cancellation status.</p>
          <button type="button" onClick={() => void refetchCancelReceipt()}
            className="underline" style={{ color: 'var(--subtle)' }}>Check status</button>
        </div>
      )}

      {/* Closed notice */}
      {st.isClosed && !isCancelSuccess && (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>
          This link is closed. No remaining balance.
        </p>
      )}

      {/* Action row */}
      {st.canCancel && (
        <div className="flex items-center gap-2 pt-1 flex-wrap">
          {st.canShare && (
            <button type="button" onClick={() => { void handleCopy() }}
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium"
              style={{ background: 'var(--surface-muted)', color: 'var(--ink-2)', border: '1px solid var(--border)', minHeight: '36px' }}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
          )}
          {st.canShare && (
            <a href={linkUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium"
              style={{ background: 'var(--surface-muted)', color: 'var(--ink-2)', border: '1px solid var(--border)', minHeight: '36px' }}>
              <ExternalLink size={13} />
              Preview
            </a>
          )}
          {!confirmCancel ? (
            <button type="button" onClick={() => setConfirmCancel(true)}
              className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium"
              style={{ color: 'var(--danger)', background: 'transparent', border: '1px solid rgba(186,43,76,0.2)', minHeight: '36px' }}>
              <Trash2 size={13} />
              {st.isExpired ? 'Reclaim funds' : 'Cancel'}
            </button>
          ) : (
            <div className="ml-auto flex items-center gap-2">
              <button type="button" onClick={() => setConfirmCancel(false)}
                className="rounded-lg px-2 py-1.5 text-xs"
                style={{ color: 'var(--muted)', background: 'var(--surface-muted)', border: '1px solid var(--border)', minHeight: '32px' }}>
                Keep
              </button>
              <button type="button" onClick={handleCancel}
                disabled={cancelActionBlocked}
                className="rounded-lg px-2 py-1.5 text-xs font-semibold disabled:opacity-50"
                style={{ background: 'var(--danger)', color: '#fff', minHeight: '32px' }}
                aria-busy={cancelActionBlocked}>
                {isCancelling ? 'Confirm in wallet…' : isCancelConfirming ? 'Cancelling…' : st.isExpired ? 'Reclaim' : 'Cancel link'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Expiry — for active non-expired links */}
      {st.isActive && !st.isExpired && expiry > 0 && (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>
          Expires: {formatExpiry(expiry)}
        </p>
      )}

      {/* Creation tx */}
      {link.txHash && (
        <a href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, link.txHash)}
          target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs" style={{ color: 'var(--subtle)' }}>
          <ExternalLink size={11} />
          View creation tx
        </a>
      )}

      {/* Cancel tx */}
      {cancelHash && (
        <a href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, cancelHash)}
          target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs" style={{ color: 'var(--success)' }}>
          <ExternalLink size={11} />
          {isCancelSuccess ? 'Cancel confirmed' : isCancelUnknown ? 'Cancel tx (unconfirmed)' : 'Cancel pending…'}
        </a>
      )}

      {/* Cancel error */}
      {cancelError && (() => {
        const classified = classifyWriteError(cancelError)
        return (
          <p className="text-xs" role="status" aria-live="polite" style={{ color: 'var(--danger)' }}>
            {classified.category === 'user_rejected'
              ? 'Cancel request dismissed.'
              : `Cancel failed: ${classified.message}`}
          </p>
        )
      })()}
    </div>
  )
}

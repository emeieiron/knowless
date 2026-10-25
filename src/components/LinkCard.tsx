/**
 * LinkCard — issuer's per-link dashboard card.
 *
 * Status is derived from chain data via deriveLinkStatus (src/lib/linkStatus.ts).
 * No stored principal is shown as a current balance; no status is inferred before
 * chain data resolves. Drafts and loading states are rendered independently.
 * Uses .iss-card scoped styles matching the bold lime dashboard theme.
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

// Stable module-level component — must not be defined inside another component.
function Badge({ label, variant }: { label: string; variant: 'active' | 'expired' | 'closed' | 'draft' | 'updating' }) {
  return (
    <span className={`iss-card-badge iss-card-badge--${variant}`}>{label}</span>
  )
}

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
      <div className="iss-card">
        <div className="iss-card-header">
          <div style={{ minWidth: 0 }}>
            <p className="iss-card-amount iss-card-amount--muted">{link.principal} USDC</p>
            <p className="iss-card-addr">{truncateAddress(link.signerAddress)}</p>
          </div>
          <Badge label="Draft" variant="draft" />
        </div>
        <p className="iss-card-meta">Transaction pending — check your wallet to confirm.</p>
      </div>
    )
  }

  // ── Loading skeleton ─────────────────────────────────────────────────────
  if (st.phase === 'loading') {
    return (
      <div className="iss-card iss-card--loading" aria-busy="true">
        <div className="iss-card-header">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
            <div className="iss-skel" style={{ width: '120px', height: '28px' }} aria-hidden="true" />
            <div className="iss-skel" style={{ width: '80px', height: '12px' }} aria-hidden="true" />
          </div>
          <div className="iss-skel" style={{ width: '60px', height: '22px' }} aria-hidden="true" />
        </div>
        <p className="sr-only" role="status">Loading link…</p>
      </div>
    )
  }

  // ── Error, no retained data ──────────────────────────────────────────────
  if (st.phase === 'error_no_data') {
    return (
      <div className="iss-card">
        <div className="iss-card-header">
          <div style={{ minWidth: 0 }}>
            <p className="iss-card-addr" style={{ fontSize: '0.8125rem', maxWidth: '100%' }}>
              {truncateAddress(link.signerAddress)}
            </p>
            <p className="iss-card-meta" style={{ color: 'var(--danger)', opacity: 1 }}>
              Could not load link data.
            </p>
          </div>
          <button type="button" onClick={() => { void refetchLinkInfo() }}
            className="iss-card-btn"
            aria-label="Retry loading link data">
            <RefreshCw size={12} />
            Retry
          </button>
        </div>
        {link.txHash && (
          <a href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, link.txHash)}
            target="_blank" rel="noopener noreferrer" className="iss-card-link">
            <ExternalLink size={11} />
            View creation tx
          </a>
        )}
      </div>
    )
  }

  // ── Ready (chain data resolved or retained) ──────────────────────────────
  const displayBalance = chainBalance !== null ? formatUsdcFixed(chainBalance) : null

  const badgeVariant: 'active' | 'expired' | 'closed' | 'draft' | 'updating' =
    st.isClosed ? 'closed'
    : st.isExpired ? 'expired'
    : isFetching ? 'updating'
    : 'active'

  return (
    <div className="iss-card">
      {/* Header row */}
      <div className="iss-card-header">
        <div style={{ minWidth: 0 }}>
          <p className={`iss-card-amount${displayBalance === null ? ' iss-card-amount--muted' : ''}`}>
            {displayBalance !== null ? `${displayBalance} USDC` : '— USDC'}
          </p>
          <p className="iss-card-addr">{truncateAddress(link.signerAddress)}</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
          <Badge label={st.statusLabel} variant={badgeVariant} />
          {st.showUpdating && (
            <span className="iss-card-badge iss-card-badge--updating" role="status" aria-live="polite">
              Updating…
            </span>
          )}
          {st.showStaleNotice && (
            <button type="button" onClick={() => { void refetchLinkInfo() }}
              className="iss-card-link" style={{ fontSize: '0.6875rem' }}
              aria-label="Retry loading link data">
              <RefreshCw size={10} />
              Retry
            </button>
          )}
        </div>
      </div>

      {/* Stale data notice */}
      {st.showStaleNotice && (
        <p className="iss-card-notice iss-card-notice--info" role="status" aria-live="polite">
          Last known data — chain read failed. Financial actions disabled until refreshed.
        </p>
      )}

      {/* Fee budget */}
      {chainFeeBalance !== null && (
        <p className="iss-card-meta">Fee budget: {formatUsdcFixed(chainFeeBalance)} USDC</p>
      )}

      {/* Expired-but-active notice */}
      {st.showReclaimNotice && (
        <div className="iss-card-notice iss-card-notice--warn">
          This link has expired.
          {displayBalance !== null && displayBalance !== '0.00'
            ? ` Cancel it to reclaim the remaining ${displayBalance} USDC + fee budget.`
            : ' Cancel it to reclaim any remaining balance.'}
        </div>
      )}

      {/* Cancel state notices */}
      {isCancelling && (
        <p className="iss-card-meta" role="status" aria-busy="true">Waiting for wallet confirmation…</p>
      )}
      {!isCancelling && cancelInFlight && (
        <p className="iss-card-meta" role="status" aria-busy="true">Cancellation pending…</p>
      )}
      {isCancelSuccess && (
        <p className="iss-card-notice iss-card-notice--success" role="status">Cancellation confirmed.</p>
      )}
      {isCancelReverted && (
        <p className="iss-card-notice iss-card-notice--danger" role="status">
          Cancellation reverted. Refresh and retry if needed.
        </p>
      )}
      {isCancelUnknown && (
        <div className="iss-card-notice iss-card-notice--warn" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <p role="status">Could not confirm cancellation status.</p>
          <button type="button" onClick={() => void refetchCancelReceipt()}
            className="iss-card-link" style={{ alignSelf: 'flex-start' }}>
            Check status
          </button>
        </div>
      )}

      {/* Closed notice */}
      {st.isClosed && !isCancelSuccess && (
        <p className="iss-card-meta">This link is closed. No remaining balance.</p>
      )}

      {/* Action row */}
      {st.canCancel && (
        <div className="iss-card-actions">
          {st.canShare && (
            <button type="button" onClick={() => { void handleCopy() }}
              className="iss-card-btn">
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
          )}
          {st.canShare && (
            <a href={linkUrl} target="_blank" rel="noopener noreferrer"
              className="iss-card-btn" style={{ textDecoration: 'none' }}>
              <ExternalLink size={13} />
              Preview
            </a>
          )}
          {!confirmCancel ? (
            <button type="button" onClick={() => setConfirmCancel(true)}
              className="iss-card-btn iss-card-btn--danger"
              style={{ marginLeft: 'auto' }}>
              <Trash2 size={13} />
              {st.isExpired ? 'Reclaim funds' : 'Cancel'}
            </button>
          ) : (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button type="button" onClick={() => setConfirmCancel(false)}
                className="iss-card-btn">
                Keep
              </button>
              <button type="button" onClick={handleCancel}
                disabled={cancelActionBlocked}
                className="iss-card-btn iss-card-btn--confirm"
                aria-busy={cancelActionBlocked}>
                {isCancelling ? 'Confirm in wallet…' : isCancelConfirming ? 'Cancelling…' : st.isExpired ? 'Reclaim' : 'Cancel link'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Expiry */}
      {st.isActive && !st.isExpired && expiry > 0 && (
        <p className="iss-card-meta">Expires: {formatExpiry(expiry)}</p>
      )}

      {/* Creation tx */}
      {link.txHash && (
        <a href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, link.txHash)}
          target="_blank" rel="noopener noreferrer" className="iss-card-link">
          <ExternalLink size={11} />
          View creation tx
        </a>
      )}

      {/* Cancel tx */}
      {cancelHash && (
        <a href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, cancelHash)}
          target="_blank" rel="noopener noreferrer" className="iss-card-link">
          <ExternalLink size={11} />
          {isCancelSuccess ? 'Cancel confirmed' : isCancelUnknown ? 'Cancel tx (unconfirmed)' : 'Cancel pending…'}
        </a>
      )}

      {/* Cancel error */}
      {cancelError && (() => {
        const classified = classifyWriteError(cancelError)
        return (
          <p className="iss-card-meta" role="status" aria-live="polite"
            style={{ color: 'var(--danger)', opacity: 1 }}>
            {classified.category === 'user_rejected'
              ? 'Cancel request dismissed.'
              : `Cancel failed: ${classified.message}`}
          </p>
        )
      })()}
    </div>
  )
}

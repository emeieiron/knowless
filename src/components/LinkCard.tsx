/**
 * LinkCard — issuer's per-link dashboard card.
 *
 * Finding 7: Expired links remain visible and cancellable so issuers can reclaim funds.
 *            `cancelLink` works on expired-but-active links (contract allows it).
 *            Status is derived from chain data, not local expiry alone.
 *            Cancelled state is from chain (linkInfo.active === false), not just local tx.
 *
 * Finding 7: isCancelSuccess no longer mutates state during render — handled in useEffect.
 */

import { useState, useEffect } from 'react'
import {
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useAccount,
  useSwitchChain,
} from 'wagmi'
import { Copy, Trash2, ExternalLink, Check } from 'lucide-react'
import type { Address } from 'viem'
import { SPOOKLY_ABI, ARC_TESTNET_CHAIN_ID } from '../lib/contract'
import { buildLinkUrl } from '../lib/crypto'
import { formatUsdcFixed, formatExpiry, truncateAddress } from '../lib/format'
import type { StoredLink } from '../lib/storage'
import { classifyWriteError } from '../lib/writeError'

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
  const { chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const isWrongChain = chainId !== ARC_TESTNET_CHAIN_ID

  const [copied, setCopied] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const { data: linkInfo, refetch: refetchLinkInfo } = useReadContract({
    address: contractAddress,
    abi: SPOOKLY_ABI,
    functionName: 'getLinkInfo',
    args: [link.signerAddress],
    chainId: ARC_TESTNET_CHAIN_ID,
  })

  const { writeContract: cancel, data: cancelHash, isPending: isCancelling, error: cancelError } = useWriteContract()
  const { isLoading: isCancelConfirming, isSuccess: isCancelSuccess } = useWaitForTransactionReceipt({ hash: cancelHash })

  // Refresh chain state and notify parent after cancel confirms — no side-effects in render
  useEffect(() => {
    if (!isCancelSuccess) return
    void refetchLinkInfo()
    onCancelled()
  }, [isCancelSuccess, refetchLinkInfo, onCancelled])

  const info = linkInfo as { balance: bigint; feeBalance: bigint; expiry: bigint; active: boolean } | undefined
  const chainBalance = info?.balance ?? null
  const chainFeeBalance = info?.feeBalance ?? null
  const isActive = info ? info.active : true  // optimistic: assume active until chain says otherwise
  const expiry = info ? Number(info.expiry) : link.expiryTs
  const isExpired = expiry > 0 && expiry < nowSeconds()
  const isDraft = !link.txHash
  const isSpent = info ? !info.active && info.balance === 0n : false

  const linkUrl = buildLinkUrl(link.privateKey, contractAddress, ARC_TESTNET_CHAIN_ID)
  const displayBalance = chainBalance !== null ? formatUsdcFixed(chainBalance) : link.principal

  // Actions
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(linkUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable — silently ignore */ }
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

  // Derive status label and color from chain state
  const statusLabel = !isActive
    ? isSpent ? 'Spent' : 'Cancelled'
    : isDraft ? 'Draft'
      : isExpired ? 'Expired'
        : formatExpiry(expiry)

  const statusColor = !isActive
    ? 'var(--subtle)'
    : isDraft
      ? 'var(--muted)'
      : isExpired
        ? 'var(--danger)'
        : 'var(--success)'

  // Show cancel button when link is active (including expired — refund is possible)
  const canCancel = isActive && !isCancelSuccess
  // Show spend link only when active and NOT expired
  const canShare = isActive && !isExpired && !isDraft

  return (
    <div className="rounded-2xl p-4 space-y-3"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', opacity: !isActive ? 0.6 : 1 }}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xl font-bold tabular-nums display" style={{ color: 'var(--ink)' }}>
            {displayBalance} USDC
          </p>
          <p className="text-xs mt-0.5 mono" style={{ color: 'var(--subtle)' }}>
            {truncateAddress(link.signerAddress)}
          </p>
        </div>
        <span className="text-xs font-medium px-2 py-1 rounded-lg"
          style={{ background: 'var(--surface-muted)', color: statusColor }}>
          {statusLabel}
        </span>
      </div>

      {/* Fee budget */}
      {chainFeeBalance !== null && (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>
          Fee budget: {formatUsdcFixed(chainFeeBalance)} USDC
        </p>
      )}

      {/* Expired-but-active notice */}
      {isActive && isExpired && (
        <div className="rounded-lg px-3 py-2 text-xs"
          style={{ background: 'rgba(186,43,76,0.06)', border: '1px solid rgba(186,43,76,0.2)' }}>
          <p style={{ color: 'var(--danger)' }}>
            This link has expired. Cancel it to reclaim the remaining {displayBalance} USDC + fee budget.
          </p>
        </div>
      )}

      {/* Action row */}
      {canCancel && (
        <div className="flex items-center gap-2 pt-1 flex-wrap">
          {/* Copy — only when spendable */}
          {canShare && (
            <button type="button" onClick={() => { void handleCopy() }}
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium"
              style={{ background: 'var(--surface-muted)', color: 'var(--ink-2)', border: '1px solid var(--border)', minHeight: '36px' }}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
          )}

          {/* Preview — only when spendable */}
          {canShare && (
            <a href={linkUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium"
              style={{ background: 'var(--surface-muted)', color: 'var(--ink-2)', border: '1px solid var(--border)', minHeight: '36px' }}>
              <ExternalLink size={13} />
              Preview
            </a>
          )}

          {/* Cancel / refund */}
          {!confirmCancel ? (
            <button type="button" onClick={() => setConfirmCancel(true)}
              className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium"
              style={{ color: 'var(--danger)', background: 'transparent', border: '1px solid rgba(186,43,76,0.2)', minHeight: '36px' }}>
              <Trash2 size={13} />
              {isExpired ? 'Reclaim funds' : 'Cancel'}
            </button>
          ) : (
            <div className="ml-auto flex items-center gap-2">
              <button type="button" onClick={() => setConfirmCancel(false)}
                className="rounded-lg px-2 py-1.5 text-xs"
                style={{ color: 'var(--muted)', background: 'var(--surface-muted)', border: '1px solid var(--border)', minHeight: '32px' }}>
                Keep
              </button>
              <button type="button" onClick={handleCancel}
                disabled={isCancelling || isCancelConfirming}
                className="rounded-lg px-2 py-1.5 text-xs font-semibold disabled:opacity-50"
                style={{ background: 'var(--danger)', color: '#fff', minHeight: '32px' }}
                aria-busy={isCancelling || isCancelConfirming}>
                {isCancelling ? 'Confirm…' : isCancelConfirming ? 'Cancelling…' : isExpired ? 'Reclaim' : 'Cancel link'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Draft warning */}
      {isDraft && isActive && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Draft — transaction not yet confirmed. Check your wallet.
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
          {isCancelSuccess ? 'Cancel confirmed' : 'Cancel pending…'}
        </a>
      )}

      {/* Cancel error */}
      {cancelError && (() => {
        const classified = classifyWriteError(cancelError)
        return (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            {classified.category === 'user_rejected'
              ? 'Cancel request dismissed.'
              : `Cancel failed: ${classified.message}`}
          </p>
        )
      })()}
    </div>
  )
}

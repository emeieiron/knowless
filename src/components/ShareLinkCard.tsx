/**
 * ShareLinkCard — shown after a link is created.
 * Displays QR code, copyable link URL, and share actions.
 * Warns that whoever has the link can spend it.
 */

import { useState } from 'react'
import { Copy, Check, ExternalLink } from 'lucide-react'
import { QRCode } from './QRCode'
import { truncateAddress } from '../lib/format'
import type { Address } from 'viem'

interface ShareLinkCardProps {
  linkUrl: string
  signerAddress: Address
  amountDisplay: string
  expiryLabel: string
  onDone: () => void
}

export function ShareLinkCard({
  linkUrl,
  signerAddress,
  amountDisplay,
  expiryLabel,
  onDone,
}: ShareLinkCardProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(linkUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback
    }
  }

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Spookly — spendable USDC link',
          text: `Pay yourself ${amountDisplay} USDC using this link`,
          url: linkUrl,
        })
      } catch {
        // User cancelled share
      }
    } else {
      void handleCopy()
    }
  }

  // Validate the link doesn't contain query strings (safety check)
  const isFragmentOnly = linkUrl.includes('#') && !linkUrl.includes('?')

  return (
    <div className="space-y-5 reveal">
      {/* Warning banner */}
      <div
        className="rounded-xl px-4 py-3 text-sm"
        role="alert"
        style={{ background: 'rgba(186,43,76,0.08)', border: '1px solid rgba(186,43,76,0.2)', color: 'var(--danger)' }}
      >
        <strong>Treat this link like cash.</strong> Anyone with the link can spend the funds. Share only with the intended recipient.
      </div>

      {/* Link meta */}
      <div className="text-center">
        <p className="text-3xl font-bold tabular-nums display" style={{ color: 'var(--ink)' }}>
          {amountDisplay} USDC
        </p>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          Expires in {expiryLabel} · {truncateAddress(signerAddress)}
        </p>
      </div>

      {/* QR code */}
      {isFragmentOnly && (
        <div className="flex justify-center">
          <div
            className="p-3 rounded-2xl qr-print"
            style={{ background: '#fff', border: '1px solid var(--border)' }}
          >
            <QRCode value={linkUrl} size={180} />
          </div>
        </div>
      )}

      {/* Link URL */}
      <div
        className="flex items-center gap-2 rounded-xl px-3 py-2.5"
        style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
      >
        <span
          className="flex-1 text-xs mono truncate select-all"
          style={{ color: 'var(--muted)' }}
          aria-label="Spendable link URL"
        >
          {linkUrl}
        </span>
        <button
          type="button"
          onClick={() => { void handleCopy() }}
          className="flex-shrink-0 rounded-lg p-1.5 transition-colors"
          style={{ color: copied ? 'var(--success)' : 'var(--muted)' }}
          aria-label={copied ? 'Copied' : 'Copy link'}
          title={copied ? 'Copied' : 'Copy link'}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>

      {/* Actions */}
      <div className="flex gap-3 share-actions">
        {typeof navigator.share !== 'undefined' && (
          <button
            type="button"
            onClick={() => { void handleShare() }}
            className="flex-1 rounded-xl py-3 font-semibold text-sm"
            style={{ background: 'var(--accent)', color: '#fff', minHeight: '48px' }}
          >
            Share link
          </button>
        )}
        <button
          type="button"
          onClick={() => { void handleCopy() }}
          className="flex-1 rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2"
          style={{
            background: typeof navigator.share !== 'undefined' ? 'var(--surface-muted)' : 'var(--accent)',
            color: typeof navigator.share !== 'undefined' ? 'var(--ink-2)' : '#fff',
            border: '1px solid var(--border)',
            minHeight: '48px',
          }}
        >
          <Copy size={15} />
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>

      {/* Open link in new tab */}
      <a
        href={linkUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-1.5 text-xs"
        style={{ color: 'var(--subtle)' }}
      >
        <ExternalLink size={12} />
        Preview spend page
      </a>

      <button
        type="button"
        onClick={onDone}
        className="w-full rounded-xl py-3 text-sm font-medium"
        style={{ color: 'var(--muted)', background: 'transparent', border: '1px solid var(--border)', minHeight: '44px' }}
      >
        Back to dashboard
      </button>
    </div>
  )
}

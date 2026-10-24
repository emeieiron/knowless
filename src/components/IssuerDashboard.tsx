/**
 * IssuerDashboard — the main issuer view.
 *
 * Finding 7: All links are shown regardless of local expiry — expired links must remain
 *            visible so issuers can cancel them and reclaim funds.
 *            Link state (expired/cancelled/funded/spent) is driven by chain data in LinkCard.
 *
 * Wallet init: wagmi status 'connecting'/'reconnecting' shows a stable loading skeleton
 * inside the normal dashboard layout, never the disconnected landing page.
 * Only a definitive 'disconnected' status shows the Connect screen.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { Plus } from 'lucide-react'
import type { Address } from 'viem'
import { SpooklyGhost } from './SpooklyGhost'
import { CreateLinkForm } from './CreateLinkForm'
import { ShareLinkCard } from './ShareLinkCard'
import { LinkCard } from './LinkCard'
import { FundFromChain } from './FundFromChain'
import { loadLinks } from '../lib/storage'
import type { StoredLink } from '../lib/storage'
import { SPOOKLY_ADDRESS, ARC_TESTNET_CHAIN_ID } from '../lib/contract'
import { formatUsdcFixed, parseUsdcInput } from '../lib/format'

type View = 'dashboard' | 'create' | 'fund' | 'share'

interface SharedLink {
  url: string
  signerAddress: Address
  amountDisplay: string
  expiryLabel: string
}

export function IssuerDashboard() {
  const { address, status } = useAccount()
  const contractAddress = SPOOKLY_ADDRESS

  const [view, setView] = useState<View>('dashboard')
  const [refreshTick, setRefreshTick] = useState(0)
  const [sharedLink, setSharedLink] = useState<SharedLink | null>(null)

  // Initialization guard: wagmi's first render may briefly report 'disconnected'
  // before the stored provider is re-hydrated and status transitions to 'reconnecting'
  // or 'connected'. We show the loading skeleton until at least one useEffect has
  // fired (i.e. the component has mounted and React's commit phase has run).
  // This avoids the initial flash of the Connect screen on page reload.
  const initializedRef = useRef(false)
  const [initialized, setInitialized] = useState(false)
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      setInitialized(true)
    }
  }, [])

  // Wallet connection states:
  // 'connecting' | 'reconnecting' → hydrating/restoring — show loading skeleton
  // 'connected'                   → fully connected
  // 'disconnected' after init     → definitively not connected — show connect landing
  const isRestoring = !initialized || status === 'connecting' || status === 'reconnecting'
  const isConnected = status === 'connected'

  const links: StoredLink[] = address && refreshTick >= 0
    ? loadLinks(ARC_TESTNET_CHAIN_ID, contractAddress, address)
    : []

  const loadAndSetLinks = useCallback(() => setRefreshTick(t => t + 1), [])

  const handleLinkCreated = useCallback((linkUrl: string, signerAddress: Address) => {
    const stored = address ? loadLinks(ARC_TESTNET_CHAIN_ID, contractAddress, address) : []
    const created = stored.find(l => l.signerAddress.toLowerCase() === signerAddress.toLowerCase())
    setSharedLink({
      url: linkUrl,
      signerAddress,
      amountDisplay: created ? formatUsdcFixed(parseUsdcInput(created.principal) ?? 0n) : '?',
      expiryLabel: created?.expiryLabel ?? '',
    })
    setView('share')
    loadAndSetLinks()
  }, [address, contractAddress, loadAndSetLinks])

  // ── Disconnected landing ─────────────────────────────────────────────────
  if (!isRestoring && !isConnected) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-4 pb-12">
        <div className="ghost-stage flex flex-col items-center gap-6 max-w-xs w-full text-center reveal">
          <SpooklyGhost className="w-28 h-auto" />
          <div className="space-y-2">
            <h1 className="text-2xl font-bold display" style={{ color: 'var(--ink)' }}>knowless</h1>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>Spendable USDC links</p>
          </div>
          <p className="text-sm" style={{ color: 'var(--muted)', maxWidth: '22ch', textAlign: 'center' }}>
            Create a funded link. Share it. Anyone can spend it — no wallet needed.
          </p>
          <ConnectKitButton label="Connect wallet" data-slot="button" />
        </div>
      </div>
    )
  }

  // ── Wallet restoring / reconnecting skeleton ─────────────────────────────
  // Rendered inside the normal dashboard shell so layout is stable.
  if (isRestoring) {
    return (
      <div className="min-h-dvh flex flex-col" aria-busy="true">
        <header className="sticky top-0 z-10 px-4 py-3 flex items-center justify-between"
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', backdropFilter: 'blur(12px)' }}>
          <div className="flex items-center gap-2">
            <SpooklyGhost className="w-6 h-auto" />
            <span className="font-semibold text-base display" style={{ color: 'var(--ink)' }}>knowless</span>
          </div>
          {/* Placeholder to keep header height identical to connected state */}
          <div style={{ width: '120px', height: '32px', borderRadius: '8px', background: 'var(--surface-muted)' }}
            aria-hidden="true" />
        </header>
        <main className="flex-1 px-4 py-6 max-w-md mx-auto w-full space-y-4"
          role="status" aria-label="Restoring wallet…">
          {/* Skeleton buttons */}
          <div style={{ height: '56px', borderRadius: '16px', background: 'var(--surface-muted)' }}
            aria-hidden="true" />
          <div style={{ height: '44px', borderRadius: '12px', background: 'var(--surface-muted)' }}
            aria-hidden="true" />
          <p className="text-sm text-center" style={{ color: 'var(--subtle)' }}>
            Restoring wallet…
          </p>
        </main>
      </div>
    )
  }

  // ── Sub-views (only reachable when connected) ────────────────────────────
  if (view === 'fund') {
    return (
      <div className="min-h-dvh flex flex-col">
        <header className="sticky top-0 z-10 px-4 py-3 flex items-center gap-3"
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', backdropFilter: 'blur(12px)' }}>
          <button type="button" onClick={() => setView('dashboard')}
            className="text-sm font-medium"
            style={{ color: 'var(--accent)', minWidth: '44px', minHeight: '44px', display: 'flex', alignItems: 'center' }}
            aria-label="Back to dashboard">
            ← Back
          </button>
          <h1 className="font-semibold text-base" style={{ color: 'var(--ink)' }}>Fund from another chain</h1>
        </header>
        <main className="flex-1 px-4 py-6 max-w-md mx-auto w-full">
          <FundFromChain
            onFunded={() => setView('create')}
            onBack={() => setView('dashboard')}
          />
        </main>
      </div>
    )
  }

  if (view === 'create') {
    return (
      <div className="min-h-dvh flex flex-col">
        <header className="sticky top-0 z-10 px-4 py-3 flex items-center gap-3"
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', backdropFilter: 'blur(12px)' }}>
          <button type="button" onClick={() => setView('dashboard')}
            className="text-sm font-medium"
            style={{ color: 'var(--accent)', minWidth: '44px', minHeight: '44px', display: 'flex', alignItems: 'center' }}
            aria-label="Back to dashboard">
            ← Back
          </button>
          <h1 className="font-semibold text-base" style={{ color: 'var(--ink)' }}>New link</h1>
        </header>
        <main className="flex-1 px-4 py-6 max-w-md mx-auto w-full">
          <CreateLinkForm contractAddress={contractAddress} onLinkCreated={handleLinkCreated} />
        </main>
      </div>
    )
  }

  if (view === 'share' && sharedLink) {
    return (
      <div className="min-h-dvh flex flex-col">
        <header className="sticky top-0 z-10 px-4 py-3 flex items-center gap-3"
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', backdropFilter: 'blur(12px)' }}>
          <h1 className="font-semibold text-base" style={{ color: 'var(--ink)' }}>Link ready</h1>
        </header>
        <main className="flex-1 px-4 py-6 max-w-md mx-auto w-full">
          <ShareLinkCard
            linkUrl={sharedLink.url}
            signerAddress={sharedLink.signerAddress}
            amountDisplay={sharedLink.amountDisplay}
            expiryLabel={sharedLink.expiryLabel}
            onDone={() => { setView('dashboard'); loadAndSetLinks() }}
          />
        </main>
      </div>
    )
  }

  // ── Main dashboard ───────────────────────────────────────────────────────
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="sticky top-0 z-10 px-4 py-3 flex items-center justify-between"
        style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', backdropFilter: 'blur(12px)' }}>
        <div className="flex items-center gap-2">
          <SpooklyGhost className="w-6 h-auto" />
          <span className="font-semibold text-base display" style={{ color: 'var(--ink)' }}>knowless</span>
        </div>
        <ConnectKitButton />
      </header>

      <main className="flex-1 px-4 py-6 max-w-md mx-auto w-full space-y-6">
        <button type="button" onClick={() => setView('create')}
          className="w-full rounded-2xl py-4 flex items-center justify-center gap-2 font-semibold"
          style={{ background: 'var(--accent)', color: '#fff', minHeight: '56px' }}>
          <Plus size={18} />
          New spendable link
        </button>

        <button type="button" onClick={() => setView('fund')}
          className="w-full rounded-xl py-3 flex items-center justify-center gap-2 text-sm font-medium"
          style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--border)', minHeight: '44px' }}>
          Fund from another chain
        </button>

        {links.length > 0 ? (
          <section aria-label="Your links">
            <h2 className="text-xs font-semibold uppercase tracking-wider mb-3"
              style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}>
              Your links
            </h2>
            <div className="space-y-3">
              {links.map(link => (
                <LinkCard
                  key={`${address ?? ''}:${ARC_TESTNET_CHAIN_ID}:${contractAddress}:${link.signerAddress}`}
                  link={link}
                  contractAddress={contractAddress}
                  onCancelled={loadAndSetLinks}
                />
              ))}
            </div>
          </section>
        ) : (
          <div className="text-center py-12 space-y-3">
            <SpooklyGhost className="w-16 h-auto mx-auto opacity-30" />
            <p className="text-sm" style={{ color: 'var(--subtle)' }}>No links yet.</p>
            <p className="text-xs" style={{ color: 'var(--subtle)' }}>Create a link to send spendable USDC.</p>
          </div>
        )}

        <div className="rounded-xl px-4 py-3 text-xs space-y-1"
          style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
          <p className="font-semibold" style={{ color: 'var(--ink-2)' }}>Arc</p>
          <p className="mono" style={{ color: 'var(--subtle)' }}>
            Contract: {contractAddress.slice(0, 10)}…{contractAddress.slice(-6)}
          </p>
        </div>
      </main>
    </div>
  )
}

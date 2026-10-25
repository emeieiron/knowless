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
import { Plus, Link2 } from 'lucide-react'
import type { Address } from 'viem'
import { SpooklyGhost } from './SpooklyGhost'
import { LandingPage } from './LandingPage'
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

function truncateAddr(addr: Address): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
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
  const initializedRef = useRef(false)
  const [initialized, setInitialized] = useState(false)
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      setInitialized(true)
    }
  }, [])

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
    return <LandingPage onCreateLink={() => setView('create')} />
  }

  // ── Wallet restoring / reconnecting skeleton ─────────────────────────────
  if (isRestoring) {
    return (
      <div className="iss-shell" aria-busy="true">
        <div className="iss-canvas">
          <header className="iss-header">
            <div className="iss-brand">
              <SpooklyGhost className="w-6 h-auto" />
              <span className="iss-brand-name">knowless</span>
            </div>
            <div className="iss-skel" style={{ width: '120px', height: '38px' }} aria-hidden="true" />
          </header>
          <div className="iss-restoring-main" role="status" aria-label="Restoring wallet…">
            <div className="iss-skel" style={{ height: '52px', borderRadius: '10px' }} aria-hidden="true" />
            <div className="iss-skel" style={{ height: '40px', borderRadius: '10px', width: '60%' }} aria-hidden="true" />
            <p className="text-sm text-center" style={{ color: '#0d1b2a', opacity: 0.5 }}>Restoring wallet…</p>
          </div>
        </div>
      </div>
    )
  }

  // ── Sub-views (only reachable when connected) ────────────────────────────
  if (view === 'fund') {
    return (
      <div className="iss-subview">
        <div className="iss-subview-canvas">
          <header className="iss-subview-header">
            <button type="button" onClick={() => setView('dashboard')}
              className="iss-back-btn" aria-label="Back to dashboard">
              ← Back
            </button>
            <h1 className="iss-subview-title">Fund from another chain</h1>
          </header>
          <main className="iss-subview-main">
            <FundFromChain
              onFunded={() => setView('create')}
              onBack={() => setView('dashboard')}
            />
          </main>
        </div>
      </div>
    )
  }

  if (view === 'create') {
    return (
      <div className="iss-subview">
        <div className="iss-subview-canvas">
          <header className="iss-subview-header">
            <button type="button" onClick={() => setView('dashboard')}
              className="iss-back-btn" aria-label="Back to dashboard">
              ← Back
            </button>
            <h1 className="iss-subview-title">New link</h1>
          </header>
          <main className="iss-subview-main">
            <CreateLinkForm contractAddress={contractAddress} onLinkCreated={handleLinkCreated} />
          </main>
        </div>
      </div>
    )
  }

  if (view === 'share' && sharedLink) {
    return (
      <div className="iss-subview">
        <div className="iss-subview-canvas">
          <header className="iss-subview-header">
            <h1 className="iss-subview-title">Link ready</h1>
          </header>
          <main className="iss-subview-main">
            <ShareLinkCard
              linkUrl={sharedLink.url}
              signerAddress={sharedLink.signerAddress}
              amountDisplay={sharedLink.amountDisplay}
              expiryLabel={sharedLink.expiryLabel}
              onDone={() => { setView('dashboard'); loadAndSetLinks() }}
            />
          </main>
        </div>
      </div>
    )
  }

  // ── Main dashboard ───────────────────────────────────────────────────────
  return (
    <div className="iss-shell">
      <div className="iss-canvas">
        {/* Header */}
        <header className="iss-header">
          <div className="iss-brand">
            <SpooklyGhost className="w-6 h-auto" />
            <span className="iss-brand-name">knowless</span>
          </div>
          <ConnectKitButton.Custom>
            {({ isConnected: ckConnected, show, address: ckAddr, ensName }) => (
              <button type="button" onClick={show} className="iss-wallet-btn"
                aria-label={ckConnected ? 'Wallet connected — click to manage' : 'Connect wallet'}>
                {ckConnected && ckAddr ? (
                  <span className="iss-wallet-addr">
                    {ensName ?? truncateAddr(ckAddr as Address)}
                  </span>
                ) : 'Connect wallet'}
              </button>
            )}
          </ConnectKitButton.Custom>
        </header>

        {/* Main content */}
        <main className="iss-main">
          {/* Heading */}
          <div>
            <h1 className="iss-heading">Your spending links.</h1>
            <p className="iss-subhead">Fund a link with USDC — anyone with it can pay without a wallet.</p>
          </div>

          {/* Actions */}
          <div className="iss-actions">
            <button type="button" onClick={() => setView('create')}
              className="iss-btn-primary">
              <Plus size={17} />
              New spending link
            </button>
            <button type="button" onClick={() => setView('fund')}
              className="iss-btn-secondary">
              <Link2 size={16} />
              Fund from another chain
            </button>
          </div>

          {/* Links */}
          {links.length > 0 ? (
            <section className="iss-links-section" aria-label="Your links">
              <p className="iss-links-label">Your links</p>
              <div className="iss-links-grid">
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
            <div className="iss-empty">
              <SpooklyGhost className="w-14 h-auto opacity-25" />
              <p className="iss-empty-text">No links yet.</p>
              <p className="iss-empty-text" style={{ fontSize: '0.8125rem' }}>
                Create a link to send spendable USDC.
              </p>
            </div>
          )}

          {/* Contract chip */}
          <div className="iss-footer-chip">
            Arc Mainnet ·{' '}
            <code>{contractAddress.slice(0, 10)}…{contractAddress.slice(-6)}</code>
          </div>
        </main>
      </div>
    </div>
  )
}

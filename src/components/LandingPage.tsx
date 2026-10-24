/**
 * LandingPage — editorial disconnected landing for knowless.
 * Shown only when wagmi status is definitively 'disconnected'.
 * No financial controls, no live data, no wallet/storage access.
 */

import { useModal } from 'connectkit'
import { ArrowRight } from 'lucide-react'
import { SpooklyGhost } from './SpooklyGhost'

// ── Decorative QR motif — dark navy modules, pale-blue scanner corners ───────
function QrMotif() {
  // 6×6 grid of modules; corners reserved for finder patterns
  const modules: [number, number][] = []
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      // skip finder-pattern cells (top-left, top-right, bottom-left 2×2)
      if ((r < 2 && c < 2) || (r < 2 && c > 3) || (r > 3 && c < 2)) continue
      if ((r + c) % 3 !== 0) modules.push([c, r])
    }
  }
  const cell = 8, gap = 2, sz = 6 * (cell + gap)
  return (
    <svg aria-hidden viewBox={`0 0 ${sz} ${sz}`} width={sz} height={sz}
      style={{ display: 'block' }}>
      {/* Finder patterns — navy */}
      {([[0,0],[sz-14-2,0],[0,sz-14-2]] as [number,number][]).map(([fx,fy],i) => (
        <g key={i}>
          <rect x={fx} y={fy} width={14} height={14} rx="2" fill="none" stroke="#122d45" strokeWidth="2"/>
          <rect x={fx+4} y={fy+4} width={6} height={6} rx="1" fill="#122d45"/>
        </g>
      ))}
      {/* Data modules — navy */}
      {modules.map(([c,r]) => (
        <rect key={`${c}-${r}`} x={c*(cell+gap)} y={r*(cell+gap)}
          width={cell} height={cell} rx="1.5" fill="#122d45" opacity={0.75}/>
      ))}
      {/* Scanner corner accents — pale blue, outside the motif */}
      {/* TL */}
      <path d={`M-6 12 L-6 -6 L12 -6`} fill="none" stroke="#4aa8e8" strokeWidth="3" strokeLinecap="round"/>
      {/* TR */}
      <path d={`M${sz-12} -6 L${sz+6} -6 L${sz+6} 12`} fill="none" stroke="#4aa8e8" strokeWidth="3" strokeLinecap="round"/>
      {/* BL */}
      <path d={`M-6 ${sz-12} L-6 ${sz+6} L12 ${sz+6}`} fill="none" stroke="#4aa8e8" strokeWidth="3" strokeLinecap="round"/>
    </svg>
  )
}

// ── Curved SVG ribbon ─────────────────────────────────────────────────────────
function CurvedRibbon() {
  return (
    <svg aria-hidden className="landing-ribbon-svg"
      viewBox="0 0 520 220" preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 0 }}>
      <defs>
        <linearGradient id="ribbonGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#ddeef8"/>
          <stop offset="55%"  stopColor="#c3dff5"/>
          <stop offset="100%" stopColor="#e5f2fb"/>
        </linearGradient>
      </defs>
      {/* Broad curved band flowing diagonally across the illustration area */}
      <path
        d="M -20 60
           C 80 20, 200 10, 320 50
           C 420 80, 500 120, 540 100
           L 540 200
           C 500 220, 420 200, 320 165
           C 200 125, 80 130, -20 160
           Z"
        fill="url(#ribbonGrad)"
        opacity="0.82"
      />
    </svg>
  )
}

// ── Decorative spending-link card ─────────────────────────────────────────────
function SpendingLinkCard() {
  return (
    <div className="landing-card landing-card--main" aria-label="Example spending link card">
      <div className="landing-card__header">
        <span className="landing-card__label">Spending link</span>
        <span className="landing-card__pill">
          <span className="landing-card__dot" />
          Ready to share
        </span>
      </div>
      <div className="landing-card__amount">25.00 <span>USDC</span></div>
      <div className="landing-card__link-row" aria-hidden>
        <span className="landing-card__link-icon">🔗</span>
        <span className="landing-card__link-text">knowless.link/…</span>
      </div>
      <div className="landing-card__actions" aria-hidden>
        <span className="landing-card__copy-btn">Copy link</span>
      </div>
    </div>
  )
}

// ── Decorative QR-pay card ────────────────────────────────────────────────────
function QrPayCard() {
  return (
    <div className="landing-card landing-card--secondary" aria-label="Example scan and pay card">
      <div className="landing-card__header">
        <span className="landing-card__label">Scan recipient QR</span>
      </div>
      <div className="landing-card__qr">
        <QrMotif />
      </div>
      <div className="landing-card__actions" aria-hidden>
        <span className="landing-card__pay-btn">Pay with link</span>
      </div>
    </div>
  )
}

// ── Hero illustration composite ───────────────────────────────────────────────
function HeroIllustration() {
  return (
    <div className="landing-illustration" aria-hidden="true">
      <CurvedRibbon />
      <div className="landing-ghost-peek">
        <SpooklyGhost className="w-full h-auto" />
      </div>
      <div className="landing-cards-wrap">
        <SpendingLinkCard />
        <QrPayCard />
      </div>
    </div>
  )
}

// ── How it works step ─────────────────────────────────────────────────────────
interface StepProps { num: string; heading: string; body: string; icon: React.ReactNode }
function Step({ num, heading, body, icon }: StepProps) {
  return (
    <div className="landing-step">
      <div className="landing-step__icon" aria-hidden="true">{icon}</div>
      <div className="landing-step__num">{num}</div>
      <h3 className="landing-step__heading">{heading}</h3>
      <p className="landing-step__body">{body}</p>
    </div>
  )
}

function IconFund() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="4" y="10" width="24" height="16" rx="3" stroke="#4aa8e8" strokeWidth="1.8"/>
      <path d="M10 10V8a6 6 0 0 1 12 0v2" stroke="#4aa8e8" strokeWidth="1.8" strokeLinecap="round"/>
      <circle cx="16" cy="18" r="2.5" stroke="#4aa8e8" strokeWidth="1.8"/>
    </svg>
  )
}
function IconShare() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden>
      <circle cx="8"  cy="16" r="3" stroke="#4aa8e8" strokeWidth="1.8"/>
      <circle cx="24" cy="8"  r="3" stroke="#4aa8e8" strokeWidth="1.8"/>
      <circle cx="24" cy="24" r="3" stroke="#4aa8e8" strokeWidth="1.8"/>
      <path d="M11 14.5l10-5M11 17.5l10 5" stroke="#4aa8e8" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  )
}
function IconPay() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="5"  y="5"  width="10" height="10" rx="1.5" stroke="#4aa8e8" strokeWidth="1.8"/>
      <rect x="17" y="5"  width="10" height="10" rx="1.5" stroke="#4aa8e8" strokeWidth="1.8"/>
      <rect x="5"  y="17" width="10" height="10" rx="1.5" stroke="#4aa8e8" strokeWidth="1.8"/>
      <rect x="8"  y="8"  width="4"  height="4"  rx="0.5" fill="#4aa8e8"/>
      <rect x="20" y="8"  width="4"  height="4"  rx="0.5" fill="#4aa8e8"/>
      <rect x="8"  y="20" width="4"  height="4"  rx="0.5" fill="#4aa8e8"/>
      <path d="M19 19h4v4M19 23h4" stroke="#4aa8e8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
interface LandingPageProps {
  /** Called when "Create a link" is clicked — parent switches to create view */
  onCreateLink: () => void
}

export function LandingPage({ onCreateLink }: LandingPageProps) {
  const { setOpen } = useModal()

  // Primary CTA: set parent view to 'create', then open connect modal
  const handleCreateLink = () => {
    onCreateLink()
    void setOpen(true)
  }

  // Nav connect: open connect modal; parent stays on 'dashboard' after connect
  const handleNavConnect = () => { void setOpen(true) }

  return (
    <>
      <style>{LANDING_CSS}</style>
      <div className="landing">

        {/* ── Navigation ────────────────────────────────────────── */}
        <header className="landing-nav" role="banner">
          <div className="landing-nav__inner">
            {/* Brand */}
            <a href="#" className="landing-nav__brand" aria-label="knowless home">
              <SpooklyGhost className="landing-nav__ghost" />
              <span className="landing-nav__wordmark">knowless</span>
            </a>

            {/* Desktop nav links + connect */}
            <nav className="landing-nav__links landing-nav__links--desktop" aria-label="Site navigation">
              <a href="#how-it-works" className="landing-nav__link">How it works</a>
              <a href="https://github.com/emeieiron/knowless"
                className="landing-nav__link"
                target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
              <button type="button" className="landing-nav__connect"
                onClick={handleNavConnect} aria-label="Connect wallet">
                Connect wallet
              </button>
            </nav>

            {/* Mobile: connect only in top row */}
            <button type="button" className="landing-nav__connect landing-nav__connect--mobile"
              onClick={handleNavConnect} aria-label="Connect wallet">
              Connect
            </button>
          </div>

          {/* Mobile: secondary row for text links */}
          <div className="landing-nav__mobile-row" aria-label="Site navigation">
            <a href="#how-it-works" className="landing-nav__link">How it works</a>
            <a href="https://github.com/emeieiron/knowless"
              className="landing-nav__link"
              target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
          </div>
        </header>

        <main>
          {/* ── Hero ──────────────────────────────────────────────── */}
          <section className="landing-hero" aria-labelledby="hero-headline">
            <div className="landing-hero__inner">

              {/* Text side — always first in DOM/mobile */}
              <div className="landing-hero__text">
                <h1 id="hero-headline" className="landing-hero__h1">
                  Money,<br className="landing-hero__br" /> made shareable.
                </h1>
                <p className="landing-hero__sub">
                  Turn USDC into a link. Anyone with it can pay — no wallet connection needed.
                </p>
                <div className="landing-hero__ctas">
                  <button type="button" className="landing-cta-primary"
                    onClick={handleCreateLink}
                    aria-label="Create a link — connect wallet to get started">
                    Create a link <ArrowRight size={18} aria-hidden />
                  </button>
                  <a href="#how-it-works" className="landing-cta-secondary">
                    See how it works
                  </a>
                </div>
                <p className="landing-hero__note">
                  Creators connect a wallet. Spenders don't.
                </p>
              </div>

              {/* Illustration side */}
              <div className="landing-hero__art">
                <HeroIllustration />
              </div>

            </div>
          </section>

          {/* ── How it works ──────────────────────────────────────── */}
          <section id="how-it-works" className="landing-how" aria-labelledby="how-heading">
            <div className="landing-how__inner">
              <h2 id="how-heading" className="landing-how__heading">How it works</h2>
              <div className="landing-steps">
                <Step num="01" heading="Fund a link" icon={<IconFund />}
                  body="Connect your wallet, choose an amount and expiry, and create your USDC spending link." />
                <div className="landing-steps__divider" aria-hidden />
                <Step num="02" heading="Share it" icon={<IconShare />}
                  body="Send the link in a message, an email, or a QR code." />
                <div className="landing-steps__divider" aria-hidden />
                <Step num="03" heading="Scan and pay" icon={<IconPay />}
                  body="Open the link, scan the recipient's QR code, and pay without connecting a wallet." />
              </div>
            </div>
          </section>
        </main>

        {/* ── Footer ────────────────────────────────────────────── */}
        <footer className="landing-footer" role="contentinfo">
          <div className="landing-footer__inner">
            <div className="landing-footer__brand">
              <SpooklyGhost className="landing-footer__ghost" />
              <span className="landing-footer__wordmark">knowless</span>
            </div>
            <p className="landing-footer__built">Built on Arc · USDC</p>
            <nav className="landing-footer__links" aria-label="Footer navigation">
              <a href="https://github.com/emeieiron/knowless"
                target="_blank" rel="noopener noreferrer"
                className="landing-footer__link">
                GitHub
              </a>
              <a href="https://studio.arc.io"
                target="_blank" rel="noopener noreferrer"
                className="landing-footer__link">
                Built with Arc Studio
              </a>
            </nav>
          </div>
        </footer>

      </div>
    </>
  )
}

// ── Scoped CSS ────────────────────────────────────────────────────────────────
const LANDING_CSS = `
/* ── Reset / base ─────────────────────────────────────── */
.landing { font-family: var(--font-sans, system-ui, sans-serif); background: #f9f8f6; color: #122d45; min-height: 100dvh; display: flex; flex-direction: column; overflow-x: hidden; }
.landing *, .landing *::before, .landing *::after { box-sizing: border-box; }

/* ── Nav ───────────────────────────────────────────────── */
.landing-nav { position: sticky; top: 0; z-index: 40; background: rgba(249,248,246,0.95); backdrop-filter: blur(10px); border-bottom: 1px solid #e2e8ef; }
.landing-nav__inner { max-width: 1320px; margin: 0 auto; padding: 0 48px; height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.landing-nav__brand { display: flex; align-items: center; gap: 8px; text-decoration: none; color: #122d45; flex-shrink: 0; }
.landing-nav__ghost { width: 28px; height: auto; }
.landing-nav__wordmark { font-size: 1.05rem; font-weight: 700; letter-spacing: -0.01em; color: #122d45; }
.landing-nav__links { display: flex; align-items: center; gap: 28px; }
.landing-nav__link { font-size: 0.875rem; color: #4a6580; text-decoration: none; font-weight: 500; transition: color .15s; white-space: nowrap; }
.landing-nav__link:hover, .landing-nav__link:focus-visible { color: #122d45; }
.landing-nav__link:focus-visible { outline: 2px solid #4aa8e8; outline-offset: 3px; border-radius: 3px; }
.landing-nav__connect { background: #122d45; color: #fff; border: none; border-radius: 8px; padding: 8px 18px; font-size: 0.875rem; font-weight: 600; cursor: pointer; min-height: 44px; transition: background .15s; white-space: nowrap; }
.landing-nav__connect:hover { background: #1a3d5c; }
.landing-nav__connect:focus-visible { outline: 2px solid #4aa8e8; outline-offset: 2px; border-radius: 8px; }

/* Desktop-only: --links--desktop, hide mobile button */
.landing-nav__links--desktop { display: flex; }
.landing-nav__connect--mobile { display: none; }
.landing-nav__mobile-row { display: none; }

/* ── Hero ───────────────────────────────────────────────── */
.landing-hero { flex: 1; padding: 72px 48px 64px; }
.landing-hero__inner { max-width: 1320px; margin: 0 auto; display: grid; grid-template-columns: 55fr 45fr; align-items: center; gap: 48px; }
.landing-hero__text { display: flex; flex-direction: column; gap: 28px; }
.landing-hero__h1 { font-family: Georgia, 'Times New Roman', serif; font-size: clamp(2.8rem, 5.5vw, 6.5rem); font-weight: 700; line-height: 1.06; letter-spacing: -0.03em; color: #122d45; margin: 0; }
.landing-hero__br { display: none; }
@media (min-width: 900px) { .landing-hero__br { display: inline; } }
.landing-hero__sub { font-size: clamp(1rem, 1.5vw, 1.15rem); line-height: 1.6; color: #4a6580; max-width: 38ch; margin: 0; }
.landing-hero__ctas { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
.landing-hero__note { font-size: 0.85rem; color: #7a98b0; margin: 0; }

/* ── CTAs ───────────────────────────────────────────────── */
.landing-cta-primary { display: inline-flex; align-items: center; gap: 8px; background: #122d45; color: #fff; border: none; border-radius: 10px; padding: 14px 26px; font-size: 1rem; font-weight: 600; cursor: pointer; min-height: 52px; transition: background .15s, transform .1s; text-decoration: none; }
.landing-cta-primary:hover { background: #1a3d5c; }
.landing-cta-primary:active { transform: scale(.98); }
.landing-cta-primary:focus-visible { outline: 2px solid #4aa8e8; outline-offset: 3px; border-radius: 10px; }
.landing-cta-secondary { display: inline-flex; align-items: center; color: #122d45; border: 1.5px solid #c8d8e6; border-radius: 10px; padding: 14px 24px; font-size: 1rem; font-weight: 500; cursor: pointer; min-height: 52px; text-decoration: none; transition: border-color .15s, background .15s; background: transparent; }
.landing-cta-secondary:hover { border-color: #4aa8e8; background: rgba(74,168,232,0.06); }
.landing-cta-secondary:focus-visible { outline: 2px solid #4aa8e8; outline-offset: 3px; border-radius: 10px; }

/* ── Illustration ───────────────────────────────────────── */
.landing-illustration { position: relative; width: 100%; height: 360px; overflow: visible; }
@media (prefers-reduced-motion: no-preference) {
  .landing-illustration { animation: landing-fadein .55s ease both; }
  @keyframes landing-fadein { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
}

/* Ghost peek */
.landing-ghost-peek { position: absolute; left: 4px; top: 12px; width: 68px; z-index: 1; opacity: 0.88; pointer-events: none; }

/* Cards wrapper */
.landing-cards-wrap { position: absolute; inset: 0; display: flex; align-items: flex-start; }

/* Cards — base */
.landing-card { background: #fff; border-radius: 16px; padding: 18px 20px; box-shadow: 0 4px 24px rgba(18,45,69,0.10), 0 1px 4px rgba(18,45,69,0.06); z-index: 2; min-width: 0; }
.landing-card--main { position: absolute; left: 56px; top: 20px; width: 248px; z-index: 2; }
.landing-card--secondary { position: absolute; right: 8px; top: 108px; width: 210px; z-index: 3; }
.landing-card__header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.landing-card__label { font-size: 0.75rem; font-weight: 600; color: #4a6580; letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap; }
.landing-card__pill { display: inline-flex; align-items: center; gap: 5px; background: #e6f7ee; color: #1a7a46; border-radius: 20px; padding: 3px 10px; font-size: 0.7rem; font-weight: 600; white-space: nowrap; }
.landing-card__dot { width: 6px; height: 6px; border-radius: 50%; background: #28a864; flex-shrink: 0; }
.landing-card__amount { font-size: 1.7rem; font-weight: 700; color: #122d45; letter-spacing: -0.02em; margin-bottom: 10px; }
.landing-card__amount span { font-size: 0.95rem; font-weight: 500; color: #7a98b0; }
.landing-card__link-row { display: flex; align-items: center; gap: 6px; background: #f3f7fa; border-radius: 8px; padding: 6px 10px; margin-bottom: 12px; overflow: hidden; }
.landing-card__link-icon { font-size: 0.85rem; flex-shrink: 0; }
.landing-card__link-text { font-size: 0.75rem; color: #7a98b0; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.landing-card__actions { display: flex; justify-content: flex-end; }
.landing-card__copy-btn { display: inline-block; background: #122d45; color: #fff; border-radius: 7px; padding: 6px 13px; font-size: 0.75rem; font-weight: 600; }
.landing-card__pay-btn { display: inline-block; background: #4aa8e8; color: #fff; border-radius: 7px; padding: 6px 13px; font-size: 0.75rem; font-weight: 600; }
.landing-card__qr { display: flex; justify-content: center; padding: 6px 0 10px; overflow: visible; }

/* ── How it works ───────────────────────────────────────── */
.landing-how { padding: 80px 48px; background: #fff; border-top: 1px solid #e2e8ef; }
.landing-how__inner { max-width: 1320px; margin: 0 auto; }
.landing-how__heading { font-family: Georgia, 'Times New Roman', serif; font-size: clamp(1.6rem, 3vw, 2.4rem); font-weight: 700; color: #122d45; letter-spacing: -0.02em; margin: 0 0 48px; text-align: center; }
.landing-steps { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; align-items: start; }
.landing-steps__divider { width: 1px; background: #e2e8ef; margin: 40px 32px 0; min-height: 120px; }
.landing-step { display: flex; flex-direction: column; gap: 12px; padding: 0 8px; }
.landing-step__icon { width: 48px; height: 48px; background: #eef5fc; border-radius: 12px; display: flex; align-items: center; justify-content: center; }
.landing-step__num { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; color: #4aa8e8; text-transform: uppercase; }
.landing-step__heading { font-size: 1.05rem; font-weight: 700; color: #122d45; margin: 0; }
.landing-step__body { font-size: 0.9rem; line-height: 1.65; color: #4a6580; margin: 0; }

/* ── Footer ─────────────────────────────────────────────── */
.landing-footer { border-top: 1px solid #e2e8ef; padding: 32px 48px; background: #f9f8f6; }
.landing-footer__inner { max-width: 1320px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; }
.landing-footer__brand { display: flex; align-items: center; gap: 7px; }
.landing-footer__ghost { width: 22px; height: auto; }
.landing-footer__wordmark { font-size: 0.9rem; font-weight: 700; color: #122d45; }
.landing-footer__built { font-size: 0.8rem; color: #7a98b0; margin: 0; }
.landing-footer__links { display: flex; align-items: center; gap: 20px; }
.landing-footer__link { font-size: 0.8rem; color: #7a98b0; text-decoration: none; transition: color .15s; }
.landing-footer__link:hover { color: #122d45; }
.landing-footer__link:focus-visible { outline: 2px solid #4aa8e8; outline-offset: 2px; border-radius: 3px; }

/* ── Responsive: tablet 640–900px ─────────────────────────── */
@media (max-width: 900px) {
  .landing-nav__inner { padding: 0 20px; height: 60px; }
  .landing-hero { padding: 40px 20px 48px; }
  /* hero: text first, art below */
  .landing-hero__inner { grid-template-columns: 1fr; gap: 36px; }
  .landing-hero__art { order: 1; }
  .landing-illustration { height: 300px; }
  .landing-card--main { left: 40px; width: 220px; }
  .landing-card--secondary { right: 4px; width: 188px; top: 90px; }
  .landing-ghost-peek { width: 56px; }
  .landing-how { padding: 56px 20px; }
  .landing-steps { grid-template-columns: 1fr; }
  .landing-steps__divider { display: none; }
  .landing-footer { padding: 24px 20px; }
  .landing-footer__inner { flex-direction: column; align-items: flex-start; gap: 12px; }
}

/* ── Responsive: mobile ≤640px — compact two-row nav ─────── */
@media (max-width: 640px) {
  /* Switch to two-row nav: brand+Connect on row 1, links on row 2 */
  .landing-nav__links--desktop { display: none; }
  .landing-nav__connect--mobile { display: flex; align-items: center; }
  .landing-nav__mobile-row {
    display: flex; align-items: center; gap: 20px;
    padding: 6px 20px 8px; border-top: 1px solid #e2e8ef;
    background: rgba(249,248,246,0.95);
  }
  .landing-nav__mobile-row .landing-nav__link { font-size: 0.82rem; }
  /* Cards: stack vertically so no overlap */
  .landing-illustration { height: auto; min-height: 380px; display: flex; flex-direction: column; align-items: center; padding: 16px 0 8px; }
  .landing-ribbon-svg { position: absolute; left: -20px; right: -20px; width: calc(100% + 40px); top: 0; height: 100%; }
  .landing-ghost-peek { position: relative; left: auto; top: auto; width: 52px; align-self: flex-start; margin-left: 8px; margin-bottom: -16px; }
  .landing-cards-wrap { position: relative; inset: auto; display: flex; flex-direction: column; align-items: center; gap: 16px; width: 100%; }
  .landing-card--main { position: relative; left: auto; top: auto; width: min(260px, 90vw); }
  .landing-card--secondary { position: relative; right: auto; top: auto; width: min(220px, 80vw); }
}

/* ── Responsive: narrow ≤400px ─────────────────────────── */
@media (max-width: 400px) {
  .landing-hero__h1 { font-size: 2.2rem; }
  .landing-hero__ctas { flex-direction: column; align-items: flex-start; }
  .landing-card--main { width: min(240px, 88vw); }
  .landing-card--secondary { width: min(200px, 80vw); }
  .landing-ghost-peek { width: 44px; }
}
`

/**
 * LandingPage — bold lime design for knowless.
 * Shown only when wagmi status is definitively 'disconnected'.
 * Decorative artwork only; no financial controls, live data, or wallet access.
 * Font: Anton (OFL), self-hosted from src/assets/fonts/Anton-Regular.woff2
 */

import { useModal } from 'connectkit'
import { ArrowRight } from 'lucide-react'
import { SpooklyGhost } from './SpooklyGhost'
import antonFont from '../assets/fonts/Anton-Regular.woff2'

interface LandingPageProps {
  onCreateLink: () => void
}

// ── Decorative QR motif — proper finder squares, no real data ──────────────
function QrMotif() {
  // 21×21 module decorative QR (not a valid/scannable code)
  const S = 5 // module size px
  const G = 1 // gap
  const N = 21
  const sz = N * (S + G)

  // Top-left finder (7×7), top-right finder (7×7), bottom-left finder (7×7)
  function Finder({ x, y }: { x: number; y: number }) {
    const u = S + G
    return (
      <g>
        {/* outer ring */}
        {[0,1,2,3,4,5,6].map(r =>
          [0,1,2,3,4,5,6].map(c => {
            const outer = r===0||r===6||c===0||c===6
            const inner = r>=2&&r<=4&&c>=2&&c<=4
            if (outer || inner)
              return <rect key={`${r}-${c}`} x={x+c*u} y={y+r*u} width={S} height={S} rx="0.5" fill="#0d1b2a"/>
            return null
          })
        )}
      </g>
    )
  }

  // Timing pattern dots (row/col 6)
  const timing: React.ReactNode[] = []
  for (let i = 8; i <= 12; i++) {
    if (i % 2 === 0) {
      timing.push(<rect key={`tr-${i}`} x={i*(S+G)} y={6*(S+G)} width={S} height={S} rx="0.5" fill="#0d1b2a"/>)
      timing.push(<rect key={`tc-${i}`} x={6*(S+G)} y={i*(S+G)} width={S} height={S} rx="0.5" fill="#0d1b2a"/>)
    }
  }

  // Data region — sparse decorative modules in bottom-right quadrant
  const dataModules = [
    [9,9],[9,11],[10,10],[10,12],[11,9],[11,11],[11,13],
    [12,10],[12,12],[13,9],[13,11],[14,10],[14,13],
    [15,9],[15,12],[16,10],[16,11],[17,13],[18,9],[18,11],[19,12],[20,10],
    [9,14],[10,15],[11,14],[12,16],[13,15],[14,14],[15,16],[16,15],
  ]

  return (
    <svg aria-hidden viewBox={`0 0 ${sz} ${sz}`} width={sz} height={sz}
      style={{ display:'block' }}>
      <Finder x={0} y={0} />
      <Finder x={(N-7)*(S+G)} y={0} />
      <Finder x={0} y={(N-7)*(S+G)} />
      {timing}
      {dataModules.map(([r,c]) => (
        <rect key={`d-${r}-${c}`} x={c*(S+G)} y={r*(S+G)} width={S} height={S} rx="0.5" fill="#0d1b2a"/>
      ))}
    </svg>
  )
}

// ── Hand-drawn accent marks ─────────────────────────────────────────────────
function Burst({ style }: { style?: React.CSSProperties }) {
  return (
    <svg aria-hidden viewBox="0 0 36 36" width="32" height="32"
      style={{ display:'block', position:'absolute', ...style }}>
      <line x1="18" y1="1"  x2="18" y2="10" stroke="#0d1b2a" strokeWidth="2.5" strokeLinecap="round"/>
      <line x1="30" y1="6"  x2="24" y2="12" stroke="#0d1b2a" strokeWidth="2.5" strokeLinecap="round"/>
      <line x1="35" y1="18" x2="26" y2="18" stroke="#0d1b2a" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  )
}

function Squiggle({ style }: { style?: React.CSSProperties }) {
  return (
    <svg aria-hidden viewBox="0 0 44 14" width="44" height="14"
      style={{ display:'block', position:'absolute', ...style }}>
      <path d="M2 7 Q8 1 14 7 Q20 13 26 7 Q32 1 38 7 Q42 11 43 9"
        fill="none" stroke="#0d1b2a" strokeWidth="2.2" strokeLinecap="round"/>
    </svg>
  )
}

// Continuous curved arrow — single connected path + arrowhead
function ArrowCurved({ style }: { style?: React.CSSProperties }) {
  return (
    <svg aria-hidden viewBox="0 0 90 90" width="80" height="80"
      style={{ position:'absolute', ...style }}>
      {/* Continuous cubic bezier — no dash */}
      <path d="M12 12 C40 4 72 30 68 68" fill="none"
        stroke="#0d1b2a" strokeWidth="2.6" strokeLinecap="round"/>
      {/* Arrowhead attached at endpoint (68,68) */}
      <path d="M60 62 L68 70 L74 60"
        fill="none" stroke="#0d1b2a" strokeWidth="2.6"
        strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function ArrowHoriz({ style }: { style?: React.CSSProperties }) {
  return (
    <svg aria-hidden viewBox="0 0 56 24" width="48" height="20"
      style={{ flexShrink:0, ...style }}>
      <path d="M2 12 L44 12 M36 5 L44 12 L36 19"
        fill="none" stroke="#0d1b2a" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ── Step icons ───────────────────────────────────────────────────────────────
function IconWallet() {
  return (
    <svg width="38" height="38" viewBox="0 0 40 40" fill="none" aria-hidden>
      <rect x="4" y="12" width="32" height="22" rx="4" stroke="#0d1b2a" strokeWidth="2.2"/>
      <path d="M4 18h32" stroke="#0d1b2a" strokeWidth="2.2"/>
      <path d="M10 12V10a6 6 0 0 1 12 0v2" stroke="#0d1b2a" strokeWidth="2.2" strokeLinecap="round"/>
      <circle cx="28" cy="25" r="2.5" fill="#0d1b2a"/>
    </svg>
  )
}
function IconLink() {
  return (
    <svg width="38" height="38" viewBox="0 0 40 40" fill="none" aria-hidden>
      <path d="M17 23a7 7 0 0 1 0-9.9l2.8-2.8a7 7 0 1 1 9.9 9.9L27 23" stroke="#0d1b2a" strokeWidth="2.2" strokeLinecap="round"/>
      <path d="M23 17a7 7 0 0 1 0 9.9l-2.8 2.8a7 7 0 1 1-9.9-9.9L13 17" stroke="#0d1b2a" strokeWidth="2.2" strokeLinecap="round"/>
    </svg>
  )
}
function IconPhone() {
  return (
    <svg width="38" height="38" viewBox="0 0 40 40" fill="none" aria-hidden>
      <rect x="12" y="4" width="16" height="28" rx="3" stroke="#0d1b2a" strokeWidth="2.2"/>
      <rect x="16" y="8" width="8" height="8" rx="1" stroke="#0d1b2a" strokeWidth="1.8"/>
      <circle cx="20" cy="28" r="1.5" fill="#0d1b2a"/>
    </svg>
  )
}

// ── Spending link card (decorative) ─────────────────────────────────────────
function SpendingCard() {
  return (
    <div className="lnd-card lnd-card--main" aria-label="Spending link card illustration">
      <div className="lnd-card__top-row">
        <span className="lnd-card__label">SPENDING LINK</span>
        <span className="lnd-card__dots" aria-hidden>···</span>
      </div>
      <div className="lnd-card__rule" aria-hidden />
      <div className="lnd-card__amount">
        <span className="lnd-card__num">25.00</span>
        <span className="lnd-card__currency">USDC</span>
      </div>
      <div className="lnd-card__rule" aria-hidden />
      <div className="lnd-card__meta">
        <span className="lnd-card__meta-item">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="9" stroke="#0d1b2a" strokeWidth="2"/>
            <path d="M12 7v5l3 3" stroke="#0d1b2a" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          7 days
        </span>
        <span className="lnd-card__meta-right">Expires in 7 days</span>
      </div>
      <div className="lnd-card__copy-strip" aria-hidden>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="9" y="9" width="13" height="13" rx="2" stroke="#f9f7f0" strokeWidth="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="#f9f7f0" strokeWidth="2"/>
        </svg>
        Copy link
      </div>
    </div>
  )
}

// ── QR pay card (decorative) ────────────────────────────────────────────────
function QrCard() {
  return (
    <div className="lnd-card lnd-card--qr" aria-label="Scan and pay card illustration">
      <div className="lnd-card__qr-label">Scan. Pay. Done.</div>
      <div className="lnd-card__qr-motif">
        <QrMotif />
      </div>
    </div>
  )
}

// ── Hero artwork composite — bounded cluster ─────────────────────────────────
function HeroArt() {
  return (
    <div className="lnd-art" aria-hidden="true">
      {/* Bounded card cluster — ghost, cards and arrow all relative to this */}
      <div className="lnd-cluster">
        {/* Ghost peeks over top-right of main card */}
        <div className="lnd-ghost">
          <SpooklyGhost className="w-full h-auto" />
        </div>
        {/* Burst accent top-left of cluster */}
        <Burst style={{ top: 8, left: -24 }} />
        <Squiggle style={{ top: 20, left: 60 }} />
        {/* Main spending card */}
        <SpendingCard />
        {/* Curved arrow from main card toward QR card */}
        <ArrowCurved style={{ top: '55%', right: -8, zIndex: 3 }} />
        {/* QR card lower-right */}
        <div className="lnd-qr-wrap">
          <QrCard />
        </div>
      </div>
    </div>
  )
}

// ── Process step ─────────────────────────────────────────────────────────────
interface StepProps { num: string; heading: string; body: string; icon: React.ReactNode }
function Step({ num, heading, body, icon }: StepProps) {
  return (
    <div className="lnd-step">
      <div className="lnd-step__top">
        <div>
          <div className="lnd-step__num">{num}</div>
          <div className="lnd-step__heading">{heading}</div>
        </div>
        <div className="lnd-step__icon">{icon}</div>
      </div>
      <p className="lnd-step__body">{body}</p>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export function LandingPage({ onCreateLink }: LandingPageProps) {
  const { setOpen } = useModal()

  const handleCreate = () => {
    onCreateLink()
    void setOpen(true)
  }

  return (
    <>
      <style>{LANDING_CSS.replace('__ANTON_URL__', antonFont)}</style>

      {/* Dark outer shell — inset lime canvas */}
      <div className="lnd-shell">
        <div className="lnd">

          {/* ── Nav ── */}
          <header className="lnd-nav" role="banner">
            <div className="lnd-nav__inner">
              <a href="#" className="lnd-nav__brand" aria-label="knowless home">
                <SpooklyGhost className="lnd-nav__ghost" />
                <span className="lnd-nav__wordmark">knowless</span>
              </a>
              {/* Desktop nav links */}
              <nav className="lnd-nav__links" aria-label="Site navigation">
                <a href="#how-it-works" className="lnd-nav__link">How it works</a>
                <a href="https://github.com/emeieiron/knowless"
                  className="lnd-nav__link" target="_blank" rel="noopener noreferrer">
                  GitHub
                </a>
                <button type="button" className="lnd-nav__connect"
                  onClick={() => void setOpen(true)} aria-label="Connect wallet">
                  Connect wallet
                </button>
              </nav>
              {/* Mobile: connect always visible in top row */}
              <button type="button" className="lnd-nav__connect lnd-nav__connect--mobile"
                onClick={() => void setOpen(true)} aria-label="Connect wallet">
                Connect wallet
              </button>
            </div>
            {/* Mobile secondary row */}
            <div className="lnd-nav__mobile-row" role="navigation" aria-label="Additional navigation">
              <a href="#how-it-works" className="lnd-nav__link">How it works</a>
              <a href="https://github.com/emeieiron/knowless"
                className="lnd-nav__link" target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
            </div>
          </header>

          <main>
            {/* ── Hero ── */}
            <section className="lnd-hero" aria-labelledby="hero-h1">
              <div className="lnd-hero__inner">

                {/* Text */}
                <div className="lnd-hero__text">
                  <h1 id="hero-h1" className="lnd-hero__h1">
                    Fund it.<br />
                    Share it.<br />
                    They spend it.
                  </h1>
                  <p className="lnd-hero__sub">
                    A spending link for your USDC. Open it, scan a recipient, and pay without connecting a wallet.
                  </p>
                  <div className="lnd-hero__ctas">
                    <button type="button" className="lnd-cta-primary"
                      onClick={handleCreate}
                      aria-label="Make a spending link — connect wallet to create">
                      Make a spending link <ArrowRight size={17} aria-hidden />
                    </button>
                    <a href="#how-it-works" className="lnd-cta-secondary">
                      See how it works
                    </a>
                  </div>
                  <p className="lnd-hero__note">
                    You fund it with a wallet. They spend it without one.
                  </p>
                </div>

                {/* Artwork */}
                <div className="lnd-hero__art">
                  <HeroArt />
                </div>

              </div>
            </section>

            {/* ── How it works ── */}
            <section id="how-it-works" className="lnd-how" aria-labelledby="how-h2">
              {/* Visually hidden heading for aria-labelledby */}
              <h2 id="how-h2" className="lnd-sr-only">How it works</h2>
              <div className="lnd-how__inner">
                <div className="lnd-steps">
                  <Step num="01" heading="FUND" icon={<IconWallet />}
                    body="Create a spending link with USDC from your wallet." />
                  <ArrowHoriz />
                  <Step num="02" heading="SHARE" icon={<IconLink />}
                    body="Share the link in a message, an email, or a QR code." />
                  <ArrowHoriz />
                  <Step num="03" heading="PAY" icon={<IconPhone />}
                    body="Open the link, scan the recipient's QR code, and pay." />
                </div>
              </div>
            </section>
          </main>

          {/* ── Footer ── */}
          <footer className="lnd-footer" role="contentinfo">
            <div className="lnd-footer__inner">
              <span className="lnd-footer__left">
                Built on Arc · Powered by USDC
              </span>
              <a href="https://studio.arc.io" target="_blank" rel="noopener noreferrer"
                className="lnd-footer__link">
                Built with Arc Studio
              </a>
            </div>
          </footer>

        </div>{/* .lnd */}
      </div>{/* .lnd-shell */}
    </>
  )
}

// ── Scoped CSS ───────────────────────────────────────────────────────────────
const LANDING_CSS = `
@font-face {
  font-family: 'Anton';
  src: url('__ANTON_URL__') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}

/* ── Shell & Canvas ── */
.lnd-shell {
  background: #0d1b2a;
  min-height: 100dvh;
  padding: 10px;
}
.lnd {
  font-family: system-ui, -apple-system, sans-serif;
  background: #dcff4f;
  color: #0d1b2a;
  min-height: calc(100dvh - 20px);
  border-radius: 18px;
  overflow: visible;
  display: flex;
  flex-direction: column;
}
.lnd *, .lnd *::before, .lnd *::after { box-sizing: border-box; }

/* ── Utilities ── */
.lnd-sr-only {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}

/* ── Nav ── */
.lnd-nav { background: transparent; position: static; }
.lnd-nav__inner {
  max-width: 1280px; margin: 0 auto; padding: 0 48px;
  height: 64px; display: flex; align-items: center;
  justify-content: space-between; gap: 16px;
}
.lnd-nav__brand {
  display: flex; align-items: center; gap: 8px;
  text-decoration: none; color: #0d1b2a; flex-shrink: 0;
}
.lnd-nav__ghost { width: 26px; height: auto; flex-shrink: 0; }
.lnd-nav__wordmark {
  font-size: 1.05rem; font-weight: 800; letter-spacing: -0.02em; color: #0d1b2a;
}
.lnd-nav__links { display: flex; align-items: center; gap: 28px; }
.lnd-nav__link {
  font-size: 0.875rem; color: #0d1b2a; text-decoration: none;
  font-weight: 600; transition: opacity .15s;
}
.lnd-nav__link:hover { opacity: 0.65; }
.lnd-nav__link:focus-visible { outline: 2px solid #0d1b2a; outline-offset: 3px; border-radius: 3px; }
.lnd-nav__connect {
  background: #0d1b2a; color: #dcff4f; border: none; border-radius: 10px;
  padding: 9px 18px; font-size: 0.875rem; font-weight: 700; cursor: pointer;
  min-height: 42px; transition: opacity .15s; white-space: nowrap;
}
.lnd-nav__connect:hover { opacity: 0.85; }
.lnd-nav__connect:focus-visible { outline: 2px solid #0d1b2a; outline-offset: 2px; border-radius: 10px; }
.lnd-nav__connect--mobile { display: none; }
.lnd-nav__mobile-row { display: none; }

/* ── Hero ── */
.lnd-hero { padding: 24px 48px 24px; flex: 1; }
.lnd-hero__inner {
  max-width: 1280px; margin: 0 auto;
  display: grid; grid-template-columns: 1fr 1fr;
  align-items: center; gap: 40px;
}
.lnd-hero__text { display: flex; flex-direction: column; gap: 16px; }
.lnd-hero__h1 {
  font-family: 'Anton', 'Impact', 'Arial Black', sans-serif;
  font-size: clamp(3.8rem, 7.5vw, 7rem);
  line-height: .92;
  font-weight: 400;
  letter-spacing: -0.01em;
  color: #0d1b2a;
  margin: 0;
}
.lnd-hero__sub {
  font-size: clamp(0.95rem, 1.3vw, 1.05rem); line-height: 1.6;
  color: #0d1b2a; max-width: 48ch; margin: 0; font-weight: 500;
}
.lnd-hero__ctas { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
.lnd-hero__note { font-size: 0.8rem; color: rgba(13,27,42,0.6); margin: 0; font-weight: 500; }

/* ── CTAs ── */
.lnd-cta-primary {
  display: inline-flex; align-items: center; gap: 8px;
  background: #0d1b2a; color: #dcff4f; border: none; border-radius: 10px;
  padding: 11px 22px; font-size: 1rem; font-weight: 700; cursor: pointer;
  min-height: 46px; transition: opacity .15s; text-decoration: none; white-space: nowrap;
}
.lnd-cta-primary:hover { opacity: 0.88; }
.lnd-cta-primary:focus-visible { outline: 2px solid #0d1b2a; outline-offset: 3px; }
.lnd-cta-secondary {
  display: inline-flex; align-items: center; color: #0d1b2a;
  font-size: 0.92rem; font-weight: 700; text-decoration: underline;
  text-underline-offset: 3px; cursor: pointer; min-height: 44px;
  background: transparent; border: none; padding: 0;
}
.lnd-cta-secondary:hover { opacity: 0.7; }
.lnd-cta-secondary:focus-visible { outline: 2px solid #0d1b2a; outline-offset: 3px; border-radius: 3px; }

/* ── Hero art column ── */
.lnd-hero__art {
  display: flex; align-items: center; justify-content: center;
  min-height: 380px;
}
.lnd-art { position: relative; width: 100%; display: flex; justify-content: center; }

/* ── Card cluster ── */
.lnd-cluster {
  position: relative;
  width: min(100%, 520px);
  height: 360px;
  flex-shrink: 1;
}

/* ── Ghost ── */
.lnd-ghost {
  position: absolute;
  top: -12px;
  left: calc(62% - 54px);
  right: auto;
  width: 80px;
  z-index: 5;
}

/* ── Cards ── */
.lnd-card {
  background: #f9f7f0;
  border-radius: 18px;
  min-width: 0;
}
.lnd-card--main {
  position: absolute;
  top: 40px;
  left: 0;
  width: 62%;
  box-shadow: 7px 7px 0 #0d1b2a;
  transform: rotate(2deg);
  padding: 18px 20px 0;
  z-index: 2;
}
.lnd-qr-wrap {
  position: absolute;
  top: 164px;
  right: 0;
  bottom: auto;
  width: 32%;
}
.lnd-card--qr {
  position: relative;
  inset: auto;
  width: 100%;
  transform: rotate(-3deg);
  box-shadow: 5px 5px 0 #0d1b2a;
  padding: 14px 12px 12px;
  z-index: 3;
}
.lnd-card__top-row {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;
}
.lnd-card__label {
  font-size: 0.6rem; font-weight: 800; letter-spacing: 0.12em;
  color: #0d1b2a; text-transform: uppercase;
}
.lnd-card__dots { font-size: 1.1rem; color: #0d1b2a; letter-spacing: 0.08em; }
.lnd-card__rule { height: 1px; background: rgba(13,27,42,0.12); margin: 8px 0; }
.lnd-card__amount { display: flex; align-items: baseline; gap: 6px; padding: 6px 0; }
.lnd-card__num {
  font-family: 'Anton', 'Impact', sans-serif;
  font-size: 3rem; font-weight: 400; line-height: 1;
  color: #0d1b2a; letter-spacing: -0.02em;
}
.lnd-card__currency { font-size: 0.85rem; font-weight: 700; color: rgba(13,27,42,0.5); }
.lnd-card__meta {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 0 10px; font-size: 0.7rem; color: rgba(13,27,42,0.65);
  font-weight: 600; gap: 4px;
}
.lnd-card__meta-item { display: flex; align-items: center; gap: 4px; }
.lnd-card__meta-right { color: rgba(13,27,42,0.45); }
.lnd-card__copy-strip {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  background: #0d1b2a; color: #f9f7f0;
  border-radius: 0 0 16px 16px; padding: 11px;
  font-size: 0.875rem; font-weight: 700;
  margin: 0 -20px;
}
.lnd-card__qr-label {
  font-size: 0.72rem; font-weight: 800; color: #0d1b2a;
  text-align: center; margin-bottom: 8px; letter-spacing: 0.01em;
}
.lnd-card__qr-motif { display: flex; justify-content: center; }
.lnd-card__qr-motif svg { width: 100%; max-width: 126px; height: auto; }

/* ── How it works ── */
.lnd-how { padding: 12px 48px 20px; }
.lnd-how__inner { max-width: 1280px; margin: 0 auto; }
.lnd-steps {
  display: grid;
  grid-template-columns: 1fr auto 1fr auto 1fr;
  align-items: center;
  gap: 12px;
}
.lnd-step {
  background: #f9f7f0;
  border-radius: 18px;
  padding: 16px 20px;
  min-width: 0;
}
.lnd-step__top {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; margin-bottom: 8px;
}
.lnd-step__icon { flex-shrink: 0; }
.lnd-step__num {
  font-size: 0.7rem; font-weight: 700; letter-spacing: 0.1em;
  color: rgba(13,27,42,0.4); text-transform: uppercase; margin-bottom: 4px;
}
.lnd-step__heading {
  font-family: 'Anton', 'Impact', sans-serif;
  font-size: 1.8rem; font-weight: 400; color: #0d1b2a;
  line-height: 1; letter-spacing: -0.01em; margin: 0;
}
.lnd-step__body {
  font-size: 0.85rem; line-height: 1.45;
  color: rgba(13,27,42,0.7); margin: 0; font-weight: 500;
}

/* ── Footer ── */
.lnd-footer { padding: 12px 48px 16px; }
.lnd-footer__inner {
  max-width: 1280px; margin: 0 auto;
  display: flex; align-items: center; justify-content: space-between;
  flex-wrap: wrap; gap: 12px;
}
.lnd-footer__left { font-size: 0.78rem; font-weight: 600; color: rgba(13,27,42,0.6); }
.lnd-footer__link {
  font-size: 0.78rem; color: rgba(13,27,42,0.5); text-decoration: none;
}
.lnd-footer__link:hover { color: #0d1b2a; }
.lnd-footer__link:focus-visible { outline: 2px solid #0d1b2a; outline-offset: 2px; border-radius: 3px; }

/* ── Reduced motion ── */
@media (prefers-reduced-motion: no-preference) {
  .lnd-cluster { animation: lnd-rise .45s ease both; }
}
@keyframes lnd-rise {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: none; }
}

/* ── <=900px ── */
@media (max-width: 900px) {
  .lnd-hero__inner { grid-template-columns: 1fr; }
  .lnd-hero__h1 { font-size: clamp(2.8rem, 9vw, 4.5rem); }
  .lnd-hero__art { margin-top: 8px; }
  .lnd-steps { grid-template-columns: 1fr; gap: 10px; }
  .lnd-steps > svg { display: none; }
  .lnd-step { border-radius: 18px; }
  .lnd-nav__links { display: none; }
  .lnd-nav__connect--mobile { display: block; }
  .lnd-nav__mobile-row {
    display: flex; align-items: center; gap: 20px;
    padding: 8px 48px; background: #dcff4f;
  }
}

/* ── <=640px ── */
@media (max-width: 640px) {
  .lnd-shell { padding: 6px; }
  .lnd { border-radius: 12px; }
  .lnd-nav__inner { padding: 0 16px; gap: 8px; }
  .lnd-nav__wordmark { font-size: 0.95rem; }
  .lnd-nav__ghost { width: 22px; }
  .lnd-nav__connect { padding: 8px 12px; font-size: 0.8rem; min-height: 38px; }
  .lnd-nav__mobile-row { padding: 7px 16px; gap: 14px; }
  .lnd-hero { padding: 28px 20px 28px; }
  .lnd-how { padding: 24px 20px 32px; }
  .lnd-footer { padding: 14px 20px 16px; }
  .lnd-cluster {
    width: 100%;
    height: auto;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
    padding-top: 44px;
  }
  .lnd-ghost {
    position: absolute;
    top: 0;
    left: min(calc(100% - 60px), 220px);
    right: auto;
    width: 64px;
  }
  .lnd-card--main {
    position: relative;
    top: auto;
    left: auto;
    width: min(280px, 100%);
    transform: rotate(1deg);
  }
  .lnd-qr-wrap {
    position: relative;
    top: auto;
    right: auto;
    bottom: auto;
    width: min(180px, 80%);
    align-self: flex-end;
  }
  .lnd-card--qr {
    position: relative;
    inset: auto;
    width: 100%;
    transform: rotate(-2deg);
  }
}

/* ── <=375px ── */
@media (max-width: 375px) {
  .lnd-hero__h1 { font-size: 2.5rem; }
  .lnd-nav__connect { padding: 7px 10px; font-size: 0.78rem; }
  .lnd-card--main { width: 100%; }
  .lnd-ghost { width: 56px; }
}
`

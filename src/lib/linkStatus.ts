/**
 * Pure decision helper for LinkCard status derivation.
 * Extracted so it can be tested without mounting components.
 *
 * Input: resolved chain data + local link metadata + cancel state.
 * Output: status label, actions allowed, display guidance.
 */

export type ChainInfo = {
  balance: bigint
  feeBalance: bigint
  expiry: bigint
  active: boolean
}

export type LinkStatusInput = {
  /** Confirmed tx hash present (not a draft) */
  hasTxHash: boolean
  /** Chain data resolved */
  chainInfo: ChainInfo | null
  /** Whether first-load query is in progress */
  isLoading: boolean
  /** Whether background refetch is in progress */
  isFetching: boolean
  /** Whether chain read failed */
  isError: boolean
  /** Whether a previous cancel tx was confirmed in this session */
  isCancelSuccess: boolean
  /** Cancel tx hash in flight (cancel submitted, not yet confirmed) */
  cancelInFlight: boolean
  /** Current unix seconds */
  nowSec: number
}

export type LinkStatusOutput = {
  /** Phase determines what to render */
  phase:
    | 'draft'          // no txHash — unfunded draft
    | 'loading'        // first chain read in progress
    | 'error_no_data'  // chain read failed, no retained data
    | 'ready'          // chain data available (fresh or retained)

  /** Status badge text — only meaningful in 'ready' phase */
  statusLabel: string
  /** Badge color token — only meaningful in 'ready' phase */
  statusColor: 'var(--subtle)' | 'var(--muted)' | 'var(--danger)' | 'var(--success)'

  /** Whether cancel action should be offered */
  canCancel: boolean
  /** Whether share/copy actions should be offered */
  canShare: boolean
  /** Whether expired-but-active reclaim notice should be shown */
  showReclaimNotice: boolean
  /** Whether actions should be disabled due to stale data */
  actionsDisabled: boolean
  /** Whether "Updating…" indicator should be shown */
  showUpdating: boolean
  /** Whether "last known" stale-data notice should be shown */
  showStaleNotice: boolean
  /** Whether "Closed" descriptor should be shown */
  isClosed: boolean
  /** True if cancelled by current session */
  isCancelSuccess: boolean
  /** Whether this is an expired link */
  isExpired: boolean
  /** Whether link is active per chain */
  isActive: boolean
}

function formatExpiryShort(expiry: number, nowSec: number): string {
  const diff = expiry - nowSec
  if (diff <= 0) return 'Expired'
  const d = Math.floor(diff / 86400)
  const h = Math.floor((diff % 86400) / 3600)
  if (d > 0) return `${d}d left`
  if (h > 0) return `${h}h left`
  return '<1h left'
}

export function deriveLinkStatus(input: LinkStatusInput): LinkStatusOutput {
  const {
    hasTxHash, chainInfo, isLoading, isFetching, isError,
    isCancelSuccess, cancelInFlight, nowSec,
  } = input

  const hasData = chainInfo !== null
  const isExpired = chainInfo ? (Number(chainInfo.expiry) > 0 && Number(chainInfo.expiry) < nowSec) : false
  const isActive = chainInfo ? chainInfo.active : false
  const isClosed = hasData && !isActive
  const isUpdating = isFetching && hasData && !isLoading
  const hasStaleData = isError && hasData

  // ── Draft: no txHash ──────────────────────────────────────────────────────
  if (!hasTxHash) {
    return {
      phase: 'draft',
      statusLabel: 'Draft', statusColor: 'var(--muted)',
      canCancel: false, canShare: false,
      showReclaimNotice: false, actionsDisabled: true,
      showUpdating: false, showStaleNotice: false,
      isClosed: false, isCancelSuccess, isExpired: false, isActive: false,
    }
  }

  // ── First load in progress ────────────────────────────────────────────────
  if (isLoading) {
    return {
      phase: 'loading',
      statusLabel: '', statusColor: 'var(--subtle)',
      canCancel: false, canShare: false,
      showReclaimNotice: false, actionsDisabled: true,
      showUpdating: false, showStaleNotice: false,
      isClosed: false, isCancelSuccess, isExpired: false, isActive: false,
    }
  }

  // ── Error with no retained data ───────────────────────────────────────────
  if (isError && !hasData) {
    return {
      phase: 'error_no_data',
      statusLabel: '', statusColor: 'var(--subtle)',
      canCancel: false, canShare: false,
      showReclaimNotice: false, actionsDisabled: true,
      showUpdating: false, showStaleNotice: false,
      isClosed: false, isCancelSuccess, isExpired: false, isActive: false,
    }
  }

  // ── No data, no error, not loading: transitional/unavailable ────────────
  if (!hasData) {
    return {
      phase: 'error_no_data',
      statusLabel: '', statusColor: 'var(--subtle)',
      canCancel: false, canShare: false,
      showReclaimNotice: false, actionsDisabled: true,
      showUpdating: false, showStaleNotice: false,
      isClosed: false, isCancelSuccess, isExpired: false, isActive: false,
    }
  }

  // ── Ready: chain data available ───────────────────────────────────────────
  let statusLabel: string
  let statusColor: LinkStatusOutput['statusColor']

  if (isCancelSuccess) {
    statusLabel = 'Cancelled'; statusColor = 'var(--subtle)'
  } else if (isClosed) {
    statusLabel = 'Closed'; statusColor = 'var(--subtle)'
  } else if (isExpired) {
    statusLabel = 'Expired'; statusColor = 'var(--danger)'
  } else {
    const expSec = chainInfo ? Number(chainInfo.expiry) : 0
    statusLabel = expSec > 0 ? formatExpiryShort(expSec, nowSec) : 'Active'
    statusColor = 'var(--success)'
  }

  // Suppress active actions while cancel is in flight or stale
  const actionsDisabled = hasStaleData
  // Only show actions when active, not stale, not cancel-confirmed, and cancel not already in flight
  const canCancel = isActive && !isCancelSuccess && !actionsDisabled && !cancelInFlight
  const canShare  = isActive && !isExpired && !isCancelSuccess && !actionsDisabled && !cancelInFlight
  // Show reclaim notice only with fresh confirmed data and no cancel in flight
  const showReclaimNotice = isActive && isExpired && !hasStaleData && !cancelInFlight && !isCancelSuccess

  return {
    phase: 'ready',
    statusLabel, statusColor,
    canCancel, canShare,
    showReclaimNotice,
    actionsDisabled,
    showUpdating: isUpdating,
    showStaleNotice: hasStaleData,
    isClosed,
    isCancelSuccess,
    isExpired,
    isActive,
  }
}

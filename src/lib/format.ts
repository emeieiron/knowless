/**
 * USDC formatting helpers.
 * All principal/fee amounts are 6-decimal ERC-20 USDC units (bigint raw).
 * Never use native (18-dec) units for accounting.
 */

export const USDC_DECIMALS = 6
export const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS) // 1_000_000n

/**
 * Parse a user-entered USDC string (e.g. "10.50") into 6-decimal bigint.
 * Returns null if invalid.
 */
export function parseUsdcInput(value: string): bigint | null {
  const trimmed = value.trim()
  if (!/^\d+(\.\d{0,6})?$/.test(trimmed)) return null
  const [intPart, fracPart = ''] = trimmed.split('.')
  const frac = fracPart.padEnd(6, '0').slice(0, 6)
  try {
    const raw = BigInt(intPart) * USDC_UNIT + BigInt(frac)
    return raw
  } catch {
    return null
  }
}

/**
 * Format a 6-decimal bigint raw value to a display string (e.g. "10.50").
 */
export function formatUsdc(raw: bigint): string {
  const neg = raw < 0n
  const abs = neg ? -raw : raw
  const int = abs / USDC_UNIT
  const frac = abs % USDC_UNIT
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '') || '0'
  const sign = neg ? '-' : ''
  return `${sign}${int}.${fracStr}`
}

/**
 * Format for display with fixed 2 decimal places.
 */
export function formatUsdcFixed(raw: bigint): string {
  const neg = raw < 0n
  const abs = neg ? -raw : raw
  const int = abs / USDC_UNIT
  const frac = abs % USDC_UNIT
  const fracStr = frac.toString().padStart(6, '0').slice(0, 2)
  const sign = neg ? '-' : ''
  return `${sign}${int}.${fracStr}`
}

/**
 * Format timestamp as relative time.
 */
export function formatExpiry(ts: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = ts - now
  if (diff <= 0) return 'Expired'
  const days = Math.floor(diff / 86400)
  const hours = Math.floor((diff % 86400) / 3600)
  if (days >= 1) return `${days}d ${hours}h left`
  const mins = Math.floor((diff % 3600) / 60)
  if (hours >= 1) return `${hours}h ${mins}m left`
  return `${mins}m left`
}

/**
 * Format a unix timestamp as a human-readable date.
 */
export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/**
 * Truncate an Ethereum address for display.
 */
export function truncateAddress(addr: string): string {
  if (addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/**
 * Parse a USDC string, returning 0n on empty/invalid.
 */
export function safeParseUsdc(value: string): bigint {
  return parseUsdcInput(value) ?? 0n
}

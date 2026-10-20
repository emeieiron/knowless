/**
 * parsePaymentRequest — decode QR text into a payment recipient + optional USDC amount.
 *
 * Supported formats:
 *   1. Raw 0x address (with optional whitespace)
 *   2. ethereum:<recipient>[@<chainId>]                   — EIP-681 basic transfer
 *   3. ethereum:pay-<recipient>[@<chainId>]               — EIP-681 with pay- prefix
 *   4. ethereum:[pay-]<token>[@<chainId>]/transfer?address=<recipient>&uint256=<base-units>
 *      where <token> must be the Arc Testnet USDC contract or omitted (direct-to-recipient)
 *
 * USDC is always 6 decimals. Amounts from EIP-681 uint256 are raw 6-decimal base units.
 * Native value (value=) in EIP-681 is intentionally ignored — native and ERC-20 decimals differ.
 *
 * Returns { ok: true, recipient, amountUsdc? } or { ok: false, error }.
 * amountUsdc, when present, is the raw USDC base-unit bigint (6 decimals).
 *
 * Chain validation: if the QR specifies a chainId it must equal ARC_TESTNET_CHAIN_ID.
 * Token validation: if a token contract is specified it must be the Arc Testnet USDC address.
 * Neither mismatch is silently ignored; both return ok:false with a user-readable message.
 *
 * Security: bounded input length, bounded exponent, no floating-point arithmetic.
 * All amounts are computed as exact bigints; no rounding or fractional USDC.
 */

import { getAddress } from 'viem'
import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC } from './contract'
import { isValidAddress } from './crypto'

export interface ParsedPaymentRequest {
  ok: true
  recipient: string      // checksummed 0x address
  /** raw USDC base units (6 decimals), present when the QR encodes an exact amount */
  amountUsdc?: bigint
}

export interface ParsedPaymentRequestError {
  ok: false
  error: string
}

export type ParsePaymentResult = ParsedPaymentRequest | ParsedPaymentRequestError

const MAX_INPUT_LENGTH = 2048
const MAX_EXPONENT    = 30   // bound before BigInt allocation

function ok(recipient: string, amountUsdc?: bigint): ParsePaymentResult {
  return { ok: true, recipient, amountUsdc }
}
function err(error: string): ParsePaymentResult {
  return { ok: false, error }
}

/** Normalize and checksum an address string. Returns null if invalid. */
function normalizeAddress(raw: string): string | null {
  const trimmed = raw.trim()
  if (!isValidAddress(trimmed)) return null
  try { return getAddress(trimmed) } catch { return null }
}

/**
 * Parse integral scientific notation "Ne+M" or "D.Fe+M" (decimal coefficient) → bigint,
 * or plain integer string. Only non-negative integers. No rounding; rejects fractional results.
 *
 * Supports EIP-681 standard form: e.g. 2.5e6 → 2500000n (exponent must be ≥ fractional digits).
 * URLSearchParams decodes '+' as space, so "1e+6" may arrive as "1e 6" — both accepted.
 * Returns null if result is not an exact non-negative integer.
 */
function parseIntegralAmount(raw: string): bigint | null {
  if (!raw || raw.length > 40) return null

  // Decimal coefficient: D.Fe+M (e.g. 2.5e6, 1.23e8)
  const decSciMatch = /^(\d+)\.(\d+)[eE][+ ]?(\d+)$/.exec(raw)
  if (decSciMatch) {
    const intPart  = decSciMatch[1]
    const fracPart = decSciMatch[2]
    const exp = Number(decSciMatch[3])
    if (exp > MAX_EXPONENT) return null
    // Exponent must be at least the number of fractional digits for an integral result
    if (exp < fracPart.length) return null   // would produce a fractional base unit
    try {
      const mantissa = BigInt(intPart + fracPart)   // remove decimal point
      const scale = exp - fracPart.length           // remaining powers of 10
      return mantissa * (10n ** BigInt(scale))
    } catch { return null }
  }

  // Integer scientific notation: digits e+digits (URLSearchParams decodes '+' as space)
  const sciMatch = /^(\d+)[eE][+ ]?(\d+)$/.exec(raw)
  if (sciMatch) {
    const exp = Number(sciMatch[2])
    if (exp > MAX_EXPONENT) return null
    try { return BigInt(sciMatch[1]) * (10n ** BigInt(exp)) }
    catch { return null }
  }

  // Plain integer
  if (!/^\d+$/.test(raw)) return null
  try { return BigInt(raw) } catch { return null }
}

export function parsePaymentRequest(input: string): ParsePaymentResult {
  if (!input || input.length > MAX_INPUT_LENGTH) return err('Invalid or oversized QR content.')

  const trimmed = input.trim()

  // ── Format 1: raw 0x address ─────────────────────────────────────────────
  if (/^0x[0-9a-fA-F]{40}$/i.test(trimmed)) {
    const addr = normalizeAddress(trimmed)
    if (!addr) return err('Invalid Ethereum address in QR code.')
    return ok(addr)
  }

  // ── Formats 2/3/4: ethereum: URI ─────────────────────────────────────────
  if (!trimmed.toLowerCase().startsWith('ethereum:')) {
    return err('Unrecognised QR format. Please scan an Ethereum address or payment request.')
  }

  const rest = trimmed.slice('ethereum:'.length)

  // Strip optional "pay-" prefix
  const withoutPay = rest.startsWith('pay-') ? rest.slice(4) : rest

  // Split path component from query
  const qmarkIdx = withoutPay.indexOf('?')
  const pathPart  = qmarkIdx >= 0 ? withoutPay.slice(0, qmarkIdx) : withoutPay
  const queryStr  = qmarkIdx >= 0 ? withoutPay.slice(qmarkIdx + 1) : ''

  // Split path component from function name (e.g. /transfer)
  const slashIdx  = pathPart.indexOf('/')
  const addrPart  = slashIdx >= 0 ? pathPart.slice(0, slashIdx) : pathPart
  const funcPart  = slashIdx >= 0 ? pathPart.slice(slashIdx + 1) : ''

  // addrPart may contain @chainId
  const atIdx     = addrPart.indexOf('@')
  const addrRaw   = atIdx >= 0 ? addrPart.slice(0, atIdx) : addrPart
  const chainRaw  = atIdx >= 0 ? addrPart.slice(atIdx + 1) : ''

  // Validate chain if specified
  if (chainRaw) {
    const chainNum = Number(chainRaw)
    if (!Number.isInteger(chainNum) || chainNum !== ARC_TESTNET_CHAIN_ID) {
      return err(`This payment request is for chain ${chainRaw}, not Arc Testnet (${ARC_TESTNET_CHAIN_ID}). Use an Arc Testnet payment QR.`)
    }
  }

  // ── Format 4: token/transfer?address=...&uint256=... ─────────────────────
  if (funcPart.toLowerCase() === 'transfer') {
    // addrRaw is the TOKEN contract address
    const tokenAddr = normalizeAddress(addrRaw)
    if (!tokenAddr) return err('Invalid token contract address in payment request.')

    // Token must be Arc Testnet USDC
    if (tokenAddr.toLowerCase() !== ARC_TESTNET_USDC.toLowerCase()) {
      return err('This payment request uses a token other than USDC on Arc Testnet. Only USDC (Arc Testnet) is supported.')
    }

    const params = new URLSearchParams(queryStr)
    const recipientRaw = params.get('address') ?? ''
    const uint256Raw   = params.get('uint256') ?? ''

    const recipient = normalizeAddress(recipientRaw)
    if (!recipient) return err('Missing or invalid recipient address in USDC transfer request.')

    // Guard against paying the USDC contract address as a recipient
    if (recipient.toLowerCase() === ARC_TESTNET_USDC.toLowerCase()) {
      return err('Recipient cannot be the USDC contract address.')
    }

    if (uint256Raw) {
      const amount = parseIntegralAmount(uint256Raw)
      if (amount === null || amount < 0n) return err('Invalid USDC amount in payment request.')
      return ok(recipient, amount)
    }
    return ok(recipient)
  }

  // ── Formats 2/3: direct address (no function) ────────────────────────────
  if (funcPart) {
    return err('This payment request uses an unsupported action. Only direct address and USDC transfer requests are supported.')
  }

  const recipient = normalizeAddress(addrRaw)
  if (!recipient) return err('Invalid Ethereum address in payment request.')

  // Guard against paying the USDC contract as the recipient
  if (recipient.toLowerCase() === ARC_TESTNET_USDC.toLowerCase()) {
    return err('Recipient cannot be the USDC contract address.')
  }

  // value= param is present but deliberately not used (native vs ERC-20 decimal mismatch)
  return ok(recipient)
}

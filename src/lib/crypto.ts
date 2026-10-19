/**
 * Cryptographic utilities for Spookly link keys.
 * Generates secp256k1 keypairs in-browser, derives addresses, and produces EIP-712 signatures.
 * Link private keys MUST stay exclusively in the URL fragment — never in query strings,
 * server requests, logs, or storage beyond the issuer's local draft store.
 */

import {
  generatePrivateKey,
  privateKeyToAccount,
  privateKeyToAddress,
  type Account,
} from 'viem/accounts'
import {
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  concat,
  toHex,
  type Hex,
  type Address,
} from 'viem'

// --- Key generation ---

export function generateLinkKey(): Hex {
  return generatePrivateKey()
}

export function deriveSignerAddress(privateKey: Hex): Address {
  return privateKeyToAddress(privateKey)
}

export function accountFromKey(privateKey: Hex): Account {
  return privateKeyToAccount(privateKey)
}

// --- EIP-712 ---

// Must match Spookly.sol _PAYMENT_AUTH_TYPEHASH exactly
const PAYMENT_AUTH_TYPEHASH = keccak256(
  new TextEncoder().encode(
    'PaymentAuth(address signerAddress,address recipient,uint256 amount,uint256 fee,address feeRecipient,uint256 quoteExpiry,uint256 nonce,uint256 expiry,address contract_,uint256 chainId)'
  )
)

export function computePaymentAuthHash(
  contractAddress: Address,
  signerAddress: Address,
  recipient: Address,
  amount: bigint,
  fee: bigint,
  feeRecipient: Address,
  quoteExpiry: bigint,
  nonce: bigint,
  expiry: bigint,
  chainId: bigint,
  domainSep: Hex
): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'bytes32, address, address, uint256, uint256, address, uint256, uint256, uint256, address, uint256'
      ),
      [
        PAYMENT_AUTH_TYPEHASH,
        signerAddress,
        recipient,
        amount,
        fee,
        feeRecipient,
        quoteExpiry,
        nonce,
        expiry,
        contractAddress,
        chainId,
      ]
    )
  )
  return keccak256(concat([toHex('\x19\x01', { size: 2 }), domainSep, structHash]))
}

export async function signPaymentAuth(
  privateKey: Hex,
  contractAddress: Address,
  signerAddress: Address,
  recipient: Address,
  amount: bigint,
  fee: bigint,
  feeRecipient: Address,
  quoteExpiry: bigint,
  nonce: bigint,
  expiry: bigint,
  chainId: bigint,
  domainSep: Hex
): Promise<Hex> {
  const digest = computePaymentAuthHash(
    contractAddress, signerAddress, recipient,
    amount, fee, feeRecipient, quoteExpiry,
    nonce, expiry, chainId, domainSep
  )
  // sign() from viem/accounts signs a raw 32-byte hash without any prefix — correct for EIP-712 digests
  const { sign } = await import('viem/accounts')
  const sigObj = await sign({ hash: digest, privateKey })
  // Pack into 65-byte hex: r(32) + s(32) + v(1)
  const r = sigObj.r.slice(2).padStart(64, '0')
  const s = sigObj.s.slice(2).padStart(64, '0')
  const v = Number(sigObj.v).toString(16).padStart(2, '0')
  return `0x${r}${s}${v}` as Hex
}

// --- URL fragment encoding ---

/**
 * Encodes a link private key + contract address + chain ID into a URL fragment.
 * Format: base64url(chainId:contractAddress:privateKey) with no padding chars.
 * Never appears in the URL path or query string.
 */
export function encodeLinkFragment(
  privateKey: Hex,
  contractAddress: Address,
  chainId: number
): string {
  const raw = `${chainId}:${contractAddress}:${privateKey}`
  // base64 → base64url: replace + and / with URL-safe chars, strip trailing =
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Decodes a link fragment produced by encodeLinkFragment.
 * Returns null on any malformation — never throws.
 *
 * Padding: base64url strips trailing '='. To restore standard base64, add
 * exactly (4 - (len % 4)) % 4 '=' chars.  The only valid residues after
 * stripping are 0 (no padding), 2 (add "=="), or 3 (add "=").
 * A residue of 1 is always an invalid base64url string.
 */
export function decodeLinkFragment(fragment: string): {
  privateKey: Hex
  contractAddress: Address
  chainId: number
} | null {
  try {
    if (!fragment || typeof fragment !== 'string') return null
    // Reject obviously corrupt fragments before base64 decode
    if (!/^[A-Za-z0-9_\-]+$/.test(fragment)) return null
    const rem = fragment.length % 4
    if (rem === 1) return null  // always invalid base64
    const padding = rem === 0 ? '' : '='.repeat(4 - rem)
    const b64 = fragment.replace(/-/g, '+').replace(/_/g, '/') + padding
    const raw = atob(b64)
    // Expected format: "<chainId>:<contractAddress>:<privateKey>"
    // contractAddress is 42 chars (0x + 40 hex), privateKey is 66 chars (0x + 64 hex).
    // The rest of the raw string is the chainId prefix + two colons.
    const firstColon = raw.indexOf(':')
    if (firstColon < 1) return null
    const secondColon = raw.indexOf(':', firstColon + 1)
    if (secondColon < 0) return null
    const chainIdStr = raw.slice(0, firstColon)
    const contractAddress = raw.slice(firstColon + 1, secondColon)
    const privateKey = raw.slice(secondColon + 1)
    const chainId = parseInt(chainIdStr, 10)
    if (!Number.isInteger(chainId) || chainId <= 0 || String(chainId) !== chainIdStr) return null
    if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) return null
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) return null
    // Validate private key is a valid secp256k1 scalar: > 0 and < curve order
    const SECP256K1_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n
    const keyVal = BigInt(privateKey)
    if (keyVal <= 0n || keyVal >= SECP256K1_ORDER) return null
    return { privateKey: privateKey as Hex, contractAddress: contractAddress as Address, chainId }
  } catch {
    return null
  }
}

// --- Nonce generation ---

export function generateNonce(): bigint {
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  let n = 0n
  for (const b of arr) n = (n << 8n) | BigInt(b)
  return n
}

// --- Address validation ---

export function isValidAddress(addr: string): addr is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

// --- Link URL helpers ---

export function buildLinkUrl(
  privateKey: Hex,
  contractAddress: Address,
  chainId: number,
  baseUrl?: string
): string {
  const fragment = encodeLinkFragment(privateKey, contractAddress, chainId)
  const base = baseUrl ?? window.location.origin + window.location.pathname
  return `${base}#pay/${fragment}`
}

export function parseLinkUrl(url: string): ReturnType<typeof decodeLinkFragment> {
  try {
    const hash = url.includes('#') ? url.split('#')[1] : ''
    if (!hash.startsWith('pay/')) return null
    return decodeLinkFragment(hash.slice(4))
  } catch {
    return null
  }
}

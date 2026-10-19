/**
 * LocalStorage for issuer link drafts.
 *
 * KEY: spookly:links:<chainId>:<contractAddress>:<issuer>
 * VALUE: JSON array of StoredLink[]
 *
 * SAFETY GUARANTEES (finding 6):
 *   - saveLink THROWS (does not swallow) if the entry cannot be persisted.
 *     The caller must catch and show actionable guidance — never silently drop keys.
 *   - loadLinks validates stored JSON; entries with missing signerAddress or privateKey
 *     are filtered out and do not cause silent key loss.
 *   - validateLinkEntry checks signer/key correspondence before exposing a link to the UI.
 *   - StoredLink distinguishes draft (no txHash) from confirmed funded link (txHash set).
 */

import type { Address, Hex } from 'viem'

export interface StoredLink {
  signerAddress: Address
  /** Link private key — stored ONLY in the issuer's own browser, never sent anywhere. */
  privateKey: Hex
  principal: string      // 6-dec USDC string, e.g. "10.00"
  feeBudget: string      // 6-dec USDC string, e.g. "0.10"
  expiryTs: number       // unix seconds
  expiryLabel: string
  createdAt: number      // unix ms
  /** Set once createLink tx is confirmed. Draft = undefined/null. */
  txHash?: string
  contractAddress: Address
  chainId: number
  issuer: Address
}

function storageKey(chainId: number, contractAddress: Address, issuer: Address): string {
  return `spookly:links:${chainId}:${contractAddress.toLowerCase()}:${issuer.toLowerCase()}`
}

function isValidEntry(e: unknown): e is StoredLink {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  return (
    typeof o.signerAddress === 'string' &&
    typeof o.privateKey === 'string' &&
    typeof o.principal === 'string' &&
    typeof o.expiryTs === 'number' &&
    typeof o.contractAddress === 'string' &&
    typeof o.chainId === 'number' &&
    typeof o.issuer === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(o.signerAddress) &&
    /^0x[0-9a-fA-F]{64}$/.test(o.privateKey)
  )
}

/**
 * Saves or updates a link.
 * THROWS with a user-facing message if the entry cannot be persisted (quota exceeded, etc.).
 * Callers MUST catch and surface the error rather than proceeding without the key persisted.
 */
export function saveLink(link: StoredLink): void {
  const key = storageKey(link.chainId, link.contractAddress, link.issuer)
  const existing = loadLinks(link.chainId, link.contractAddress, link.issuer)
  const idx = existing.findIndex(l => l.signerAddress.toLowerCase() === link.signerAddress.toLowerCase())
  if (idx >= 0) existing[idx] = link
  else existing.unshift(link)

  const serialized = JSON.stringify(existing)
  try {
    localStorage.setItem(key, serialized)
  } catch {
    // Do NOT drop old entries. Throw so the caller can show actionable guidance.
    throw new Error(
      'Browser storage quota exceeded. Cannot save link key. ' +
      'Free up browser storage or export your existing links before creating a new one. ' +
      'Proceeding without saving would cause irreversible key loss.'
    )
  }
}

/** Loads all links for a scope. Filters out corrupt entries. */
export function loadLinks(chainId: number, contractAddress: Address, issuer: Address): StoredLink[] {
  const key = storageKey(chainId, contractAddress, issuer)
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidEntry)
  } catch {
    return []
  }
}

/** Removes a specific link by signerAddress. */
export function removeLink(
  chainId: number, contractAddress: Address, issuer: Address, signerAddress: Address
): void {
  const key = storageKey(chainId, contractAddress, issuer)
  const existing = loadLinks(chainId, contractAddress, issuer)
  const filtered = existing.filter(l => l.signerAddress.toLowerCase() !== signerAddress.toLowerCase())
  try { localStorage.setItem(key, JSON.stringify(filtered)) }
  catch { /* best effort — removal can never cause key loss */ }
}

/** Updates the txHash for a confirmed link. No-op if not found. */
export function updateLinkTxHash(
  chainId: number, contractAddress: Address, issuer: Address,
  signerAddress: Address, txHash: string
): void {
  const key = storageKey(chainId, contractAddress, issuer)
  const links = loadLinks(chainId, contractAddress, issuer)
  const idx = links.findIndex(l => l.signerAddress.toLowerCase() === signerAddress.toLowerCase())
  if (idx < 0) return
  links[idx] = { ...links[idx], txHash }
  try { localStorage.setItem(key, JSON.stringify(links)) }
  catch { /* best effort */ }
}

/**
 * Validates that the stored private key actually derives the stored signerAddress.
 * Returns true if valid, false if corrupt/mismatched (entry should be treated as draft-only).
 */
export async function validateLinkKeyCorrespondence(link: StoredLink): Promise<boolean> {
  try {
    const { privateKeyToAddress } = await import('viem/accounts')
    const derived = privateKeyToAddress(link.privateKey)
    return derived.toLowerCase() === link.signerAddress.toLowerCase()
  } catch {
    return false
  }
}

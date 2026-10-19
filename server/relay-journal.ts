/**
 * Relay journal — durable, pre-broadcast persistence (file-backed adapter).
 *
 * INVARIANT: a JournalEntry is written to disk with status="pending" and the
 * complete signed raw transaction BEFORE sendRawTransaction is called.
 * If the write fails the caller must NOT broadcast.
 *
 * On recovery, entries whose status is still "pending" (or "broadcast") are
 * re-submitted by sending the IDENTICAL raw transaction.
 * A new transaction is NEVER prepared for an existing journal entry.
 *
 * Shared codec types/helpers live in relay-codec.ts (no fs imports).
 * This file only adds the filesystem persistence layer on top.
 */

import {
  writeFileSync, readFileSync, readdirSync, renameSync, mkdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { keccak256, type Address } from 'viem'
import {
  type JournalEntry,
  type JournalStatus,
  validateShallow,
  validateEntryDeep,
} from './relay-codec.js'

// Re-export types so callers that previously imported from here still compile
export type { JournalEntry, JournalStatus }
export { validateEntryDeep, makeIntentKey } from './relay-codec.js'

// ── Journal store ─────────────────────────────────────────────────────────

const MAX_JOURNAL_ENTRIES = 50_000

export class RelayJournal {
  private readonly dir: string
  private readonly byRelayKey    = new Map<string, JournalEntry>()
  private readonly byIntentKey   = new Map<string, JournalEntry>()
  private readonly byRelayNonce  = new Map<number, string>()
  private readonly configuredRelayAddress?: string
  private readonly configuredChainId?: number
  private readonly configuredContractAddress?: string

  journalError: string | null = null
  readonly readinessPromise: Promise<void>
  available = false

  constructor(
    dir: string,
    configuredRelayAddress?: string,
    configuredChainId?: number,
    configuredContractAddress?: string,
  ) {
    this.dir = dir
    this.configuredRelayAddress = configuredRelayAddress
    this.configuredChainId = configuredChainId
    this.configuredContractAddress = configuredContractAddress
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this._hydrateShallow()
    this.readinessPromise = configuredRelayAddress
      ? this._deepValidate(configuredRelayAddress).then(() => { this.available = !this.journalError })
      : Promise.resolve().then(() => { this.available = !this.journalError })
  }

  // ── Shallow hydration (sync) ─────────────────────────────────────────────

  private _hydrateShallow(): void {
    let files: string[]
    try { files = readdirSync(this.dir) } catch { return }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = readFileSync(join(this.dir, f), 'utf8')
        const parsed: unknown = JSON.parse(raw)
        const entry = validateShallow(parsed, f)

        if (this.byRelayKey.size >= MAX_JOURNAL_ENTRIES) {
          this.journalError = `journal at capacity (${MAX_JOURNAL_ENTRIES} entries) — refusing to hydrate more`
          console.error(`[journal] ${this.journalError}`)
          break
        }

        if (this.byRelayKey.has(entry.relayKey)) {
          const existing = this.byRelayKey.get(entry.relayKey)!
          if (existing.intentKey !== entry.intentKey) {
            this.journalError = `conflicting relayKey "${entry.relayKey}" in ${f} (nonce conflict)`
            console.error(`[journal] ${this.journalError}`)
          } else if (existing.rawTx !== entry.rawTx) {
            this.journalError = `ambiguous duplicate relayKey "${entry.relayKey}" in ${f}: same intentKey but different rawTx`
            console.error(`[journal] ${this.journalError}`)
          } else if (existing.status !== entry.status) {
            this.journalError = `contradictory status for relayKey "${entry.relayKey}" in ${f}: existing="${existing.status}" vs "${entry.status}"`
            console.error(`[journal] ${this.journalError}`)
          }
          continue
        }

        if (this.byIntentKey.has(entry.intentKey)) {
          this.journalError = `duplicate intentKey in ${f} — possible journal corruption`
          console.error(`[journal] ${this.journalError}`)
          break
        }

        const isUnresolved = entry.status === 'pending' || entry.status === 'broadcast'
        if (isUnresolved && this.byRelayNonce.has(entry.relayNonce)) {
          const existing = this.byRelayNonce.get(entry.relayNonce)!
          if (existing !== entry.relayKey) {
            this.journalError = `relay nonce ${entry.relayNonce} already reserved by "${existing}" — conflict with "${entry.relayKey}" in ${f}`
            console.error(`[journal] ${this.journalError}`)
          }
          continue
        }

        this.byRelayKey.set(entry.relayKey, entry)
        this.byIntentKey.set(entry.intentKey, entry)
        if (entry.status === 'pending' || entry.status === 'broadcast') {
          this.byRelayNonce.set(entry.relayNonce, entry.relayKey)
        }
      } catch (err) {
        const msg = (err instanceof Error) ? err.message : String(err)
        this.journalError = `corrupt journal entry "${f}": ${msg}`
        console.error(`[journal] corrupt entry "${f}": ${msg}`)
      }
    }
    console.log(`[journal] hydrated ${this.byRelayKey.size} entries from ${this.dir}`)
    if (this.journalError) {
      console.error(`[journal] JOURNAL ERROR — operator action required: ${this.journalError}`)
    }
  }

  // ── Deep async validation ─────────────────────────────────────────────────

  private async _deepValidate(configuredRelayAddress: string): Promise<void> {
    if (this.journalError) return
    for (const entry of this.byRelayKey.values()) {
      const filename = entry.relayKey.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json'

      if (this.configuredChainId !== undefined && entry.chainId !== this.configuredChainId) {
        this.journalError = `entry chainId ${entry.chainId} !== configured chainId ${this.configuredChainId} in ${filename}`
        console.error(`[journal] ${this.journalError}`)
        return
      }
      if (this.configuredContractAddress !== undefined &&
          entry.contractAddress.toLowerCase() !== this.configuredContractAddress.toLowerCase()) {
        this.journalError = `entry contractAddress ${entry.contractAddress} !== configured contractAddress ${this.configuredContractAddress} in ${filename}`
        console.error(`[journal] ${this.journalError}`)
        return
      }

      try {
        await validateEntryDeep(entry, configuredRelayAddress, filename)
      } catch (err) {
        const msg = (err instanceof Error) ? err.message : String(err)
        this.journalError = `deep identity check failed: ${msg}`
        console.error(`[journal] deep identity check failed "${filename}": ${msg}`)
        return
      }
    }
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  getByRelayKey(relayKey: string): JournalEntry | undefined {
    return this.byRelayKey.get(relayKey)
  }

  getByIntentKey(intentKey: string): JournalEntry | undefined {
    return this.byIntentKey.get(intentKey)
  }

  getPendingEntries(): JournalEntry[] {
    return [...this.byRelayKey.values()].filter(
      e => e.status === 'pending' || e.status === 'broadcast'
    )
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  writeNew(entry: JournalEntry): void {
    if (this.byRelayKey.size >= MAX_JOURNAL_ENTRIES)
      throw new Error('[journal] at capacity — cannot write new entry')
    this._writeEntry(entry)
    this.byRelayKey.set(entry.relayKey, entry)
    this.byIntentKey.set(entry.intentKey, entry)
    this.byRelayNonce.set(entry.relayNonce, entry.relayKey)
  }

  updateStatus(
    relayKey: string,
    status: JournalStatus,
    extra?: Partial<Pick<JournalEntry, 'receiptBlockNumber'>>,
  ): void {
    const entry = this.byRelayKey.get(relayKey)
    if (!entry) throw new Error(`[journal] updateStatus: unknown relayKey ${relayKey}`)
    const updated: JournalEntry = { ...entry, status, updatedAt: Date.now(), ...extra }
    this._writeEntry(updated)
    this.byRelayKey.set(relayKey, updated)
    this.byIntentKey.set(updated.intentKey, updated)
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _writeEntry(entry: JournalEntry): void {
    const filename = entry.relayKey.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json'
    const filePath = join(this.dir, filename)
    const tmp      = filePath + '.tmp_' + createHash('sha256').update(entry.relayKey + Date.now()).digest('hex').slice(0, 12)
    const data     = JSON.stringify(entry, null, 2)
    writeFileSync(tmp, data, { mode: 0o600, flag: 'w' })
    renameSync(tmp, filePath)
  }
}

// ── getLinkInfo ABI helpers (used by relay-core transport) ────────────────
// Kept here so relay-core.ts doesn't need to know the ABI encoding.

export function encodeLinkInfoCall(signerAddress: Address): string {
  const sig = 'getLinkInfo(address)'
  const hash = keccak256((`0x` + Buffer.from(sig).toString('hex')) as `0x${string}`)
  const selector = hash.slice(0, 10)
  const padded = signerAddress.toLowerCase().slice(2).padStart(64, '0')
  return selector + padded
}

/**
 * relay-codec.ts — Runtime-neutral relay codec: types, fingerprinting, ABI
 * encoding, HMAC quote signing, deep entry validation, and receipt event
 * checking.
 *
 * NO filesystem imports. NO Worker-incompatible globals.
 * Importable from both the Node.js server relay AND the Cloudflare Worker.
 *
 * Hash functions use @noble/hashes (pure-JS, no node:crypto) so this file
 * runs in Node.js, Bun, and Cloudflare Workers (nodejs_compat not required).
 *   - Cloudflare Workers with `compatibility_flags = ["nodejs_compat"]`
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  type Hex, type Address,
  encodeAbiParameters, decodeAbiParameters,
  keccak256, toBytes,
  parseTransaction, recoverTransactionAddress,
} from 'viem'

// ── Entry types ────────────────────────────────────────────────────────────

export type JournalStatus =
  | 'pending'      // signed & persisted, not yet broadcast
  | 'broadcast'    // sent to RPC, outcome unknown
  | 'confirmed'    // receipt received and PaymentExecuted event verified
  | 'failed'       // definitively failed (contract revert, expiry proof)

export interface JournalEntry {
  /** Canonical intent fingerprint — sha256 of all 8 intent fields */
  intentKey: string
  /** `signerAddress:nonce` (lowercase) — relay-level idempotency key */
  relayKey: string

  // Intent fields — immutable once written
  signerAddress: string
  recipient: string
  amount: string
  fee: string
  feeRecipient: string
  quoteExpiry: string
  nonce: string
  sig: string

  // Relay-side fields
  relayNonce: number
  chainId: number
  contractAddress: string

  // Signed transaction — set before broadcast, never changed
  rawTx: string    // 0x hex RLP-encoded signed transaction
  txHash: string   // 0x hex keccak256(rawTx)

  status: JournalStatus
  createdAt: number
  updatedAt: number
  receiptBlockNumber?: number
}

// Required non-empty string fields for shallow shape validation
export const REQUIRED_STRING_FIELDS: (keyof JournalEntry)[] = [
  'intentKey', 'relayKey', 'signerAddress', 'recipient',
  'amount', 'fee', 'feeRecipient', 'quoteExpiry', 'nonce', 'sig',
  'contractAddress', 'rawTx', 'txHash',
]

// ── Intent fingerprint ─────────────────────────────────────────────────────

/**
 * A stable, canonical key for one payment intent.
 * All 8 authorization fields are included — recipient, feeRecipient,
 * quoteExpiry, and sig are bound so tampering any field changes the key.
 */
export function makeIntentKey(
  signerAddress: string,
  nonce: string,
  recipient: string,
  amount: string,
  fee: string,
  feeRecipient: string,
  quoteExpiry: string,
  sig: string,
): string {
  return bytesToHex(sha256(
    new TextEncoder().encode(
      `${signerAddress.toLowerCase()}:${nonce}:${recipient.toLowerCase()}:` +
      `${amount}:${fee}:${feeRecipient.toLowerCase()}:${quoteExpiry}:${sig.toLowerCase()}`
    )
  ))
}

// ── Relay key ──────────────────────────────────────────────────────────────

/** Relay-level idempotency key: `signerAddress:nonce` (lowercase) */
export function makeRelayKey(signerAddress: string, nonce: string): string {
  return `${signerAddress.toLowerCase()}:${nonce}`
}

// ── ABI encoding ──────────────────────────────────────────────────────────

/**
 * Encode the executePayment calldata (selector + ABI-encoded args).
 * Selector: keccak256("executePayment(address,address,uint128,uint128,address,uint64,uint256,bytes)")[0:4]
 */
export function encodeExecutePayment(
  signerAddress: Address,
  recipient: Address,
  amount: bigint,
  fee: bigint,
  feeRecipient: Address,
  quoteExpiry: bigint,
  nonce: bigint,
  sig: Hex,
): Hex {
  const SELECTOR = ('0x' + keccak256(
    toBytes('executePayment(address,address,uint128,uint128,address,uint64,uint256,bytes)')
  ).slice(2, 10)) as Hex
  const encoded = encodeAbiParameters(
    [
      { type: 'address' }, { type: 'address' },
      { type: 'uint128' }, { type: 'uint128' },
      { type: 'address' }, { type: 'uint64' },
      { type: 'uint256' }, { type: 'bytes' },
    ],
    [signerAddress, recipient, amount, fee, feeRecipient, quoteExpiry, nonce, sig],
  )
  return (SELECTOR + encoded.slice(2)) as Hex
}

/** Encode calldata for a JournalEntry's intent fields */
export function encodeExecutePaymentFromEntry(entry: JournalEntry): Hex {
  return encodeExecutePayment(
    entry.signerAddress as Address,
    entry.recipient as Address,
    BigInt(entry.amount),
    BigInt(entry.fee),
    entry.feeRecipient as Address,
    BigInt(entry.quoteExpiry),
    BigInt(entry.nonce),
    entry.sig as Hex,
  )
}

// ── HMAC quote signing ─────────────────────────────────────────────────────

export interface QuotePayload {
  signerAddress: string
  quotedFee: string
  feeRecipient: string
  quoteExpiry: number
  issuedAt: number
}

/**
 * Derive a stable HMAC secret from the relay private key.
 * Must match the derivation in relay-core.ts.
 */
export function deriveHmacSecret(relayPrivateKey: Hex): string {
  return bytesToHex(sha256(
    new TextEncoder().encode('spookly-relay-hmac-v1:' + relayPrivateKey.toLowerCase())
  ))
}

// Base64 helpers (no Buffer, works in Workers)
function b64Encode(s: string): string {
  return btoa(s)
}
function b64Decode(s: string): string {
  return atob(s)
}

/** Sign a quote payload → base64(payload).hmac */
export function signQuote(payload: QuotePayload, hmacSecret: string): string {
  const data = JSON.stringify(payload)
  const keyBytes = new TextEncoder().encode(hmacSecret)
  const msgBytes = new TextEncoder().encode(data)
  const mac = bytesToHex(hmac(sha256, keyBytes, msgBytes))
  return b64Encode(data) + '.' + mac
}

/** Verify and decode a quote token. Returns null on any failure (tampered/expired). */
export function verifyQuote(token: string, hmacSecret: string): QuotePayload | null {
  try {
    const dot = token.lastIndexOf('.')
    if (dot < 0) return null
    const data = b64Decode(token.slice(0, dot))
    const mac  = token.slice(dot + 1)
    const keyBytes = new TextEncoder().encode(hmacSecret)
    const msgBytes = new TextEncoder().encode(data)
    const expected = bytesToHex(hmac(sha256, keyBytes, msgBytes))
    if (mac.length !== expected.length) return null
    let diff = 0
    for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i)
    if (diff !== 0) return null
    return JSON.parse(data) as QuotePayload
  } catch { return null }
}

// ── Receipt event validation ──────────────────────────────────────────────

/** Minimal on-chain receipt shape */
export interface OnChainReceipt {
  status: string
  to: string | null
  transactionHash: string
  logs: Array<{ address: string; topics: string[]; data: string }>
  blockNumber?: string
}

// PaymentExecuted(address indexed signerAddress, address indexed recipient,
//                 uint128 amount, uint128 fee, address indexed feeRecipient, uint256 nonce)
export const PAYMENT_EXECUTED_TOPIC = keccak256(
  toBytes('PaymentExecuted(address,address,uint128,uint128,address,uint256)')
)

/**
 * Verify that a receipt contains a PaymentExecuted event matching the intent.
 * Returns { ok: true, blockNumber } only when ALL fields match the journal entry.
 */
export function checkPaymentExecutedLog(
  receipt: OnChainReceipt,
  entry: JournalEntry,
  contractAddress: string,
): { ok: true; blockNumber: bigint } | { ok: false } {
  const topicAddr = (t: string | undefined) =>
    t && t.length >= 42 ? ('0x' + t.slice(-40)).toLowerCase() : ''

  const match = receipt.logs.find(log => {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) return false
    if (!log.topics[0] || log.topics[0].toLowerCase() !== PAYMENT_EXECUTED_TOPIC.toLowerCase()) return false
    if (topicAddr(log.topics[1]) !== entry.signerAddress.toLowerCase()) return false
    if (topicAddr(log.topics[2]) !== entry.recipient.toLowerCase()) return false
    if (topicAddr(log.topics[3]) !== entry.feeRecipient.toLowerCase()) return false
    try {
      const [amount, fee, nonce] = decodeAbiParameters(
        [{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }],
        log.data as Hex,
      )
      if (amount.toString() !== entry.amount) return false
      if (fee.toString() !== entry.fee) return false
      if (nonce.toString() !== entry.nonce) return false
    } catch { return false }
    return true
  })
  if (!match) return { ok: false }
  const blockNum = receipt.blockNumber ? BigInt(receipt.blockNumber) : 0n
  return { ok: true, blockNumber: blockNum }
}

// ── Deep entry identity validation (async) ────────────────────────────────

/**
 * Parse the raw signed transaction and verify:
 *   1. keccak256(rawTx) === txHash
 *   2. tx.chainId === entry.chainId
 *   3. tx.to === entry.contractAddress (lowercased)
 *   4. tx.nonce === entry.relayNonce
 *   5. tx.data === encodeExecutePayment(intent fields)
 *   6. recovered sender === configuredRelayAddress
 *
 * Throws with a descriptive message on any mismatch.
 */
export async function validateEntryDeep(
  entry: JournalEntry,
  configuredRelayAddress: string,
  filename: string,
): Promise<void> {
  // 1. Hash check (synchronous — already done in shallow, but re-check here for standalone callers)
  const derivedHash = keccak256(entry.rawTx as Hex)
  if (derivedHash.toLowerCase() !== entry.txHash.toLowerCase())
    throw new Error(`txHash does not match keccak256(rawTx) in ${filename}`)

  // 2-4. Parse tx
  let tx: ReturnType<typeof parseTransaction>
  try {
    tx = parseTransaction(entry.rawTx as Hex)
  } catch (err) {
    throw new Error(`rawTx failed to parse in ${filename}: ${(err as Error).message}`)
  }

  if (typeof tx.chainId !== 'number' && typeof tx.chainId !== 'bigint')
    throw new Error(`parsed tx missing chainId in ${filename}`)
  const parsedChainId = Number(tx.chainId)
  if (parsedChainId !== entry.chainId)
    throw new Error(`tx.chainId ${parsedChainId} !== stored chainId ${entry.chainId} in ${filename}`)

  const parsedTo = (tx.to ?? '').toLowerCase()
  if (parsedTo !== entry.contractAddress.toLowerCase())
    throw new Error(`tx.to ${parsedTo} !== contractAddress ${entry.contractAddress} in ${filename}`)

  if (typeof tx.nonce !== 'number')
    throw new Error(`parsed tx missing nonce in ${filename}`)
  if (tx.nonce !== entry.relayNonce)
    throw new Error(`tx.nonce ${tx.nonce} !== relayNonce ${entry.relayNonce} in ${filename}`)

  // 5. Calldata
  const expectedCalldata = encodeExecutePaymentFromEntry(entry)
  const parsedData = (tx.data ?? '0x').toLowerCase()
  if (parsedData !== expectedCalldata.toLowerCase())
    throw new Error(`tx.data does not match encodeExecutePayment(intent fields) in ${filename}`)

  // 6. Sender (async ecrecover)
  type SerializedTx = Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction']
  let recoveredSender: string
  try {
    recoveredSender = await recoverTransactionAddress({
      serializedTransaction: entry.rawTx as SerializedTx,
    })
  } catch (err) {
    throw new Error(`sender recovery failed in ${filename}: ${(err as Error).message}`)
  }
  if (recoveredSender.toLowerCase() !== configuredRelayAddress.toLowerCase())
    throw new Error(`tx sender ${recoveredSender} !== configuredRelayAddress ${configuredRelayAddress} in ${filename}`)
}

// ── Shallow shape validation ───────────────────────────────────────────────

/**
 * Synchronous shape check for a parsed JSON object.
 * Verifies required fields, formats, and structural invariants
 * (relayKey = signerAddress:nonce, intentKey recomputed match, hash match).
 * Does NOT recover sender (async).
 */
export function validateShallow(raw: unknown, filename: string): JournalEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`not an object in ${filename}`)
  const e = raw as Record<string, unknown>

  for (const f of REQUIRED_STRING_FIELDS) {
    if (typeof e[f] !== 'string' || (e[f]).length === 0)
      throw new Error(`missing/empty field "${String(f)}" in ${filename}`)
  }

  if (typeof e.relayNonce !== 'number')
    throw new Error(`relayNonce not a number in ${filename}`)
  if (typeof e.chainId !== 'number')
    throw new Error(`chainId not a number in ${filename}`)
  if (typeof e.createdAt !== 'number' || typeof e.updatedAt !== 'number')
    throw new Error(`missing timestamps in ${filename}`)

  const validStatuses: JournalStatus[] = ['pending','broadcast','confirmed','failed']
  if (!validStatuses.includes(e.status as JournalStatus))
    throw new Error(`invalid status "${String(e.status)}" in ${filename}`)

  // relayKey must be signerAddress:nonce
  const expectedRelayKey = makeRelayKey(e.signerAddress as string, e.nonce as string)
  if ((e.relayKey as string).toLowerCase() !== expectedRelayKey.toLowerCase())
    throw new Error(`relayKey/signerAddress/nonce inconsistency in ${filename}`)

  if (!/^[0-9a-f]{64}$/.test(e.intentKey as string))
    throw new Error(`intentKey not a valid sha256 hex in ${filename}`)
  if (!/^0x[0-9a-fA-F]{64}$/.test(e.txHash as string))
    throw new Error(`txHash invalid in ${filename}`)
  if (!/^0x[0-9a-fA-F]+$/.test(e.rawTx as string))
    throw new Error(`rawTx not valid hex in ${filename}`)
  if (!/^0x[0-9a-fA-F]{40}$/.test(e.contractAddress as string))
    throw new Error(`contractAddress invalid in ${filename}`)

  // Hash integrity
  const derivedHash = keccak256(e.rawTx as `0x${string}`)
  if (derivedHash.toLowerCase() !== (e.txHash as string).toLowerCase())
    throw new Error(`txHash does not match keccak256(rawTx) in ${filename}`)

  // Intent fingerprint integrity
  const recomputed = makeIntentKey(
    e.signerAddress as string, e.nonce as string,
    e.recipient as string, e.amount as string,
    e.fee as string, e.feeRecipient as string,
    e.quoteExpiry as string, e.sig as string,
  )
  if (recomputed !== (e.intentKey as string))
    throw new Error(`intentKey does not match recomputed fingerprint in ${filename}`)

  if (!/^\d+$/.test(e.quoteExpiry as string))
    throw new Error(`quoteExpiry not a valid integer string in ${filename}`)
  if (BigInt(e.quoteExpiry as string) === 0n)
    throw new Error(`quoteExpiry is zero in ${filename}`)

  return e as unknown as JournalEntry
}

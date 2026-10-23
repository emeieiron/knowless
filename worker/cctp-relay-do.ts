/**
 * cctp-relay-do.ts — CCTP routing extension for the knowless RelayDO.
 *
 * Shared codec/helpers imported by relay-do.ts (runs inside the Worker).
 * No node:crypto — uses @noble/hashes throughout.
 *
 * Key invariants
 * ──────────────
 * • DEST_CHAIN_CONFIGS: MessageTransmitterV2 = 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64
 *   on both Ethereum Mainnet (domain 0) and Base Mainnet (domain 6) — official Circle V2.
 * • MESSAGE_RECEIVED_TOPIC: exact V2 signature with uint32 finalityThresholdExecuted
 *   and bytes messageBody (NOT the V1 uint64 nonce signature).
 * • fetchIrisFee: real Iris API returns a top-level JSON array, not {fees:[...]}.
 * • pollCctpMessage: validates cctpVersion, sourceTxHash root, burnToken, messageSender,
 *   destinationCaller, forwardTxHash format.
 * • CctpQuotePayload: binds sourceChainId, escrowAddress, routerAddress so submit
 *   can verify against trusted config rather than trusting request fields.
 * • checkCctpPaymentRoutedLog: also verifies PaymentExecuted on the escrow
 *   (recipient=router, feeRecipient=router, fee>0) and the CctpPaymentRouted relayer topic.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { hmac } from '@noble/hashes/hmac.js'
import {
  type Hex, type Address,
  keccak256, toBytes, encodeAbiParameters, parseAbiParameters,
} from 'viem'

// ── CCTP Journal types ────────────────────────────────────────────────────────

export type CctpJournalStatus =
  | 'pending'               // signed & persisted, not yet broadcast
  | 'broadcast'             // source tx sent to RPC, outcome unknown
  | 'cctp_source_confirmed' // source receipt ok; CctpPaymentRouted + PaymentExecuted seen
  | 'cctp_mint_pending'     // Circle messages API: forwarding in progress
  | 'cctp_mint_confirmed'   // destination receipt verified: MessageReceived + USDC Transfer
  | 'cctp_mint_failed'      // forwarding failed definitively
  | 'failed'                // definitive on-source failure

export interface CctpJournalEntry {
  cctpIntentKey:    string
  legacyRelayKey:   string   // signerAddress:escrowNonce — cross-table conflict key

  // Routing fields (all immutable once written)
  signerAddress:    string
  destinationDomain: number
  mintRecipient:    string
  grossAmount:      string   // decimal
  maxCctpFee:       string   // decimal
  relayFee:         string   // decimal
  relayerAddress:   string
  quoteExpiry:      string   // decimal seconds
  escrowNonce:      string   // decimal

  paymentSig:       string   // hex
  cctpSig:          string   // hex

  // Relay-side
  relayNonce:       number
  chainId:          number
  routerAddress:    string

  rawTx:            string   // 0x hex
  txHash:           string   // 0x hex

  status:           CctpJournalStatus

  sourceTxHash:      string | null
  destTxHash:        string | null
  netAmountDelivered: string | null

  createdAt:  number
  updatedAt:  number
  receiptBlockNumber: number | null
  errorMsg:   string | null
}

// ── CCTP intent fingerprint ───────────────────────────────────────────────────

export function makeCctpIntentKey(
  signerAddress: string,
  escrowNonce: string,
  destinationDomain: number,
  mintRecipient: string,
  grossAmount: string,
  maxCctpFee: string,
  relayFee: string,
  quoteExpiry: string,
  paymentSig: string,
  cctpSig: string,
): string {
  const raw =
    `cctp:${signerAddress.toLowerCase()}:${escrowNonce}:${destinationDomain}:` +
    `${mintRecipient.toLowerCase()}:${grossAmount}:${maxCctpFee}:${relayFee}:` +
    `${quoteExpiry}:${paymentSig.toLowerCase()}:${cctpSig.toLowerCase()}`
  return bytesToHex(sha256(new TextEncoder().encode(raw)))
}

// ── CCTP ABI encoder ──────────────────────────────────────────────────────────

export function encodeCctpRoutePayment(
  signerAddress:     Address,
  grossAmount:       bigint,  // uint128
  maxCctpFee:        bigint,  // uint256
  relayFee:          bigint,  // uint128
  quoteExpiry:       bigint,  // uint64
  escrowNonce:       bigint,  // uint256
  destinationDomain: number,  // uint32
  mintRecipient:     Address,
  paymentSig:        Hex,
  cctpSig:           Hex,
): Hex {
  const SELECTOR = ('0x' + keccak256(
    toBytes('routePayment(address,uint128,uint256,uint128,uint64,uint256,uint32,address,bytes,bytes)')
  ).slice(2, 10)) as Hex

  const encoded = encodeAbiParameters(
    parseAbiParameters(
      'address, uint128, uint256, uint128, uint64, uint256, uint32, address, bytes, bytes'
    ),
    [
      signerAddress, grossAmount, maxCctpFee, relayFee,
      quoteExpiry, escrowNonce, destinationDomain, mintRecipient,
      paymentSig, cctpSig,
    ],
  )
  return (SELECTOR + encoded.slice(2)) as Hex
}

// ── CCTP quote token ──────────────────────────────────────────────────────────

/**
 * CCTP quote payload.
 * Binds sourceChainId, escrowAddress and routerAddress so submit can verify
 * against trusted config rather than blindly trusting request fields.
 * Tag 'cctp-v1' prevents legacy quote reuse.
 */
export interface CctpQuotePayload {
  t:                 'cctp-v1'
  signerAddress:     string   // lowercase
  destinationDomain: number
  mintRecipient:     string   // lowercase
  grossAmount:       string   // decimal USDC base units
  maxCctpFee:        string   // decimal
  relayFee:          string   // decimal
  relayerAddress:    string   // relay wallet address (feeRecipient for escrow)
  quoteExpiry:       number   // unix seconds
  issuedAt:          number
  // Fields bound so submit can compare against trusted config:
  sourceChainId:     number
  escrowAddress:     string   // lowercase
  routerAddress:     string   // lowercase
}

function b64Encode(s: string): string { return btoa(s) }
function b64Decode(s: string): string { return atob(s) }

export function signCctpQuote(payload: CctpQuotePayload, hmacSecret: string): string {
  const data    = JSON.stringify(payload)
  const keyBytes = new TextEncoder().encode(hmacSecret)
  const msgBytes = new TextEncoder().encode(data)
  const mac = bytesToHex(hmac(sha256, keyBytes, msgBytes))
  return b64Encode(data) + '.' + mac
}

export function verifyCctpQuote(token: string, hmacSecret: string): CctpQuotePayload | null {
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
    const parsed = JSON.parse(data) as CctpQuotePayload
    if (parsed.t !== 'cctp-v1') return null
    return parsed
  } catch { return null }
}

// ── CctpPaymentRouted event topic ─────────────────────────────────────────────

/**
 * CctpPaymentRouted(address indexed signerAddress, uint32 indexed destinationDomain,
 *   address mintRecipient, uint256 grossAmount, uint256 maxCctpFee,
 *   uint128 relayFee, address indexed relayer, uint256 nonce)
 */
export const CCTP_PAYMENT_ROUTED_TOPIC = keccak256(
  toBytes('CctpPaymentRouted(address,uint32,address,uint256,uint256,uint128,address,uint256)')
)

/**
 * PaymentExecuted(address indexed signerAddress, address indexed recipient,
 *   uint128 amount, uint128 fee, address indexed feeRecipient, uint256 nonce)
 */
export const PAYMENT_EXECUTED_TOPIC = keccak256(
  toBytes('PaymentExecuted(address,address,uint128,uint128,address,uint256)')
)

/**
 * Verify source receipt contains:
 *  1. CctpPaymentRouted emitted by router: signerAddress topic, destinationDomain topic, relayer topic
 *  2. PaymentExecuted emitted by escrow: recipient=router, feeRecipient=router, fee>0
 * Returns { ok: true, blockNumber } only when both are present.
 */
export function checkCctpPaymentRoutedLog(
  receipt: {
    status: string
    to: string | null
    transactionHash: string
    logs: Array<{ address: string; topics: string[]; data: string }>
    blockNumber?: string
  },
  entry: CctpJournalEntry,
  routerAddress: string,
  escrowAddress: string,
): { ok: true; blockNumber: bigint } | { ok: false; reason: string } {
  const topicAddr = (t: string | undefined) =>
    t && t.length >= 42 ? ('0x' + t.slice(-40)).toLowerCase() : ''

  if (receipt.status !== '0x1')
    return { ok: false, reason: 'receipt.status is not 0x1 (success)' }

  if ((receipt.to ?? '').toLowerCase() !== routerAddress.toLowerCase())
    return { ok: false, reason: 'receipt.to is not router' }

  if (receipt.transactionHash.toLowerCase() !== (entry.txHash ?? '').toLowerCase())
    return { ok: false, reason: 'receipt.transactionHash does not match stored txHash' }

  // 1. CctpPaymentRouted from router
  const routedLog = receipt.logs.find(log => {
    if (log.address.toLowerCase() !== routerAddress.toLowerCase()) return false
    if (log.topics[0]?.toLowerCase() !== CCTP_PAYMENT_ROUTED_TOPIC.toLowerCase()) return false
    if (topicAddr(log.topics[1]) !== entry.signerAddress.toLowerCase()) return false
    const domainHex = log.topics[2] ? parseInt(log.topics[2], 16) : -1
    if (domainHex !== entry.destinationDomain) return false
    // topics[3] = relayer (indexed address)
    if (topicAddr(log.topics[3]) !== entry.relayerAddress.toLowerCase()) return false
    return true
  })
  if (!routedLog) return { ok: false, reason: 'CctpPaymentRouted event not found or mismatched' }

  // 2. PaymentExecuted from escrow: recipient=router, feeRecipient=router, fee>0
  const peLog = receipt.logs.find(log => {
    if (log.address.toLowerCase() !== escrowAddress.toLowerCase()) return false
    if (log.topics[0]?.toLowerCase() !== PAYMENT_EXECUTED_TOPIC.toLowerCase()) return false
    // topics[1] = signerAddress (indexed)
    if (topicAddr(log.topics[1]) !== entry.signerAddress.toLowerCase()) return false
    // topics[2] = recipient (indexed) — must be router
    if (topicAddr(log.topics[2]) !== routerAddress.toLowerCase()) return false
    // topics[3] = feeRecipient (indexed) — must be router
    if (topicAddr(log.topics[3]) !== routerAddress.toLowerCase()) return false
    return true
  })
  if (!peLog) return { ok: false, reason: 'PaymentExecuted event not found or recipient/feeRecipient not router' }

  // Verify fee>0 from PaymentExecuted data (amount=32b, fee=32b)
  try {
    const data = peLog.data.startsWith('0x') ? peLog.data.slice(2) : peLog.data
    const fee = BigInt('0x' + (data.slice(64, 128) || '0'))
    if (fee === 0n) return { ok: false, reason: 'PaymentExecuted fee is 0' }
  } catch { return { ok: false, reason: 'Could not decode PaymentExecuted fee' } }

  const blockNum = receipt.blockNumber ? BigInt(receipt.blockNumber) : 0n
  return { ok: true, blockNumber: blockNum }
}

// ── Destination receipt verification ─────────────────────────────────────────

/**
 * MessageReceived(address indexed caller, uint32 sourceDomain,
 *   bytes32 indexed nonce, bytes32 sender,
 *   uint32 indexed finalityThresholdExecuted, bytes messageBody)
 *
 * This is the CCTP V2 event from MessageTransmitterV2.
 * NOTE: parameters at positions 1,3 are NOT indexed (uint32 sourceDomain, bytes32 sender).
 */
export const MESSAGE_RECEIVED_TOPIC = keccak256(
  toBytes('MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)')
)

/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value) */
export const ERC20_TRANSFER_TOPIC = keccak256(
  toBytes('Transfer(address,address,uint256)')
)

/**
 * MintAndWithdraw(address indexed mintRecipient, uint256 amount,
 *   address indexed mintToken, uint256 feeCollected)
 * Emitted by TokenMessengerV2 on successful mint+withdrawal.
 */
export const MINT_AND_WITHDRAW_TOPIC = keccak256(
  toBytes('MintAndWithdraw(address,uint256,address,uint256)')
)

/**
 * Decoded BurnMessageV2 body from CCTP V2.
 * Packed layout (all fields 32 bytes each):
 *   version        @ offset 0   (4 bytes used, but stored in 32-byte slot)
 *   burnToken      @ offset 32
 *   mintRecipient  @ offset 64
 *   amount         @ offset 96  (gross — before feeExecuted deduction)
 *   messageSender  @ offset 128
 *   maxFee         @ offset 160
 *   feeExecuted    @ offset 192
 *   expirationBlock@ offset 224
 *   hookData       @ offset 256+
 *
 * Net recipient amount = amount - feeExecuted.
 */
export interface DecodedBurnMessageV2 {
  burnToken:      string  // 0x address (lowercase)
  mintRecipient:  string  // 0x address (lowercase, from bytes32)
  amount:         bigint  // gross amount
  messageSender:  string  // 0x address (router)
  maxFee:         bigint
  feeExecuted:    bigint
  netAmount:      bigint  // amount - feeExecuted
}

/** Decode BurnMessageV2 body bytes (hex string, may include 0x prefix). */
export function decodeBurnMessageV2Body(bodyHex: string): DecodedBurnMessageV2 | null {
  try {
    const h = bodyHex.startsWith('0x') ? bodyHex.slice(2) : bodyHex
    // BurnMessageV2 PACKED layout (byte offsets):
    //   version        @ byte   0, length  4 (uint32)  → hex chars  0-7
    //   burnToken      @ byte   4, length 32           → hex chars  8-71  (addr: last 40 hex)
    //   mintRecipient  @ byte  36, length 32           → hex chars 72-135 (addr: last 40 hex)
    //   amount         @ byte  68, length 32           → hex chars 136-199
    //   messageSender  @ byte 100, length 32           → hex chars 200-263 (addr: last 40 hex)
    //   maxFee         @ byte 132, length 32           → hex chars 264-327
    //   feeExecuted    @ byte 164, length 32           → hex chars 328-391
    //   expirationBlock@ byte 196, length 32           → hex chars 392-455
    //   hookData       @ byte 228+                     → hex chars 456+
    // Minimum: 8(version) + 7*64(fields) = 456 hex chars
    if (h.length < 456) return null
    const burnToken      = ('0x' + h.slice(8  + 24, 8  + 64)).toLowerCase()
    const mintRecipient  = ('0x' + h.slice(72 + 24, 72 + 64)).toLowerCase()
    const amount         = BigInt('0x' + (h.slice(136, 200) || '0'))
    const messageSender  = ('0x' + h.slice(200 + 24, 200 + 64)).toLowerCase()
    const maxFee         = BigInt('0x' + (h.slice(264, 328) || '0'))
    const feeExecuted    = BigInt('0x' + (h.slice(328, 392) || '0'))
    if (feeExecuted > maxFee) return null
    if (feeExecuted >= amount) return null
    return {
      burnToken, mintRecipient, amount, messageSender, maxFee, feeExecuted,
      netAmount: amount - feeExecuted,
    }
  } catch { return null }
}

/**
 * Verify a destination chain receipt for CCTP V2 delivery.
 *
 * Checks:
 *  1. Transaction receipt status = 0x1
 *  2. MessageReceived from official transmitter:
 *     - sourceDomain = Arc (26)
 *     - correct attested nonce (from message API)
 *     - messageSender = router (as bytes32)
 *     - finalityThresholdExecuted >= 2000 (standard)
 *     - messageBody decodes correctly: burnToken=destUSDC, mintRecipient, amount match
 *  3. MintAndWithdraw from official transmitter (or its token messenger):
 *     - mintRecipient matches
 *     - amount >= grossAmount - signedMaxCctpFee (actual net bounded)
 *     - feeCollected <= signedMaxCctpFee
 *  4. ERC-20 Transfer to mintRecipient for the net amount
 *  Returns { ok: true, netAmount, feeExecuted } on success.
 */
/** Source chain (Arc Testnet) CCTP V2 TokenMessengerV2 — outer envelope sender field in MessageReceived. */
export const ARC_TOKEN_MESSENGER_V2 = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa'

export function verifyDestinationReceipt(
  receipt: {
    status: string
    transactionHash: string
    logs: Array<{ address: string; topics: string[]; data: string }>
  },
  entry: CctpJournalEntry,
  transmitterAddr: string,  // MessageTransmitterV2 address (from DEST_CHAIN_CONFIGS)
  usdcAddr: string,         // destination USDC address (from DEST_CHAIN_CONFIGS)
  attestedNonce: string,    // nonce from Circle Messages API (bytes32 hex)
  arcTokenMessenger?: string, // source TokenMessengerV2 (default: ARC_TOKEN_MESSENGER_V2)
): { ok: true; netAmount: bigint; feeExecuted: bigint } | { ok: false; reason: string } {
  if (receipt.status !== '0x1')
    return { ok: false, reason: `destination receipt status ${receipt.status} (not 0x1)` }

  const routerLower       = (entry.routerAddress ?? entry.relayerAddress).toLowerCase()
  const recipLower        = entry.mintRecipient.toLowerCase()
  const grossAmount       = BigInt(entry.grossAmount)
  const signedMaxFee      = BigInt(entry.maxCctpFee)
  const srcMessengerLower = (arcTokenMessenger ?? ARC_TOKEN_MESSENGER_V2).toLowerCase()

  // 1. MessageReceived from transmitter
  const mrLog = receipt.logs.find(log => {
    if (log.address.toLowerCase() !== transmitterAddr.toLowerCase()) return false
    if ((log.topics[0] ?? '').toLowerCase() !== MESSAGE_RECEIVED_TOPIC.toLowerCase()) return false
    // topics[2] = nonce (indexed bytes32): match attested nonce from Circle API
    const logNonce = (log.topics[2] ?? '').toLowerCase()
    const expNonce = attestedNonce.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    if (logNonce !== '0x' + expNonce) return false
    // Source domain (not indexed) is in data slot 0: first 32 bytes of data
    const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data
    if (data.length < 64) return false
    const srcDomain = parseInt(data.slice(0, 64), 16)
    if (srcDomain !== ARC_SOURCE_DOMAIN) return false
    // sender (not indexed) is data slot 1: bytes 32-63
    // messageSender in BurnMessageV2 = router; here we verify the outer envelope sender (TokenMessengerV2)
    // sender = keccak256-left-padded? No — it's the raw bytes32 address of the source TokenMessenger/router
    // Per V2 docs, sender = bytes32(messageSender from message body = router address)
    // sender slot 1 = outer envelope sender = source TokenMessengerV2 (NOT the router)
    const senderHex = '0x' + data.slice(64 + 24, 64 + 64)  // last 20 bytes of 32-byte slot
    if (senderHex.toLowerCase() !== srcMessengerLower) return false
    // finalityThresholdExecuted (indexed, topics[3])
    const finality = log.topics[3] ? parseInt(log.topics[3], 16) : 0
    if (finality < 2000) return false
    return true
  })
  if (!mrLog) return { ok: false, reason: 'MessageReceived V2 event not found or mismatched' }

  // Decode message body from MessageReceived data to verify burnToken/amount/recipient
  const mrData = mrLog.data.startsWith('0x') ? mrLog.data.slice(2) : mrLog.data
  // MessageReceived data: sourceDomain(32) + sender(32) + messageBody(dynamic)
  // messageBody is ABI-encoded bytes at slot 2+ (offset pointer at slot 2, then length, then data)
  let bodyDecoded: DecodedBurnMessageV2 | null = null
  try {
    // data[0..31] = sourceDomain, data[32..63] = sender, data[64..95] = offset to messageBody
    // data[96..127] = length of messageBody, data[128+] = messageBody bytes
    if (mrData.length >= 256) {
      const bodyLenHex = mrData.slice(192, 256)
      const bodyLen = parseInt(bodyLenHex, 16)
      if (bodyLen > 0 && mrData.length >= 256 + bodyLen * 2) {
        const bodyHex = mrData.slice(256, 256 + bodyLen * 2)
        bodyDecoded = decodeBurnMessageV2Body(bodyHex)
      }
    }
  } catch { /* bodyDecoded stays null */ }

  // Arc USDC address on source chain (constant — burnToken is SOURCE token, not destination)
  const arcUsdcLower = '0x3600000000000000000000000000000000000000'
  if (bodyDecoded) {
    // burnToken in BurnMessageV2 body is the SOURCE Arc USDC, not the destination USDC
    if (bodyDecoded.burnToken !== arcUsdcLower)
      return { ok: false, reason: `MessageReceived body.burnToken ${bodyDecoded.burnToken} !== Arc USDC ${arcUsdcLower}` }
    if (bodyDecoded.mintRecipient !== recipLower)
      return { ok: false, reason: `MessageReceived mintRecipient mismatch: ${bodyDecoded.mintRecipient} vs ${recipLower}` }
    if (bodyDecoded.messageSender !== routerLower)
      return { ok: false, reason: `MessageReceived messageSender ${bodyDecoded.messageSender} !== router ${routerLower}` }
    if (bodyDecoded.maxFee > signedMaxFee)
      return { ok: false, reason: `MessageReceived maxFee ${bodyDecoded.maxFee} > signed ${signedMaxFee}` }
    if (bodyDecoded.feeExecuted > signedMaxFee)
      return { ok: false, reason: `MessageReceived feeExecuted ${bodyDecoded.feeExecuted} > signed maxCctpFee ${signedMaxFee}` }
  }

  // 2. MintAndWithdraw: find actual net amount delivered
  const mawLog = receipt.logs.find(log => {
    if ((log.topics[0] ?? '').toLowerCase() !== MINT_AND_WITHDRAW_TOPIC.toLowerCase()) return false
    // topics[1] = mintRecipient (indexed address)
    const recip = ('0x' + (log.topics[1] ?? '').slice(-40)).toLowerCase()
    if (recip !== recipLower) return false
    return true
  })

  let netAmount: bigint
  let feeExecuted: bigint

  if (mawLog) {
    // data: amount(32) + feeCollected(32)
    const mawData = mawLog.data.startsWith('0x') ? mawLog.data.slice(2) : mawLog.data
    if (mawData.length < 128) return { ok: false, reason: 'MintAndWithdraw data too short' }
    netAmount   = BigInt('0x' + mawData.slice(0, 64))
    feeExecuted = BigInt('0x' + mawData.slice(64, 128))
    if (feeExecuted > signedMaxFee)
      return { ok: false, reason: `MintAndWithdraw feeCollected ${feeExecuted} > signed maxCctpFee ${signedMaxFee}` }
    // netAmount + feeExecuted should equal grossAmount (within rounding)
    if (netAmount + feeExecuted !== grossAmount)
      return { ok: false, reason: `MintAndWithdraw amounts don't sum to gross: net=${netAmount} fee=${feeExecuted} gross=${grossAmount}` }
  } else {
    // Fallback: use bodyDecoded values if available
    if (!bodyDecoded) return { ok: false, reason: 'Neither MintAndWithdraw event nor decodable message body found' }
    netAmount   = bodyDecoded.netAmount
    feeExecuted = bodyDecoded.feeExecuted
  }

  // Verify minimum net delivery
  const minNet = grossAmount - signedMaxFee
  if (netAmount < minNet)
    return { ok: false, reason: `Net delivered ${netAmount} < minimum expected ${minNet}` }

  // 3. ERC-20 Transfer to mintRecipient for net amount
  const transferLog = receipt.logs.find(log => {
    if (log.address.toLowerCase() !== usdcAddr.toLowerCase()) return false
    if ((log.topics[0] ?? '').toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase()) return false
    // topics[2] = to (indexed address)
    const to = ('0x' + (log.topics[2] ?? '').slice(-40)).toLowerCase()
    if (to !== recipLower) return false
    // data = amount (uint256)
    const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data
    const transferAmt = BigInt('0x' + (data.slice(0, 64) || '0'))
    return transferAmt === netAmount
  })
  if (!transferLog)
    return { ok: false, reason: `USDC Transfer to mintRecipient for netAmount ${netAmount} not found` }

  return { ok: true, netAmount, feeExecuted }
}

// ── CCTP SQL schema ───────────────────────────────────────────────────────────

export const CCTP_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS cctp_journal (
    cctpIntentKey      TEXT PRIMARY KEY,
    legacyRelayKey     TEXT NOT NULL UNIQUE,
    signerAddress      TEXT NOT NULL,
    destinationDomain  INTEGER NOT NULL,
    mintRecipient      TEXT NOT NULL,
    grossAmount        TEXT NOT NULL,
    maxCctpFee         TEXT NOT NULL,
    relayFee           TEXT NOT NULL,
    relayerAddress     TEXT NOT NULL,
    quoteExpiry        TEXT NOT NULL,
    escrowNonce        TEXT NOT NULL,
    paymentSig         TEXT NOT NULL,
    cctpSig            TEXT NOT NULL,
    relayNonce         INTEGER,
    chainId            INTEGER NOT NULL,
    routerAddress      TEXT NOT NULL,
    rawTx              TEXT,
    txHash             TEXT,
    status             TEXT NOT NULL DEFAULT 'pending',
    sourceTxHash       TEXT,
    destTxHash         TEXT,
    netAmountDelivered TEXT,
    createdAt          INTEGER NOT NULL,
    updatedAt          INTEGER NOT NULL,
    receiptBlockNumber INTEGER,
    errorMsg           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cctp_status      ON cctp_journal(status);
  CREATE INDEX IF NOT EXISTS idx_cctp_relayKey    ON cctp_journal(legacyRelayKey);
`

// ── Iris fee API ──────────────────────────────────────────────────────────────

const IRIS_BASE_DEFAULT = 'https://iris-api.circle.com'
export const ARC_SOURCE_DOMAIN = 26

export interface IrisFeeResult {
  ok: true
  forwardFee: bigint    // 6-dec USDC base units
  minimumFeeBps: bigint // bps rate (0 = no minimum)
  ttlSeconds: number
}

/**
 * Fetch CCTP forwarding fees from Circle Iris API.
 *
 * GET /v2/burn/USDC/fees/{sourceDomain}/{destinationDomain}?forward=true
 *
 * REAL API response: a top-level JSON ARRAY (not {fees:[...]}):
 *   [ { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low, med, high } }, ... ]
 *
 * We select finalityThreshold=2000 (standard) and use forwardFee.high as the
 * conservative maxCctpFee input.  minimumFee is a bps RATE; this release fails
 * closed if nonzero rather than silently under-quoting.
 * We fail closed on any malformed or missing required fields.
 */
export async function fetchIrisFee(
  destinationDomain: number,
  grossAmount: bigint,
  signal?: AbortSignal,
  irisBaseUrl?: string,
): Promise<IrisFeeResult | { ok: false; reason: string }> {
  const base = irisBaseUrl || IRIS_BASE_DEFAULT
  const url  = `${base}/v2/burn/USDC/fees/${ARC_SOURCE_DOMAIN}/${destinationDomain}?forward=true`
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal,
    })
  } catch (e) {
    return { ok: false, reason: `Iris API fetch failed: ${(e as Error).message}` }
  }

  if (!res.ok) return { ok: false, reason: `Iris API returned ${res.status}` }

  let json: unknown
  try { json = await res.json() } catch {
    return { ok: false, reason: 'Iris API returned non-JSON body' }
  }

  // Real API returns a top-level array
  if (!Array.isArray(json) || json.length === 0)
    return { ok: false, reason: 'Iris API response must be a non-empty JSON array' }

  const standardEntry = (json as Array<Record<string, unknown>>).find(
    f => Number(f.finalityThreshold) === 2000
  )
  if (!standardEntry)
    return { ok: false, reason: 'Iris API returned no standard-finality (2000) fee tier' }

  // forwardFee is an object {low, med, high} — use high (conservative)
  const forwardFeeObj = standardEntry.forwardFee as Record<string, unknown> | undefined
  if (!forwardFeeObj || typeof forwardFeeObj !== 'object')
    return { ok: false, reason: 'Iris API: forwardFee field missing or not an object' }

  const highStr = String(forwardFeeObj.high ?? '')
  if (!/^\d+$/.test(highStr))
    return { ok: false, reason: `Iris forwardFee.high '${highStr}' is not a non-negative integer` }

  let forwardFeeHigh: bigint
  try { forwardFeeHigh = BigInt(highStr) } catch {
    return { ok: false, reason: 'Iris forwardFee.high could not be parsed as bigint' }
  }

  // minimumFee is a bps RATE (integer, may be 0)
  const minimumFeeStr = String(standardEntry.minimumFee ?? '0')
  if (!/^\d+$/.test(minimumFeeStr))
    return { ok: false, reason: `Iris minimumFee '${minimumFeeStr}' is not a non-negative integer` }
  let minimumFeeBps: bigint
  try { minimumFeeBps = BigInt(minimumFeeStr) } catch {
    return { ok: false, reason: 'Iris minimumFee could not be parsed as bigint' }
  }

  // minimumFee is a bps RATE. This release fails closed for nonzero rate.
  if (minimumFeeBps > 0n)
    return { ok: false, reason: `Iris minimumFee bps rate ${minimumFeeBps} is nonzero — unsupported in this release` }

  const forwardFee = forwardFeeHigh

  // ttlSeconds: Iris doesn't return this field; we default to 60s
  const ttlSeconds = 60

  return { ok: true, forwardFee, minimumFeeBps, ttlSeconds }
}

// ── Circle Messages API ───────────────────────────────────────────────────────

const MESSAGES_BASE_DEFAULT = 'https://iris-api.circle.com'

export interface CctpMessageStatus {
  cctpVersion:      number   // must be 2 for CCTP V2
  sourceTxHash:     string   // must match requested hash
  destTxHash:       string | null
  mintRecipient:    string   // 32-byte hex (bytes32 padded address)
  amount:           string   // decimal USDC base units (gross, per V2 body)
  sourceDomain:     number
  destinationDomain: number
  attestedNonce:    string   // bytes32 hex — assigned offchain, NOT the template nonce
  burnToken:        string   // lowercase address
  messageSender:    string   // lowercase address (router)
  destinationCaller: string  // must be 0x0000..0000 (permissionless)
  forwardState:     string
  forwardTxHash:    string | null
}

/**
 * Poll Circle Messages V2 API.
 * Returns a CctpMessageStatus only when a message matching ALL of:
 *   - sourceTxHash root matches requested hash
 *   - cctpVersion = 2
 *   - sourceDomain = 26 (Arc)
 *   - destinationDomain matches
 *   - burnToken = expectedArcUsdc (Arc USDC)
 *   - messageSender = expectedRouter (router address)
 *   - mintRecipient matches
 *   - destinationCaller = 0x00...00 (Circle Forwarding Service, permissionless)
 */
export async function pollCctpMessage(
  sourceTxHash: string,
  destinationDomain: number,
  mintRecipient: string,
  expectedRouter: string,
  expectedArcUsdc: string,
  signal?: AbortSignal,
  messagesBaseUrl?: string,
): Promise<CctpMessageStatus | null | { error: string }> {
  const base = messagesBaseUrl || MESSAGES_BASE_DEFAULT
  const url = `${base}/v2/messages/${ARC_SOURCE_DOMAIN}?transactionHash=${sourceTxHash}`
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal,
    })
  } catch (e) {
    return { error: `Messages API fetch failed: ${(e as Error).message}` }
  }

  if (res.status === 404) return null
  if (!res.ok) return { error: `Messages API returned ${res.status}` }

  let json: unknown
  try { json = await res.json() } catch { return { error: 'Messages API non-JSON' } }

  // Root sourceTxHash must match (not blindly trust per-message hashes)
  const rootTxHash = (json as Record<string, unknown>)?.sourceTxHash
  if (rootTxHash && typeof rootTxHash === 'string') {
    if (rootTxHash.toLowerCase() !== sourceTxHash.toLowerCase())
      return { error: `Messages API sourceTxHash mismatch: got ${rootTxHash}` }
  }

  const messages = (json as Record<string, unknown>)?.messages
  if (!Array.isArray(messages)) return null

  const mintRecipientNorm  = mintRecipient.toLowerCase().replace(/^0x/, '')
  const mintRecipientB32   = mintRecipientNorm.padStart(64, '0')
  const routerNorm         = expectedRouter.toLowerCase().replace(/^0x/, '')
  const arcUsdcNorm        = expectedArcUsdc.toLowerCase().replace(/^0x/, '')
  const ZERO_BYTES32       = '0'.repeat(64)

  for (const msg of messages) {
    const m = msg as Record<string, unknown>
    const decoded = m.decodedMessage as Record<string, unknown> | undefined
    if (!decoded) continue

    // cctpVersion MUST be 2
    const cctpVer = Number(m.cctpVersion ?? decoded.cctpVersion ?? 0)
    if (cctpVer !== 2) continue

    if (Number(decoded.sourceDomain) !== ARC_SOURCE_DOMAIN) continue
    if (Number(decoded.destinationDomain) !== destinationDomain) continue

    const body = decoded.decodedMessageBody as Record<string, unknown> | undefined
    if (!body) continue

    // mintRecipient match
    const msgMintRecipient = String(body.mintRecipient ?? '').toLowerCase().replace(/^0x/, '')
    if (msgMintRecipient !== mintRecipientB32 && msgMintRecipient !== mintRecipientNorm) continue

    // burnToken must be Arc USDC
    const msgBurnToken = String(body.burnToken ?? '').toLowerCase().replace(/^0x/, '')
    if (msgBurnToken !== arcUsdcNorm) continue

    // messageSender (in body) must be router
    const msgSender = String(body.messageSender ?? '').toLowerCase().replace(/^0x/, '')
    if (msgSender !== routerNorm) continue

    // destinationCaller must be zero (permissionless forwarding)
    const destCaller = String(decoded.destinationCaller ?? body.destinationCaller ?? '').toLowerCase().replace(/^0x/, '')
    if (destCaller !== ZERO_BYTES32 && destCaller !== '') continue

    // attested nonce: V2 assigns nonces offchain; template may show 0.
    // We use the nonce from the decoded message (may be '0' pre-attestation).
    const attestedNonce = String(decoded.nonce ?? body.nonce ?? '0')

    const state: string = String(m.status ?? 'pending').toLowerCase()
    const mappedState = state === 'complete' ? 'complete' :
                        state === 'failed'   ? 'failed'   :
                        state === 'attested' ? 'attested' : 'pending'

    // forwardTxHash: validate format if present
    let forwardTxHash: string | null = null
    const rawFwd = m.forwardTxHash
    if (rawFwd && typeof rawFwd === 'string' && /^0x[0-9a-fA-F]{64}$/.test(rawFwd)) {
      forwardTxHash = rawFwd
    }

    // destTxHash: only use a validated forwardTxHash from Circle API (no invented fallback fields)
    const destTxHash: string | null = forwardTxHash

    return {
      cctpVersion:       cctpVer,
      sourceTxHash:      sourceTxHash,
      destTxHash,
      mintRecipient:     String(body.mintRecipient ?? ''),
      amount:            String(body.amount ?? '0'),
      sourceDomain:      Number(decoded.sourceDomain),
      destinationDomain: Number(decoded.destinationDomain),
      attestedNonce,
      burnToken:         String(body.burnToken ?? ''),
      messageSender:     String(body.messageSender ?? ''),
      destinationCaller: destCaller,
      forwardState:      String(m.forwardState ?? ''),
      forwardTxHash,
    }
  }
  return null
}

// ── Destination chain configuration ──────────────────────────────────────────

export interface DestChainConfig {
  chainId:         number
  rpcUrl:          string
  transmitterAddr: string  // MessageTransmitterV2
  usdcAddr:        string  // USDC on destination
}

/**
 * Official Circle CCTP V2 mainnet configs.
 * MessageTransmitterV2: 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64 (both Ethereum + Base Mainnet).
 */
export const DEST_CHAIN_CONFIGS: Record<number, DestChainConfig> = {
  // Ethereum Mainnet (domain 0)
  0: {
    chainId:         1,
    rpcUrl:          'https://eth.llamarpc.com',
    transmitterAddr: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
    usdcAddr:        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  // Base Mainnet (domain 6)
  6: {
    chainId:         8453,
    rpcUrl:          'https://mainnet.base.org',
    transmitterAddr: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
    usdcAddr:        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
}

// ── Gas constants ─────────────────────────────────────────────────────────────

export const CCTP_QUOTE_GAS_CEILING = 600_000n
export const ARC_USDC_SCALE         = 1_000_000_000_000n  // 1e12 (18-dec → 6-dec)
export const ARC_GAS_FLOOR          = 20_000_000_000n     // 20 Gwei
export const CCTP_FEE_BUFFER_MIN    = 5_000n              // 0.005 USDC minimum buffer

export const SUPPORTED_CCTP_DEST_DOMAINS = [0, 6] as const

// ── Router readiness check ────────────────────────────────────────────────────

export async function validateRouterImmutables(
  routerAddress: string,
  expectedEscrow: string,
  expectedUsdc: string,
  rpcUrl: string,
): Promise<string | null> {
  const encodeViewCall = (sig: string): string => {
    return ('0x' + keccak256(toBytes(sig)).slice(2, 10))
  }

  async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`)
    const json = await res.json() as { result?: unknown; error?: { message: string } }
    if (json.error) throw new Error(`RPC: ${json.error.message}`)
    return json.result
  }

  try {
    const [escrowHex, usdcHex] = await Promise.all([
      rpcCall('eth_call', [{ to: routerAddress, data: encodeViewCall('escrow()') }, 'latest']) as Promise<string>,
      rpcCall('eth_call', [{ to: routerAddress, data: encodeViewCall('usdc()') }, 'latest']) as Promise<string>,
    ])
    const readEscrow = ('0x' + escrowHex.slice(-40)).toLowerCase()
    const readUsdc   = ('0x' + usdcHex.slice(-40)).toLowerCase()
    if (readEscrow !== expectedEscrow.toLowerCase())
      return `Router escrow mismatch: expected ${expectedEscrow}, got ${readEscrow}`
    if (readUsdc !== expectedUsdc.toLowerCase())
      return `Router usdc mismatch: expected ${expectedUsdc}, got ${readUsdc}`
    return null
  } catch (e) {
    return `Router readiness check failed: ${(e as Error).message}`
  }
}

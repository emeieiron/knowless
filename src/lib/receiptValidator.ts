/**
 * receiptValidator.ts — shared PaymentExecuted receipt validation.
 *
 * Used by usePendingIntent (UI polling) and receipt tests.
 *
 * VALIDATION RULES
 * ────────────────
 * A receipt is only "confirmed paid" when ALL of the following hold:
 *   1. The RPC call succeeded (no network error, no null result).
 *   2. receipt.status === '0x1' (not reverted).
 *   3. receipt.to (lower-cased) matches the configured contract address.
 *   4. receipt.transactionHash (lower-cased) matches the expected txHash.
 *   5. At least one log in receipt.logs matches the PaymentExecuted event:
 *      - topics[0] === PAYMENT_EXECUTED_TOPIC  (keccak256 of the event signature)
 *      - topics[1] (indexed signerAddress) matches intent.signerAddress
 *      - topics[2] (indexed recipient) matches intent.recipient
 *      - topics[3] (indexed feeRecipient) matches intent.feeRecipient
 *      - The emitting contract address matches the configured contract address.
 *      - Decoded data (amount, fee, nonce) matches intent fields.
 *
 * Any RPC uncertainty (exception, missing receipt) returns 'pending'.
 * A receipt that fails any check returns 'failed' (never 'success').
 * An elapsed timer alone NEVER returns 'success'.
 */

import type { Address, Hex } from 'viem'
import { decodeAbiParameters, keccak256, toBytes } from 'viem'

// ── Event signature and topic ─────────────────────────────────────────────

// PaymentExecuted(address indexed signerAddress, address indexed recipient,
//                 uint128 amount, uint128 fee, address indexed feeRecipient, uint256 nonce)
const PAYMENT_EXECUTED_SIG =
  'PaymentExecuted(address,address,uint128,uint128,address,uint256)'

export const PAYMENT_EXECUTED_TOPIC = keccak256(toBytes(PAYMENT_EXECUTED_SIG))

// ── Types ─────────────────────────────────────────────────────────────────

export interface ReceiptValidationConfig {
  contractAddress: Address   // lower-case comparison
  chainId: number
}

/** Minimal receipt log shape as returned by eth_getTransactionReceipt */
export interface RpcLog {
  address: string
  topics: string[]
  data: string
}

/** Minimal receipt shape as returned by eth_getTransactionReceipt */
export interface RpcReceipt {
  status: string               // '0x1' = success
  to: string | null
  transactionHash: string
  logs: RpcLog[]
  blockNumber?: string
}

export interface IntentForValidation {
  signerAddress: Address
  recipient: Address
  feeRecipient: Address
  amount: bigint
  fee: bigint
  nonce: bigint
  txHash: Hex
}

export type ValidationResult =
  | { ok: true;  blockNumber: bigint }
  | { ok: false; reason: string }

/**
 * Validate a raw RPC receipt object against a known payment intent.
 * Pure function — no I/O. Returns { ok: true } only if all checks pass.
 */
export function validateReceipt(
  receipt: RpcReceipt,
  intent: IntentForValidation,
  cfg: ReceiptValidationConfig,
): ValidationResult {
  // 1. Status
  if (receipt.status !== '0x1')
    return { ok: false, reason: 'receipt reverted (status != 0x1)' }

  // 2. Contract address
  if ((receipt.to ?? '').toLowerCase() !== cfg.contractAddress.toLowerCase())
    return { ok: false, reason: `receipt.to ${receipt.to} != configured contract ${cfg.contractAddress}` }

  // 3. txHash match
  if (receipt.transactionHash.toLowerCase() !== intent.txHash.toLowerCase())
    return { ok: false, reason: `receipt txHash mismatch` }

  // 4. Find a matching PaymentExecuted log
  const matchingLog = receipt.logs.find(log => {
    if (log.address.toLowerCase() !== cfg.contractAddress.toLowerCase()) return false
    if (!log.topics[0] || log.topics[0].toLowerCase() !== PAYMENT_EXECUTED_TOPIC.toLowerCase()) return false

    // Indexed topics: [0]=event_id [1]=signerAddress [2]=recipient [3]=feeRecipient
    // Each address topic is 32 bytes; address occupies the last 20 bytes
    const topicToAddr = (t: string | undefined): string => {
      if (!t || t.length < 42) return ''
      return ('0x' + t.slice(-40)).toLowerCase()
    }

    if (topicToAddr(log.topics[1]) !== intent.signerAddress.toLowerCase()) return false
    if (topicToAddr(log.topics[2]) !== intent.recipient.toLowerCase()) return false
    if (topicToAddr(log.topics[3]) !== intent.feeRecipient.toLowerCase()) return false

    // Non-indexed data: (uint128 amount, uint128 fee, uint256 nonce)
    try {
      const [amount, fee, nonce] = decodeAbiParameters(
        [{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }],
        log.data as Hex,
      )
      if (amount !== intent.amount) return false
      if (fee !== intent.fee) return false
      if (nonce !== intent.nonce) return false
    } catch {
      return false
    }

    return true
  })

  if (!matchingLog)
    return { ok: false, reason: 'no matching PaymentExecuted log found in receipt' }

  const blockNum = receipt.blockNumber ? BigInt(receipt.blockNumber) : 0n
  return { ok: true, blockNumber: blockNum }
}

/**
 * Fetch a receipt from RPC and validate it.
 *
 * Returns 'pending'  — no proof either way; keep polling.
 * Returns 'success'  — matching receipt with PaymentExecuted event verified.
 * Returns 'failed'   — definitively reverted (status=0x0 AND txHash matches
 *                      AND contract address matches). No other condition produces
 *                      'failed': a wrong txHash, wrong contract, malformed body,
 *                      RPC error, or missing PaymentExecuted log is UNCERTAINTY,
 *                      not proof that THIS transaction reverted.
 *
 * Uncertainty rule: only return 'failed' when we have POSITIVE evidence of a
 * revert on THIS specific transaction. Any ambiguity keeps the intent alive.
 */
export type PollReceiptResult = 'pending' | 'success' | 'failed'

/**
 * Verify the RPC endpoint is on the expected chain by calling eth_chainId.
 * Returns true only on a confirmed match. Any error or mismatch returns false
 * (treated as uncertainty — keep intent pending, do not accept any evidence).
 */
async function verifyChainId(rpcUrl: string, expectedChainId: number): Promise<boolean> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_chainId', params: [] }),
    })
    if (!res.ok) return false
    const body = await res.json() as { result?: string; error?: unknown }
    if (body.error || typeof body.result !== 'string') return false
    // eth_chainId returns hex string, e.g. '0x4D1092'
    const reportedChainId = Number(body.result)
    return reportedChainId === expectedChainId
  } catch {
    return false
  }
}

export async function pollAndValidateReceipt(
  rpcUrl: string,
  txHash: Hex,
  intent: IntentForValidation,
  cfg: ReceiptValidationConfig,
): Promise<PollReceiptResult> {
  // Step 0: verify the RPC endpoint is on the configured chain.
  // A wrong/malformed/absent chain response is uncertainty — keep pending.
  // This prevents a compromised or wrong RPC from providing false evidence.
  const chainOk = await verifyChainId(rpcUrl, cfg.chainId)
  if (!chainOk) return 'pending'

  let receipt: RpcReceipt | null
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    })
    if (!res.ok) return 'pending'  // network-level failure → uncertain
    const body = await res.json() as { result?: RpcReceipt | null; error?: unknown }
    if (body.error) return 'pending'   // RPC error → uncertain
    receipt = body.result ?? null
  } catch {
    return 'pending'  // fetch error → uncertain
  }

  if (!receipt) return 'pending'  // not yet mined

  // Verify this receipt is for our txHash and our contract before treating
  // it as definitive evidence. A wrong hash/contract is uncertainty, not failure.
  if (receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) return 'pending'
  if ((receipt.to ?? '').toLowerCase() !== cfg.contractAddress.toLowerCase()) return 'pending'

  // Now we have a receipt for the right tx on the right contract.
  // Only EXACT status=0x0 is a definitive revert. Any unknown/malformed
  // status value (undefined, null, '0x2', etc.) is uncertainty — keep pending.
  if (receipt.status === '0x0') return 'failed'
  if (receipt.status !== '0x1') return 'pending'  // unknown status → uncertain

  // Successful receipt — verify the PaymentExecuted event matches intent.
  // A missing/wrong event is uncertainty (we have a mined success but cannot
  // confirm it is our specific payment — keep intent alive for investigation).
  const v = validateReceipt(receipt, intent, cfg)
  return v.ok ? 'success' : 'pending'
}

/**
 * cctp.ts — shared types, ABI fragments, and EIP-712 helpers for the
 * KnowlessCctpRouter cross-chain payment contract.
 *
 * No deployed address is stored here — addresses must come from
 * environment variables or deployment manifests at runtime.
 *
 * Chain facts (Arc):
 *   Chain ID          : 5042
 *   USDC (ERC-20/gas) : 0x3600000000000000000000000000000000000000
 *   Arc CCTP domain   : 26
 *   Destination domains: EthereumSepolia=0, BaseSepolia=6
 */

import {
  keccak256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  hashTypedData,
  toHex,
} from 'viem'
import type { Address, Hex } from 'viem'

// ── Chain / domain constants ─────────────────────────────────────────────────

export const ARC_CHAIN_ID          = 5042n
/** @deprecated use ARC_CHAIN_ID */
export const ARC_TESTNET_CHAIN_ID  = ARC_CHAIN_ID
export const ARC_CCTP_DOMAIN       = 26
export const ETH_SEPOLIA_DOMAIN    = 0
export const BASE_SEPOLIA_DOMAIN   = 6
export const FINALITY_THRESHOLD    = 2000

/**
 * Circle Forwarding Service static hook bytes32:
 * "cctp-forward" magic (24 bytes) + version 0 (4 bytes) + length 0 (4 bytes).
 */
export const FORWARDING_HOOK: Hex =
  '0x636374702d666f72776172640000000000000000000000000000000000000000'

export const SUPPORTED_DESTINATION_DOMAINS: ReadonlyArray<number> = [
  ETH_SEPOLIA_DOMAIN,
  BASE_SEPOLIA_DOMAIN,
] as const

export const DESTINATION_DOMAIN_LABELS: Record<number, string> = {
  [ETH_SEPOLIA_DOMAIN]:  'Ethereum',
  [BASE_SEPOLIA_DOMAIN]: 'Base',
}

// ── KnowlessCctpRouter ABI (minimal — routePayment + events + errors + views) ─

export const KNOWLESS_CCTP_ROUTER_ABI = [
  // ── routePayment ────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'routePayment',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'signerAddress',     type: 'address' },
      { name: 'grossAmount',       type: 'uint128' },
      { name: 'maxCctpFee',        type: 'uint256' },
      { name: 'relayFee',          type: 'uint128' },
      { name: 'quoteExpiry',       type: 'uint64'  },
      { name: 'nonce',             type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32'  },
      { name: 'mintRecipient',     type: 'address' },
      { name: 'paymentSig',        type: 'bytes'   },
      { name: 'cctpSig',           type: 'bytes'   },
    ],
    outputs: [],
  },
  // ── View: domainSeparator ────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'domainSeparator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  // ── Immutables / constants ──────────────────────────────────────────────────
  {
    type: 'function',
    name: 'escrow',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'usdc',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'tokenMessenger',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'ARC_TESTNET_CHAIN_ID',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ARC_CCTP_DOMAIN',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint32' }],
  },
  {
    type: 'function',
    name: 'ETH_SEPOLIA_DOMAIN',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint32' }],
  },
  {
    type: 'function',
    name: 'BASE_SEPOLIA_DOMAIN',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint32' }],
  },
  {
    type: 'function',
    name: 'FINALITY_THRESHOLD',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint32' }],
  },
  {
    type: 'function',
    name: 'FORWARDING_HOOK',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'CCTP_PAYMENT_TYPEHASH',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  // ── Events ───────────────────────────────────────────────────────────────────
  {
    type: 'event',
    name: 'CctpPaymentRouted',
    inputs: [
      { name: 'signerAddress',     type: 'address', indexed: true  },
      { name: 'destinationDomain', type: 'uint32',  indexed: true  },
      { name: 'mintRecipient',     type: 'address', indexed: false },
      { name: 'grossAmount',       type: 'uint256', indexed: false },
      { name: 'maxCctpFee',        type: 'uint256', indexed: false },
      { name: 'relayFee',          type: 'uint128', indexed: false },
      { name: 'relayer',           type: 'address', indexed: true  },
      { name: 'nonce',             type: 'uint256', indexed: false },
    ],
  },
  // ── Custom errors ─────────────────────────────────────────────────────────────
  { type: 'error', name: 'WrongSourceChain',       inputs: [] },
  { type: 'error', name: 'ZeroRecipient',           inputs: [] },
  { type: 'error', name: 'ZeroRelayFee',            inputs: [] },
  { type: 'error', name: 'AmountNotGreaterThanFee', inputs: [] },
  { type: 'error', name: 'UnsupportedDestination',  inputs: [] },
  { type: 'error', name: 'QuoteExpired',            inputs: [] },
  { type: 'error', name: 'WrongRelayer',            inputs: [] },
  { type: 'error', name: 'InvalidCctpSignature',    inputs: [] },
] as const

// ── CctpPayment EIP-712 typed-data definition ────────────────────────────────

/**
 * The EIP-712 domain for KnowlessCctpRouter.
 * chainId and verifyingContract must be filled at runtime from the
 * deployment manifest (never hardcoded here).
 */
export function cctpPaymentDomain(
  chainId: bigint,
  verifyingContract: Address,
): {
  name: string
  version: string
  chainId: bigint
  verifyingContract: Address
} {
  return {
    name:              'KnowlessCctpRouter',
    version:           '1',
    chainId,
    verifyingContract,
  }
}

/**
 * CctpPayment EIP-712 typed-data types (for use with viem signTypedData /
 * wagmi useSignTypedData).
 */
export const CCTP_PAYMENT_TYPES = {
  CctpPayment: [
    { name: 'signerAddress',     type: 'address' },
    { name: 'destinationDomain', type: 'uint32'  },
    { name: 'mintRecipient',     type: 'address' },
    { name: 'grossAmount',       type: 'uint256' },
    { name: 'maxCctpFee',        type: 'uint256' },
    { name: 'relayFee',          type: 'uint128' },
    { name: 'relayer',           type: 'address' },
    { name: 'quoteExpiry',       type: 'uint64'  },
    { name: 'nonce',             type: 'uint256' },
    { name: 'escrow',            type: 'address' },
    { name: 'chainId',           type: 'uint256' },
  ],
} as const

/**
 * CctpPayment message values.
 * All bigint fields match the Solidity types (uint128 → bigint is safe).
 */
export interface CctpPaymentMessage {
  signerAddress:     Address
  destinationDomain: number
  mintRecipient:     Address
  grossAmount:       bigint
  maxCctpFee:        bigint
  relayFee:          bigint
  relayer:           Address
  quoteExpiry:       bigint
  nonce:             bigint
  escrow:            Address
  chainId:           bigint
}

// ── Solidity-compatible digest helpers ───────────────────────────────────────

/**
 * Compute the CCTP_PAYMENT_TYPEHASH the same way the contract does:
 *   keccak256(bytes("CctpPayment(...)"))
 * Uses toHex(string) to produce the correct Hex argument for encodePacked.
 */
export const CCTP_PAYMENT_TYPEHASH: Hex = keccak256(
  toHex(
    'CctpPayment(' +
    'address signerAddress,' +
    'uint32 destinationDomain,' +
    'address mintRecipient,' +
    'uint256 grossAmount,' +
    'uint256 maxCctpFee,' +
    'uint128 relayFee,' +
    'address relayer,' +
    'uint64 quoteExpiry,' +
    'uint256 nonce,' +
    'address escrow,' +
    'uint256 chainId' +
    ')'
  ),
)

/**
 * Compute the CctpPayment struct hash off-chain using the same ABI encoding
 * as the contract's abi.encode() call.
 */
export function computeCctpPaymentStructHash(msg: CctpPaymentMessage): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'bytes32, address, uint32, address, uint256, uint256, uint128, address, uint64, uint256, address, uint256'
      ),
      [
        CCTP_PAYMENT_TYPEHASH,
        msg.signerAddress,
        msg.destinationDomain,
        msg.mintRecipient,
        msg.grossAmount,
        msg.maxCctpFee,
        msg.relayFee,
        msg.relayer,
        msg.quoteExpiry,
        msg.nonce,
        msg.escrow,
        msg.chainId,
      ],
    ),
  )
}

/**
 * Compute the full EIP-712 digest for a CctpPayment message using two methods
 * that must agree:
 *
 *   Method A (manual): keccak256(encodePacked(['bytes2','bytes32','bytes32'], ['0x1901', domSep, structHash]))
 *   Method B (viem):   hashTypedData({ domain, types, primaryType, message })
 *
 * The exported function uses Method A (matching the Solidity contract byte-for-byte).
 * The interop fixture in cctp.test.ts verifies A === B for a concrete test vector.
 *
 * EIP-712 prefix is TWO bytes (0x19, 0x01) encoded as bytes2 in encodePacked,
 * NOT a single bytes1 0x19.
 */
export function computeCctpPaymentDigest(
  msg: CctpPaymentMessage,
  routerAddress: Address,
): Hex {
  const domain     = cctpPaymentDomain(msg.chainId, routerAddress)
  const structHash = computeCctpPaymentStructHash(msg)

  // Reconstruct domain separator using viem hashTypedData internals:
  // domain separator = keccak256(abi.encode(DOMAIN_TYPEHASH, name, version, chainId, verifyingContract))
  // viem's hashTypedData computes this internally — we derive domSep by hashing only
  // the domain portion via a single-field types object, which viem handles correctly.
  // Instead we compute domSep directly to match the contract exactly:
  const EIP712_DOMAIN_TYPEHASH = keccak256(
    toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
  )
  const domSep = keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toHex(domain.name)),
        keccak256(toHex(domain.version)),
        domain.chainId,
        domain.verifyingContract,
      ],
    ),
  )

  // Canonical EIP-712 final hash: keccak256(0x1901 || domainSeparator || structHash)
  return keccak256(
    encodePacked(['bytes2', 'bytes32', 'bytes32'], ['0x1901', domSep, structHash]),
  )
}

/**
 * Compute the EIP-712 digest using viem's hashTypedData for interoperability
 * verification.  Must equal computeCctpPaymentDigest for any valid message.
 */
export function computeCctpPaymentDigestViem(
  msg: CctpPaymentMessage,
  routerAddress: Address,
): Hex {
  return hashTypedData({
    domain:      cctpPaymentDomain(msg.chainId, routerAddress),
    types:       CCTP_PAYMENT_TYPES,
    primaryType: 'CctpPayment',
    message: {
      signerAddress:     msg.signerAddress,
      destinationDomain: msg.destinationDomain,
      mintRecipient:     msg.mintRecipient,
      grossAmount:       msg.grossAmount,
      maxCctpFee:        msg.maxCctpFee,
      relayFee:          msg.relayFee,
      relayer:           msg.relayer,
      quoteExpiry:       msg.quoteExpiry,
      nonce:             msg.nonce,
      escrow:            msg.escrow,
      chainId:           msg.chainId,
    },
  })
}

// ── Input validation helpers ─────────────────────────────────────────────────

// Fix 2: exported type alias for discriminated union, not interface+union
export type CctpRouteValidation =
  | { ok: true;  error?: never }
  | { ok: false; error: string }

/**
 * Validate a CctpPayment message before signing or submitting.
 * Does NOT check chain state (balance, expiry against block.timestamp, etc.).
 */
export function validateCctpPaymentMessage(msg: CctpPaymentMessage): CctpRouteValidation {
  if (msg.mintRecipient === '0x0000000000000000000000000000000000000000')
    return { ok: false, error: 'Mint recipient cannot be zero address' }
  if (msg.relayFee <= 0n)
    return { ok: false, error: 'Relay fee must be > 0' }
  if (msg.grossAmount <= msg.maxCctpFee)
    return { ok: false, error: 'Gross amount must be > maxCctpFee' }
  if (!SUPPORTED_DESTINATION_DOMAINS.includes(msg.destinationDomain))
    return { ok: false, error: `Unsupported destination domain: ${msg.destinationDomain}` }
  if (msg.chainId !== ARC_TESTNET_CHAIN_ID)
    return { ok: false, error: `Wrong source chain: expected ${ARC_TESTNET_CHAIN_ID}, got ${msg.chainId}` }
  return { ok: true }
}

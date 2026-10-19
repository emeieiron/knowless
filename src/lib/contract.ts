/**
 * Spookly contract ABI and address constants.
 * Deploy address is written here after deployment.
 */

import type { Address } from 'viem'

// ARC TESTNET deployment — updated after deploy
// v2 deployment — includes feeRecipient+quoteExpiry in PaymentAuth
export const SPOOKLY_ADDRESS_TESTNET: Address = '0xbe223821c0925e87cde1ca397fdce253a8ce7b22'
export const ARC_TESTNET_CHAIN_ID = 5042002
export const ARC_TESTNET_USDC: Address = '0x3600000000000000000000000000000000000000'

export const SPOOKLY_ABI = [
  {
    type: 'constructor',
    inputs: [{ name: '_usdc', type: 'address' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'createLink',
    inputs: [
      { name: 'signerAddress', type: 'address' },
      { name: 'principal', type: 'uint128' },
      { name: 'feeBudget', type: 'uint128' },
      { name: 'expiry', type: 'uint64' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'executePayment',
    inputs: [
      { name: 'signerAddress', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint128' },
      { name: 'fee', type: 'uint128' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'quoteExpiry', type: 'uint64' },
      { name: 'nonce', type: 'uint256' },
      { name: 'sig', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'cancelLink',
    inputs: [{ name: 'signerAddress', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getLinkInfo',
    inputs: [{ name: 'signerAddress', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'issuer', type: 'address' },
          { name: 'balance', type: 'uint128' },
          { name: 'feeBalance', type: 'uint128' },
          { name: 'expiry', type: 'uint64' },
          { name: 'active', type: 'bool' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'domainSeparator',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'links',
    inputs: [{ name: 'signerAddress', type: 'address' }],
    outputs: [
      { name: 'issuer', type: 'address' },
      { name: 'balance', type: 'uint128' },
      { name: 'feeBalance', type: 'uint128' },
      { name: 'expiry', type: 'uint64' },
      { name: 'active', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'usdc',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'usedNonces',
    inputs: [
      { name: 'signerAddress', type: 'address' },
      { name: 'nonce', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  // Events
  {
    type: 'event',
    name: 'LinkCreated',
    inputs: [
      { name: 'signerAddress', type: 'address', indexed: true },
      { name: 'issuer', type: 'address', indexed: true },
      { name: 'principal', type: 'uint128', indexed: false },
      { name: 'feeBudget', type: 'uint128', indexed: false },
      { name: 'expiry', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PaymentExecuted',
    inputs: [
      { name: 'signerAddress', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint128', indexed: false },
      { name: 'fee', type: 'uint128', indexed: false },
      { name: 'feeRecipient', type: 'address', indexed: true },
      { name: 'nonce', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LinkCancelled',
    inputs: [
      { name: 'signerAddress', type: 'address', indexed: true },
      { name: 'issuer', type: 'address', indexed: true },
      { name: 'refund', type: 'uint128', indexed: false },
    ],
  },
  // Custom errors
  { type: 'error', name: 'ZeroSignerAddress', inputs: [] },
  { type: 'error', name: 'SignerAlreadyRegistered', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'ExpiryInPast', inputs: [] },
  { type: 'error', name: 'LinkNotActive', inputs: [] },
  { type: 'error', name: 'LinkExpired', inputs: [] },
  { type: 'error', name: 'ZeroRecipient', inputs: [] },
  { type: 'error', name: 'SelfRecipient', inputs: [] },
  { type: 'error', name: 'NonceUsed', inputs: [] },
  { type: 'error', name: 'InsufficientBalance', inputs: [] },
  { type: 'error', name: 'InsufficientFeeBalance', inputs: [] },
  { type: 'error', name: 'InvalidSignature', inputs: [] },
  { type: 'error', name: 'TransferFailed', inputs: [] },
  { type: 'error', name: 'NotIssuer', inputs: [] },
  { type: 'error', name: 'QuoteExpired', inputs: [] },
  { type: 'error', name: 'WrongFeeRecipient', inputs: [] },
] as const

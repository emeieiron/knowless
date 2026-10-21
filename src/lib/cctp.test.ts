// oxlint-disable no-floating-promises
/**
 * cctp.test.ts — interoperability fixture for computeCctpPaymentDigest.
 *
 * Verifies that the manual 0x1901 || domSep || structHash path (Method A,
 * used by computeCctpPaymentDigest) produces the same digest as viem's
 * hashTypedData (Method B, used by computeCctpPaymentDigestViem) for the
 * same message and routerAddress.
 *
 * This is a pure in-process TypeScript fixture bound to the actual Solidity
 * schema (CCTP_PAYMENT_TYPES, cctpPaymentDomain) from the module under test.
 * No contract deployment, browser, or camera.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeCctpPaymentDigest,
  computeCctpPaymentDigestViem,
  CCTP_PAYMENT_TYPEHASH,
  CCTP_PAYMENT_TYPES,
  cctpPaymentDomain,
  validateCctpPaymentMessage,
  ETH_SEPOLIA_DOMAIN,
  BASE_SEPOLIA_DOMAIN,
  ARC_TESTNET_CHAIN_ID,
  type CctpPaymentMessage,
} from './cctp.js'
import { keccak256, toHex } from 'viem'

// ── Test vector ────────────────────────────────────────────────────────────────

// Stable fictional addresses — not real deployed contracts
const ROUTER_ADDR  = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const ESCROW_ADDR  = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
const SIGNER_ADDR  = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const
const RELAYER_ADDR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as const
const MINT_ADDR    = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as const

const testMsg: CctpPaymentMessage = {
  signerAddress:     SIGNER_ADDR,
  destinationDomain: ETH_SEPOLIA_DOMAIN,
  mintRecipient:     MINT_ADDR,
  grossAmount:       5_000_000n,
  maxCctpFee:          100_000n,
  relayFee:            200_000n,
  relayer:           RELAYER_ADDR,
  quoteExpiry:       9_999_999_999n,
  nonce:             42n,
  escrow:            ESCROW_ADDR,
  chainId:           ARC_TESTNET_CHAIN_ID,
}

// ── C1: CCTP_PAYMENT_TYPEHASH ─────────────────────────────────────────────────

void it('C1: CCTP_PAYMENT_TYPEHASH matches keccak256 of canonical type string', () => {
  const typeStr =
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
  assert.equal(CCTP_PAYMENT_TYPEHASH, keccak256(toHex(typeStr)))
})

// ── C2: digest interoperability ────────────────────────────────────────────────

void describe('C2: digest interop — manual 0x1901 path === viem hashTypedData', () => {
  void it('ETH_SEPOLIA_DOMAIN test vector agrees', () => {
    const digestA = computeCctpPaymentDigest(testMsg, ROUTER_ADDR)
    const digestB = computeCctpPaymentDigestViem(testMsg, ROUTER_ADDR)
    assert.equal(digestA, digestB)
    assert.match(digestA, /^0x[0-9a-f]{64}$/)
  })

  void it('BASE_SEPOLIA_DOMAIN agrees and differs from ETH_SEP', () => {
    const msgBase = { ...testMsg, destinationDomain: BASE_SEPOLIA_DOMAIN }
    const digestA = computeCctpPaymentDigest(msgBase, ROUTER_ADDR)
    const digestB = computeCctpPaymentDigestViem(msgBase, ROUTER_ADDR)
    assert.equal(digestA, digestB)
    assert.notEqual(digestA, computeCctpPaymentDigest(testMsg, ROUTER_ADDR))
  })

  void it('different routerAddress → different digest, both methods agree', () => {
    const other = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc' as const
    const dA = computeCctpPaymentDigest(testMsg, ROUTER_ADDR)
    const dO = computeCctpPaymentDigest(testMsg, other)
    assert.notEqual(dA, dO)
    assert.equal(computeCctpPaymentDigestViem(testMsg, other), dO)
  })

  void it('mutating nonce changes digest, both methods agree', () => {
    const msg2 = { ...testMsg, nonce: 43n }
    const d1 = computeCctpPaymentDigest(testMsg, ROUTER_ADDR)
    const d2 = computeCctpPaymentDigest(msg2, ROUTER_ADDR)
    assert.notEqual(d1, d2)
    assert.equal(computeCctpPaymentDigestViem(msg2, ROUTER_ADDR), d2)
  })
})

// ── C3: cctpPaymentDomain ──────────────────────────────────────────────────────

void it('C3: cctpPaymentDomain fields round-trip correctly', () => {
  const dom = cctpPaymentDomain(ARC_TESTNET_CHAIN_ID, ROUTER_ADDR)
  assert.equal(dom.name, 'KnowlessCctpRouter')
  assert.equal(dom.version, '1')
  assert.equal(dom.chainId, ARC_TESTNET_CHAIN_ID)
  assert.equal(dom.verifyingContract, ROUTER_ADDR)
})

// ── C4: field order ────────────────────────────────────────────────────────────

void it('C4: CCTP_PAYMENT_TYPES field names match Solidity struct order', () => {
  const fields = CCTP_PAYMENT_TYPES.CctpPayment.map((f) => f.name)
  assert.deepEqual(fields, [
    'signerAddress', 'destinationDomain', 'mintRecipient',
    'grossAmount', 'maxCctpFee', 'relayFee', 'relayer',
    'quoteExpiry', 'nonce', 'escrow', 'chainId',
  ])
})

// ── C6: Solidity interop proof ────────────────────────────────────────────────
// Hardcoded values produced by SolidityInteropFixture.test_R24_SolidityInteropProof()
// (contracts/test/KnowlessCctpRouter.t.sol).  The Solidity test signs the same
// message with vm.sign and verifies ecrecover — these digests are real, not
// two copies of the same JS encoding.
//
// Fixed test vector (matches SolidityInteropFixture constants):
//   FIXTURE_ROUTER  : 0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f (checksummed below)
//   signerAddress   : 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 (Foundry acct[1])
//   destinationDomain: 0 (ETH_SEPOLIA)
//   mintRecipient   : 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
//   grossAmount     : 5_000_000n
//   maxCctpFee      : 100_000n
//   relayFee        : 200_000n
//   relayer         : 0x90F79bf6EB2c4f870365E785982E1f101E93b906
//   quoteExpiry     : 9_999_999_999n
//   nonce           : 42n
//   escrow          : 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
//   chainId         : 5042002n
//
// Solidity output (from test logs, immutable):
//   domSep     : 0xcf863bdafb6c2e95763ea1a810cb29543d25168f6c4e5e301b1ba0703fd61c2b
//   structHash : 0x0e7caf76f70354a1b83113d7817ec06efb03f69047a82d94aa42dc1662b2c238
//   digest     : 0x770872e55bc2931638c8a49b1a96cfedb8a237c6276a9ab52b63d3ee5bda6fd1

const INTEROP_FIXTURE_ROUTER   = '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f' as const
const INTEROP_SOLIDITY_DIGEST  = '0x770872e55bc2931638c8a49b1a96cfedb8a237c6276a9ab52b63d3ee5bda6fd1' as const

const interopMsg: CctpPaymentMessage = {
  signerAddress:     '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  destinationDomain: ETH_SEPOLIA_DOMAIN,
  mintRecipient:     '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  grossAmount:       5_000_000n,
  maxCctpFee:        100_000n,
  relayFee:          200_000n,
  relayer:           '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  quoteExpiry:       9_999_999_999n,
  nonce:             42n,
  escrow:            '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  chainId:           5042002n,
}

void describe('C6: Solidity interop proof — TS digest === Solidity-computed digest', () => {
  void it('computeCctpPaymentDigest matches Solidity test_R24_SolidityInteropProof output', () => {
    const tsDigest = computeCctpPaymentDigest(interopMsg, INTEROP_FIXTURE_ROUTER)
    assert.equal(
      tsDigest.toLowerCase(),
      INTEROP_SOLIDITY_DIGEST.toLowerCase(),
      `TS digest ${tsDigest} !== Solidity digest ${INTEROP_SOLIDITY_DIGEST}`,
    )
  })

  void it('computeCctpPaymentDigestViem also matches Solidity output', () => {
    const viemDigest = computeCctpPaymentDigestViem(interopMsg, INTEROP_FIXTURE_ROUTER)
    assert.equal(
      viemDigest.toLowerCase(),
      INTEROP_SOLIDITY_DIGEST.toLowerCase(),
      `viem digest ${viemDigest} !== Solidity digest ${INTEROP_SOLIDITY_DIGEST}`,
    )
  })
})

// ── C5: validateCctpPaymentMessage ─────────────────────────────────────────────

void describe('C5: validateCctpPaymentMessage', () => {
  void it('accepts valid message', () => {
    assert.deepEqual(validateCctpPaymentMessage(testMsg), { ok: true })
  })
  void it('rejects zero mintRecipient', () => {
    assert.equal(validateCctpPaymentMessage({
      ...testMsg,
      mintRecipient: '0x0000000000000000000000000000000000000000',
    }).ok, false)
  })
  void it('rejects zero relayFee', () => {
    assert.equal(validateCctpPaymentMessage({ ...testMsg, relayFee: 0n }).ok, false)
  })
  void it('rejects grossAmount === maxCctpFee', () => {
    assert.equal(validateCctpPaymentMessage({ ...testMsg, grossAmount: testMsg.maxCctpFee }).ok, false)
  })
  void it('rejects unsupported destination domain', () => {
    assert.equal(validateCctpPaymentMessage({ ...testMsg, destinationDomain: 99 }).ok, false)
  })
  void it('rejects wrong source chain', () => {
    assert.equal(validateCctpPaymentMessage({ ...testMsg, chainId: 1n }).ok, false)
  })
})

// ── C7: decodeBurnMessageV2Body packed layout ───────────────────────────────

void describe('C7: decodeBurnMessageV2Body packed layout', () => {
  // Import dynamically to avoid top-level circular type issues
  // BurnMessageV2 PACKED layout (byte offsets):
  //   version        @  byte  0,  4 bytes (uint32)
  //   burnToken      @  byte  4, 32 bytes
  //   mintRecipient  @  byte 36, 32 bytes
  //   amount         @  byte 68, 32 bytes
  //   messageSender  @  byte 100, 32 bytes
  //   maxFee         @  byte 132, 32 bytes
  //   feeExecuted    @  byte 164, 32 bytes
  //   expirationBlock@  byte 196, 32 bytes
  //   hookData       @  byte 228+

  const buildBody = (overrides?: Partial<{
    version: number; burnToken: string; mintRecipient: string
    amount: bigint; messageSender: string; maxFee: bigint
    feeExecuted: bigint; expirationBlock: bigint; hookData: string
  }>): string => {
    const o = {
      version:        1,
      burnToken:      '0x3600000000000000000000000000000000000000',
      mintRecipient:  '0xaAbBcCdDeEfF0011223344556677889900aAbBcC',
      amount:         1000000n,
      messageSender:  '0xd75a607d9f99a35fadbfd3caf077918265ab59ab',
      maxFee:         55000n,
      feeExecuted:    53841n,
      expirationBlock: 99999999n,
      hookData:       '0000000000000000000000000000000000000000000000000000000000000000',
      ...overrides,
    }
    const pad32 = (v: string) => v.replace(/^0x/, '').toLowerCase().padStart(64, '0')
    const pad32n = (v: bigint) => v.toString(16).padStart(64, '0')
    const version4 = o.version.toString(16).padStart(8, '0')  // 4 bytes = 8 hex chars
    return (
      version4 +
      pad32(o.burnToken) +
      pad32(o.mintRecipient) +
      pad32n(o.amount) +
      pad32(o.messageSender) +
      pad32n(o.maxFee) +
      pad32n(o.feeExecuted) +
      pad32n(o.expirationBlock) +
      o.hookData
    )
  }

  void it('decodes correct packed body', async () => {
    const { decodeBurnMessageV2Body } = await import('../../worker/cctp-relay-do.js')
    const body = buildBody()
    const decoded = decodeBurnMessageV2Body(body)
    assert.ok(decoded !== null, 'decode should succeed')
    assert.equal(decoded!.burnToken, '0x3600000000000000000000000000000000000000')
    assert.equal(decoded!.mintRecipient, '0xaabbccddeeff0011223344556677889900aabbcc')
    assert.equal(decoded!.amount, 1000000n)
    assert.equal(decoded!.messageSender, '0xd75a607d9f99a35fadbfd3caf077918265ab59ab')
    assert.equal(decoded!.maxFee, 55000n)
    assert.equal(decoded!.feeExecuted, 53841n)
    assert.equal(decoded!.netAmount, 1000000n - 53841n)
  })

  void it('rejects body that is too short', async () => {
    const { decodeBurnMessageV2Body } = await import('../../worker/cctp-relay-do.js')
    assert.equal(decodeBurnMessageV2Body('aabbccdd'), null, 'too short')
  })

  void it('rejects feeExecuted > maxFee', async () => {
    const { decodeBurnMessageV2Body } = await import('../../worker/cctp-relay-do.js')
    const body = buildBody({ feeExecuted: 60000n, maxFee: 55000n })
    assert.equal(decodeBurnMessageV2Body(body), null, 'feeExecuted > maxFee should return null')
  })

  void it('rejects feeExecuted >= amount', async () => {
    const { decodeBurnMessageV2Body } = await import('../../worker/cctp-relay-do.js')
    const body = buildBody({ amount: 1000n, feeExecuted: 1000n, maxFee: 2000n })
    assert.equal(decodeBurnMessageV2Body(body), null, 'feeExecuted >= amount should return null')
  })
})

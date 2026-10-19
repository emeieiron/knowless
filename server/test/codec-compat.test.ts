// oxlint-disable no-floating-promises
/**
 * codec-compat.test.ts
 *
 * Proves that @noble/hashes produces byte-identical results to node:crypto
 * createHash('sha256') and createHmac('sha256', key) for all inputs used
 * by relay-codec.ts: makeIntentKey, deriveHmacSecret, signQuote/verifyQuote.
 *
 * Uses deterministic test fixtures only. No private keys, no live RPC.
 * Run: bun test server/test/codec-compat.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import {
  makeIntentKey,
  deriveHmacSecret,
  signQuote,
  verifyQuote,
  type QuotePayload,
} from '../relay-codec.js'

// ── Helpers matching relay-codec.ts ────────────────────────────────────────

function nodeSha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function nodeHmacSha256Base64(key: string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64')
}

function nobleSha256Hex(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)))
}

function nobleHmacSha256Base64(key: string, data: string): string {
  const raw = hmac(sha256, new TextEncoder().encode(key), new TextEncoder().encode(data))
  return btoa(String.fromCharCode(...raw))
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const SIGNER  = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const RECIP   = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
const AMOUNT  = '1000000'
const FEE     = '150000'
const FEE_REC = '0x9920873625f62bf226a021cc3014a01955b9f327'
const EXPIRY  = '1729296000'
const NONCE   = '0'
const SIG     = '0x' + 'ab'.repeat(32) + 'cd'.repeat(32) + '1b'

const HMAC_KEY_FIXTURE = 'fixture-hmac-secret-32bytes-padded'

// ── CC-C1: sha256 bit-identity ──────────────────────────────────────────────

void describe('CC-C1: sha256 bit-identity', () => {
  const inputs = [
    'intent-key:test',
    SIGNER + ':' + NONCE + ':' + RECIP + ':' + AMOUNT + ':' + FEE + ':' + FEE_REC + ':' + EXPIRY + ':' + SIG,
    '',
    'relay-hmac:' + '0x' + 'ac'.repeat(32),
    'utf8: caf\u00e9 \u4e2d\u6587',
  ]

  for (const input of inputs) {
    it(`sha256("${input.slice(0, 40)}...") matches`, () => {
      const node  = nodeSha256Hex(input)
      const noble = nobleSha256Hex(input)
      assert.equal(noble, node, `sha256 mismatch for input "${input.slice(0, 40)}"`)
    })
  }
})

// ── CC-C2: HMAC-SHA256 bit-identity ────────────────────────────────────────

void describe('CC-C2: HMAC-SHA256 bit-identity', () => {
  const cases: Array<{ key: string; data: string }> = [
    { key: HMAC_KEY_FIXTURE, data: 'payload:test' },
    { key: 'short', data: 'data' },
    { key: 'a'.repeat(64), data: 'exactly-one-block' },
    { key: 'k', data: '' },
    { key: HMAC_KEY_FIXTURE, data: '{"signerAddress":"0xf39f","quotedFee":"150000","feeRecipient":"0x992","quoteExpiry":1729296000,"issuedAt":1729209600}' },
  ]

  for (const { key, data } of cases) {
    it(`hmac(key="${key.slice(0, 12)}...", data="${data.slice(0, 30)}...")`, () => {
      const node  = nodeHmacSha256Base64(key, data)
      const noble = nobleHmacSha256Base64(key, data)
      assert.equal(noble, node, `HMAC mismatch`)
    })
  }
})

// ── CC-C3: makeIntentKey uses sha256 matching node:crypto ───────────────────

void describe('CC-C3: makeIntentKey matches node:crypto sha256', () => {
  it('intentKey equals node sha256 of canonical input', () => {
    const intentKey = makeIntentKey(SIGNER, NONCE, RECIP, AMOUNT, FEE, FEE_REC, EXPIRY, SIG)

    // relay-codec.ts intentKey = sha256 of fields joined by ":" — NO prefix
    const canonical = `${SIGNER}:${NONCE}:${RECIP}:${AMOUNT}:${FEE}:${FEE_REC}:${EXPIRY}:${SIG}`
    const expected  = nodeSha256Hex(canonical)

    assert.equal(intentKey, expected, 'makeIntentKey does not match node:crypto sha256')
  })

  it('different sig → different intentKey', () => {
    const k1 = makeIntentKey(SIGNER, NONCE, RECIP, AMOUNT, FEE, FEE_REC, EXPIRY, SIG)
    const k2 = makeIntentKey(SIGNER, NONCE, RECIP, AMOUNT, FEE, FEE_REC, EXPIRY, '0x' + 'ff'.repeat(65))
    assert.notEqual(k1, k2)
  })

  it('different nonce → different intentKey', () => {
    const k1 = makeIntentKey(SIGNER, '0', RECIP, AMOUNT, FEE, FEE_REC, EXPIRY, SIG)
    const k2 = makeIntentKey(SIGNER, '1', RECIP, AMOUNT, FEE, FEE_REC, EXPIRY, SIG)
    assert.notEqual(k1, k2)
  })

  it('mixed-case signer/recip/sig normalised to lowercase before hashing', () => {
    const sigUpper = SIG.toUpperCase().replace('0X', '0x')
    const k1 = makeIntentKey(SIGNER.toUpperCase(), NONCE, RECIP.toUpperCase(), AMOUNT, FEE, FEE_REC.toUpperCase(), EXPIRY, sigUpper)
    const k2 = makeIntentKey(SIGNER.toLowerCase(), NONCE, RECIP.toLowerCase(), AMOUNT, FEE, FEE_REC.toLowerCase(), EXPIRY, SIG.toLowerCase())
    assert.equal(k1, k2, 'mixed-case inputs must produce same intentKey as lowercase')
  })
})

// ── CC-C4: deriveHmacSecret matches node:crypto sha256 ─────────────────────

void describe('CC-C4: deriveHmacSecret matches node:crypto sha256', () => {
  const testKey = '0x' + 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

  it('deriveHmacSecret equals node sha256 of "spookly-relay-hmac-v1:<key>"', () => {
    const secret   = deriveHmacSecret(testKey as `0x${string}`)
    const expected = nodeSha256Hex(`spookly-relay-hmac-v1:${testKey}`)
    assert.equal(secret, expected)
  })
})

// ── CC-C5: signQuote/verifyQuote round-trip and token format ────────────────

void describe('CC-C5: quote HMAC token round-trip', () => {
  const payload: QuotePayload = {
    signerAddress: SIGNER,
    quotedFee:     FEE,
    feeRecipient:  FEE_REC,
    quoteExpiry:   1729296000,
    issuedAt:      1729209600,
  }

  it('signQuote produces base64(payload).hexHmac format', () => {
    const token = signQuote(payload, HMAC_KEY_FIXTURE)
    assert.ok(token.includes('.'), 'token must contain "."')
    const [b64Part, hexPart] = token.split('.')
    // b64Part decodes to JSON of payload
    const decoded = JSON.parse(atob(b64Part))
    assert.equal(decoded.signerAddress, payload.signerAddress)
    assert.equal(decoded.quotedFee, payload.quotedFee)
    // hexPart is hex HMAC
    assert.match(hexPart, /^[0-9a-f]{64}$/, 'HMAC part must be 64 hex chars (sha256)')
  })

  it('verifyQuote returns payload on valid token', () => {
    const token    = signQuote(payload, HMAC_KEY_FIXTURE)
    const verified = verifyQuote(token, HMAC_KEY_FIXTURE)
    assert.ok(verified, 'verifyQuote returned null on valid token')
    assert.equal(verified.signerAddress, payload.signerAddress)
    assert.equal(verified.quotedFee,     payload.quotedFee)
    assert.equal(verified.quoteExpiry,   payload.quoteExpiry)
  })

  it('verifyQuote returns null for tampered payload', () => {
    const token  = signQuote(payload, HMAC_KEY_FIXTURE)
    const parts  = token.split('.')
    // Corrupt the HMAC part
    const bad    = parts[0] + '.' + 'a'.repeat(64)
    assert.equal(verifyQuote(bad, HMAC_KEY_FIXTURE), null)
  })

  it('verifyQuote returns null for wrong key', () => {
    const token = signQuote(payload, HMAC_KEY_FIXTURE)
    assert.equal(verifyQuote(token, 'wrong-key'), null)
  })

  it('token HMAC matches node:crypto HMAC-SHA256 independently computed', () => {
    const token  = signQuote(payload, HMAC_KEY_FIXTURE)
    const [b64, hexHmac] = token.split('.')
    // signQuote HMACs over JSON.stringify(payload) — i.e. the raw JSON string
    // that becomes b64, not over b64 itself.
    const rawJson = atob(b64)
    const nodeHex = createHmac('sha256', HMAC_KEY_FIXTURE).update(rawJson, 'utf8').digest('hex')
    assert.equal(hexHmac, nodeHex, 'token HMAC does not match node:crypto HMAC-SHA256')
  })
})

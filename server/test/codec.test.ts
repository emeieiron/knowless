// oxlint-disable require-await
/**
 * codec.test.ts — round-trip tests for the PRODUCTION encodeLinkFragment /
 * decodeLinkFragment exports from src/lib/crypto.ts.
 *
 * Bun resolves TypeScript source files directly and provides native btoa/atob,
 * so no shims or inline reimplementations are needed.  The @/ alias is
 * configured in tsconfig.json; Bun honours it at runtime.
 *
 * Deterministic TEST-ONLY fixtures are used throughout.  No private key values
 * or link fragments are ever logged.
 *
 * CC1: encode → decode round-trip recovers signer address, contract, chainId
 * CC2: zero private key scalar → decodeLinkFragment returns null
 * CC3: negative chainId prefix → decodeLinkFragment returns null
 * CC4: mangled base64url characters → returns null without throwing
 * CC5: fragment decoded to a different (valid positive) chainId — mismatch is
 *      detectable by the caller; the codec itself does not restrict which
 *      chain IDs are "supported" (that is the app's responsibility)
 * CC6: trailing = character (standard base64, not base64url) → returns null
 * CC7: private key at curve order (>= SECP256K1_ORDER) → returns null
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Hex, Address } from 'viem'

// Import the REAL production exports — not copies or reimplementations.
// Bun resolves the @/ path alias from tsconfig.json compilerOptions.paths.
import { encodeLinkFragment, decodeLinkFragment } from '../../src/lib/crypto.js'

// ── Test fixtures ─────────────────────────────────────────────────────────────
// TEST-ONLY key — first hardhat/anvil account; controls no real funds.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const CONTRACT = '0xbe223821c0925e87cde1ca397fdce253a8ce7b22' as Address
const ARC_TESTNET_CHAIN_ID = 5042002
const SECP256K1_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n

void describe('Link Fragment Codec (production exports)', () => {

  void it('CC1: encode → decode round-trip recovers privateKey, contractAddress, chainId', () => {
    const fragment = encodeLinkFragment(TEST_KEY, CONTRACT, ARC_TESTNET_CHAIN_ID)

    // Fragment must be pure base64url — no +, /, or = characters
    assert.ok(!/[+/=]/.test(fragment), 'fragment must be base64url (no +/=)')

    const decoded = decodeLinkFragment(fragment)
    assert.ok(decoded !== null, 'valid fragment must decode successfully')
    assert.equal(decoded.privateKey.toLowerCase(), TEST_KEY.toLowerCase(), 'privateKey round-trips correctly')
    assert.equal(decoded.contractAddress.toLowerCase(), CONTRACT.toLowerCase(), 'contractAddress round-trips')
    assert.equal(decoded.chainId, ARC_TESTNET_CHAIN_ID, 'chainId round-trips correctly')
  })

  void it('CC2: zero private key scalar → decode returns null', () => {
    const ZERO_KEY = ('0x' + '00'.repeat(32)) as Hex
    const fragment = encodeLinkFragment(ZERO_KEY, CONTRACT, ARC_TESTNET_CHAIN_ID)
    const decoded = decodeLinkFragment(fragment)
    assert.equal(decoded, null, 'zero scalar key must be rejected')
  })

  void it('CC3: negative chainId prefix → decode returns null', () => {
    // Manually build a raw string with a negative chainId.
    // encodeLinkFragment uses btoa internally; we call it directly here to
    // construct an input that bypasses the encoder's own constraints.
    const raw = `-5042002:${CONTRACT}:${TEST_KEY}`
    const fragment = btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const decoded = decodeLinkFragment(fragment)
    assert.equal(decoded, null, 'negative chainId must be rejected')
  })

  void it('CC4: mangled base64url characters → returns null without throwing', () => {
    const fragment = 'abc!def~ghi'   // '!' and '~' are not valid base64url chars
    const decoded = decodeLinkFragment(fragment)
    assert.equal(decoded, null, 'mangled characters must be rejected without throw')
  })

  void it('CC5: fragment with a different (valid positive) chainId — mismatch detectable by caller', () => {
    // Encode with Ethereum mainnet chainId (1).  The codec accepts any positive
    // integer; the app layer is responsible for rejecting unsupported chains.
    const fragment = encodeLinkFragment(TEST_KEY, CONTRACT, 1)
    const decoded = decodeLinkFragment(fragment)
    assert.ok(decoded !== null, 'valid fragment with a different chainId must decode without error')
    assert.notEqual(decoded.chainId, ARC_TESTNET_CHAIN_ID, 'chainId mismatch is detectable by the caller')
    assert.equal(decoded.chainId, 1, 'decoded chainId matches what was encoded')
  })

  void it('CC6: fragment containing "=" (standard base64 padding) → returns null', () => {
    // Construct a raw string whose standard base64 form has trailing "=" padding.
    // A 1-byte input always produces a 2-char base64 with "==" padding — exactly
    // what we need to guarantee the "=" is present regardless of platform.
    const rawOneByte = 'A'                          // 1-byte input → base64 = "QQ==" (always has =)
    const b64WithPadding = btoa(rawOneByte)         // "QQ=="
    assert.ok(b64WithPadding.includes('='), 'test fixture must have = padding (codec invariant)')

    // decodeLinkFragment must reject a string containing "=" (not base64url)
    const decoded = decodeLinkFragment(b64WithPadding)
    assert.equal(decoded, null, 'fragment with = padding must be rejected (not valid base64url)')
  })

  void it('CC7: private key at curve order (>= SECP256K1_ORDER) → returns null', () => {
    const orderHex = ('0x' + SECP256K1_ORDER.toString(16)) as Hex
    const fragment = encodeLinkFragment(orderHex, CONTRACT, ARC_TESTNET_CHAIN_ID)
    const decoded = decodeLinkFragment(fragment)
    assert.equal(decoded, null, 'key at curve order must be rejected')
  })

})

// oxlint-disable no-floating-promises
/**
 * health-smoke.mjs — Production Wrangler bundle + Miniflare smoke tests
 *
 * S1  GET /relay/health  → 200 ok:true available:true
 * S2  GET /relay/quote   → 200 with quoteToken/fee (strict RPC fixture)
 * S3  POST /relay        → 202; SQL row observed INSIDE eth_sendRawTransaction BEFORE ACK;
 *                          rawTx and txHash=keccak256(rawTx) asserted in handler
 * S4  POST /relay again  → 202 exact same txHash (idempotent)
 * S5  Restart same disk + changed nonce/gas → same txHash, exact-byte replay
 * S6  Changed contract → same DO (chain+relayAddr namespace), fingerprint fails → 503 everywhere
 * S7  GET /relay/unknown → 404 no-store
 * S8  OPTIONS /relay     → 204 CORS preflight
 *
 * SQL observation uses node:sqlite DatabaseSync on the raw persist dir filesystem —
 * no test/admin route added to the production Worker or DO.
 * The mock eth_sendRawTransaction handler reads SQLite BEFORE replying to the Worker,
 * proving the row was written before any external ACK.
 *
 * Uses unfunded Foundry fixture key only. Strict RPC fixture rejects unknown selectors.
 * No live RPC fallback, no funded key, no on-chain transactions.
 *
 * Usage: bun run smoke:worker  (builds bundle, copies, runs, preserves exit code, cleans up)
 */

import assert               from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir }           from 'node:os'
import { createServer }     from 'node:http'
import { resolve, dirname } from 'node:path'
import { fileURLToPath }    from 'node:url'
import { DatabaseSync }     from 'node:sqlite'
import { Miniflare }        from 'miniflare'
import { keccak256 }        from 'viem'

const __dir = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(__dir, '../../_smoke-bundle.js')

if (!existsSync(BUNDLE)) {
  process.stderr.write(`Bundle not found: ${BUNDLE}\n`)
  process.stderr.write('Run: bun run smoke:worker\n')
  process.exit(1)
}

// ── Unfunded Foundry fixture constants ────────────────────────────────────────
const DEV_KEY     = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const RELAY_ADDR  = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' // address(DEV_KEY)
const SIGNER_ADDR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' // acct[1]
const RECIPIENT   = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc' // acct[2]
const CONTRACT    = '0xbe223821c0925e87cde1ca397fdce253a8ce7b22'
const CHAIN_ID    = 5042002

// ── Verified ABI selectors (keccak256 of function sig, first 4 bytes) ────────
// getLinkInfo(address)                                               0x0e19fe42
// usedNonces(address,uint256)                                        0x6a8a6894
// executePayment(address,address,uint128,uint128,address,uint64,uint256,bytes) 0x72cfac07
const SEL_LINK_INFO    = '0x0e19fe42'
const SEL_USED_NONCES  = '0x6a8a6894'
const SEL_EXEC_PAYMENT = '0x72cfac07'

// ── Payment fixture ───────────────────────────────────────────────────────────
const AMOUNT = 1_000_000n       // 1.00 USDC
const FEE    = 150_000n         // 0.15 USDC — must cover gas + margin
const NONCE  = 0n
const SIG    = '0x' + 'ab'.repeat(32) + 'cd'.repeat(32) + '1b'  // 65-byte EIP-712 stub

// ── node:sqlite filesystem scanner ───────────────────────────────────────────
// Recursively scans a directory (depth ≤ 4) for .sqlite files that contain
// relay_journal. Returns all matching file paths.
// Never follows symlinks; never touches the live funded relay dir.
function findJournalFiles(dir, depth = 4) {
  if (depth === 0) return []
  const found = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    const fp = `${dir}/${e.name}`
    if (e.isDirectory()) {
      found.push(...findJournalFiles(fp, depth - 1))
    } else if (e.isFile()) {
      // Try opening as SQLite to check for relay_journal table
      let db
      try {
        db = new DatabaseSync(fp, { readOnly: true, timeout: 2000 })
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='relay_journal'"
        ).get()
        if (row) found.push(fp)
      } catch { /* not a SQLite file or incompatible */ } finally {
        try { db?.close() } catch {}
      }
    }
  }
  return found
}

// Read all relay_journal rows from the first matching SQLite file in persist dir.
// Throws if no file found. Called SYNCHRONOUSLY inside the mock RPC handler.
function readJournalRowsSync(persistDir) {
  const files = findJournalFiles(persistDir)
  if (files.length === 0)
    throw new Error(`No relay_journal SQLite file found in ${persistDir}`)
  const file = files[0]
  const db = new DatabaseSync(file, { readOnly: true, timeout: 3000 })
  try {
    const rows = db.prepare(
      `SELECT intentKey, relayKey, signerAddress, relayNonce,
              rawTx, txHash, status, chainId, contractAddress
       FROM relay_journal ORDER BY rowid ASC`
    ).all()
    return rows
  } finally {
    db.close()
  }
}

// ── Mock RPC state ────────────────────────────────────────────────────────────
// Mutable; changed between S4→S5 to prove exact-byte replay.
const mockState = { nonce: 0, gasPrice: 20_000_000_000n }

// capturedRawTx: set by mock on eth_sendRawTransaction; reset between tests
let capturedRawTx = null

// sqlObservation: result captured INSIDE eth_sendRawTransaction BEFORE reply
let sqlObservation = null  // { rows, assertError } — set on every broadcast

function makeMockRpc(persistDir) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      let rpc
      try { rpc = JSON.parse(body) } catch {
        res.writeHead(400); res.end('{}'); return
      }
      const reply = (result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
      }
      const rpcErr = (msg) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: rpc.id,
          error: { code: -32600, message: msg },
        }))
      }

      const m = rpc.method

      if (m === 'eth_chainId')
        return reply('0x' + CHAIN_ID.toString(16))

      if (m === 'eth_gasPrice')
        return reply('0x' + mockState.gasPrice.toString(16))

      if (m === 'eth_getTransactionCount')
        return reply('0x' + mockState.nonce.toString(16))

      if (m === 'eth_call') {
        const data = (rpc.params?.[0]?.data ?? '').toLowerCase()
        const sel  = data.slice(0, 10)

        if (sel === SEL_LINK_INFO) {
          const issuer     = SIGNER_ADDR.toLowerCase().slice(2).padStart(64, '0')
          const balance    = AMOUNT.toString(16).padStart(64, '0')
          const feeBal     = (FEE + 50_000n).toString(16).padStart(64, '0')
          const expiry     = (BigInt(Math.floor(Date.now() / 1000)) + 3600n).toString(16).padStart(64, '0')
          const active     = '0'.repeat(63) + '1'
          return reply('0x' + issuer + balance + feeBal + expiry + active)
        }

        if (sel === SEL_USED_NONCES)
          return reply('0x' + '0'.padStart(64, '0'))

        if (sel === SEL_EXEC_PAYMENT)
          return reply('0x')  // simulation success

        // Any other selector is unknown — reject explicitly
        return rpcErr(`Unknown eth_call selector: ${sel}`)
      }

      if (m === 'eth_sendRawTransaction') {
        const raw = rpc.params?.[0] ?? null
        capturedRawTx = raw

        // ── SQL observation BEFORE ACK ──────────────────────────────────────
        // The DO writes rawTx/txHash/status=pending to SQLite BEFORE calling
        // eth_sendRawTransaction. We are synchronously inside that call here —
        // before we reply, we read the filesystem to verify the row exists.
        let obsError = null
        let obsRows  = null
        try {
          obsRows = readJournalRowsSync(persistDir)
        } catch (e) {
          obsError = `readJournalRowsSync failed: ${e.message}`
        }

        // Save observation for the test case to inspect
        sqlObservation = { rows: obsRows, assertError: obsError }

        if (obsError) {
          // Observation failed — return an RPC error so the test fails nonzero
          return rpcErr(obsError)
        }

        // Return keccak256(rawTx) — must match what the DO derived from the same bytes
        const txHash = keccak256(raw)
        return reply(txHash)
      }

      if (m === 'eth_getTransactionReceipt')
        return reply(null)  // pending — do not confirm

      return rpcErr(`Unknown RPC method: ${m}`)
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0
let failed = 0
const results = []

async function test(name, fn) {
  try {
    await fn()
    passed++
    results.push(`  ✓  ${name}`)
  } catch (e) {
    failed++
    results.push(`  ✗  ${name}\n     ${e.message}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const persist = mkdtempSync(`${tmpdir()}/knowless-smoke-`)
let mf  = null
let rpc = null

try {
  const { server, url: rpcUrl } = await makeMockRpc(persist)
  rpc = server

  // Miniflare config — production bundle, SQLite DO, real persist dir
  const MF_CONFIG = {
    scriptPath:            BUNDLE,
    modules:               true,
    compatibilityDate:     '2026-08-04',
    compatibilityFlags:    ['nodejs_compat'],
    durableObjects: {
      RELAY_DO: { className: 'RelayDO', useSQLite: true },
    },
    durableObjectsPersist: persist,
    bindings: {
      RELAY_CHAIN_ID:         String(CHAIN_ID),
      RELAY_CONTRACT_ADDRESS: CONTRACT,
      RELAY_PRIVATE_KEY:      DEV_KEY,
      RELAY_MAX_FEE_USDC:     '200000',
      RELAY_FEE_MARGIN_USDC:  '50000',
      RELAY_QUOTE_TTL_S:      '300',
      RELAY_RPC_URL:          rpcUrl,
      ALLOWED_ORIGIN:         'http://localhost:5173',
    },
  }

  mf = new Miniflare(MF_CONFIG)
  await mf.ready
  console.log('mf.ready ✓')

  // ── S1: Health ──────────────────────────────────────────────────────────────
  await test('S1: GET /relay/health → 200 ok:true available:true', async () => {
    const res  = await mf.dispatchFetch('http://fake/relay/health')
    const body = await res.json()
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(body)}`)
    assert.equal(body.ok,        true,  'ok must be true')
    assert.equal(body.available, true,  'available must be true')
    assert.equal(body.relayWallet.toLowerCase(), RELAY_ADDR, 'relayWallet mismatch')
    console.log(`    health: chainId=${body.chainId} available=${body.available} relayWallet=${body.relayWallet}`)
  })

  // ── S8: OPTIONS preflight ───────────────────────────────────────────────────
  await test('S8: OPTIONS /relay → 204 CORS preflight', async () => {
    const res = await mf.dispatchFetch('http://fake/relay', {
      method:  'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })

  // ── S7: 404 ─────────────────────────────────────────────────────────────────
  await test('S7: GET /relay/unknown → 404 no-store', async () => {
    const res = await mf.dispatchFetch('http://fake/relay/unknown')
    assert.equal(res.status, 404)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })

  // ── S2: Quote ───────────────────────────────────────────────────────────────
  let quoteToken, quotedFee, quoteExpiry
  await test('S2: GET /relay/quote → 200 with quoteToken', async () => {
    const res  = await mf.dispatchFetch(
      `http://fake/relay/quote?signerAddress=${SIGNER_ADDR}`
    )
    const body = await res.json()
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(body)}`)
    assert.ok(body.quoteToken,  'missing quoteToken')
    assert.ok(body.quotedFee,   'missing quotedFee')
    assert.ok(body.quoteExpiry, 'missing quoteExpiry')
    assert.equal(body.feeRecipient.toLowerCase(), RELAY_ADDR, 'feeRecipient mismatch')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    quoteToken  = body.quoteToken
    quotedFee   = body.quotedFee
    quoteExpiry = body.quoteExpiry
    console.log(`    quote: fee=${quotedFee} expiry=${quoteExpiry}`)
  })

  assert.ok(quoteToken, 'S2 failed — aborting S3+')

  // ── S3: POST — SQL-before-ACK observation ───────────────────────────────────
  let firstTxHash
  capturedRawTx  = null
  sqlObservation = null

  await test('S3: POST /relay → 202; SQL row verified inside sendRawTransaction before ACK', async () => {
    const body = {
      signerAddress: SIGNER_ADDR,
      recipient:     RECIPIENT,
      amount:        AMOUNT.toString(),
      fee:           quotedFee,
      feeRecipient:  RELAY_ADDR,
      quoteExpiry:   BigInt(quoteExpiry).toString(),
      nonce:         NONCE.toString(),
      sig:           SIG,
      chainId:       CHAIN_ID,
      quoteToken,
    }

    const res  = await mf.dispatchFetch('http://fake/relay', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
    const resp = await res.json()
    assert.equal(res.status, 202, `Expected 202 got ${res.status}: ${JSON.stringify(resp)}`)
    assert.ok(resp.txHash, 'missing txHash in 202 response')
    assert.match(resp.txHash, /^0x[0-9a-f]{64}$/, 'txHash format')
    firstTxHash = resp.txHash

    // eth_sendRawTransaction must have been called
    assert.ok(capturedRawTx, 'eth_sendRawTransaction was never called')

    // SQL observation (captured synchronously BEFORE broadcast ACK)
    assert.ok(sqlObservation, 'sqlObservation not set — handler did not fire')
    if (sqlObservation.assertError)
      throw new Error(`SQL pre-ACK observation failed: ${sqlObservation.assertError}`)

    const rows = sqlObservation.rows
    assert.ok(rows && rows.length > 0, 'No SQL rows found before broadcast ACK')
    const row = rows[rows.length - 1]   // last inserted row

    assert.ok(row.rawTx,  'rawTx not persisted before broadcast ACK')
    assert.ok(row.txHash, 'txHash not persisted before broadcast ACK')
    // status is 'pending' at this point (broadcast is in-flight/not yet ACKed)
    assert.equal(row.status, 'pending',
      `Expected status=pending before ACK, got ${row.status}`)

    // keccak256(rawTx) === persisted txHash
    const derived = keccak256(row.rawTx)
    assert.equal(row.txHash, derived,     'persisted txHash ≠ keccak256(rawTx)')
    assert.equal(resp.txHash, derived,    'response txHash ≠ keccak256(rawTx)')

    // Broadcast bytes match persisted rawTx exactly
    assert.equal(
      capturedRawTx.toLowerCase(),
      row.rawTx.toLowerCase(),
      'Broadcast bytes differ from persisted rawTx'
    )

    console.log(`    txHash: ${firstTxHash.slice(0, 18)}...`)
    console.log(`    SQL row status before ACK: ${row.status}`)
    console.log(`    keccak256(rawTx) match: ✓`)
  })

  assert.ok(firstTxHash, 'S3 failed — aborting S4+')

  // ── S4: Idempotent retry ────────────────────────────────────────────────────
  await test('S4: POST /relay (same intent) → 202 exact same txHash', async () => {
    const res  = await mf.dispatchFetch('http://fake/relay', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        signerAddress: SIGNER_ADDR, recipient: RECIPIENT,
        amount: AMOUNT.toString(), fee: quotedFee,
        feeRecipient: RELAY_ADDR,
        quoteExpiry: BigInt(quoteExpiry).toString(),
        nonce: NONCE.toString(), sig: SIG, chainId: CHAIN_ID, quoteToken,
      }),
    })
    const resp = await res.json()
    assert.equal(res.status, 202, `Expected 202 got ${res.status}`)
    assert.equal(resp.txHash, firstTxHash, 'Idempotent retry returned different txHash')
  })

  // ── S5: Restart + exact-byte replay ─────────────────────────────────────────
  await test('S5: restart + changed nonce/gas → same txHash, exact-byte replay', async () => {
    await mf.dispose()
    mf = null

    // Change mock: a fresh sign would produce different bytes
    mockState.nonce    = 99
    mockState.gasPrice = 40_000_000_000n

    // Recreate with the same persist dir
    mf = new Miniflare({ ...MF_CONFIG, durableObjectsPersist: persist })
    await mf.ready

    // Health must be available with the persisted row loaded
    const hRes  = await mf.dispatchFetch('http://fake/relay/health')
    const hBody = await hRes.json()
    assert.equal(hRes.status, 200)
    assert.equal(hBody.available, true, `available must be true after restart`)
    assert.equal(hBody.queueDepth, 1,   `Expected queueDepth=1 after restart, got ${hBody.queueDepth}`)
    console.log(`    restart: available=${hBody.available} queueDepth=${hBody.queueDepth}`)

    // Read SQL directly to confirm rawTx survived restart
    const rowsAfterRestart = readJournalRowsSync(persist)
    assert.equal(rowsAfterRestart.length, 1, 'Expected 1 SQL row after restart')
    const rowAfterRestart = rowsAfterRestart[0]
    assert.ok(rowAfterRestart.rawTx, 'rawTx must survive Miniflare restart')

    // Reset capture; retry the same intent
    capturedRawTx  = null
    sqlObservation = null

    const retryRes  = await mf.dispatchFetch('http://fake/relay', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        signerAddress: SIGNER_ADDR, recipient: RECIPIENT,
        amount: AMOUNT.toString(), fee: quotedFee,
        feeRecipient: RELAY_ADDR,
        quoteExpiry: BigInt(quoteExpiry).toString(),
        nonce: NONCE.toString(), sig: SIG, chainId: CHAIN_ID, quoteToken,
      }),
    })
    const retryBody = await retryRes.json()
    assert.equal(retryRes.status, 202, `Expected 202 got ${retryRes.status}: ${JSON.stringify(retryBody)}`)
    assert.equal(retryBody.txHash, firstTxHash,
      'Retry after restart returned different txHash — re-signed instead of replaying exact bytes')

    // eth_sendRawTransaction must have been called (replay re-broadcasts)
    assert.ok(capturedRawTx, 'eth_sendRawTransaction not called on retry')

    // Exact-byte match: broadcast == persisted rawTx (unchanged through restart)
    assert.equal(
      capturedRawTx.toLowerCase(),
      rowAfterRestart.rawTx.toLowerCase(),
      'Re-broadcast bytes differ from persisted rawTx — not exact-byte replay'
    )
    console.log(`    exact-byte replay: ✓ (rawTx unchanged through restart, nonce=99 gas×2 ignored)`)
  })

  // ── S6: Config mismatch (changed contract) → fingerprint fail → 503 ─────────
  await test('S6: changed contract → same DO namespace, fingerprint fails → 503 everywhere, 0 broadcasts', async () => {
    await mf.dispose()
    mf = null

    const WRONG_CONTRACT = '0x' + '42'.repeat(20)  // different from real CONTRACT
    capturedRawTx = null  // reset so we can assert 0 broadcasts

    const mf6 = new Miniflare({
      ...MF_CONFIG,
      bindings: { ...MF_CONFIG.bindings, RELAY_CONTRACT_ADDRESS: WRONG_CONTRACT },
      durableObjectsPersist: persist,  // same disk → same DO object
    })
    try {
      await mf6.ready

      const h = await mf6.dispatchFetch('http://fake/relay/health')
      assert.equal(h.status, 503, `health: expected 503 got ${h.status}`)
      assert.equal(h.headers.get('cache-control'), 'no-store', 'health must be no-store')

      const q = await mf6.dispatchFetch(
        `http://fake/relay/quote?signerAddress=${SIGNER_ADDR}`)
      assert.equal(q.status, 503, `quote: expected 503 got ${q.status}`)
      assert.equal(q.headers.get('cache-control'), 'no-store')

      const p = await mf6.dispatchFetch('http://fake/relay', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          signerAddress: SIGNER_ADDR, recipient: RECIPIENT,
          amount: AMOUNT.toString(), fee: quotedFee,
          feeRecipient: RELAY_ADDR,
          quoteExpiry:  BigInt(quoteExpiry).toString(),
          nonce:        NONCE.toString(), sig: SIG, chainId: CHAIN_ID, quoteToken,
        }),
      })
      assert.equal(p.status, 503, `POST: expected 503 got ${p.status}`)
      assert.equal(p.headers.get('cache-control'), 'no-store')

      assert.equal(capturedRawTx, null,
        'eth_sendRawTransaction must not be called when fingerprint mismatches')

      console.log(`    mismatch: health=${h.status} quote=${q.status} post=${p.status} broadcasts=0`)
    } finally {
      try { await mf6.dispose() } catch {}
    }
  })

} finally {
  if (mf) { try { await mf.dispose() } catch {} }
  if (rpc) rpc.close()
  // Clean up test persist dir only — never touch the live relay dir
  try { rmSync(persist, { recursive: true, force: true }) } catch {}

  console.log('\n── Smoke results ──────────────────────────────────────────')
  for (const r of results) console.log(r)
  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

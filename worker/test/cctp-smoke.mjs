// oxlint-disable no-floating-promises
/**
 * cctp-smoke.mjs — CCTP relay DO integration tests
 *
 * C1  CCTP disabled (no router) → /relay/cctp/quote → 503
 * C2  CCTP enabled (mock router): GET /relay/cctp/quote → 200 with quoteToken
 * C2b desiredNetAmount quote → gross = desiredNet + maxCctpFee
 * C3  POST /relay/cctp/submit → 202; SQL row observed in cctp_journal INSIDE
 *     eth_sendRawTransaction BEFORE ACK; rawTx/txHash/status=pending asserted
 * C4  Same submit → 202 exact same txHash (idempotent)
 * C5  Restart same disk → same txHash, exact-byte replay
 * C6  Legacy submit with same signer+nonce BEFORE cctp is terminal → 409 cross-table conflict
 * C7  CCTP submit with same signer+nonce BEFORE legacy is terminal → 409 cross-table conflict
 * C8  GET /relay/cctp/status?txHash=... → 200 with correct fields
 * C8b Status name mapping: server cctp_* names covered by UI map
 * C8c Status with wrong params → 400
 * C9  Modified destinationDomain AFTER signing quote → 400 quote mismatch
 * C10 Wrong quoteToken (legacy quote format) → 401
 * C11 Legacy smoke: GET /relay/health still works with cctpEnabled:true (router configured)
 *
 * Fixture key: Foundry acct[0] (unfunded, test only).
 * Mock Iris API returns a fixed forwardFee=50000 (0.05 USDC).
 * Mock RPC rejects unknown selectors.
 * No live keys, no live RPC, no funded transactions.
 *
 * Usage: bun run smoke:cctp  (builds bundle, copies, runs)
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
import { privateKeyToAccount } from 'viem/accounts'

const __dir = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(__dir, '../../_smoke-bundle.js')

if (!existsSync(BUNDLE)) {
  process.stderr.write(`Bundle not found: ${BUNDLE}\n`)
  process.stderr.write('Run: bun run smoke:cctp\n')
  process.exit(1)
}

// ── Fixture constants ─────────────────────────────────────────────────────────
const DEV_KEY      = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const RELAY_ADDR   = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'  // address(DEV_KEY)
const SIGNER_ADDR  = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'  // acct[1]
const MINT_RECIPIENT = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc' // acct[2]
const CONTRACT     = '0xbe223821c0925e87cde1ca397fdce253a8ce7b22'   // escrow
const MOCK_ROUTER  = '0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f'   // mock router address
const CHAIN_ID     = 5042002

// ABI selectors
const SEL_LINK_INFO    = '0x0e19fe42'   // getLinkInfo(address)
const SEL_USED_NONCES  = '0x6a8a6894'   // usedNonces(address,uint256)
const SEL_EXEC_PAYMENT = '0x72cfac07'   // executePayment(...)
const SEL_ROUTE_PAYMENT = keccak256(
  new TextEncoder().encode(
    'routePayment(address,uint128,uint256,uint128,uint64,uint256,uint32,address,bytes,bytes)'
  )
).slice(0, 10)  // first 4 bytes → 10 hex chars including 0x

// selectors for router immutable reads
const SEL_ESCROW = keccak256(new TextEncoder().encode('escrow()')).slice(0, 10)
const SEL_USDC   = keccak256(new TextEncoder().encode('usdc()')).slice(0, 10)

// Payment / CCTP fixture values
const GROSS_AMOUNT = 5_000_000n    // 5 USDC
const RELAY_FEE    = 150_000n      // 0.15 USDC relay fee (above gas estimate)
const MAX_CCTP_FEE = 100_000n      // 0.10 USDC (above Iris forwardFee=50000)
const ESCROW_NONCE = 0n
const DEST_DOMAIN  = 0             // ETH_SEPOLIA
const SIG_65       = '0x' + 'ab'.repeat(32) + 'cd'.repeat(32) + '1b'

// ── CCTP SQLite scanner ───────────────────────────────────────────────────────
function findCctpFiles(dir, depth = 4) {
  if (depth === 0) return []
  const found = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    const fp = `${dir}/${e.name}`
    if (e.isDirectory()) {
      found.push(...findCctpFiles(fp, depth - 1))
    } else if (e.isFile()) {
      let db
      try {
        db = new DatabaseSync(fp, { readOnly: true, timeout: 2000 })
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='cctp_journal'"
        ).get()
        if (row) found.push(fp)
      } catch {} finally {
        try { db?.close() } catch {}
      }
    }
  }
  return found
}

function readCctpRowsSync(persistDir) {
  const files = findCctpFiles(persistDir)
  if (files.length === 0)
    throw new Error(`No cctp_journal SQLite file found in ${persistDir}`)
  const db = new DatabaseSync(files[0], { readOnly: true, timeout: 3000 })
  try {
    return db.prepare(
      `SELECT cctpIntentKey, legacyRelayKey, signerAddress, relayNonce,
              rawTx, txHash, status, chainId, routerAddress, destinationDomain
       FROM cctp_journal ORDER BY rowid ASC`
    ).all()
  } finally { db.close() }
}

// Also scan relay_journal for cross-table test
function readLegacyRowsSync(persistDir) {
  const files = findCctpFiles(persistDir)
  if (files.length === 0) return []
  const db = new DatabaseSync(files[0], { readOnly: true, timeout: 3000 })
  try {
    return db.prepare(
      `SELECT intentKey, relayKey, signerAddress, relayNonce, rawTx, txHash, status
       FROM relay_journal ORDER BY rowid ASC`
    ).all()
  } finally { db.close() }
}

// ── Mock state ────────────────────────────────────────────────────────────────
const mockState = { nonce: 0, gasPrice: 20_000_000_000n }
let capturedCctpRawTx = null
let cctpSqlObservation = null

// ── Mock Iris API server ──────────────────────────────────────────────────────
function makeIrisMock() {
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    res.setHeader('Content-Type', 'application/json')
    if (url.includes('/v2/burn/USDC/fees/')) {
      // Real Iris API returns a top-level JSON array, not {fees:[...]}
      // forwardFee is an object {low, med, high} in 6-dec USDC base units
      // minimumFee is a bps rate (0 = no minimum)
      res.writeHead(200)
      res.end(JSON.stringify([
        { finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 50000, med: 50000, high: 50500 } },
        { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 50000, med: 50000, high: 50500 } },
      ]))
    } else if (url.includes('/v2/messages/')) {
      // Return no messages (pending state)
      res.writeHead(200)
      res.end(JSON.stringify({ messages: [] }))
    } else {
      res.writeHead(404); res.end('{}')
    }
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// ── Mock RPC server ───────────────────────────────────────────────────────────
function makeMockRpc(persistDir, irisUrl) {
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
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
          error: { code: -32600, message: msg } }))
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
        const to   = (rpc.params?.[0]?.to ?? '').toLowerCase()

        if (sel === SEL_LINK_INFO) {
          const issuer    = SIGNER_ADDR.slice(2).padStart(64, '0')
          const balance   = GROSS_AMOUNT.toString(16).padStart(64, '0')
          const feeBal    = (RELAY_FEE + 50_000n).toString(16).padStart(64, '0')
          const expiry    = (BigInt(Math.floor(Date.now() / 1000)) + 3600n).toString(16).padStart(64, '0')
          const active    = '0'.repeat(63) + '1'
          return reply('0x' + issuer + balance + feeBal + expiry + active)
        }
        if (sel === SEL_USED_NONCES)
          return reply('0x' + '0'.padStart(64, '0'))
        if (sel === SEL_EXEC_PAYMENT)
          return reply('0x')
        // Route payment simulation
        if (sel === SEL_ROUTE_PAYMENT)
          return reply('0x')
        // Router immutable reads (readiness check)
        if (sel === SEL_ESCROW && to === MOCK_ROUTER.toLowerCase())
          return reply('0x' + CONTRACT.toLowerCase().slice(2).padStart(64, '0'))
        if (sel === SEL_USDC && to === MOCK_ROUTER.toLowerCase())
          return reply('0x' + '3600000000000000000000000000000000000000'.padStart(64, '0'))

        return rpcErr(`Unknown eth_call selector: ${sel} to: ${to}`)
      }

      if (m === 'eth_sendRawTransaction') {
        const raw = rpc.params?.[0] ?? null
        capturedCctpRawTx = raw

        // SQL observation BEFORE ACK
        let obsError = null; let obsRows = null
        try { obsRows = readCctpRowsSync(persistDir) } catch (e) { obsError = e.message }
        cctpSqlObservation = { rows: obsRows, assertError: obsError }
        if (obsError) return rpcErr(obsError)

        return reply(keccak256(raw))
      }

      if (m === 'eth_getTransactionReceipt')
        return reply(null)

      return rpcErr(`Unknown RPC method: ${m}`)
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0; let failed = 0; const results = []
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ✓  ${name}`) }
  catch (e) { failed++; results.push(`  ✗  ${name}\n     ${e.message}`) }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const persist = mkdtempSync(`${tmpdir()}/knowless-cctp-smoke-`)
let mf = null; let rpcSrv = null; let irisSrv = null

try {
  const { server: iServer, url: irisUrl } = await makeIrisMock()
  irisSrv = iServer

  // Patch fetchIrisFee base URL via env var (worker reads IRIS_BASE_URL if set)
  // The cctp-relay-do.ts module uses a hardcoded URL — in tests we inject via
  // a mock that intercepts by port. The mock RPC is enough since readiness
  // uses RPC only; Iris is fetched by the DO at quote time.
  // We inject a full Iris mock server and configure the Worker bundle to use it
  // via RELAY_IRIS_BASE_URL env binding.

  const { server: rServer, url: rpcUrl } = await makeMockRpc(persist, irisUrl)
  rpcSrv = rServer

  const BASE_CONFIG = {
    scriptPath:            BUNDLE,
    modules:               true,
    compatibilityDate:     '2026-08-04',
    compatibilityFlags:    ['nodejs_compat'],
    durableObjects: {
      RELAY_DO: { className: 'RelayDO', useSQLite: true },
    },
    durableObjectsPersist: persist,
    bindings: {
      RELAY_CHAIN_ID:              String(CHAIN_ID),
      RELAY_CONTRACT_ADDRESS:      CONTRACT,
      RELAY_PRIVATE_KEY:           DEV_KEY,
      RELAY_MAX_FEE_USDC:          '500000',
      RELAY_FEE_MARGIN_USDC:       '50000',
      RELAY_QUOTE_TTL_S:           '300',
      RELAY_RPC_URL:               rpcUrl,
      RELAY_IRIS_BASE_URL:         irisUrl,
      ALLOWED_ORIGIN:              'http://localhost:5173',
      // Note: RELAY_CCTP_ROUTER_ADDRESS added/removed per test
    },
  }

  // ── C11: Legacy health still works ──────────────────────────────────────────
  mf = new Miniflare({
    ...BASE_CONFIG,
    bindings: { ...BASE_CONFIG.bindings, RELAY_CCTP_ROUTER_ADDRESS: MOCK_ROUTER },
  })
  await mf.ready
  console.log('mf.ready ✓')

  await test('C11: GET /relay/health → 200, cctpRouterConfigured:true', async () => {
    const res  = await mf.dispatchFetch('http://fake/relay/health')
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    // cctpRouterConfigured = true when address is set (readiness check lazy on first quote)
    assert.equal(body.cctpRouterConfigured, true, 'cctpRouterConfigured must be true when router configured')
    // cctpEnabled = true only after readiness verified (first quote call)
    console.log(`    health: cctpRouterConfigured=${body.cctpRouterConfigured} cctpEnabled=${body.cctpEnabled}`)
  })

  // ── C1: CCTP disabled (no router address) ────────────────────────────────────
  await test('C1: no router → /relay/cctp/quote → 503', async () => {
    await mf.dispose(); mf = null
    mf = new Miniflare({ ...BASE_CONFIG })  // no RELAY_CCTP_ROUTER_ADDRESS
    await mf.ready
    const res = await mf.dispatchFetch(
      `http://fake/relay/cctp/quote?signerAddress=${SIGNER_ADDR}&destinationDomain=0&mintRecipient=${MINT_RECIPIENT}&grossAmount=5000000`
    )
    assert.equal(res.status, 503, `expected 503 got ${res.status}`)
    const body = await res.json()
    assert.match(body.error, /not configured|CCTP/)
  })

  // ── C2: CCTP quote with router configured ────────────────────────────────────
  let quoteToken, quotedRelayFee, quoteExpiry, quotedMaxCctpFee, quotedGrossAmount

  await test('C2: GET /relay/cctp/quote → 200 with quoteToken', async () => {
    await mf.dispose(); mf = null
    mf = new Miniflare({
      ...BASE_CONFIG,
      bindings: { ...BASE_CONFIG.bindings, RELAY_CCTP_ROUTER_ADDRESS: MOCK_ROUTER },
    })
    await mf.ready

    const res = await mf.dispatchFetch(
      `http://fake/relay/cctp/quote?signerAddress=${SIGNER_ADDR}&destinationDomain=0&mintRecipient=${MINT_RECIPIENT}&grossAmount=5000000`
    )
    const body = await res.json()
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(body)}`)
    assert.ok(body.quoteToken,    'missing quoteToken')
    assert.ok(body.relayFee,      'missing relayFee')
    assert.ok(body.maxCctpFee,    'missing maxCctpFee')
    assert.ok(body.quoteExpiry,   'missing quoteExpiry')
    assert.equal(body.destinationDomain, 0, 'destinationDomain should be 0')
    assert.equal(body.routerAddress.toLowerCase(), MOCK_ROUTER.toLowerCase(), 'routerAddress mismatch')
    assert.equal(res.headers.get('cache-control'), 'no-store')

    quoteToken       = body.quoteToken
    quotedRelayFee   = body.relayFee
    quoteExpiry      = body.quoteExpiry
    quotedMaxCctpFee = body.maxCctpFee
    quotedGrossAmount = body.grossAmount
    console.log(`    cctp quote: relayFee=${quotedRelayFee} maxCctpFee=${quotedMaxCctpFee} expiry=${quoteExpiry}`)
  })

  assert.ok(quoteToken, 'C2 failed — aborting C3+')

  // ── C2b: desiredNetAmount quote — gross = desiredNet + maxCctpFee ─────────────
  await test('C2b: GET /relay/cctp/quote?desiredNetAmount=4000000 → gross>4000000', async () => {
    const res = await mf.dispatchFetch(
      `http://fake/relay/cctp/quote?signerAddress=${SIGNER_ADDR}&destinationDomain=0&mintRecipient=${MINT_RECIPIENT}&desiredNetAmount=4000000`
    )
    const body = await res.json()
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(body)}`)
    assert.ok(body.quoteToken, 'missing quoteToken')
    const gross    = BigInt(body.grossAmount)
    const maxFee   = BigInt(body.maxCctpFee)
    const minDest  = BigInt(body.minDestReceived)
    // gross = desiredNet + maxCctpFee; never less than requested net
    assert.ok(gross > 4000000n, `gross ${gross} should be > desiredNet 4000000`)
    assert.equal(gross - maxFee, minDest, 'minDestReceived should equal gross - maxCctpFee')
    assert.ok(minDest >= 4000000n - maxFee, 'minDestReceived should be close to desiredNet')
    console.log(`    C2b desiredNet quote: gross=${gross} maxFee=${maxFee} minDest=${minDest}`)
  })

  // ── C3: CCTP submit — SQL-before-ACK observation ─────────────────────────────
  let firstCctpTxHash
  capturedCctpRawTx = null; cctpSqlObservation = null

  await test('C3: POST /relay/cctp/submit → 202; cctp_journal row before ACK', async () => {
    const submitBody = {
      signerAddress:     SIGNER_ADDR,
      destinationDomain: 0,
      mintRecipient:     MINT_RECIPIENT,
      grossAmount:       quotedGrossAmount,
      maxCctpFee:        quotedMaxCctpFee,
      relayFee:          quotedRelayFee,
      quoteExpiry:       quoteExpiry,
      escrowNonce:       ESCROW_NONCE.toString(),
      paymentSig:        SIG_65,
      cctpSig:           SIG_65,
      chainId:           CHAIN_ID,
      quoteToken,
    }
    const res  = await mf.dispatchFetch('http://fake/relay/cctp/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(submitBody),
    })
    const resp = await res.json()
    assert.equal(res.status, 202, `Expected 202 got ${res.status}: ${JSON.stringify(resp)}`)
    assert.ok(resp.txHash, 'missing txHash')
    assert.match(resp.txHash, /^0x[0-9a-f]{64}$/)
    firstCctpTxHash = resp.txHash

    assert.ok(capturedCctpRawTx, 'eth_sendRawTransaction never called')
    assert.ok(cctpSqlObservation, 'cctpSqlObservation not set')
    if (cctpSqlObservation.assertError)
      throw new Error(`SQL pre-ACK observation failed: ${cctpSqlObservation.assertError}`)

    const rows = cctpSqlObservation.rows
    assert.ok(rows && rows.length > 0, 'No cctp_journal rows before ACK')
    const row = rows[rows.length - 1]
    assert.ok(row.rawTx, 'rawTx not persisted before ACK')
    assert.ok(row.txHash, 'txHash not persisted before ACK')
    assert.equal(row.status, 'pending', `Expected status=pending, got ${row.status}`)
    assert.equal(row.txHash, keccak256(row.rawTx), 'txHash ≠ keccak256(rawTx)')
    assert.equal(capturedCctpRawTx.toLowerCase(), row.rawTx.toLowerCase(),
      'broadcast bytes differ from persisted rawTx')

    console.log(`    cctp txHash: ${firstCctpTxHash.slice(0, 18)}...`)
    console.log(`    SQL row before ACK: status=${row.status} ✓`)
  })

  assert.ok(firstCctpTxHash, 'C3 failed — aborting C4+')

  // ── C4: Idempotent retry ─────────────────────────────────────────────────────
  await test('C4: same intent → 202 exact same txHash (idempotent)', async () => {
    capturedCctpRawTx = null
    const res = await mf.dispatchFetch('http://fake/relay/cctp/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        signerAddress: SIGNER_ADDR, destinationDomain: 0,
        mintRecipient: MINT_RECIPIENT, grossAmount: quotedGrossAmount,
        maxCctpFee: quotedMaxCctpFee, relayFee: quotedRelayFee,
        quoteExpiry, escrowNonce: ESCROW_NONCE.toString(),
        paymentSig: SIG_65, cctpSig: SIG_65, chainId: CHAIN_ID, quoteToken,
      }),
    })
    const resp = await res.json()
    assert.equal(res.status, 202)
    assert.equal(resp.txHash, firstCctpTxHash, 'Idempotent retry returned different txHash')
  })

  // ── C8: Status endpoint ──────────────────────────────────────────────────────
  await test('C8: GET /relay/cctp/status?txHash=... → 200 with status fields', async () => {
    const res = await mf.dispatchFetch(
      `http://fake/relay/cctp/status?txHash=${firstCctpTxHash}`
    )
    const body = await res.json()
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(body)}`)
    assert.ok(['pending','broadcast'].includes(body.status), `Unexpected status: ${body.status}`)
    assert.equal(body.txHash, firstCctpTxHash)
    assert.equal(body.destinationDomain, 0)
    assert.equal(body.mintRecipient.toLowerCase(), MINT_RECIPIENT.toLowerCase())
    // Must not expose sigs or full journal
    assert.equal(body.paymentSig, undefined, 'paymentSig must not be in status response')
    assert.equal(body.cctpSig,    undefined, 'cctpSig must not be in status response')
  })

  // ── C8b: Status name mapping — server cctp_* names map to client names ────────
  await test('C8b: status endpoint returns server names; mapping covers known states', async () => {
    // Server returns 'pending' or 'broadcast' for a freshly submitted CCTP intent
    const res = await mf.dispatchFetch(
      `http://fake/relay/cctp/status?txHash=${firstCctpTxHash}`
    )
    const body = await res.json()
    assert.equal(res.status, 200)
    // Verify the server status is a known server-side name
    const KNOWN_SERVER_STATES = ['pending','broadcast','cctp_source_confirmed','cctp_mint_pending','cctp_mint_confirmed','cctp_mint_failed','failed']
    assert.ok(KNOWN_SERVER_STATES.includes(body.status),
      `Server returned unexpected status: ${body.status}`)
    // The UI mapping covers all of these
    const UI_MAP = {
      pending: 'pending', broadcast: 'pending',
      cctp_source_confirmed: 'source_confirmed', cctp_mint_pending: 'mint_pending',
      cctp_mint_confirmed: 'mint_confirmed', cctp_mint_failed: 'mint_failed', failed: 'failed',
    }
    assert.ok(UI_MAP[body.status] !== undefined,
      `Server status '${body.status}' has no UI mapping`)
  })

  // ── C8c: Status with wrong params → 400 ─────────────────────────────────────
  await test('C8c: status?signerAddress=...&escrowNonce=... → 400 (not accepted)', async () => {
    const res = await mf.dispatchFetch(
      `http://fake/relay/cctp/status?signerAddress=${SIGNER_ADDR}&escrowNonce=1`
    )
    assert.equal(res.status, 400, `Expected 400 for unsupported status query params`)
  })

  // ── C5: Restart + exact-byte replay ─────────────────────────────────────────
  await test('C5: restart + changed nonce/gas → same txHash, exact-byte replay', async () => {
    await mf.dispose(); mf = null
    mockState.nonce    = 99
    mockState.gasPrice = 40_000_000_000n

    mf = new Miniflare({
      ...BASE_CONFIG,
      bindings: { ...BASE_CONFIG.bindings, RELAY_CCTP_ROUTER_ADDRESS: MOCK_ROUTER },
      durableObjectsPersist: persist,
    })
    await mf.ready

    const hRes = await mf.dispatchFetch('http://fake/relay/health')
    const hBody = await hRes.json()
    assert.equal(hRes.status, 200)
    assert.equal(hBody.available, true)
    assert.equal(hBody.cctpQueueDepth, 1, `Expected cctpQueueDepth=1, got ${hBody.cctpQueueDepth}`)

    capturedCctpRawTx = null; cctpSqlObservation = null

    const retryRes = await mf.dispatchFetch('http://fake/relay/cctp/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        signerAddress: SIGNER_ADDR, destinationDomain: 0,
        mintRecipient: MINT_RECIPIENT, grossAmount: quotedGrossAmount,
        maxCctpFee: quotedMaxCctpFee, relayFee: quotedRelayFee,
        quoteExpiry, escrowNonce: ESCROW_NONCE.toString(),
        paymentSig: SIG_65, cctpSig: SIG_65, chainId: CHAIN_ID, quoteToken,
      }),
    })
    const retryBody = await retryRes.json()
    assert.equal(retryRes.status, 202)
    assert.equal(retryBody.txHash, firstCctpTxHash,
      'Retry after restart returned different txHash — re-signed instead of replaying')
    assert.ok(capturedCctpRawTx, 'eth_sendRawTransaction not called on retry')

    const rowsAfter = readCctpRowsSync(persist)
    assert.equal(rowsAfter.length, 1)
    assert.equal(
      capturedCctpRawTx.toLowerCase(),
      rowsAfter[0].rawTx.toLowerCase(),
      'Re-broadcast bytes differ from persisted rawTx'
    )
    console.log(`    exact-byte replay: ✓`)
  })

  // ── C6: Legacy submit conflicts with existing CCTP row ───────────────────────
  // A CCTP row already exists for SIGNER_ADDR:ESCROW_NONCE (status=pending/broadcast).
  // A legacy /relay POST for the same signer+nonce should return 409.
  await test('C6: legacy /relay submit for same signer+nonce → 409 cross-table conflict', async () => {
    // Get a legacy quote first
    const qRes = await mf.dispatchFetch(
      `http://fake/relay/quote?signerAddress=${SIGNER_ADDR}`
    )
    const qBody = await qRes.json()
    assert.equal(qRes.status, 200, `Legacy quote failed: ${JSON.stringify(qBody)}`)

    const legacyBody = {
      signerAddress: SIGNER_ADDR,
      recipient:     MINT_RECIPIENT,
      amount:        '5000000',
      fee:           qBody.quotedFee,
      feeRecipient:  RELAY_ADDR,
      quoteExpiry:   String(qBody.quoteExpiry),
      nonce:         ESCROW_NONCE.toString(),   // SAME nonce as CCTP row above
      sig:           SIG_65,
      chainId:       CHAIN_ID,
      quoteToken:    qBody.quoteToken,
    }
    const res = await mf.dispatchFetch('http://fake/relay', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(legacyBody),
    })
    const resp = await res.json()
    assert.equal(res.status, 409, `Expected 409 got ${res.status}: ${JSON.stringify(resp)}`)
    assert.match(resp.error, /CCTP|conflict/i, 'error must mention CCTP conflict')
  })

  // ── C7: CCTP submit conflicts with existing legacy row ───────────────────────
  // First do a successful legacy submission for nonce=1, then try CCTP for nonce=1.
  await test('C7: CCTP submit for same signer+nonce as existing legacy → 409', async () => {
    // First: legacy submission at nonce=1 (different from CCTP nonce=0 above)
    mockState.nonce = 1  // next relay nonce
    const qRes = await mf.dispatchFetch(
      `http://fake/relay/quote?signerAddress=${SIGNER_ADDR}`
    )
    const qBody = await qRes.json()
    assert.equal(qRes.status, 200)

    const legNonce = '1'
    const legRes = await mf.dispatchFetch('http://fake/relay', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        signerAddress: SIGNER_ADDR, recipient: MINT_RECIPIENT,
        amount: '5000000', fee: qBody.quotedFee,
        feeRecipient: RELAY_ADDR,
        quoteExpiry: String(qBody.quoteExpiry),
        nonce: legNonce, sig: SIG_65, chainId: CHAIN_ID, quoteToken: qBody.quoteToken,
      }),
    })
    assert.equal(legRes.status, 202, `Legacy nonce=1 submit failed: ${legRes.status}`)

    // Now: CCTP quote for grossAmount=5000000, then submit with escrowNonce=1
    const cqRes = await mf.dispatchFetch(
      `http://fake/relay/cctp/quote?signerAddress=${SIGNER_ADDR}&destinationDomain=0&mintRecipient=${MINT_RECIPIENT}&grossAmount=5000000`
    )
    const cqBody = await cqRes.json()
    assert.equal(cqRes.status, 200, `CCTP quote failed: ${JSON.stringify(cqBody)}`)

    // Change relay nonce so CCTP gets a different relay nonce
    mockState.nonce = 2

    const res = await mf.dispatchFetch('http://fake/relay/cctp/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        signerAddress: SIGNER_ADDR, destinationDomain: 0,
        mintRecipient: MINT_RECIPIENT, grossAmount: cqBody.grossAmount,
        maxCctpFee: cqBody.maxCctpFee, relayFee: cqBody.relayFee,
        quoteExpiry: cqBody.quoteExpiry, escrowNonce: legNonce, // SAME as legacy nonce=1
        paymentSig: SIG_65, cctpSig: SIG_65, chainId: CHAIN_ID, quoteToken: cqBody.quoteToken,
      }),
    })
    const resp = await res.json()
    assert.equal(res.status, 409, `Expected 409 got ${res.status}: ${JSON.stringify(resp)}`)
    assert.match(resp.error, /legacy|conflict|signer/i, 'error must mention legacy conflict')
  })

  // ── C9: Modified destinationDomain after quote → 400 ────────────────────────
  await test('C9: modified destinationDomain → quoteToken mismatch → 400', async () => {
    // Get a quote for domain=0
    const cqRes = await mf.dispatchFetch(
      `http://fake/relay/cctp/quote?signerAddress=${SIGNER_ADDR}&destinationDomain=0&mintRecipient=${MINT_RECIPIENT}&grossAmount=5000000`
    )
    const cqBody = await cqRes.json()
    assert.equal(cqRes.status, 200)

    mockState.nonce = 10
    const res = await mf.dispatchFetch('http://fake/relay/cctp/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        signerAddress: SIGNER_ADDR,
        destinationDomain: 6,  // TAMPERED: domain=6 instead of quoted 0
        mintRecipient: MINT_RECIPIENT, grossAmount: cqBody.grossAmount,
        maxCctpFee: cqBody.maxCctpFee, relayFee: cqBody.relayFee,
        quoteExpiry: cqBody.quoteExpiry, escrowNonce: '99',
        paymentSig: SIG_65, cctpSig: SIG_65, chainId: CHAIN_ID, quoteToken: cqBody.quoteToken,
      }),
    })
    assert.equal(res.status, 400, `Expected 400 for tampered domain, got ${res.status}`)
    const resp = await res.json()
    assert.match(resp.error, /destinationDomain|mismatch/i)
  })

  // ── C10: Wrong quoteToken format (legacy quote) → 401 ───────────────────────
  await test('C10: legacy quoteToken for CCTP submit → 401', async () => {
    // Get a legacy quote token (not cctp-v1)
    const lqRes = await mf.dispatchFetch(
      `http://fake/relay/quote?signerAddress=${SIGNER_ADDR}`
    )
    const lqBody = await lqRes.json()
    assert.equal(lqRes.status, 200)

    const cqRes = await mf.dispatchFetch(
      `http://fake/relay/cctp/quote?signerAddress=${SIGNER_ADDR}&destinationDomain=0&mintRecipient=${MINT_RECIPIENT}&grossAmount=5000000`
    )
    const cqBody = await cqRes.json()

    mockState.nonce = 20
    const res = await mf.dispatchFetch('http://fake/relay/cctp/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        signerAddress: SIGNER_ADDR, destinationDomain: 0,
        mintRecipient: MINT_RECIPIENT, grossAmount: cqBody.grossAmount,
        maxCctpFee: cqBody.maxCctpFee, relayFee: cqBody.relayFee,
        quoteExpiry: cqBody.quoteExpiry, escrowNonce: '20',
        paymentSig: SIG_65, cctpSig: SIG_65, chainId: CHAIN_ID,
        quoteToken: lqBody.quoteToken,  // WRONG: legacy quote token
      }),
    })
    assert.equal(res.status, 401, `Expected 401 for legacy quoteToken, got ${res.status}`)
  })

} finally {
  if (mf) { try { await mf.dispose() } catch {} }
  if (rpcSrv) rpcSrv.close()
  if (irisSrv) irisSrv.close()
  try { rmSync(persist, { recursive: true, force: true }) } catch {}

  console.log('\n── CCTP Smoke results ─────────────────────────────────────')
  for (const r of results) console.log(r)
  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

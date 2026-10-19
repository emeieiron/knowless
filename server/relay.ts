/**
 * Spookly relay server — same-origin, server-only signer.
 *
 * SECURITY MODEL
 *   - Only calls Spookly.executePayment on the configured chain/contract
 *   - Holders POST { signerAddress, recipient, amount, fee, feeRecipient,
 *                    quoteExpiry, nonce, sig, chainId, quoteToken }
 *   - quoteToken is a HMAC-SHA256 token issued by /relay/quote, derived
 *     from the relay key (stable across restarts for the same key).
 *   - feeRecipient is the relay wallet address — the contract enforces
 *     msg.sender == feeRecipient.
 *   - The signed raw transaction is persisted to the journal BEFORE
 *     sendRawTransaction is called. If the journal write fails, the
 *     broadcast is skipped entirely.
 *   - On restart, pending journal entries are re-sent verbatim (same raw tx,
 *     same hash, same relay nonce) — no new transaction is ever prepared for
 *     an existing intent.
 *   - RPC reads fail-closed.
 *   - Rate limit: 10 req / IP / 60 s; stores capped at 10 000 entries.
 *   - Request body capped at 4 KB.
 *   - Upstream RPC URLs and error details never reach the browser.
 *
 * HUMAN CONFIGURATION (copy server/relay-env-example.txt → .env):
 *   RELAY_PRIVATE_KEY=0x<64 hex chars>   — funded Arc Testnet wallet
 *   RELAY_PORT=4001
 *
 * OPTIONAL:
 *   RELAY_MAX_FEE_USDC=200000            — ceiling fee per payment (6-dec)
 *   RELAY_FEE_MARGIN_USDC=50000          — overhead added to gas estimate
 *   RELAY_QUOTE_TTL_S=300                — quote token lifetime in seconds
 */

import {
  createPublicClient, createWalletClient, http,
  type Hex, type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { RelayJournal } from './relay-journal.js'
import {
  RelayCore,
  type RelayTransport,
  type LinkInfo,
  type EstimateGasParams,
  type ExecuteParams,
} from './relay-core.js'

// ── Configuration ──────────────────────────────────────────────────────────
const CHAIN_ID       = parseInt(process.env.RELAY_CHAIN_ID        ?? '5042002', 10)
const CONTRACT_ADDR  = (process.env.VITE_SPOOKLY_ADDRESS_TESTNET ?? '') as Address
const PORT           = parseInt(process.env.RELAY_PORT             ?? '4001',   10)
const MAX_FEE_USDC   = BigInt(process.env.RELAY_MAX_FEE_USDC       ?? '200000')
const FEE_MARGIN_USDC= BigInt(process.env.RELAY_FEE_MARGIN_USDC   ?? '50000')
const QUOTE_TTL_S    = parseInt(process.env.RELAY_QUOTE_TTL_S      ?? '300',    10)
const ARC_GAS_FLOOR  = 20_000_000_000n // 20 Gwei

if (!CONTRACT_ADDR || !/^0x[0-9a-fA-F]{40}$/.test(CONTRACT_ADDR)) {
  console.error('[relay] VITE_SPOOKLY_ADDRESS_TESTNET not set or invalid. Cannot start.')
  process.exit(1)
}

// ── RPC URL ────────────────────────────────────────────────────────────────
const proxyChains = (process.env.RPC_PROXY_CHAINS ?? '').split(',').map(s => s.trim())
const RPC_URL = (
  process.env.RPC_PROXY_BASE_URL && proxyChains.includes('Arc_Testnet')
    ? `${process.env.RPC_PROXY_BASE_URL}/api/rpc/Arc_Testnet?_rpc_token=${process.env.RPC_PROXY_TOKEN}`
    : 'https://rpc.testnet.arc.io' // arc-studio-allow-onchain-literal
)

// ── Relay key ──────────────────────────────────────────────────────────────
const RELAY_PK = process.env.RELAY_PRIVATE_KEY as Hex | undefined
const relayAvailable = !!RELAY_PK && /^0x[0-9a-fA-F]{64}$/.test(RELAY_PK)
const account = relayAvailable ? privateKeyToAccount(RELAY_PK) : null

// ── viem clients ───────────────────────────────────────────────────────────
const arcChain = {
  id: CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const

const pub = createPublicClient({ chain: arcChain, transport: http(RPC_URL) })
const wall = account
  ? createWalletClient({ account, chain: arcChain, transport: http(RPC_URL) })
  : null

// ── ABI fragments ──────────────────────────────────────────────────────────
const EXECUTE_ABI = {
  type: 'function' as const, name: 'executePayment',
  inputs: [
    { name: 'signerAddress', type: 'address' }, { name: 'recipient',    type: 'address' },
    { name: 'amount',        type: 'uint128' }, { name: 'fee',          type: 'uint128' },
    { name: 'feeRecipient',  type: 'address' }, { name: 'quoteExpiry',  type: 'uint64'  },
    { name: 'nonce',         type: 'uint256' }, { name: 'sig',          type: 'bytes'   },
  ],
  outputs: [], stateMutability: 'nonpayable' as const,
} as const

const GET_LINK_ABI = {
  type: 'function' as const, name: 'getLinkInfo',
  inputs: [{ name: 'signerAddress', type: 'address' }],
  outputs: [{ name: '', type: 'tuple', components: [
    { name: 'issuer',     type: 'address' },
    { name: 'balance',    type: 'uint128' },
    { name: 'feeBalance', type: 'uint128' },
    { name: 'expiry',     type: 'uint64'  },
    { name: 'active',     type: 'bool'    },
  ]}],
  stateMutability: 'view' as const,
} as const

const NONCES_ABI = {
  type: 'function' as const, name: 'usedNonces',
  inputs: [{ name: 'signerAddress', type: 'address' }, { name: 'nonce', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
  stateMutability: 'view' as const,
} as const

// ── Live viem transport ────────────────────────────────────────────────────
function makeViemTransport(): RelayTransport {
  return {
    async getGasPrice() { return pub.getGasPrice() },
    async getNonce(address) { return pub.getTransactionCount({ address }) },
    async estimateContractGas(p: EstimateGasParams) {
      return pub.estimateContractGas({
        address: p.contractAddress, abi: [EXECUTE_ABI],
        functionName: 'executePayment',
        args: [p.signerAddress, p.recipient, p.amount, p.fee,
               p.feeRecipient, p.quoteExpiry, p.nonce, p.sig],
        account: p.feeRecipient,
      })
    },
    async simulateExecutePayment(p: ExecuteParams) {
      await pub.simulateContract({
        address: p.contractAddress, abi: [EXECUTE_ABI],
        functionName: 'executePayment',
        args: [p.signerAddress, p.recipient, p.amount, p.fee,
               p.feeRecipient, p.quoteExpiry, p.nonce, p.sig],
        account: p.from,
      })
    },
    async getLinkInfo(signerAddress: Address): Promise<LinkInfo> {
      const info = await pub.readContract({
        address: CONTRACT_ADDR, abi: [GET_LINK_ABI],
        functionName: 'getLinkInfo', args: [signerAddress],
      })
      return info
    },
    async getUsedNonce(signerAddress: Address, nonce: bigint) {
      return pub.readContract({
        address: CONTRACT_ADDR, abi: [NONCES_ABI],
        functionName: 'usedNonces', args: [signerAddress, nonce],
      })
    },
    async sendRawTransaction(rawTx: Hex) {
      if (!wall) throw new Error('Relay wallet not available')
      return wall.sendRawTransaction({ serializedTransaction: rawTx })
    },
    async getTransactionReceipt(txHash: Hex) {
      const r = await pub.getTransactionReceipt({ hash: txHash })
      if (!r) return null
      return {
        status: r.status === 'success' ? '0x1' : '0x0',
        to: r.to ?? null,
        transactionHash: r.transactionHash,
        logs: r.logs.map(l => ({
          address: l.address,
          topics: [...l.topics],
          data: l.data,
        })),
        blockNumber: r.blockNumber ? ('0x' + r.blockNumber.toString(16)) : undefined,
      }
    },
  }
}

// ── Journal + Core ─────────────────────────────────────────────────────────
// Lazy construction: only create the production journal/core when this file is
// the actual entrypoint (import.meta.main). When imported by tests, these stay
// null and tests inject their own journal/core via makeRequestHandler overrides.
const JOURNAL_DIR = join(process.cwd(), '.relay-journal')

let journal: RelayJournal
let core: RelayCore

if (import.meta.main) {
  mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 })
  journal = new RelayJournal(JOURNAL_DIR, account?.address, CHAIN_ID, CONTRACT_ADDR)
  const relayCfg = {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT_ADDR,
    relayAddress: (account?.address ?? '0x0000000000000000000000000000000000000000'),
    privateKey: (RELAY_PK ?? '0x' + '00'.repeat(32)) as Hex,
    maxFeeUsdc: MAX_FEE_USDC,
    feeMarginUsdc: FEE_MARGIN_USDC,
    quoteTtlS: QUOTE_TTL_S,
    arcGasFloor: ARC_GAS_FLOOR,
    journalDir: JOURNAL_DIR,
  }
  core = new RelayCore(relayCfg, journal)
} else {
  // Not running as entrypoint — stub values; tests must pass coreOverride
  journal = null as unknown as RelayJournal
  core    = null as unknown as RelayCore
}

// ── Rate limiter ───────────────────────────────────────────────────────────
// Exported so tests can create isolated instances via makeRateLimiter().
export interface RateLimiter {
  check(ip: string, now?: number): boolean
}

const RATE_WINDOW_MS  = 60_000    // 1 minute sliding window
const RATE_MAX_REQS   = 10        // max requests per IP per window
const RATE_MAX_IPS    = 10_000    // max distinct IPs stored
const RATE_MAX_TS_PER_IP = 256    // cap per-IP timestamp array

export function makeRateLimiter(): RateLimiter {
  const store = new Map<string, number[]>()

  return {
    check(ip: string, now: number = Date.now()): boolean {
      const cutoff = now - RATE_WINDOW_MS

      // Evict expired IPs when at capacity and this is a new IP
      if (store.size >= RATE_MAX_IPS && !store.has(ip)) {
        for (const [k, ts] of store.entries()) {
          // Entry expired if ALL timestamps are outside the window
          if (ts.every(t => t <= cutoff)) store.delete(k)
          if (store.size < RATE_MAX_IPS * 0.8) break
        }
        // Still at capacity after eviction — reject new IPs
        if (store.size >= RATE_MAX_IPS) return false
      }

      // Keep only timestamps within the window (t > cutoff means within window)
      let ts = (store.get(ip) ?? []).filter(t => t > cutoff)
      // Cap per-IP array to prevent unbounded growth from a single IP flooding
      if (ts.length >= RATE_MAX_TS_PER_IP) ts = ts.slice(ts.length - RATE_MAX_TS_PER_IP + 1)
      ts.push(now)
      store.set(ip, ts)
      return ts.length <= RATE_MAX_REQS
    },
  }
}

const globalRateLimiter = makeRateLimiter()

// ── Response helper ────────────────────────────────────────────────────────
type Res = { writeHead(s: number, h: Record<string, string>): void; end(b: string): void }
function json(res: Res, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// ── RelayBody type (used in makeRequestHandler) ────────────────────────────
interface RelayBody {
  signerAddress?: unknown; recipient?: unknown
  amount?: unknown; fee?: unknown; feeRecipient?: unknown
  quoteExpiry?: unknown; nonce?: unknown; sig?: unknown
  chainId?: unknown; quoteToken?: unknown
}

// ── HTTP server ────────────────────────────────────────────────────────────
const MAX_BODY_BYTES = 4096

/**
 * makeRequestHandler — creates a Node HTTP request handler.
 * Exported for tests that want to start the real server on an ephemeral port
 * with an injected transport/core (pass overrides) or the defaults.
 */
export function makeRequestHandler(opts?: {
  coreOverride?: typeof core
  relayAvailableOverride?: boolean
  accountOverride?: typeof account
  chainIdOverride?: number
  transportFactory?: () => ReturnType<typeof makeViemTransport>
  rateLimiterOverride?: RateLimiter
}) {
  const _core             = opts?.coreOverride ?? core
  const _relayAvailable   = opts?.relayAvailableOverride ?? relayAvailable
  const _account          = opts?.accountOverride ?? account
  const _chainId          = opts?.chainIdOverride ?? CHAIN_ID
  const _makeTransport    = opts?.transportFactory ?? makeViemTransport
  const _rateLimiter      = opts?.rateLimiterOverride ?? globalRateLimiter

  return function handler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    void (async () => {
      try {
        const ip  = req.socket?.remoteAddress ?? 'unknown'
        const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

        res.setHeader('Access-Control-Allow-Origin', 'same-origin')
        res.setHeader('Vary', 'Origin')
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

        if (url.pathname === '/relay/health') {
          // Await deep validation before advertising availability
          // Await RelayCore's own readiness gate (which validates against cfg.relayAddress/chainId/contract,
          // even if the journal was constructed without optional config expectations).
          await _core?.readinessPromise.catch(() => undefined)
          const journalError = _core?.journal.journalError ?? null
          const coreError = _core?.coreReadinessError ?? null
          const healthy = _relayAvailable && !journalError && !coreError && (_core?.journal.available ?? false)
          json(res, healthy ? 200 : 503, {
            ok: healthy,
            available: healthy,
            journalError: journalError ?? undefined,
            queueDepth: _core?.currentQueueDepth ?? 0,
            chainId: _chainId,
            relayWallet: _account?.address ?? null,
          })
          return
        }

        if (req.method === 'GET' && url.pathname === '/relay/quote') {
          const sa = url.searchParams.get('signerAddress') as Address | null
          if (!sa || !/^0x[0-9a-fA-F]{40}$/.test(sa)) { json(res, 400, { error: 'Invalid signerAddress.' }); return }
          if (!_relayAvailable || !_account) {
            json(res, 503, { error: 'Relay not configured. See server/relay-env-example.txt.', available: false })
            return
          }
          const transport = _makeTransport()
          try {
            const q = await _core.buildQuote(sa, transport)
            json(res, 200, {
              quotedFee: q.quotedFee.toString(),
              feeRecipient: q.feeRecipient,
              quoteExpiry: q.quoteExpiry,
              feeBalance: q.feeBalance.toString(),
              quoteToken: q.quoteToken,
              gasEstimate: q.gasEstimate.toString(),
              gasPrice: q.gasPrice.toString(),
            })
          } catch (e) {
            const err = e as Error & { httpStatus?: number; extra?: object }
            json(res, err.httpStatus ?? 500, { error: err.message, ...(err.extra ?? {}) })
          }
          return
        }

        if (req.method === 'POST' && url.pathname === '/relay') {
          let body = ''
          let size = 0
          let tooLarge = false
          await new Promise<void>((resolve, reject) => {
            req.on('data', (chunk: Buffer) => {
              size += chunk.length
              if (tooLarge) return  // drain silently — response already sent
              if (size > MAX_BODY_BYTES) {
                tooLarge = true
                // Send exactly one 413 response, then drain the rest
                res.writeHead(413, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Request body too large.' }))
                resolve()
                return
              }
              body += chunk.toString()
            })
            req.on('end', () => resolve())
            req.on('error', (e) => reject(e))
          })
          if (tooLarge) return
          let parsed: RelayBody
          try { parsed = JSON.parse(body) as RelayBody }
          catch { json(res, 400, { error: 'Invalid JSON.' }); return }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            json(res, 400, { error: 'Request body must be a JSON object.' }); return
          }
          if (!_relayAvailable || !_account) {
            json(res, 503, { error: 'Relay not configured.', available: false }); return
          }
          if (!_rateLimiter.check(ip)) {
            json(res, 429, { error: 'Rate limit exceeded.' }); return
          }
          const { signerAddress, recipient, amount: amountRaw, fee: feeRaw,
            feeRecipient, quoteExpiry: qeRaw, nonce: nonceRaw, sig, chainId, quoteToken } = parsed
          if (typeof signerAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(signerAddress))
            { json(res, 400, { error: 'Invalid signerAddress.' }); return }
          if (typeof recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(recipient))
            { json(res, 400, { error: 'Invalid recipient.' }); return }
          if (typeof feeRecipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(feeRecipient))
            { json(res, 400, { error: 'Invalid feeRecipient.' }); return }
          if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig))
            { json(res, 400, { error: 'Invalid sig.' }); return }
          if (typeof quoteToken !== 'string' || quoteToken.length < 10)
            { json(res, 400, { error: 'Missing quoteToken.' }); return }
          if (chainId !== _chainId)
            { json(res, 400, { error: `Wrong chain. Expected ${_chainId}.` }); return }
          let amount: bigint, fee: bigint, nonce: bigint, quoteExpiry: bigint
          try {
            amount = BigInt(String(amountRaw))
            fee    = BigInt(String(feeRaw))
            nonce  = BigInt(String(nonceRaw))
            quoteExpiry = BigInt(String(qeRaw))
          } catch {
            json(res, 400, { error: 'amount/fee/nonce/quoteExpiry must be decimal bigint strings.' }); return
          }
          if (amount <= 0n) { json(res, 400, { error: 'amount must be > 0.' }); return }
          if (fee < 0n)     { json(res, 400, { error: 'fee must be >= 0.' }); return }
          const transport = _makeTransport()
          let result: import('./relay-core.js').RelayResult
          try {
            result = await _core.enqueueRelay({
              signerAddress: signerAddress as Address,
              recipient: recipient as Address,
              amount, fee,
              feeRecipient: feeRecipient as Address,
              quoteExpiry, nonce,
              sig: sig as Hex,
              chainId: chainId,
              quoteToken,
            }, transport)
          } catch (e) {
            // Map known structured errors (e.g. queue capacity) to their HTTP status.
            // Never surface credential-bearing messages.
            const httpStatus = (e instanceof Error && 'httpStatus' in e)
              ? (e as Error & { httpStatus: number }).httpStatus : 500
            const safeMsg = httpStatus === 503 ? 'Relay busy — try again later.'
              : httpStatus === 400 ? 'Bad request.'
              : 'Internal server error.'
            json(res, httpStatus, { error: safeMsg }); return
          }
          json(res, result.status, result.body)
          return
        }

        json(res, 404, { error: 'Not found.' })
      } catch (e) {
        // Catch any unhandled error in the handler: return a sanitized 5xx,
        // log the error type only (no credential-bearing URLs or raw stack),
        // and keep the server alive.
        console.error('[relay] unhandled handler error:', (e instanceof Error) ? e.constructor.name : 'unknown')
        try { json(res, 500, { error: 'Internal server error.' }) } catch { /**/ }
      }
    })()
  }
}

// ── Entrypoint guard ────────────────────────────────────────────────────────
// Only start the HTTP server when this file is executed directly (not imported
// by tests or other modules). This prevents the server from binding to port
// 4001 when `relay.ts` is imported to access makeRequestHandler.
if (import.meta.main) {
  const { createServer } = await import('node:http')
  const server = createServer(makeRequestHandler())

  // Recover pending journal entries on startup
  if (relayAvailable) {
    const transport = makeViemTransport()
    core.recoverPending(transport).catch(e => {
      console.error('[relay] recovery error:', (e as Error).message)
    })
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[relay] :${PORT} available=${relayAvailable} chain=${CHAIN_ID} contract=${CONTRACT_ADDR}`)
    if (!relayAvailable) console.warn('[relay] RELAY_PRIVATE_KEY not set — returning 503. See server/relay-env-example.txt.')
  })
}

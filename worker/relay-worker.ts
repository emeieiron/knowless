/**
 * relay-worker.ts — Cloudflare Worker entry point for knowless relay.
 *
 * Routes:
 *   GET  /relay/health       → RelayDO#fetch
 *   GET  /relay/quote?...    → RelayDO#fetch
 *   POST /relay              → RelayDO#fetch
 *
 * All signing requests route to ONE Durable Object instance per
 * chain + relay ACCOUNT ADDRESS. The contract address is stored
 * inside the DO's persisted config_fingerprint (chain+contract+relayAddress),
 * so a contract change routes to the SAME DO instance and triggers
 * the fingerprint mismatch gate — fail closed, zero broadcasts.
 *
 * DO key = sha256("do-key:relay:" + chainId + ":" + relayAddress.toLowerCase())
 *
 * The router derives relayAddress from RELAY_PRIVATE_KEY.
 * Invalid or missing key → 503/no-store before routing to the DO.
 *
 * CORS: exact-match ALLOWED_ORIGIN only. Never wildcard with credentials.
 * Cache-Control: no-store on all relay responses.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { RelayDO } from './relay-do'

export { RelayDO }

export interface Env {
  RELAY_DO: DurableObjectNamespace
  ALLOWED_ORIGIN: string         // e.g. 'https://knowless.vercel.app'
  RELAY_PRIVATE_KEY: string
  RELAY_CHAIN_ID?: string
  RELAY_CONTRACT_ADDRESS: string
  RELAY_HMAC_SECRET?: string
  RELAY_MAX_FEE_USDC?: string
  RELAY_FEE_MARGIN_USDC?: string
  RELAY_QUOTE_TTL_S?: string
  RELAY_RPC_URL?: string
  RELAY_CCTP_ROUTER_ADDRESS?: string
}

const RELAY_PATHS = new Set([
  '/relay', '/relay/health', '/relay/quote',
  '/relay/cctp/quote', '/relay/cctp/submit', '/relay/cctp/status',
])

function isRelayPath(pathname: string): boolean {
  return RELAY_PATHS.has(pathname) || pathname.startsWith('/relay/')
}

function noStore(): { 'Cache-Control': string } {
  return { 'Cache-Control': 'no-store' }
}

function corsHeaders(origin: string, allowedOrigin: string): Record<string, string> {
  const acao = origin === allowedOrigin ? allowedOrigin : 'null'
  return {
    'Access-Control-Allow-Origin': acao,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
}

/**
 * Derive the stable DO name from chain + relay ACCOUNT ADDRESS only.
 * Contract address is in the persisted config_fingerprint, not the namespace
 * key — so a contract change routes to the SAME DO and fails the fingerprint
 * check, blocking all operations until an operator-supervised cutover.
 */
function deriveDoKey(chainId: number, relayAddress: string): string {
  const raw = `do-key:relay:${chainId}:${relayAddress.toLowerCase()}`
  return bytesToHex(sha256(new TextEncoder().encode(raw)))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url    = new URL(request.url)
    const origin = request.headers.get('Origin') ?? ''
    const allowedOrigin = env.ALLOWED_ORIGIN ?? ''

    // Preflight — include no-store and CORS headers
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...corsHeaders(origin, allowedOrigin), ...noStore() },
      })
    }

    // Only handle relay paths
    if (!isRelayPath(url.pathname)) {
      return new Response('Not found.', {
        status: 404,
        headers: noStore(),
      })
    }

    // Guard: validate key + derive relayAddress before routing.
    // Missing or malformed key → 503/no-store; no DO stub created.
    if (!env.RELAY_PRIVATE_KEY || !env.RELAY_CONTRACT_ADDRESS) {
      return Response.json(
        { error: 'Relay not configured.' },
        { status: 503, headers: { ...corsHeaders(origin, allowedOrigin), ...noStore() } },
      )
    }

    let relayAddress: string
    try {
      const pk = env.RELAY_PRIVATE_KEY as Hex
      if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('invalid key format')
      relayAddress = privateKeyToAccount(pk).address
    } catch {
      return Response.json(
        { error: 'Relay not configured: invalid RELAY_PRIVATE_KEY.' },
        { status: 503, headers: { ...corsHeaders(origin, allowedOrigin), ...noStore() } },
      )
    }

    // Route to single DO keyed by chain + relay ACCOUNT ADDRESS.
    // Contract identity is validated inside the DO (config_fingerprint).
    const chainId = parseInt(env.RELAY_CHAIN_ID ?? '5042002', 10)
    const doKey   = deriveDoKey(chainId, relayAddress)
    const doId    = env.RELAY_DO.idFromName(doKey)
    const doStub  = env.RELAY_DO.get(doId)

    let response: Response
    try {
      response = await doStub.fetch(request)
    } catch (e) {
      const name = e instanceof Error ? e.constructor.name : 'unknown'
      console.error('[relay-worker] DO fetch error:', name)
      response = Response.json(
        { error: 'Internal server error.' },
        { status: 500 },
      )
    }

    // Add CORS + no-store headers to all relay responses
    const headers = new Headers(response.headers)
    for (const [k, v] of Object.entries(corsHeaders(origin, allowedOrigin))) {
      headers.set(k, v)
    }
    headers.set('Cache-Control', 'no-store')

    return new Response(response.body, {
      status:     response.status,
      statusText: response.statusText,
      headers,
    })
  },
} satisfies ExportedHandler<Env>

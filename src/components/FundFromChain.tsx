/**
 * FundFromChain — fund an Arc knowless link from Ethereum or Base
 * via CCTP V2 depositForBurnWithHook.
 *
 * Flow:
 *   1. User selects source chain and enters USDC amount.
 *   2. Component fetches fee quote and shows gross/fee/min-received/gas note.
 *   3. User approves USDC spend (if needed), then burns via TokenMessengerV2.
 *   4. Component polls Circle Messages API and Arc for destination confirmation.
 *   5. On confirmed destination mint, user proceeds to create the link.
 *
 * Security:
 *   - No private key access. Uses selected EIP-6963 connector only.
 *   - All chain/contract config is static constants; no caller-supplied RPC URLs.
 *   - Source burns only after explicit user approval.
 *   - Approval hash and burn hash persisted in sessionStorage keyed by account+chain.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { useAccount, useSwitchChain, useReadContract, useConfig } from 'wagmi'
import {
  formatUnits, parseUnits, createWalletClient, createPublicClient, http, custom,
  type Address, type Hex, type EIP1193Provider,
} from 'viem'
import { ArrowDown, Loader2 } from 'lucide-react'
import { classifyWriteError } from '../lib/writeError'
import {
  obtainProvider, switchAndVerify, verifyChain, hasSourceEth,
  assertConnectorUnchanged,
  persistApproval, loadApproval, clearApproval,
  ProviderUnavailableError, ChainMismatchError, SwitchUnsupportedError,
  InsufficientEthError, IndeterminateError, ConnectorChangedError,
} from '../lib/fundOrchestration'

// ── Static chain/token config ───────────────────────────────────────────────

const ARC_CHAIN_ID     = 5042
const ARC_USDC: Address = '0x3600000000000000000000000000000000000000' // arc-studio-allow-onchain-literal
const ARC_DOMAIN       = 26

const CCTP_FORWARDING_HOOK =
  '0x636374702d666f72776172640000000000000000000000000000000000000000' as Hex

const MESSAGES_API = 'https://iris-api.circle.com'

export const SOURCE_CHAINS = [
  {
    chainId:      1,
    label:        'Ethereum',
    shortLabel:   'Ethereum',
    domain:       0,
    usdc:         '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address,
    messenger:    '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' as Address,
    explorerBase: 'https://etherscan.io',
    rpcUrl:       'https://eth.llamarpc.com',
  },
  {
    chainId:      8453,
    label:        'Base',
    shortLabel:   'Base',
    domain:       6,
    usdc:         '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
    messenger:    '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' as Address,
    explorerBase: 'https://basescan.org',
    rpcUrl:       'https://mainnet.base.org',
  },
] as const

// ── Minimal ABIs ──────────────────────────────────────────────────────────

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'allowance',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
] as const

// Official 8-argument V2 ABI (destinationCaller is arg 5)
const TOKEN_MESSENGER_V2_ABI = [
  { type: 'function', name: 'depositForBurnWithHook',
    inputs: [
      { name: 'amount',               type: 'uint256' },
      { name: 'destinationDomain',    type: 'uint32'  },
      { name: 'mintRecipient',        type: 'bytes32' },
      { name: 'burnToken',            type: 'address' },
      { name: 'destinationCaller',    type: 'bytes32' },
      { name: 'maxFee',               type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32'  },
      { name: 'hookData',             type: 'bytes'   },
    ],
    outputs: [], stateMutability: 'nonpayable' },
] as const

// ── Session storage for transfer record ──────────────────────────────────────

interface FundRecord {
  sourceTxHash:       string
  sourceChainId:      number
  destinationAddress: string
  grossAmount:        string   // decimal 6-dec USDC base units as string
  status:             'pending_source' | 'source_confirmed' | 'mint_confirmed' | 'failed'
  destTxHash:         string | null
  netAmountReceived:  string | null
}

function burnKey(address: string, sourceChainId: number) {
  return `knowless:fund:${address.toLowerCase()}:${sourceChainId}`
}
function loadRecord(address: string, sourceChainId: number): FundRecord | null {
  try { const r = sessionStorage.getItem(burnKey(address, sourceChainId)); return r ? JSON.parse(r) as FundRecord : null }
  catch { return null }
}
function saveRecord(address: string, sourceChainId: number, rec: FundRecord): void {
  try { sessionStorage.setItem(burnKey(address, sourceChainId), JSON.stringify(rec)) }
  catch { /* non-fatal */ }
}
function clearRecord(address: string, sourceChainId: number): void {
  try { sessionStorage.removeItem(burnKey(address, sourceChainId)) } catch { /* ok */ }
}

// ── Component ────────────────────────────────────────────────────────────────

interface FundFromChainProps {
  onFunded: (netAmountUsdc: bigint) => void
  onBack:   () => void
}

type FundState =
  | { phase: 'select' }
  | { phase: 'preview'; chainIdx: number; grossAmount: bigint; maxFee: bigint }
  | { phase: 'approving' }
  | { phase: 'burning' }
  | { phase: 'indeterminate'; error: string }   // tx sent but no hash — check wallet
  | { phase: 'monitoring'; sourceTxHash: string; sourceChainId: number; destAddress: string; grossAmount: string }
  | { phase: 'confirmed'; netAmount: bigint; destTxHash: string }
  | { phase: 'failed'; error: string }

export function FundFromChain({ onFunded, onBack }: FundFromChainProps) {
  const { address } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const config = useConfig()

  const [chainIdx, setChainIdx]       = useState(0)
  const [amountStr, setAmountStr]     = useState('')
  const [amountError, setAmountError] = useState('')
  const [state, setState]             = useState<FundState>({ phase: 'select' })
  const [irisLoading, setIrisLoading] = useState(false)
  const [irisError, setIrisError]     = useState('')

  const pollRef     = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightRef = useRef(false)  // double-click / duplicate sequence guard

  const srcChain = SOURCE_CHAINS[chainIdx]

  // ── Reload: restore from persisted burn or approval record ───────────────
  useEffect(() => {
    if (!address) return
    for (const sc of SOURCE_CHAINS) {
      const rec = loadRecord(address, sc.chainId)
      if (!rec) continue
      if (rec.status === 'mint_confirmed' && rec.netAmountReceived) {
        setState({ phase: 'confirmed', netAmount: BigInt(rec.netAmountReceived), destTxHash: rec.destTxHash ?? '' })
        return
      }
      if (rec.status !== 'failed') {
        const scIdx = SOURCE_CHAINS.findIndex(s => s.chainId === sc.chainId)
        setState({ phase: 'monitoring', sourceTxHash: rec.sourceTxHash, sourceChainId: sc.chainId,
          destAddress: rec.destinationAddress, grossAmount: rec.grossAmount })
        setChainIdx(scIdx >= 0 ? scIdx : 0)
        return
      }
    }
  }, [address])

  // ── Balance + allowance reads (via wagmi — shows in select/preview UI) ───
  const { data: balanceRaw } = useReadContract({
    address: srcChain.usdc, abi: ERC20_ABI, functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
    chainId: srcChain.chainId,
  })
  const balance = balanceRaw as bigint | undefined

  // ── Preview: fetch Iris fee quote ────────────────────────────────────────
  const handlePreview = useCallback(async () => {
    setAmountError(''); setIrisError('')
    if (!address) return
    if (!amountStr.trim()) { setAmountError('Enter an amount'); return }
    const amt = (() => { try { return parseUnits(amountStr, 6) } catch { return null } })()
    if (!amt || amt <= 0n) { setAmountError('Enter a valid USDC amount'); return }
    if (balance !== undefined && amt > balance) {
      setAmountError(`Max: ${formatUnits(balance, 6)} USDC`)
      return
    }
    setIrisLoading(true)
    try {
      const res = await fetch(
        `${MESSAGES_API}/v2/burn/USDC/fees/${srcChain.domain}/${ARC_DOMAIN}?forward=true`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) },
      )
      if (!res.ok) throw new Error(`Fee API returned ${res.status}`)
      const tiers = await res.json() as Array<Record<string, unknown>>
      const standard = tiers.find(f => Number(f.finalityThreshold) === 2000)
      if (!standard) throw new Error('No standard-finality fee tier available')
      const feeObj = standard.forwardFee as Record<string, unknown> | undefined
      const highStr = String(feeObj?.high ?? '')
      if (!/^\d+$/.test(highStr)) throw new Error('Unexpected fee format from Circle API')
      if (Number(standard.minimumFee) !== 0) throw new Error('Nonzero protocol rate fee — not supported in this version')
      const baseFee = BigInt(highStr)
      const buffer  = baseFee / 100n > 5000n ? baseFee / 100n : 5000n
      const maxFee  = baseFee + buffer
      if (amt <= maxFee) { setIrisError('Amount too small to cover bridge fee'); return }
      setState({ phase: 'preview', chainIdx, grossAmount: amt, maxFee })
    } catch (e) {
      setIrisError((e as Error).message)
    } finally {
      setIrisLoading(false)
    }
  }, [address, amountStr, balance, chainIdx, srcChain])

  // ── Approve + burn ───────────────────────────────────────────────────────
  const handleBurn = useCallback(async () => {
    if (state.phase !== 'preview' || !address) return
    if (inFlightRef.current) return           // block double-click
    inFlightRef.current = true

    const { grossAmount, maxFee } = state
    const sc = SOURCE_CHAINS[chainIdx]

    try {
      // Step 1: acquire selected connector's provider (no chainId — avoids pre-switch rejection)
      const { provider, connectorUid, account } = await obtainProvider(config)

      // Step 2: switch and verify chain
      setState({ phase: 'approving' })  // show busy immediately before any async op
      try {
        await switchAndVerify(provider, sc.chainId, sc.label, switchChainAsync)
      } catch (err) {
        const e = err as { name?: string; code?: number }
        if (e.code === 4001 || e.name === 'UserRejectedRequestError') {
          setState({ phase: 'preview', chainIdx, grossAmount, maxFee })
          return
        }
        if (err instanceof SwitchUnsupportedError || err instanceof ChainMismatchError) {
          setState({ phase: 'failed', error: (err as Error).message })
          return
        }
        setState({ phase: 'failed', error: classifyWriteError(err, sc.label).message })
        return
      }

      // Step 3: verify connector/account unchanged after switch
      assertConnectorUnchanged(config, connectorUid, account)

      // Step 4: ETH balance check — zero ETH means no gas for approval or burn
      const ethOk = await hasSourceEth(provider as EIP1193Provider, account)
      if (!ethOk) {
        setState({ phase: 'failed', error:
          `No ${sc.label} ETH for gas. Add ETH to your ${sc.label} wallet to pay transaction fees, then retry.` })
        return
      }

      // Step 5: build wallet + public clients bound to confirmed provider + trusted chain
      const viemChain = {
        id: sc.chainId, name: sc.label,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [sc.rpcUrl] } },
      }
      const walletClient = createWalletClient({
        account, chain: viemChain, transport: custom(provider as EIP1193Provider),
      })
      const publicClient = createPublicClient({
        chain: viemChain, transport: http(sc.rpcUrl),
      })

      // Step 6: approve if needed — check for existing persisted approval first
      const currentAllowance = await publicClient.readContract({
        address: sc.usdc, abi: ERC20_ABI, functionName: 'allowance',
        args: [account, sc.messenger],
      }) as bigint

      if (currentAllowance < grossAmount) {
        // Check for a persisted approval hash from a previous attempt
        let approveTxHash = loadApproval(account, sc.chainId)
        let approvalSufficient = false

        if (approveTxHash) {
          // Check if the previously submitted approval confirmed
          try {
            const rcpt = await publicClient.getTransactionReceipt({ hash: approveTxHash })
            if (rcpt?.status === 'reverted') {
              clearApproval(account, sc.chainId)
              approveTxHash = null  // will re-approve below
            } else if (rcpt?.status === 'success') {
              // Confirmed — re-check allowance
              const updatedAllowance = await publicClient.readContract({
                address: sc.usdc, abi: ERC20_ABI, functionName: 'allowance',
                args: [account, sc.messenger],
              }) as bigint
              clearApproval(account, sc.chainId)
              if (updatedAllowance >= grossAmount) {
                // Sufficient allowance — skip re-approval, proceed directly to burn
                approveTxHash = null
                approvalSufficient = true
              } else {
                // Confirmed but insufficient (e.g. partial) — allow new approval
                approveTxHash = null
              }
            }
            // Not yet mined — keep polling below
          } catch { /* receipt not found — keep polling */ }
        }

        if (!approvalSufficient && !approveTxHash) {
          // Verify chain and account still correct before sending
          const chainOk = await verifyChain(provider as EIP1193Provider, sc.chainId, 1, 0)
          if (!chainOk) {
            setState({ phase: 'failed', error:
              `Network changed. Please switch back to ${sc.label} and retry.` })
            return
          }
          assertConnectorUnchanged(config, connectorUid, account)

          try {
            approveTxHash = await walletClient.writeContract({
              address: sc.usdc, abi: ERC20_ABI, functionName: 'approve',
              args: [sc.messenger, grossAmount],
              chain: viemChain, account,
            })
            persistApproval(account, sc.chainId, approveTxHash)
          } catch (approveErr) {
            const cls = classifyWriteError(approveErr, sc.label)
            if (cls.category === 'user_rejected') {
              setState({ phase: 'preview', chainIdx, grossAmount, maxFee })
              return
            }
            // No hash returned — don't classify as indeterminate for preflight rejections
            setState({ phase: 'failed', error: cls.message })
            return
          }
        }

        // Poll for confirmed approval receipt (max 90s, 3s interval)
        // Skip if allowance already sufficient
        const deadline = Date.now() + 90_000
        let approvedOk = approvalSufficient
        while (!approvedOk && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 3000))
          try {
            const rcpt = await publicClient.getTransactionReceipt({ hash: approveTxHash! })
            if (rcpt?.status === 'success') { approvedOk = true; break }
            if (rcpt?.status === 'reverted') {
              clearApproval(account, sc.chainId)
              throw new Error('Approval transaction reverted.')
            }
          } catch (e2) {
            if ((e2 as Error).message?.includes('reverted')) throw e2
            // receipt not found — keep polling
          }
        }
        if (!approvedOk) {
          // Timeout — keep approval hash so reload can resume
          throw new Error('Approval not confirmed within timeout. Please wait and retry.')
        }
      }

      // Step 7: verify chain and account again before burn
      const preBurnOk = await verifyChain(provider as EIP1193Provider, sc.chainId, 1, 0)
      if (!preBurnOk) {
        setState({ phase: 'failed', error:
          `Network changed during approval. Switch back to ${sc.label} and retry.` })
        return
      }
      assertConnectorUnchanged(config, connectorUid, account)

      // Step 8: burn
      const mintRecipient32 = ('0x' + account.toLowerCase().slice(2).padStart(64, '0')) as Hex
      setState({ phase: 'burning' })

      let burnTxHash: Hex | undefined
      try {
        burnTxHash = await walletClient.writeContract({
          address: sc.messenger, abi: TOKEN_MESSENGER_V2_ABI,
          functionName: 'depositForBurnWithHook',
          args: [
            grossAmount, ARC_DOMAIN, mintRecipient32, sc.usdc,
            ('0x' + '00'.repeat(32)) as Hex,  // destinationCaller = zero (permissionless)
            maxFee, 2000, CCTP_FORWARDING_HOOK,
          ],
          chain: viemChain, account,
        })
      } catch (burnErr) {
        const cls = classifyWriteError(burnErr, sc.label)
        if (cls.category === 'user_rejected') {
          setState({ phase: 'preview', chainIdx, grossAmount, maxFee })
          return
        }
        // Only truly indeterminate when: an error with NO classifiable category AND no hash.
        // Classified categories (chain_mismatch, pending_popup, contract_revert, generic) are failed.
        if (!burnTxHash && cls.category === 'generic') {
          // Unknown dispatch/RPC result — do not offer retry
          setState({ phase: 'indeterminate',
            error: 'Bridge result unknown. Check your wallet activity — do not retry until you confirm the transaction failed on-chain.' })
          return
        }
        setState({ phase: 'failed', error: cls.message })
        return
      }

      if (!burnTxHash) {
        setState({ phase: 'indeterminate',
          error: 'Bridge submitted but no transaction hash returned. Check your wallet activity before retrying.' })
        return
      }

      // Step 9: persist burn and start monitoring
      if (address) {
        saveRecord(address, sc.chainId, {
          sourceTxHash: burnTxHash, sourceChainId: sc.chainId,
          destinationAddress: account, grossAmount: grossAmount.toString(),
          status: 'pending_source', destTxHash: null, netAmountReceived: null,
        })
      }
      setState({ phase: 'monitoring', sourceTxHash: burnTxHash, sourceChainId: sc.chainId,
        destAddress: account, grossAmount: grossAmount.toString() })

    } catch (e) {
      if (e instanceof ProviderUnavailableError || e instanceof ConnectorChangedError ||
          e instanceof InsufficientEthError) {
        setState({ phase: 'failed', error: (e as Error).message })
      } else if (e instanceof IndeterminateError) {
        setState({ phase: 'indeterminate', error: (e as Error).message })
      } else {
        setState({ phase: 'failed', error: classifyWriteError(e, sc.label).message })
      }
    } finally {
      inFlightRef.current = false
    }
  }, [state, address, chainIdx, switchChainAsync, config])

  // ── Mint monitoring (poll Circle Messages API + Arc) ─────────────

  useEffect(() => {
    if (state.phase !== 'monitoring') {
      if (pollRef.current) clearTimeout(pollRef.current)
      return
    }
    const { sourceTxHash, sourceChainId, grossAmount } = state
    const destAddress = state.destAddress
    let active = true, delay = 8000

    const poll = async () => {
      if (!active) return
      try {
        const sc = SOURCE_CHAINS.find(s => s.chainId === sourceChainId)
        const srcDomain = sc?.domain ?? 0
        const res = await fetch(
          `${MESSAGES_API}/v2/messages/${srcDomain}?transactionHash=${sourceTxHash}`,
          { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) },
        )
        if (!res.ok) { delay = Math.min(delay * 2, 60000); if (active) pollRef.current = setTimeout(poll, delay); return }
        const data = await res.json() as Record<string, unknown>

        // Validate root sourceTxHash
        if (typeof data.sourceTxHash === 'string' &&
            data.sourceTxHash.toLowerCase() !== sourceTxHash.toLowerCase()) {
          if (active) { delay = Math.min(delay * 2, 60000); pollRef.current = setTimeout(poll, delay) }
          return
        }

        const msgs = data.messages as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(msgs) || !msgs.length) {
          if (active) { delay = Math.min(delay * 1.5, 30000); pollRef.current = setTimeout(poll, delay) }
          return
        }

        // Find matching message: dest domain 26, cctpVersion 2
        const msg = msgs.find(m => {
          const dec = m.decodedMessage as Record<string, unknown> | undefined
          return Number(m.cctpVersion ?? dec?.cctpVersion ?? 0) === 2 &&
                 Number(dec?.destinationDomain) === ARC_DOMAIN
        })
        if (!msg) { if (active) pollRef.current = setTimeout(poll, delay); return }

        // Use forwardTxHash ONLY — no forwardState enum guessing
        const fwdHash = typeof msg.forwardTxHash === 'string' &&
          /^0x[0-9a-fA-F]{64}$/.test(msg.forwardTxHash as string)
          ? msg.forwardTxHash as string : null
        if (!fwdHash) { if (active) pollRef.current = setTimeout(poll, delay); return }

        // Fetch Arc receipt and find USDC Transfer to recipient
        try {
          const rpc = 'https://rpc.mainnet.arc.io' // arc-studio-allow-onchain-literal
          const rcpRes = await fetch(rpc, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [fwdHash] }),
            signal: AbortSignal.timeout(8000),
          })
          if (!rcpRes.ok) { if (active) pollRef.current = setTimeout(poll, delay); return }
          const rcpJson = await rcpRes.json() as { result?: Record<string, unknown> | null }
          const rcpt = rcpJson.result
          if (!rcpt || rcpt.status !== '0x1') { if (active) pollRef.current = setTimeout(poll, delay); return }

          const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
          const logs = (rcpt.logs as Array<{ address: string; topics: string[]; data: string }> | undefined) ?? []
          const transferLog = logs.find(l =>
            l.address.toLowerCase() === ARC_USDC.toLowerCase() &&
            (l.topics[0] ?? '').toLowerCase() === TRANSFER_TOPIC &&
            ('0x' + (l.topics[2] ?? '').slice(-40)).toLowerCase() === destAddress.toLowerCase()
          )
          if (!transferLog) { if (active) pollRef.current = setTimeout(poll, delay); return }

          const netAmount = BigInt('0x' + (transferLog.data.replace(/^0x/, '') || '0'))
          if (address) saveRecord(address, sourceChainId, {
            sourceTxHash, sourceChainId, destinationAddress: destAddress,
            grossAmount, status: 'mint_confirmed', destTxHash: fwdHash,
            netAmountReceived: netAmount.toString(),
          })
          if (active) setState({ phase: 'confirmed', netAmount, destTxHash: fwdHash })
        } catch { if (active) pollRef.current = setTimeout(poll, delay) }
        return
      } catch { /* network error — backoff */ }
      if (active) { delay = Math.min(delay * 1.5, 30000); pollRef.current = setTimeout(poll, delay) }
    }

    pollRef.current = setTimeout(poll, 3000)
    return () => { active = false; if (pollRef.current) clearTimeout(pollRef.current) }
  }, [state, address]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ───────────────────────────────────────────────────────────────

  const infoRow = (label: string, value: string) => (
    <div key={label} className="flex justify-between items-center text-sm py-1">
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="font-medium" style={{ color: 'var(--ink)' }}>{value}</span>
    </div>
  )

  if (state.phase === 'confirmed') {
    return (
      <div className="space-y-5">
        <div className="rounded-2xl p-5 text-center space-y-3"
          style={{ background: 'var(--success-surface, #ecfdf5)', border: '1px solid var(--success-border, #bbf7d0)' }}>
          <div className="text-3xl">✓</div>
          <p className="font-semibold text-lg" style={{ color: 'var(--ink)' }}>
            {formatUnits(state.netAmount, 6)} USDC received
          </p>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>Bridged to your Arc wallet</p>
          {state.destTxHash && (
            <a href={`https://explorer.arc.io/tx/${state.destTxHash}`}
              target="_blank" rel="noopener noreferrer"
              className="text-xs block" style={{ color: 'var(--accent)' }}>
              View on Arc Explorer ↗
            </a>
          )}
        </div>
        <button type="button"
          onClick={() => { if (address) clearRecord(address, SOURCE_CHAINS[chainIdx].chainId); onFunded(state.netAmount) }}
          className="w-full rounded-2xl py-4 font-semibold"
          style={{ background: 'var(--accent)', color: '#fff', minHeight: '56px' }}>
          Create link with this USDC
        </button>
        <button type="button" onClick={onBack} className="w-full text-sm py-2" style={{ color: 'var(--muted)' }}>Back</button>
      </div>
    )
  }

  if (state.phase === 'indeterminate') {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl p-4 text-sm space-y-2"
          style={{ background: 'var(--warning-surface, #fffbeb)', border: '1px solid var(--warning-border, #fde68a)', color: 'var(--warning-text, #92400e)' }}>
          <p className="font-semibold">Bridge status unknown</p>
          <p>{state.error}</p>
        </div>
        <button type="button" onClick={onBack} className="w-full rounded-2xl py-4 font-semibold"
          style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--border)', minHeight: '56px' }}>
          Back to link creation
        </button>
      </div>
    )
  }

  if (state.phase === 'failed') {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl p-4 text-sm"
          style={{ background: 'var(--error-surface, #fef2f2)', border: '1px solid var(--error-border, #fecaca)', color: 'var(--error-text, #dc2626)' }}>
          {state.error}
        </div>
        <button type="button" onClick={() => setState({ phase: 'select' })}
          className="w-full rounded-2xl py-4 font-semibold"
          style={{ background: 'var(--accent)', color: '#fff', minHeight: '56px' }}>
          Try again
        </button>
        <button type="button" onClick={onBack} className="w-full text-sm py-2" style={{ color: 'var(--muted)' }}>Back</button>
      </div>
    )
  }

  if (state.phase === 'monitoring') {
    const sc = SOURCE_CHAINS.find(s => s.chainId === state.sourceChainId)
    return (
      <div className="space-y-5">
        <div className="rounded-2xl p-5 text-center space-y-4"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <Loader2 size={32} className="animate-spin mx-auto" style={{ color: 'var(--accent)' }} />
          <div>
            <p className="font-semibold" style={{ color: 'var(--ink)' }}>Bridging in progress</p>
            <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>Circle is minting USDC on Arc. This typically takes 1–3 minutes.</p>
          </div>
          <div className="text-xs space-y-1 text-left">
            <p style={{ color: 'var(--subtle)' }}>
              Source tx:&nbsp;
              <a href={`${sc?.explorerBase ?? ''}/tx/${state.sourceTxHash}`}
                target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                {state.sourceTxHash.slice(0, 12)}…
              </a>
            </p>
            <p style={{ color: 'var(--subtle)' }}>Destination: Arc ({state.destAddress.slice(0, 8)}…)</p>
          </div>
          <p className="text-xs" style={{ color: 'var(--subtle)' }}>You can close and return — the transfer will complete in the background.</p>
        </div>
      </div>
    )
  }

  if (state.phase === 'approving' || state.phase === 'burning') {
    const label = state.phase === 'approving' ? 'Waiting for USDC approval…' : 'Waiting for bridge burn…'
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12">
        <Loader2 size={32} className="animate-spin" style={{ color: 'var(--accent)' }} />
        <p className="text-sm font-medium" style={{ color: 'var(--ink)' }}>{label}</p>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>Confirm in your wallet.</p>
      </div>
    )
  }

  if (state.phase === 'preview') {
    const { grossAmount, maxFee } = state
    const sc = SOURCE_CHAINS[chainIdx]
    const minReceived = grossAmount - maxFee
    return (
      <div className="space-y-5">
        <h2 className="text-base font-semibold" style={{ color: 'var(--ink)' }}>Review bridge</h2>
        <div className="rounded-2xl p-4 space-y-1 divide-y"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          {infoRow('Source', sc.label)}
          {infoRow('Destination', 'Arc (your wallet)')}
          {infoRow('You send', `${formatUnits(grossAmount, 6)} USDC`)}
          {infoRow('Max bridge fee', `${formatUnits(maxFee, 6)} USDC`)}
          {infoRow('Min you receive', `${formatUnits(minReceived, 6)} USDC`)}
        </div>
        <div className="rounded-xl px-4 py-3 text-xs" style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
          Source {sc.label} ETH is required for gas. After bridging, USDC arrives directly in your Arc wallet.
        </div>
        <button type="button" onClick={() => void handleBurn()}
          className="w-full rounded-2xl py-4 font-semibold"
          style={{ background: 'var(--accent)', color: '#fff', minHeight: '56px' }}>
          Approve &amp; Bridge
        </button>
        <button type="button" onClick={() => setState({ phase: 'select' })}
          className="w-full text-sm py-2" style={{ color: 'var(--muted)' }}>← Back</button>
      </div>
    )
  }

  // ── Select phase ──────────────────────────────────────────────────────────
  const balanceDisplay = balance !== undefined ? formatUnits(balance, 6) : '…'

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--ink)' }}>Fund from another chain</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Bridge USDC via Circle CCTP V2 to your Arc wallet.</p>
      </div>
      <div>
        <label className="text-xs font-medium block mb-2" style={{ color: 'var(--muted)' }}>Source chain</label>
        <div className="flex gap-2">
          {SOURCE_CHAINS.map((sc, i) => (
            <button key={sc.chainId} type="button"
              onClick={() => { setChainIdx(i); setAmountStr(''); setAmountError('') }}
              className="flex-1 rounded-xl py-3 text-sm font-medium transition-colors"
              style={{
                background: chainIdx === i ? 'var(--accent)' : 'var(--surface)',
                color:      chainIdx === i ? '#fff' : 'var(--ink)',
                border:     chainIdx === i ? 'none' : '1px solid var(--border)',
                minHeight: '44px',
              }}>
              {sc.shortLabel}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--muted)' }}>
        <span className="rounded-lg px-2 py-1" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>{srcChain.shortLabel}</span>
        <ArrowDown size={14} />
        <span className="rounded-lg px-2 py-1" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>Arc</span>
      </div>
      <div>
        <div className="flex justify-between items-center mb-2">
          <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Amount (USDC)</label>
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>Balance: {balanceDisplay} USDC</span>
        </div>
        <input type="text" inputMode="decimal" value={amountStr}
          onChange={e => { setAmountStr(e.target.value); setAmountError('') }}
          placeholder="0.00"
          className="w-full rounded-xl px-4 py-3 text-lg font-medium outline-none"
          style={{ background: 'var(--surface)', border: `1px solid ${amountError ? 'var(--error, #dc2626)' : 'var(--border)'}`,
            color: 'var(--ink)', minHeight: '52px' }}
          aria-invalid={!!amountError} aria-describedby={amountError ? 'amount-error' : undefined} />
        {amountError && (
          <p id="amount-error" className="text-xs mt-1" style={{ color: 'var(--error, #dc2626)' }} role="alert">{amountError}</p>
        )}
      </div>
      {irisError && (
        <p className="text-xs rounded-xl px-3 py-2"
          style={{ background: 'var(--error-surface, #fef2f2)', color: 'var(--error-text, #dc2626)', border: '1px solid var(--error-border, #fecaca)' }}>
          {irisError}
        </p>
      )}
      <button type="button" disabled={irisLoading || !address} onClick={() => void handlePreview()}
        className="w-full rounded-2xl py-4 font-semibold flex items-center justify-center gap-2"
        style={{ background: irisLoading || !address ? 'var(--surface-muted)' : 'var(--accent)',
          color: irisLoading || !address ? 'var(--subtle)' : '#fff',
          minHeight: '56px', cursor: irisLoading || !address ? 'not-allowed' : 'pointer' }}>
        {irisLoading ? <><Loader2 size={16} className="animate-spin" /> Fetching fees…</> : 'Preview bridge'}
      </button>
      <button type="button" onClick={onBack} className="w-full text-sm py-2" style={{ color: 'var(--muted)' }}>
        ← Back to link creation
      </button>
    </div>
  )
}

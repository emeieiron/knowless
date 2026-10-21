/**
 * FundFromChain — fund an Arc Testnet knowless link from Ethereum Sepolia or Base Sepolia
 * via CCTP V2 depositForBurnWithHook.
 *
 * Flow:
 *   1. User selects source chain and enters USDC amount.
 *   2. Component shows gross debit, max bridge fee, min received, and estimated gas.
 *   3. User approves USDC spend on source chain, then burns via TokenMessengerV2.
 *   4. Component polls Circle Messages API and the Arc Testnet RPC for destination confirmation.
 *   5. On confirmed destination mint, user proceeds to create the link.
 *
 * The destination (Arc Testnet) wallet is the user's OWN wagmi-connected address — minted
 * directly there, never to the escrow or a relay wallet.
 *
 * Security:
 *   - No private key access.
 *   - All chain config is static constants; no caller-supplied RPC URLs.
 *   - Source burns only after explicit user approval.
 *   - Persistence: txHash stored in sessionStorage under a deterministic key so reload
 *     resumes polling without re-burning.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import {
  useAccount, useWriteContract, useSwitchChain,
  useReadContract, useWaitForTransactionReceipt,
} from 'wagmi'
import { formatUnits, parseUnits, type Address, type Hex } from 'viem'
import { ArrowDown, Loader2 } from 'lucide-react'

// ── Static chain/token config ───────────────────────────────────────────────

const ARC_TESTNET_CHAIN_ID     = 5042002
const ARC_TESTNET_USDC: Address = '0x3600000000000000000000000000000000000000' // arc-studio-allow-onchain-literal

const SOURCE_CHAINS = [
  {
    chainId:       11155111,
    label:         'Ethereum Sepolia',
    shortLabel:    'Eth Sepolia',
    usdc:          '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address, // arc-studio-allow-onchain-literal
    messenger:     '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as Address, // arc-studio-allow-onchain-literal
    explorerBase:  'https://sepolia.etherscan.io',
    rpcUrl:        'https://rpc.sepolia.org',
  },
  {
    chainId:       84532,
    label:         'Base Sepolia',
    shortLabel:    'Base Sepolia',
    usdc:          '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address, // arc-studio-allow-onchain-literal
    messenger:     '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as Address, // arc-studio-allow-onchain-literal
    explorerBase:  'https://sepolia.basescan.org',
    rpcUrl:        'https://sepolia.base.org',
  },
] as const

// Arc Testnet domain in CCTP
const ARC_TESTNET_DOMAIN = 26

// Fixed forwarding hook as documented in Circle V2 docs (32-byte selector for "cctp-forward")
const CCTP_FORWARDING_HOOK =
  '0x636374702d666f72776172640000000000000000000000000000000000000000' as Hex

const MESSAGES_API = 'https://iris-api-sandbox.circle.com'

// Minimal ABIs
const ERC20_ABI = [
  {
    type: 'function', name: 'balanceOf',
    inputs:  [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'allowance',
    inputs:  [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'approve',
    inputs:  [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const

const TOKEN_MESSENGER_V2_ABI = [
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    inputs: [
      { name: 'amount',           type: 'uint256' },
      { name: 'destinationDomain',type: 'uint32'  },
      { name: 'mintRecipient',    type: 'bytes32' },
      { name: 'burnToken',        type: 'address' },
      { name: 'destinationCaller',type: 'bytes32' },
      { name: 'maxFee',           type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData',         type: 'bytes'   },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

// ── Session storage for transfer record ──────────────────────────────────────

interface FundRecord {
  sourceTxHash:       string
  sourceChainId:      number
  destinationAddress: string
  grossAmount:        string  // decimal 6-dec USDC
  status:             'pending_source' | 'source_confirmed' | 'mint_confirmed' | 'failed'
  destTxHash:         string | null
  netAmountReceived:  string | null
}

function recordKey(address: string, sourceChainId: number) {
  return `knowless:fund:${address.toLowerCase()}:${sourceChainId}`
}

function loadRecord(address: string, sourceChainId: number): FundRecord | null {
  try {
    const raw = sessionStorage.getItem(recordKey(address, sourceChainId))
    return raw ? JSON.parse(raw) as FundRecord : null
  } catch { return null }
}

function saveRecord(address: string, sourceChainId: number, rec: FundRecord): void {
  try {
    sessionStorage.setItem(recordKey(address, sourceChainId), JSON.stringify(rec))
  } catch { /* storage full — non-fatal */ }
}

function clearRecord(address: string, sourceChainId: number): void {
  try { sessionStorage.removeItem(recordKey(address, sourceChainId)) } catch { /* ok */ }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface FundFromChainProps {
  onFunded: (netAmountUsdc: bigint) => void
  onBack:   () => void
}

type FundState =
  | { phase: 'select' }                     // source chain + amount selection
  | { phase: 'preview'; chainIdx: number; grossAmount: bigint; maxFee: bigint }
  | { phase: 'approving' }                  // waiting for approve tx
  | { phase: 'burning' }                    // waiting for depositForBurnWithHook tx
  | { phase: 'monitoring'; sourceTxHash: string; sourceChainId: number; destAddress: string; grossAmount: string }
  | { phase: 'confirmed'; netAmount: bigint; destTxHash: string }
  | { phase: 'failed'; error: string }

export function FundFromChain({ onFunded, onBack }: FundFromChainProps) {
  const { address, chainId: connectedChainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()

  const [chainIdx, setChainIdx] = useState(0)
  const [amountStr, setAmountStr] = useState('')
  const [amountError, setAmountError] = useState('')
  const [state, setState] = useState<FundState>({ phase: 'select' })
  const [irisLoading, setIrisLoading] = useState(false)
  const [irisError, setIrisError]     = useState('')
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const srcChain = SOURCE_CHAINS[chainIdx]

  // ── Reload: check for existing transfer record ──────────────────────────
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
        setState({
          phase: 'monitoring',
          sourceTxHash:   rec.sourceTxHash,
          sourceChainId:  sc.chainId,
          destAddress:    rec.destinationAddress,
          grossAmount:    rec.grossAmount,
        })
        setChainIdx(scIdx >= 0 ? scIdx : 0)
        return
      }
    }
  }, [address])

  // ── Balance + allowance reads ────────────────────────────────────────────

  const { data: balanceRaw, refetch: refetchBalance } = useReadContract({
    address: srcChain.usdc,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
    chainId: srcChain.chainId,
  })
  const balance = balanceRaw as bigint | undefined

  const grossAmountBigInt: bigint | null = (() => {
    try { return amountStr ? parseUnits(amountStr, 6) : null }
    catch { return null }
  })()

  const { data: allowanceRaw } = useReadContract({
    address: srcChain.usdc,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, srcChain.messenger] : undefined,
    query: { enabled: !!address && grossAmountBigInt !== null },
    chainId: srcChain.chainId,
  })
  const allowance = allowanceRaw as bigint | undefined

  // ── Write hooks ──────────────────────────────────────────────────────────

  const { writeContractAsync: approveAsync } = useWriteContract()
  const { writeContractAsync: burnAsync }    = useWriteContract()

  // ── Approve + burn flow ──────────────────────────────────────────────────

  const handlePreview = useCallback(async () => {
    setAmountError('')
    if (!address) return
    if (!amountStr.trim()) { setAmountError('Enter an amount'); return }
    const amt = (() => { try { return parseUnits(amountStr, 6) } catch { return null } })()
    if (!amt || amt <= 0n) { setAmountError('Enter a valid USDC amount'); return }
    if (balance !== undefined && amt > balance) {
      setAmountError(`Max: ${formatUnits(balance, 6)} USDC`)
      return
    }

    setIrisLoading(true)
    setIrisError('')
    try {
      const url = `${MESSAGES_API}/v2/burn/USDC/fees/26/${ARC_TESTNET_DOMAIN === 26 ? '0' : '6'}?forward=true`
      // Actually we need the SOURCE domain → ARC domain. Source domain for ETH Sepolia=0, Base Sepolia=6.
      // The query is: GET /v2/burn/USDC/fees/{sourceDomain}/{destDomain}?forward=true
      // Arc is destination (domain 26 for inbound funding? No — Arc is domain 26 for OUTGOING from Arc)
      // For INBOUND funding, source is 0/6, destination is Arc (domain 26).
      // Arc domain number: per Circle docs, Arc Testnet = domain 26.
      const srcDomain = srcChain.chainId === 11155111 ? 0 : 6
      const irisUrl = `${MESSAGES_API}/v2/burn/USDC/fees/${srcDomain}/26?forward=true`
      const res = await fetch(irisUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`Iris returned ${res.status}`)
      const data = await res.json() as unknown[]
      const standard = (data as Array<Record<string, unknown>>).find(f => Number(f.finalityThreshold) === 2000)
      if (!standard) throw new Error('No standard-finality fee tier available')
      const feeObj = standard.forwardFee as Record<string, unknown> | undefined
      const highStr = String(feeObj?.high ?? '')
      if (!/^\d+$/.test(highStr)) throw new Error('Unexpected fee format from Iris API')
      const maxFee = BigInt(highStr) + (BigInt(highStr) / 100n > 5000n ? BigInt(highStr) / 100n : 5000n)
      setState({ phase: 'preview', chainIdx, grossAmount: amt, maxFee })
    } catch (e) {
      setIrisError((e as Error).message)
    } finally {
      setIrisLoading(false)
    }
  }, [address, amountStr, balance, chainIdx, srcChain])

  const handleBurn = useCallback(async () => {
    if (state.phase !== 'preview' || !address) return
    const { grossAmount, maxFee } = state
    const sc = SOURCE_CHAINS[chainIdx]

    try {
      // Switch to source chain if needed
      if (connectedChainId !== sc.chainId) {
        await switchChainAsync({ chainId: sc.chainId })
      }

      // Approve if needed — wait for confirmed receipt before burn
      if ((allowance ?? 0n) < grossAmount) {
        setState({ phase: 'approving' })
        const approveTxHash = await approveAsync({
          address: sc.usdc,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [sc.messenger, grossAmount],
          chainId: sc.chainId,
        })
        // Poll for approval receipt (max 90s, 3s interval)
        const approveDeadline = Date.now() + 90_000
        let approvedOk = false
        while (Date.now() < approveDeadline) {
          await new Promise(r => setTimeout(r, 3000))
          try {
            const rcpRes = await fetch(sc.rpcUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1,
                method: 'eth_getTransactionReceipt', params: [approveTxHash] }),
            })
            const rcp = await rcpRes.json() as { result?: { status?: string } | null }
            if (rcp.result?.status === '0x1') { approvedOk = true; break }
            if (rcp.result?.status === '0x0') throw new Error('Approval transaction reverted.')
          } catch (e2) { if ((e2 as Error).message?.includes('reverted')) throw e2 }
        }
        if (!approvedOk) throw new Error('Approval not confirmed within timeout. Check your wallet.')
        await refetchBalance()
      }

      // Convert recipient address to bytes32 (left-padded to 32 bytes)
      const mintRecipientBytes32 = ('0x' + address.toLowerCase().slice(2).padStart(64, '0')) as Hex

      setState({ phase: 'burning' })
      let burnTxHash: string | undefined
      try {
        burnTxHash = await burnAsync({
          address: sc.messenger,
          abi: TOKEN_MESSENGER_V2_ABI,
          functionName: 'depositForBurnWithHook',
          args: [
            grossAmount,
            ARC_TESTNET_DOMAIN,
            mintRecipientBytes32,
            sc.usdc,
            ('0x' + '00'.repeat(32)) as `0x${string}`,  // destinationCaller = zero (permissionless forwarding)
            maxFee,
            2000,  // standard finalityThreshold
            CCTP_FORWARDING_HOOK,
          ],
          chainId: sc.chainId,
        })
      } catch (burnErr) {
        const bMsg = (burnErr as Error).message ?? ''
        if (!burnTxHash && !bMsg.includes('User rejected') && !bMsg.includes('user rejected')) {
          // Unknown result — no hash returned, not a rejection. Show indeterminate guidance.
          setState({ phase: 'failed', error:
            'Burn result unknown. Check your wallet activity — if a transaction appeared, do not retry until you confirm it failed, to avoid a double burn.' })
          return
        }
        throw burnErr
      }

      if (!burnTxHash) {
        setState({ phase: 'failed', error:
          'Burn submitted but hash not returned by wallet. Check your wallet activity before retrying.' })
        return
      }

      // Save public record before updating state
      const rec: FundRecord = {
        sourceTxHash:       burnTxHash,
        sourceChainId:      sc.chainId,
        destinationAddress: address,
        grossAmount:        grossAmount.toString(),
        status:             'pending_source',
        destTxHash:         null,
        netAmountReceived:  null,
      }
      saveRecord(address, sc.chainId, rec)

      setState({
        phase:          'monitoring',
        sourceTxHash:   burnTxHash,
        sourceChainId:  sc.chainId,
        destAddress:    address,
        grossAmount:    grossAmount.toString(),
      })
    } catch (e) {
      const msg = (e as Error).message ?? ''
      const safe = msg.includes('User rejected') || msg.includes('user rejected')
        ? 'Transaction rejected in wallet.'
        : msg.includes('chain') ? 'Wrong chain — please switch and retry.'
        : msg.includes('timeout') || msg.includes('reverted') || msg.includes('wallet activity')
          ? msg
          : 'Transaction failed. Check your wallet and retry.'
      setState({ phase: 'failed', error: safe })
    }
  }, [state, address, chainIdx, connectedChainId, switchChainAsync, allowance, approveAsync, burnAsync, refetchBalance])

  // ── Mint monitoring (poll Circle Messages API + Arc Testnet) ─────────────

  useEffect(() => {
    if (state.phase !== 'monitoring') {
      if (pollRef.current) clearTimeout(pollRef.current)
      return
    }
    const { sourceTxHash, sourceChainId, grossAmount } = state
    let active = true
    let delay = 8000

    const poll = async () => {
      if (!active) return
      try {
        const srcDomain = sourceChainId === 11155111 ? 0 : 6
        const url = `${MESSAGES_API}/v2/messages/${srcDomain}?transactionHash=${sourceTxHash}`
        const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
        if (!res.ok) { delay = Math.min(delay * 2, 60000); pollRef.current = setTimeout(poll, delay); return }
        const data = await res.json() as Record<string, unknown>

        // Root sourceTxHash validation
        if (data.sourceTxHash && typeof data.sourceTxHash === 'string' &&
            data.sourceTxHash.toLowerCase() !== sourceTxHash.toLowerCase()) {
          // Mismatch — unexpected response
          delay = Math.min(delay * 2, 60000)
          if (active) pollRef.current = setTimeout(poll, delay)
          return
        }

        const msgs = data.messages as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(msgs) || msgs.length === 0) {
          if (active) { delay = Math.min(delay * 1.5, 30000); pollRef.current = setTimeout(poll, delay) }
          return
        }

        // Find matching message: dest domain 26, cctpVersion 2
        const msg = msgs.find(m => {
          const dec = m.decodedMessage as Record<string, unknown> | undefined
          return Number(m.cctpVersion ?? dec?.cctpVersion ?? 0) === 2 &&
                 Number(dec?.destinationDomain) === ARC_TESTNET_DOMAIN
        })
        if (!msg) { if (active) pollRef.current = setTimeout(poll, delay); return }

        const fwdState = String(msg.forwardState ?? '').toLowerCase()
        const fwdHash = typeof msg.forwardTxHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(msg.forwardTxHash as string)
          ? msg.forwardTxHash as string : null

        if (fwdState === 'failed') {
          if (address) saveRecord(address, sourceChainId, {
            sourceTxHash, sourceChainId, destinationAddress: address ?? '',
            grossAmount, status: 'failed', destTxHash: null, netAmountReceived: null,
          })
          if (active) setState({ phase: 'failed', error: 'Circle forwarding service reported failure. Please contact support.' })
          return
        }

        if ((fwdState === 'complete' || msg.status === 'complete') && fwdHash) {
          // Fetch Arc Testnet receipt to verify actual net amount
          try {
            const rpc = 'https://rpc.testnet.arc.io' // arc-studio-allow-onchain-literal
            const rcpRes = await fetch(rpc, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [fwdHash] }),
              signal: AbortSignal.timeout(8000),
            })
            if (!rcpRes.ok) { if (active) pollRef.current = setTimeout(poll, delay); return }
            const rcpJson = await rcpRes.json() as { result?: Record<string, unknown> | null }
            const rcpt = rcpJson.result
            if (!rcpt || rcpt.status !== '0x1') { if (active) pollRef.current = setTimeout(poll, delay); return }

            // Find USDC Transfer to recipient in receipt logs
            const ARC_USDC = ARC_TESTNET_USDC.toLowerCase()
            const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
            const destAddr = (state as { destAddress: string }).destAddress ?? address ?? ''
            const logs = (rcpt.logs as Array<{ address: string; topics: string[]; data: string }> | undefined) ?? []
            const transferLog = logs.find(l =>
              l.address.toLowerCase() === ARC_USDC &&
              (l.topics[0] ?? '').toLowerCase() === TRANSFER_TOPIC &&
              ('0x' + (l.topics[2] ?? '').slice(-40)).toLowerCase() === destAddr.toLowerCase()
            )
            if (!transferLog) { if (active) pollRef.current = setTimeout(poll, delay); return }

            const netAmount = BigInt('0x' + (transferLog.data.replace(/^0x/, '') || '0'))
            const rec: FundRecord = {
              sourceTxHash, sourceChainId, destinationAddress: destAddr,
              grossAmount, status: 'mint_confirmed',
              destTxHash: fwdHash, netAmountReceived: netAmount.toString(),
            }
            if (address) saveRecord(address, sourceChainId, rec)
            if (active) setState({ phase: 'confirmed', netAmount, destTxHash: fwdHash })
          } catch { if (active) pollRef.current = setTimeout(poll, delay) }
          return
        }
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
    const srcChainCfg = SOURCE_CHAINS[chainIdx]
    return (
      <div className="space-y-5">
        <div className="rounded-2xl p-5 text-center space-y-3"
          style={{ background: 'var(--success-surface, #ecfdf5)', border: '1px solid var(--success-border, #bbf7d0)' }}>
          <div className="text-3xl">✓</div>
          <p className="font-semibold text-lg" style={{ color: 'var(--ink)' }}>
            {formatUnits(state.netAmount, 6)} USDC received
          </p>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Bridged from {srcChainCfg.shortLabel} to Arc Testnet
          </p>
          {state.destTxHash && (
            <a href={`https://explorer.testnet.arc.io/tx/${state.destTxHash}`}
              target="_blank" rel="noopener noreferrer"
              className="text-xs block" style={{ color: 'var(--accent)' }}>
              View on Arc Explorer ↗
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            if (address) clearRecord(address, SOURCE_CHAINS[chainIdx].chainId)
            onFunded(state.netAmount)
          }}
          className="w-full rounded-2xl py-4 font-semibold"
          style={{ background: 'var(--accent)', color: '#fff', minHeight: '56px' }}>
          Create link with this USDC
        </button>
        <button type="button" onClick={onBack}
          className="w-full text-sm py-2" style={{ color: 'var(--muted)' }}>
          Back
        </button>
      </div>
    )
  }

  if (state.phase === 'failed') {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl p-4 text-sm" style={{ background: 'var(--error-surface, #fef2f2)', border: '1px solid var(--error-border, #fecaca)', color: 'var(--error-text, #dc2626)' }}>
          {state.error}
        </div>
        <button type="button"
          onClick={() => setState({ phase: 'select' })}
          className="w-full rounded-2xl py-4 font-semibold"
          style={{ background: 'var(--accent)', color: '#fff', minHeight: '56px' }}>
          Try again
        </button>
        <button type="button" onClick={onBack} className="w-full text-sm py-2" style={{ color: 'var(--muted)' }}>
          Back
        </button>
      </div>
    )
  }

  if (state.phase === 'monitoring') {
    return (
      <div className="space-y-5">
        <div className="rounded-2xl p-5 text-center space-y-4"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <Loader2 size={32} className="animate-spin mx-auto" style={{ color: 'var(--accent)' }} />
          <div>
            <p className="font-semibold" style={{ color: 'var(--ink)' }}>Bridging in progress</p>
            <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
              Circle is minting USDC on Arc Testnet. This typically takes 1–3 minutes.
            </p>
          </div>
          <div className="text-xs space-y-1 text-left">
            <p style={{ color: 'var(--subtle)' }}>
              Source tx:&nbsp;
              <a href={`${SOURCE_CHAINS.find(s => s.chainId === state.sourceChainId)?.explorerBase ?? ''}/tx/${state.sourceTxHash}`}
                target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                {state.sourceTxHash.slice(0, 12)}…
              </a>
            </p>
            <p style={{ color: 'var(--subtle)' }}>Destination: Arc Testnet ({state.destAddress.slice(0, 8)}…)</p>
          </div>
          <p className="text-xs" style={{ color: 'var(--subtle)' }}>
            You can close and return — the transfer will complete in the background.
          </p>
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
          style={{ background: 'var(--surface)', border: '1px solid var(--border)'}}>
          {infoRow('Source', sc.label)}
          {infoRow('Destination', 'Arc Testnet (your wallet)')}
          {infoRow('You send', `${formatUnits(grossAmount, 6)} USDC`)}
          {infoRow('Max bridge fee', `${formatUnits(maxFee, 6)} USDC`)}
          {infoRow('Min you receive', `${formatUnits(minReceived, 6)} USDC`)}
        </div>
        <div className="rounded-xl px-4 py-3 text-xs" style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
          After the bridge confirms, you will receive USDC directly in your Arc Testnet wallet. Create a link from there.
        </div>
        <button type="button"
          onClick={() => void handleBurn()}
          className="w-full rounded-2xl py-4 font-semibold"
          style={{ background: 'var(--accent)', color: '#fff', minHeight: '56px' }}>
          Approve &amp; Bridge
        </button>
        <button type="button"
          onClick={() => setState({ phase: 'select' })}
          className="w-full text-sm py-2" style={{ color: 'var(--muted)' }}>
          ← Back
        </button>
      </div>
    )
  }

  // ── Select phase ─────────────────────────────────────────────────────────
  const balanceDisplay = balance !== undefined ? formatUnits(balance, 6) : '…'

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--ink)' }}>Fund from another chain</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Bridge USDC via Circle CCTP V2 directly to your Arc Testnet wallet.
        </p>
      </div>

      {/* Source chain selector */}
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
                minHeight:  '44px',
              }}>
              {sc.shortLabel}
            </button>
          ))}
        </div>
      </div>

      {/* Source → Destination indicator */}
      <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--muted)' }}>
        <span className="rounded-lg px-2 py-1" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
          {srcChain.shortLabel}
        </span>
        <ArrowDown size={14} />
        <span className="rounded-lg px-2 py-1" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
          Arc Testnet
        </span>
      </div>

      {/* Amount input */}
      <div>
        <div className="flex justify-between items-center mb-2">
          <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Amount (USDC)</label>
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>
            Balance: {balanceDisplay} USDC
          </span>
        </div>
        <input
          type="text"
          inputMode="decimal"
          value={amountStr}
          onChange={e => { setAmountStr(e.target.value); setAmountError('') }}
          placeholder="0.00"
          className="w-full rounded-xl px-4 py-3 text-lg font-medium outline-none"
          style={{
            background: 'var(--surface)',
            border: `1px solid ${amountError ? 'var(--error, #dc2626)' : 'var(--border)'}`,
            color: 'var(--ink)',
            minHeight: '52px',
          }}
          aria-invalid={!!amountError}
          aria-describedby={amountError ? 'amount-error' : undefined}
        />
        {amountError && (
          <p id="amount-error" className="text-xs mt-1" style={{ color: 'var(--error, #dc2626)' }} role="alert">
            {amountError}
          </p>
        )}
      </div>

      {irisError && (
        <p className="text-xs rounded-xl px-3 py-2"
          style={{ background: 'var(--error-surface, #fef2f2)', color: 'var(--error-text, #dc2626)', border: '1px solid var(--error-border, #fecaca)' }}>
          {irisError}
        </p>
      )}

      <button type="button"
        disabled={irisLoading || !address}
        onClick={() => void handlePreview()}
        className="w-full rounded-2xl py-4 font-semibold flex items-center justify-center gap-2"
        style={{
          background: irisLoading || !address ? 'var(--surface-muted)' : 'var(--accent)',
          color: irisLoading || !address ? 'var(--subtle)' : '#fff',
          minHeight: '56px',
          cursor: irisLoading || !address ? 'not-allowed' : 'pointer',
        }}>
        {irisLoading ? <><Loader2 size={16} className="animate-spin" /> Fetching fees…</> : 'Preview bridge'}
      </button>

      <button type="button" onClick={onBack}
        className="w-full text-sm py-2" style={{ color: 'var(--muted)' }}>
        ← Back to link creation
      </button>
    </div>
  )
}

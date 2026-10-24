/**
 * CreateLinkForm — issuer creates and funds a new spendable link.
 *
 * FLOW: approve USDC → createLink tx → done (parent callback)
 *
 * Finding 4: Balance check includes GAS_RESERVE_USDC. All amounts use 6-dec ERC-20 USDC.
 * Finding 5: `step` is DERIVED from wagmi states — no useEffect setState transitions.
 *            Side-effects (callback, storage update) run in a single useEffect keyed on
 *            the createHash, preventing double-fire. Double-click prevented by disabling
 *            buttons during pending operations. Error recovery: button re-enables when
 *            wagmi error clears (rejection resets write hook state via reset()).
 * Finding 6: saveLink throws on quota — caught here, shown as actionable error.
 * Finding 8: chainId undefined (chain not yet resolved after connect) is treated as
 *            wrong-chain. handleApprove/handleCreate re-check chainId synchronously
 *            before submitting so a stale wagmi snapshot never reaches writeContract.
 *            Error classifier maps -32002/4001/4902/chain-mismatch codes to actionable
 *            messages instead of slicing raw provider strings.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
  useReadContract,
} from 'wagmi'
import { erc20Abi } from 'viem'
import type { Address, Hex } from 'viem'
import { SPOOKLY_ABI, ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC } from '../lib/contract'
import { generateLinkKey, deriveSignerAddress, buildLinkUrl } from '../lib/crypto'
import { saveLink, updateLinkTxHash } from '../lib/storage'
import { parseUsdcInput, formatUsdcFixed } from '../lib/format'
import { classifyWriteError } from '../lib/writeError'

const ARC_EXPLORER = 'https://explorer.arc.io' // arc-studio-allow-onchain-literal
function buildTxExplorerUrl(_chainId: number, txHash: string): string {
  return `${ARC_EXPLORER}/tx/${txHash}`
}

const EXPIRY_OPTIONS = [
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 7 * 86400 },
  { label: '30 days', seconds: 30 * 86400 },
]

const DEFAULT_FEE_BUDGET_USDC = 100_000n   // 0.10 USDC (6 dec)
const DEFAULT_FEE_BUDGET_STR = '0.10'

// Conservative gas reserve for approve + createLink gas (≈ 2 txs × ~0.001 USDC each on Arc)
const GAS_RESERVE_USDC = 3_000n  // 0.003 USDC (6 dec)

interface CreateLinkFormProps {
  contractAddress: Address
  onLinkCreated: (linkUrl: string, signerAddress: Address) => void
}

export function CreateLinkForm({ contractAddress, onLinkCreated }: CreateLinkFormProps) {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain } = useSwitchChain()
  // Treat chainId===undefined (chain not yet resolved after connect) as wrong-chain.
  // A wagmi snapshot with chainId=undefined can happen in the render cycle immediately
  // after connection approval; sending a write with the wrong chain causes the wallet
  // to reject with "does not match the target chain".
  const isWrongChain = isConnected && chainId !== ARC_TESTNET_CHAIN_ID

  const [amountStr, setAmountStr] = useState('')
  const [expiryIdx, setExpiryIdx] = useState(1)
  const [storageError, setStorageError] = useState('')

  // Keypair generated at start of create — persisted in ref to survive re-renders
  const pendingKeyRef = useRef<Hex | null>(null)
  const pendingSignerRef = useRef<Address | null>(null)

  // Read USDC ERC-20 balance (6-dec)
  const { data: usdcBalance } = useReadContract({
    address: ARC_TESTNET_USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  })

  // Read USDC allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: ARC_TESTNET_USDC,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, contractAddress] : undefined,
    query: { enabled: !!address },
  })

  // Approve USDC
  const {
    writeContract: approve,
    data: approveHash,
    isPending: isApproving,
    error: approveError,
    reset: resetApprove,
  } = useWriteContract()
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } =
    useWaitForTransactionReceipt({ hash: approveHash })

  // Create link
  const {
    writeContract: createLink,
    data: createHash,
    isPending: isCreating,
    error: createError,
    reset: resetCreate,
  } = useWriteContract()
  const { isLoading: isCreateConfirming, isSuccess: isCreateSuccess } =
    useWaitForTransactionReceipt({ hash: createHash })

  const parsedAmount = parseUsdcInput(amountStr)
  const totalNeeded = parsedAmount ? parsedAmount + DEFAULT_FEE_BUDGET_USDC : null
  const effectiveBalance = usdcBalance !== undefined ? (usdcBalance) - GAS_RESERVE_USDC : null
  const maxAmount = effectiveBalance !== null && effectiveBalance > DEFAULT_FEE_BUDGET_USDC
    ? effectiveBalance - DEFAULT_FEE_BUDGET_USDC
    : 0n

  const amountError = amountStr && parsedAmount === null
    ? 'Enter a valid USDC amount (e.g. 5.00)'
    : parsedAmount !== null && parsedAmount < 1000n
      ? 'Minimum 0.001 USDC'
      : parsedAmount !== null && totalNeeded !== null && usdcBalance !== undefined
          && usdcBalance < totalNeeded + GAS_RESERVE_USDC
        ? 'Insufficient balance (amount + fee budget + gas reserve exceeds available USDC)'
        : ''

  const needsApproval = allowance !== undefined && parsedAmount !== null
    ? allowance < (parsedAmount + DEFAULT_FEE_BUDGET_USDC)
    : true

  const canProceed = parsedAmount !== null && parsedAmount > 0n && !amountError && isConnected && !isWrongChain

  // Classify write errors into user-facing categories
  const approveClassified = approveError ? classifyWriteError(approveError) : null
  const createClassified  = createError  ? classifyWriteError(createError)  : null
  const isApproveRejected = approveClassified?.category === 'user_rejected'
  const isCreateRejected  = createClassified?.category  === 'user_rejected'

  const isApproveInFlight = isApproving || isApproveConfirming
  const isCreateInFlight = isCreating || isCreateConfirming
  const isAnyInFlight = isApproveInFlight || isCreateInFlight

  // Refresh allowance after approval confirms — single-fire via hash
  useEffect(() => {
    if (!isApproveSuccess || !approveHash) return
    void refetchAllowance()
  }, [isApproveSuccess, approveHash, refetchAllowance])

  // After create confirms — single-fire via createHash
  const didFireCallback = useRef<string | null>(null)
  useEffect(() => {
    if (!isCreateSuccess || !createHash) return
    if (didFireCallback.current === createHash) return
    didFireCallback.current = createHash
    const privateKey = pendingKeyRef.current
    const signerAddress = pendingSignerRef.current
    if (!privateKey || !signerAddress || !address) return
    updateLinkTxHash(ARC_TESTNET_CHAIN_ID, contractAddress, address, signerAddress, createHash)
    const url = buildLinkUrl(privateKey, contractAddress, ARC_TESTNET_CHAIN_ID)
    onLinkCreated(url, signerAddress)
  }, [isCreateSuccess, createHash, address, contractAddress, onLinkCreated])

  // ── Actions ────────────────────────────────────────────────────────────

  const handleApprove = useCallback(() => {
    if (!parsedAmount || !address) return
    if (chainId !== ARC_TESTNET_CHAIN_ID) return
    if (isAnyInFlight) return
    resetApprove()
    setStorageError('')
    const total = parsedAmount + DEFAULT_FEE_BUDGET_USDC
    approve({
      address: ARC_TESTNET_USDC,
      abi: erc20Abi,
      functionName: 'approve',
      args: [contractAddress, total],
      chainId: ARC_TESTNET_CHAIN_ID,
    })
  }, [parsedAmount, address, chainId, isAnyInFlight, resetApprove, approve, contractAddress])

  const handleCreate = useCallback(() => {
    if (!parsedAmount || !address) return
    if (chainId !== ARC_TESTNET_CHAIN_ID) return
    if (isAnyInFlight) return
    // Recheck allowance before proceeding
    if (allowance !== undefined && allowance < (parsedAmount + DEFAULT_FEE_BUDGET_USDC)) {
      setStorageError('Allowance has changed. Please approve again.')
      return
    }
    resetCreate()
    setStorageError('')

    // Generate keypair
    const privateKey = generateLinkKey()
    const signerAddress = deriveSignerAddress(privateKey)
    const expiryTs = Math.floor(Date.now() / 1000) + EXPIRY_OPTIONS[expiryIdx].seconds

    pendingKeyRef.current = privateKey
    pendingSignerRef.current = signerAddress

    // Save draft BEFORE submitting — a crash/reload preserves the key
    try {
      saveLink({
        signerAddress,
        privateKey,
        principal: amountStr,
        feeBudget: DEFAULT_FEE_BUDGET_STR,
        expiryTs,
        expiryLabel: EXPIRY_OPTIONS[expiryIdx].label,
        createdAt: Date.now(),
        contractAddress,
        chainId: ARC_TESTNET_CHAIN_ID,
        issuer: address,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      setStorageError(msg || 'Cannot save link key: browser storage is full. Free up space or export existing links first.')
      pendingKeyRef.current = null
      pendingSignerRef.current = null
      return
    }

    createLink({
      address: contractAddress,
      abi: SPOOKLY_ABI,
      functionName: 'createLink',
      args: [signerAddress, BigInt(parsedAmount), DEFAULT_FEE_BUDGET_USDC, BigInt(expiryTs)],
      chainId: ARC_TESTNET_CHAIN_ID,
    })
  }, [
    parsedAmount, address, chainId, isAnyInFlight, allowance,
    expiryIdx, amountStr, contractAddress, resetCreate, createLink,
  ])

  if (!isConnected) {
    return <p className="text-sm" style={{ color: 'var(--muted)' }}>Connect your wallet to create a link.</p>
  }

  const balanceDisplay = usdcBalance !== undefined ? formatUsdcFixed(usdcBalance) : null
  const isIdle = !isAnyInFlight && !isCreateSuccess

  return (
    <div className="space-y-5">
      {/* Amount input */}
      <div>
        <label htmlFor="link-amount" className="block text-sm font-medium mb-1.5" style={{ color: 'var(--ink-2)' }}>
          Amount
        </label>
        <div className="flex items-center rounded-xl px-4 py-3 gap-2"
          style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
          <input
            id="link-amount" type="text" inputMode="decimal" placeholder="0.00"
            value={amountStr}
            onChange={e => { if (isIdle) { setAmountStr(e.target.value); setStorageError('') } }}
            disabled={!isIdle}
            className="flex-1 bg-transparent text-2xl font-semibold outline-none tabular-nums display"
            style={{ color: 'var(--ink)', fontSize: '1.5rem', minWidth: 0 }}
            aria-describedby={amountError ? 'amount-error' : undefined}
            autoComplete="off" autoCorrect="off" spellCheck={false}
          />
          <span className="font-medium text-base" style={{ color: 'var(--muted)' }}>USDC</span>
        </div>
        {balanceDisplay && (
          <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
            Balance: {balanceDisplay} USDC
            {isIdle && maxAmount > 0n && (
              <button type="button" className="ml-2 underline" style={{ color: 'var(--accent)' }}
                onClick={() => setAmountStr(formatUsdcFixed(maxAmount))}>
                Max
              </button>
            )}
          </p>
        )}
        {amountError && (
          <p id="amount-error" role="alert" className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>
            {amountError}
          </p>
        )}
      </div>

      {/* Expiry selector */}
      <fieldset>
        <legend className="block text-sm font-medium mb-2" style={{ color: 'var(--ink-2)' }}>Expires in</legend>
        <div className="flex gap-2">
          {EXPIRY_OPTIONS.map((opt, i) => (
            <button key={opt.label} type="button"
              onClick={() => { if (isIdle) setExpiryIdx(i) }}
              disabled={!isIdle}
              className="flex-1 rounded-lg py-2 text-sm font-medium transition-colors"
              style={{
                background: expiryIdx === i ? 'var(--accent)' : 'var(--surface-muted)',
                color: expiryIdx === i ? '#fff' : 'var(--ink-2)',
                border: `1px solid ${expiryIdx === i ? 'var(--accent)' : 'var(--border)'}`,
                minHeight: '44px',
              }}
              aria-pressed={expiryIdx === i}>
              {opt.label}
            </button>
          ))}
        </div>
      </fieldset>

      {/* Fee summary */}
      {parsedAmount !== null && parsedAmount > 0n && (
        <div className="rounded-xl px-4 py-3 text-sm space-y-1"
          style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
          <div className="flex justify-between">
            <span style={{ color: 'var(--muted)' }}>Link amount</span>
            <span className="font-medium tabular-nums" style={{ color: 'var(--ink)' }}>{formatUsdcFixed(parsedAmount)} USDC</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--muted)' }}>Relay fee budget</span>
            <span className="font-medium tabular-nums" style={{ color: 'var(--ink)' }}>{DEFAULT_FEE_BUDGET_STR} USDC</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--subtle)' }}>Gas reserve (approve + create)</span>
            <span className="tabular-nums" style={{ color: 'var(--subtle)' }}>{formatUsdcFixed(GAS_RESERVE_USDC)} USDC</span>
          </div>
          <div className="flex justify-between pt-1 border-t font-semibold" style={{ borderColor: 'var(--border)' }}>
            <span style={{ color: 'var(--ink)' }}>Total locked</span>
            <span className="tabular-nums" style={{ color: 'var(--ink)' }}>
              {formatUsdcFixed(parsedAmount + DEFAULT_FEE_BUDGET_USDC)} USDC
            </span>
          </div>
        </div>
      )}

      {/* Wrong chain */}
      {isWrongChain && (
        <button type="button" onClick={() => switchChain({ chainId: ARC_TESTNET_CHAIN_ID })}
          className="w-full rounded-xl py-3.5 font-semibold text-sm"
          style={{ background: 'var(--danger)', color: '#fff', minHeight: '48px' }}>
          Switch to Arc
        </button>
      )}

      {/* Approve */}
      {!isWrongChain && needsApproval && !isCreateSuccess && canProceed && (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Approve USDC first, then create the funded link.</p>
      )}
      {!isWrongChain && needsApproval && !isCreateSuccess && (
        <button type="button" onClick={handleApprove}
          disabled={!canProceed || isAnyInFlight}
          className="w-full rounded-xl py-3.5 font-semibold text-sm transition-opacity disabled:opacity-50"
          style={{ background: 'var(--accent)', color: '#fff', minHeight: '48px' }}
          aria-busy={isApproveInFlight}>
          {isApproving ? '1 of 2: Confirm approval in wallet…' : isApproveConfirming ? '1 of 2: Approving USDC…' : '1 of 2: Approve USDC'}
        </button>
      )}

      {/* Create */}
      {!isWrongChain && !needsApproval && !isCreateSuccess && canProceed && (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>USDC is already approved for this amount. Create the link to deposit the funds.</p>
      )}
      {!isWrongChain && !needsApproval && !isCreateSuccess && (
        <button type="button" onClick={handleCreate}
          disabled={!canProceed || isAnyInFlight}
          className="w-full rounded-xl py-3.5 font-semibold text-sm transition-opacity disabled:opacity-50"
          style={{ background: 'var(--accent)', color: '#fff', minHeight: '48px' }}
          aria-busy={isCreateInFlight}>
          {isCreating ? '2 of 2: Confirm link in wallet…'
            : isCreateConfirming ? '2 of 2: Creating link…'
              : '2 of 2: Create link'}
        </button>
      )}

      {/* Status messages */}
      {isApproveInFlight && (
        <p role="status" aria-live="polite" className="text-xs text-center" style={{ color: 'var(--muted)' }}>
          1 of 2: Approving USDC spend…
        </p>
      )}
      {approveHash && isApproveSuccess && (
        <p role="status" aria-live="polite" className="text-xs text-center" style={{ color: 'var(--success)' }}>
          1 of 2: USDC approved.{' '}
          <a href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, approveHash)}
            target="_blank" rel="noopener noreferrer" className="underline">
            View tx
          </a>
        </p>
      )}
      {createHash && isCreateInFlight && (
        <p role="status" aria-live="polite" className="text-xs text-center" style={{ color: 'var(--muted)' }}>
          <a href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, createHash)}
            target="_blank" rel="noopener noreferrer" className="underline">
            2 of 2: Link transaction submitted
          </a>{' '}— waiting for confirmation…
        </p>
      )}
      {approveClassified && (
        <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>
          {isApproveRejected ? 'Approval cancelled.' : `Approval failed: ${approveClassified.message}`}
        </p>
      )}
      {createClassified && (
        <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>
          {isCreateRejected ? 'Create cancelled.' : `Create failed: ${createClassified.message}`}
        </p>
      )}
      {storageError && (
        <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>{storageError}</p>
      )}
    </div>
  )
}

/**
 * classifyWriteError — maps viem/wagmi write errors to concise user-facing messages.
 *
 * Categories:
 *   - UserRejectedRequest (code -4001, name UserRejectedRequestError): user dismissed
 *   - ResourceUnavailable (code -32002, name ResourceUnavailableRpcError): wallet has a
 *     pending popup already open — check the wallet for an existing request
 *   - ConnectorChainMismatch / ChainMismatch: wallet is on the wrong chain
 *   - ChainNotFound: no chain configured for this request
 *   - ContractFunctionReverted: on-chain revert (includes custom error name if available)
 *   - ProviderNotFound / ProviderDisconnected: wallet disconnected
 *   - generic fallback: safe single-line summary without internal formatter output
 *
 * Never exposes raw viem TransactionExecutionError "Request Arguments:" blocks, which
 * include the "chain: undefined (id: ...)" formatter output.
 */

type WriteErrorCategory =
  | 'user_rejected'
  | 'resource_unavailable'
  | 'chain_mismatch'
  | 'chain_not_found'
  | 'contract_revert'
  | 'provider_unavailable'
  | 'generic'

export interface ClassifiedError {
  category: WriteErrorCategory
  message: string
}

/** Safely walk nested .cause chain up to depth 4. */
function causes(err: unknown, depth = 4): unknown[] {
  const acc: unknown[] = [err]
  let cur = err
  for (let i = 0; i < depth; i++) {
    const c = (cur as { cause?: unknown } | null)?.cause
    if (!c) break
    acc.push(c)
    cur = c
  }
  return acc
}

function name(e: unknown): string {
  return typeof (e as { name?: unknown })?.name === 'string'
    ? (e as { name: string }).name
    : ''
}

function code(e: unknown): number | undefined {
  const c = (e as { code?: unknown })?.code
  return typeof c === 'number' ? c : undefined
}

function msg(e: unknown): string {
  return typeof (e as { message?: unknown })?.message === 'string'
    ? (e as { message: string }).message
    : ''
}

/** Extract the short top-level message before any "Request Arguments:" block. */
function shortMessage(e: unknown): string {
  const raw = typeof (e as { shortMessage?: unknown })?.shortMessage === 'string'
    ? (e as { shortMessage: string }).shortMessage
    : msg(e)
  // Strip everything from "Request Arguments:" onward
  const cut = raw.indexOf('Request Arguments:')
  return (cut >= 0 ? raw.slice(0, cut) : raw).trim()
}

/** Attempt to extract the custom Solidity error name from a revert. */
function revertName(err: unknown): string | null {
  const chain = causes(err)
  for (const e of chain) {
    const n = name(e)
    if (n === 'ContractFunctionExecutionError' || n === 'ContractFunctionRevertedError') {
      // viem puts the custom error name in .data.errorName or in the message
      const data = (e as { data?: { errorName?: string } })?.data
      if (data?.errorName) return data.errorName
      // Fallback: parse "Error: <Name>" from message
      const m = msg(e)
      const match = /Error:\s+([A-Z][A-Za-z0-9]+)/.exec(m)
      if (match) return match[1]
    }
  }
  return null
}

export function classifyWriteError(err: unknown, networkName = 'Arc Testnet'): ClassifiedError {
  if (!err) return { category: 'generic', message: 'Unknown error.' }

  const chain = causes(err)

  // Walk the cause chain looking for known error types
  for (const e of chain) {
    const n = name(e)
    const c = code(e)

    // User rejected
    if (n === 'UserRejectedRequestError' || c === -4001 || c === 4001) {
      return { category: 'user_rejected', message: 'Request cancelled.' }
    }

    // Resource unavailable — pending popup
    if (n === 'ResourceUnavailableRpcError' || c === -32002) {
      return {
        category: 'resource_unavailable',
        message: 'Your wallet has a pending request. Check the wallet for an existing approval popup, then try again.',
      }
    }

    // Chain mismatch
    if (n === 'ConnectorChainMismatchError' || n === 'ChainMismatchError') {
      return {
        category: 'chain_mismatch',
        message: `Wallet is on the wrong network. Switch to ${networkName} and try again.`,
      }
    }

    // Chain not found / switch rejected by wallet
    if (n === 'ChainNotFoundError') {
      return {
        category: 'chain_not_found',
        message: `${networkName} is not configured in your wallet. Add it manually and try again.`,
      }
    }

    // SwitchChainError — user rejected or wallet does not support switching
    if (n === 'SwitchChainError') {
      return {
        category: 'chain_mismatch',
        message: `Could not switch to ${networkName}. Please switch manually in your wallet and try again.`,
      }
    }

    // Provider not found or disconnected
    if (n === 'ProviderNotFoundError' || n === 'ConnectorNotConnectedError') {
      return {
        category: 'provider_unavailable',
        message: 'Wallet disconnected. Reconnect and try again.',
      }
    }

    // Contract revert
    if (n === 'ContractFunctionExecutionError' || n === 'ContractFunctionRevertedError') {
      const rn = revertName(err)
      const detail = rn ? ` (${rn})` : ''
      return {
        category: 'contract_revert',
        message: `Transaction reverted on-chain${detail}. Check your balance and allowance.`,
      }
    }

    // Also catch by message patterns for wallets that don't set name/code properly
    const m = msg(e).toLowerCase()
    if (m.includes('user rejected') || m.includes('user denied') || m.includes('rejected by user')) {
      return { category: 'user_rejected', message: 'Request cancelled.' }
    }
    if (m.includes('resource unavailable') || m.includes('already pending')) {
      return {
        category: 'resource_unavailable',
        message: 'Your wallet has a pending request. Check the wallet for an existing approval popup, then try again.',
      }
    }
  }

  // Insufficient funds (native gas) — walk cause chain for message patterns
  for (const e of chain) {
    const m2 = msg(e).toLowerCase()
    if (m2.includes('insufficient funds') || m2.includes('insufficient native') ||
        m2.includes('exceeds balance') || m2.includes('gas required exceeds allowance')) {
      return {
        category: 'generic',
        message: `Insufficient ${networkName} gas (ETH/native) for this transaction. Add gas funds and try again.`,
      }
    }
  }

  // Generic fallback — take the root short message, strip formatter output
  const root = chain[0]
  let text = shortMessage(root)
  // If it's still long (contains internal viem boilerplate), use the innermost short message
  if (text.length > 120) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const s = shortMessage(chain[i])
      if (s.length > 0 && s.length <= 120) { text = s; break }
    }
  }
  // Final safety clip — should not be reached
  if (text.length > 120) text = text.slice(0, 117) + '…'
  return { category: 'generic', message: text || 'Transaction failed. Please try again.' }
}

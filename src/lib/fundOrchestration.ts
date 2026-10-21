/**
 * fundOrchestration.ts — testable core of the FundFromChain sequence.
 *
 * Extracted so tests can inject mock EIP-1193 providers and wallet clients
 * without a component harness or live transactions.
 *
 * CONTRACT:
 *  - obtainProvider: get the currently selected connector's EIP-1193 provider
 *    via connector.getProvider() (no chainId arg — avoids wagmi rejecting for
 *    chain mismatch before the switch).
 *  - switchAndVerify: switch wallet to target chain, then poll eth_chainId
 *    with bounded retries until it matches (switch can resolve before the
 *    provider's chainId reflects the new chain).
 *  - preflight: check source ETH native balance and source USDC allowance.
 *  - persistApproval / loadApproval / clearApproval: sessionStorage approval
 *    hash keyed by account+chainId so reload can resume without re-approving.
 */

import type { EIP1193Provider, Address, Hex } from 'viem'
import { getConnections } from 'wagmi/actions'
import type { Config } from 'wagmi'

// ── Approval hash persistence ──────────────────────────────────────────────

export function approvalKey(account: string, chainId: number): string {
  return `knowless:fund:approval:${account.toLowerCase()}:${chainId}`
}

export function persistApproval(account: string, chainId: number, hash: Hex): void {
  try { sessionStorage.setItem(approvalKey(account, chainId), hash) } catch { /* non-fatal */ }
}

export function loadApproval(account: string, chainId: number): Hex | null {
  try {
    const v = sessionStorage.getItem(approvalKey(account, chainId))
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? v as Hex : null
  } catch { return null }
}

export function clearApproval(account: string, chainId: number): void {
  try { sessionStorage.removeItem(approvalKey(account, chainId)) } catch { /* ok */ }
}

// ── Provider acquisition ───────────────────────────────────────────────────

export class ProviderUnavailableError extends Error {
  constructor(msg = 'Wallet not connected. Connect your wallet and try again.') {
    super(msg); this.name = 'ProviderUnavailableError'
  }
}

export class ConnectorChangedError extends Error {
  constructor() {
    super('Wallet disconnected or account changed. Refresh and try again.')
    this.name = 'ConnectorChangedError'
  }
}

export class ChainMismatchError extends Error {
  constructor(public networkName: string) {
    super(`Still on wrong network. Please switch to ${networkName} manually in your wallet.`)
    this.name = 'ChainMismatchError'
  }
}

export class SwitchUnsupportedError extends Error {
  constructor(public networkName: string) {
    super(`Wallet does not support switching to ${networkName}. Switch manually and retry.`)
    this.name = 'SwitchUnsupportedError'
  }
}

export class InsufficientEthError extends Error {
  constructor(public networkName: string) {
    super(`No ${networkName} test ETH for gas. Get test ETH from a Sepolia faucet first.`)
    this.name = 'InsufficientEthError'
  }
}

export class IndeterminateError extends Error {
  constructor() {
    super('Bridge result unknown. Check your wallet activity — do not retry until you confirm the transaction failed on-chain.')
    this.name = 'IndeterminateError'
  }
}

/**
 * Obtain the EIP-1193 provider from the currently selected connector.
 * Uses connector.getProvider() WITHOUT a chainId — avoids wagmi rejecting
 * when current chain ≠ requested source chain before the switch.
 * Also returns the connector uid and current account for later change-detection.
 */
export async function obtainProvider(config: Config): Promise<{
  provider: EIP1193Provider
  connectorUid: string
  account: Address
}> {
  const currentUid = config.state.current
  if (!currentUid) throw new ProviderUnavailableError()
  const conn = config.state.connections.get(currentUid)
  if (!conn || !conn.accounts.length) {
    throw new ProviderUnavailableError()
  }
  const provider = await conn.connector.getProvider() as EIP1193Provider | undefined
  if (!provider?.request) throw new ProviderUnavailableError()
  return { provider, connectorUid: conn.connector.uid, account: conn.accounts[0] }
}

/**
 * Verify the provider's current chain matches targetChainId.
 * Retries up to maxAttempts×intervalMs (switch can resolve before chainId updates).
 */
export async function verifyChain(
  provider: EIP1193Provider,
  targetChainId: number,
  maxAttempts = 8,
  intervalMs = 500,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const hex = await provider.request({ method: 'eth_chainId' }) as string
    if (parseInt(hex, 16) === targetChainId) return true
    if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}

/**
 * Switch the wagmi connector to targetChainId via wallet_switchEthereumChain,
 * then poll verifyChain. Returns the provider after switch.
 * Throws ChainMismatchError / SwitchUnsupportedError / user-rejected on failure.
 */
export async function switchAndVerify(
  provider: EIP1193Provider,
  targetChainId: number,
  networkName: string,
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>,
): Promise<void> {
  // Check if already on the right chain
  const alreadyCorrect = await verifyChain(provider, targetChainId, 1, 0)
  if (alreadyCorrect) return

  try {
    await switchChainAsync({ chainId: targetChainId })
  } catch (err) {
    // If switch throws, check if the wallet is actually on the right chain now
    const nowCorrect = await verifyChain(provider, targetChainId, 3, 300)
    if (nowCorrect) return

    // Classify the switch error
    const e = err as { name?: string; code?: number }
    if (e.code === 4001 || e.name === 'UserRejectedRequestError') {
      throw err // re-throw for caller to handle as user_rejected
    }
    if (e.code === 4902 || e.name === 'SwitchChainError') {
      throw new SwitchUnsupportedError(networkName)
    }
    throw new ChainMismatchError(networkName)
  }

  // Poll until provider reflects the new chain
  const ok = await verifyChain(provider, targetChainId, 10, 400)
  if (!ok) throw new ChainMismatchError(networkName)
}

/**
 * Check source chain ETH native balance for gas.
 * Returns true if non-zero, false if zero (caller should throw InsufficientEthError).
 */
export async function hasSourceEth(
  provider: EIP1193Provider,
  account: Address,
): Promise<boolean> {
  const hex = await provider.request({
    method: 'eth_getBalance',
    params: [account, 'latest'],
  }) as string
  return BigInt(hex) > 0n
}

/**
 * Verify the connector/account haven't changed mid-flow.
 */
export function assertConnectorUnchanged(
  config: Config,
  originalUid: string,
  originalAccount: Address,
): void {
  const currentUid = config.state.current
  if (!currentUid) throw new ConnectorChangedError()
  const conn = config.state.connections.get(currentUid)
  if (!conn || conn.connector.uid !== originalUid ||
      conn.accounts[0]?.toLowerCase() !== originalAccount.toLowerCase()) {
    throw new ConnectorChangedError()
  }
}

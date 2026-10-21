/**
 * writeError.test.ts — focused unit tests for classifyWriteError.
 *
 * Tests the parameterized networkName, error classification by error name/code,
 * and critically: a wrapped error whose message contains "chain" in a non-chain context
 * must NOT be classified as chain_mismatch.
 *
 * No DOM, camera, browser, or wallet connectivity required.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyWriteError } from './writeError.js'

function makeErr(name: string, code?: number, message?: string): Error {
  const e = new Error(message ?? name) as Error & { name: string; code?: number }
  e.name = name
  if (code !== undefined) e.code = code
  return e
}

function makeWrapped(outer: string, inner: Error): Error & { cause: Error } {
  const e = new Error(outer) as Error & { cause: Error }
  e.cause = inner
  return e
}

describe('classifyWriteError', () => {
  it('WE1: user rejection by name', () => {
    const cls = classifyWriteError(makeErr('UserRejectedRequestError'))
    assert.equal(cls.category, 'user_rejected')
  })

  it('WE2: user rejection by code 4001', () => {
    const cls = classifyWriteError(makeErr('WalletError', 4001))
    assert.equal(cls.category, 'user_rejected')
  })

  it('WE3: resource unavailable -32002', () => {
    const cls = classifyWriteError(makeErr('ResourceUnavailableRpcError', -32002))
    assert.equal(cls.category, 'resource_unavailable')
    assert.ok(!cls.message.toLowerCase().includes('chain'))
  })

  it('WE4: chain mismatch by name', () => {
    const cls = classifyWriteError(makeErr('ConnectorChainMismatchError'), 'Ethereum Sepolia')
    assert.equal(cls.category, 'chain_mismatch')
    assert.ok(cls.message.includes('Ethereum Sepolia'), `expected network name in: ${cls.message}`)
  })

  it('WE5: chain not found uses networkName', () => {
    const cls = classifyWriteError(makeErr('ChainNotFoundError'), 'Base Sepolia')
    assert.equal(cls.category, 'chain_not_found')
    assert.ok(cls.message.includes('Base Sepolia'))
  })

  it('WE6: SwitchChainError uses networkName', () => {
    const cls = classifyWriteError(makeErr('SwitchChainError'), 'Eth Sepolia')
    assert.equal(cls.category, 'chain_mismatch')
    assert.ok(cls.message.includes('Eth Sepolia'))
    assert.ok(!cls.message.includes('Arc Testnet'))
  })

  it('WE7: provider disconnected', () => {
    const cls = classifyWriteError(makeErr('ProviderNotFoundError'))
    assert.equal(cls.category, 'provider_unavailable')
  })

  it('WE8: contract revert', () => {
    const cls = classifyWriteError(makeErr('ContractFunctionExecutionError'))
    assert.equal(cls.category, 'contract_revert')
  })

  it('WE9: insufficient funds message', () => {
    const cls = classifyWriteError(new Error('insufficient funds for gas'), 'Eth Sepolia')
    assert.equal(cls.category, 'generic')
    assert.ok(cls.message.includes('Eth Sepolia'))
    assert.ok(cls.message.toLowerCase().includes('gas'))
  })

  it('WE10: CRITICAL — error message containing "chain" in Request Arguments must NOT become chain_mismatch', () => {
    // This is the confirmed regression: viem wraps errors with "Request Arguments: chain: Ethereum Sepolia ..."
    // The old code did msg.includes('chain') which caught this and produced "Wrong chain" incorrectly.
    const inner = new Error('execution reverted: ERC20: insufficient allowance')
    const outer = new Error(
      'The contract function "approve" reverted.\n\nRequest Arguments:\n  chain:  Ethereum Sepolia (id: 11155111)\n  from:   0xabc...'
    )
    ;(outer as Error & { cause: Error }).cause = inner
    const cls = classifyWriteError(outer, 'Ethereum Sepolia')
    // Must NOT be chain_mismatch — this is a contract revert
    assert.notEqual(cls.category, 'chain_mismatch',
      `Should not be chain_mismatch, got: ${cls.category} — "${cls.message}"`)
    // message must not contain "Wrong chain" or "please switch"
    assert.ok(!cls.message.toLowerCase().includes('wrong chain'),
      `Should not say wrong chain: "${cls.message}"`)
  })

  it('WE11: error message "chain" in generic non-chain context is not chain_mismatch', () => {
    // Another variant: error about a "chain of approvals" or "supply chain"
    const e = new Error('The supply chain contract call failed due to chain-linked nodes')
    const cls = classifyWriteError(e, 'Arc Testnet')
    assert.notEqual(cls.category, 'chain_mismatch')
  })

  it('WE12: unknown error returns safe generic message', () => {
    const cls = classifyWriteError(new Error('something unexpected'))
    assert.equal(cls.category, 'generic')
    assert.ok(cls.message.length > 0)
    assert.ok(cls.message.length <= 120)
  })

  it('WE13: default networkName is Arc Testnet', () => {
    const cls = classifyWriteError(makeErr('ConnectorChainMismatchError'))
    assert.ok(cls.message.includes('Arc Testnet'))
  })

  it('WE14: nested cause chain — user rejection inside TransactionExecutionError', () => {
    const inner = makeErr('UserRejectedRequestError', 4001)
    const outer = makeWrapped('TransactionExecutionError: user rejected', inner)
    const cls = classifyWriteError(outer)
    assert.equal(cls.category, 'user_rejected')
  })
})

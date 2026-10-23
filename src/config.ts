/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 *
 * multiInjectedProviderDiscovery: true — enables EIP-6963 provider discovery so
 * MetaMask and Phantom each appear as a stable, independently-addressable connector.
 * Without this, injected() binds to window.ethereum which the last-loaded wallet
 * overwrites, causing the approved connector to silently swap on reconnect.
 */

import { http, createConfig } from 'wagmi'
import { mainnet, base } from 'wagmi/chains'
import { arc } from 'viem/chains'

// Pre-register chain RPC URLs for Arc Studio tracing (dev-only)
if (import.meta.env.DEV) {
  import('./tracing').then(({ registerChain }) => {
    registerChain(arc.id, arc.rpcUrls.default.http[0])
  })
}

// Source chains supported for CCTP inbound funding (Ethereum Mainnet, Base Mainnet).
// Arc and mainnet are always included.
// Arc-only contract reads (escrow getLinkInfo, domainSeparator, etc.) must always
// specify chainId: arc.id explicitly so a source-chain switch does not redirect them.
export const config = createConfig({
  chains: [arc, mainnet, base],
  multiInjectedProviderDiscovery: true, // stable per-wallet connector via EIP-6963
  transports: {
    [arc.id]: http(),
    [mainnet.id]:    http(),
    [base.id]:       http(),
  },
})

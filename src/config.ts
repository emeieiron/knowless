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
import { mainnet, sepolia, baseSepolia } from 'wagmi/chains'
import { arcTestnet } from 'viem/chains'

// Pre-register chain RPC URLs for Arc Studio tracing (dev-only)
if (import.meta.env.DEV) {
  import('./tracing').then(({ registerChain }) => {
    registerChain(arcTestnet.id, arcTestnet.rpcUrls.default.http[0])
  })
}

// Source chains supported for CCTP inbound funding (Ethereum Sepolia, Base Sepolia).
// Arc Testnet and mainnet are always included.
// Arc-only contract reads (escrow getLinkInfo, domainSeparator, etc.) must always
// specify chainId: arcTestnet.id explicitly so a source-chain switch does not redirect them.
export const config = createConfig({
  chains: [arcTestnet, sepolia, baseSepolia, mainnet],
  multiInjectedProviderDiscovery: true, // stable per-wallet connector via EIP-6963
  transports: {
    [arcTestnet.id]: http(),
    [sepolia.id]:    http(),
    [baseSepolia.id]:http(),
    [mainnet.id]:    http(), // ENS resolution uses mainnet
  },
})

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
import { mainnet } from 'wagmi/chains'
import { arcTestnet } from 'viem/chains'

// Pre-register chain RPC URLs for Arc Studio tracing (dev-only)
if (import.meta.env.DEV) {
  import('./tracing').then(({ registerChain }) => {
    registerChain(arcTestnet.id, arcTestnet.rpcUrls.default.http[0])
  })
}

export const config = createConfig({
  chains: [arcTestnet, mainnet], // mainnet needed for ENS resolution
  multiInjectedProviderDiscovery: true, // stable per-wallet connector via EIP-6963
  transports: {
    [arcTestnet.id]: http(),
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})

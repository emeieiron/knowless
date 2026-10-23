/**
 * knowless — Spendable USDC links on Arc
 *
 * Routes:
 *   /            → IssuerDashboard (connect wallet, create links, view status, cancel)
 *   #pay/<frag>  → PayScreen (walletless holder spend flow)
 *
 * The link private key ONLY exists in the URL fragment (#pay/<base64url-encoded-key>).
 * It never appears in query strings, paths, server requests, logs, or analytics.
 */

import { useEffect, useState } from 'react'
import { IssuerDashboard } from './components/IssuerDashboard'
import { PayScreen } from './components/PayScreen'
import { SPOOKLY_ADDRESS, ARC_TESTNET_CHAIN_ID } from './lib/contract'

type Route = { type: 'dashboard' } | { type: 'pay'; fragment: string }

function parseRoute(): Route {
  const hash = window.location.hash
  if (hash.startsWith('#pay/')) {
    return { type: 'pay', fragment: hash.slice(5) }
  }
  return { type: 'dashboard' }
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute)

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  if (route.type === 'pay') {
    return (
      <PayScreen
        fragment={route.fragment}
        contractAddress={SPOOKLY_ADDRESS}
        chainId={ARC_TESTNET_CHAIN_ID}
      />
    )
  }

  return <IssuerDashboard />
}

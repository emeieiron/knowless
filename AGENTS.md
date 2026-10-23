# knowless

Spendable USDC payment links. An issuer creates a link embedding an ephemeral private key in the URL fragment. The holder visits, enters a recipient and amount (or scans a payment QR), signs an EIP-712 PaymentAuth off-chain, and the relay submits it to the escrow on Arc Mainnet. No server sees the key. No approval is needed to spend — only to create. Cross-chain payout (Arc → Ethereum or Base) routes through KnowlessCctpRouter using Circle CCTP V2. Inbound funding (Ethereum/Base → Arc) uses depositForBurnWithHook directly from the issuer's wallet.

## Production Contracts (Arc Mainnet — USE THESE)

| Contract | Address | Deploy tx |
|----------|---------|-----------|
| Spookly (escrow) | `0xd93F67D2735e3Af22E699D65AeAa6147Db2c9214` | `0xa3eafb8b265cd6c10a0d923d4ccceb93f9119a4fa4e46fef13211c0ed22729b0` |
| KnowlessCctpRouter | `0x86Eb182052582D814C37A127a712353087BA759A` | `0x6a4df3dbd704a9eaa99b924c33feafd48d948c3f2941208461aa206ea43ee42e` |

Explorer: https://explorer.arc.io

## Network Configuration

| Chain | Chain ID | CCTP Domain | USDC |
|-------|----------|-------------|------|
| Arc Mainnet | 5042 | 26 | `0x3600000000000000000000000000000000000000` (ERC-20 6 dec / native 18 dec — same balance pool) |
| Ethereum | 1 | 0 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Base | 8453 | 6 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

- Arc RPC: `https://rpc.mainnet.arc.io`
- CCTP TokenMessengerV2 (all three chains): `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`
- CCTP MessageTransmitterV2 (all three chains): `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`

## Historical Testnet Addresses (DO NOT USE in production)

These are superseded and must not appear in any mainnet build:
- Arc Testnet escrow v2: `0xbe223821c0925e87cde1ca397fdce253a8ce7b22` (chain 5042002)
- Arc Testnet router: `0xd75a607d9f99a35fadbfd3caf077918265ab59ab` (chain 5042002)
- Arc Testnet escrow v1: `0x03389493bca813f7b7bc59dde93455afb1d785e5`

## Infrastructure

- Frontend: Vercel (`https://knowless-pi.vercel.app`)
- Relay: Cloudflare Worker (`knowless-relay`, `https://knowless-relay.em-eieiron.workers.dev`)
- Relay storage: Cloudflare Durable Object SQLite (`RelayDO`, v1 migration, `new_sqlite_classes = ["RelayDO"]`)
- Relay signing key: stored as `RELAY_PRIVATE_KEY` secret in Cloudflare — never read or rotate from Arc Studio

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS, wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, tests in `contracts/test/*.t.sol`.
  - Build: `bun run contracts:build` (`forge build`)
  - Test: `bun run contracts:test` (`forge test`)
- Relay Worker: TypeScript, Cloudflare Workers, Durable Objects, SQLite
- Wallet: EIP-6963 injected (Phantom, MetaMask)
- CCTP: Circle V2, `depositForBurnWithHook` (8 args, void), standard finality 2000, forwarding hook `0x636374702d666f72776172640000000000000000000000000000000000000000`

## Key Source Files

- `src/lib/contract.ts` — escrow/router addresses, ABIs
- `src/lib/cctp.ts` — CCTP typed-data helpers, chain/domain config
- `src/components/PayScreen.tsx` — walletless payment + CCTP payout
- `src/components/IssuerDashboard.tsx` — link creation and management
- `src/components/FundFromChain.tsx` — inbound CCTP funding
- `src/lib/fundOrchestration.ts` — wallet provider acquisition, ETH balance check, approval persistence
- `worker/relay-do.ts` — Cloudflare DO: legacy relay journal, queue, nonce
- `worker/cctp-relay-do.ts` — CCTP extension: cctp_journal, quote/submit/status endpoints
- `src/config.ts` — wagmi config (Arc, Ethereum, Base chains)

## To Run (development)

```bash
bun install
bun run dev
```

Typecheck: `bun run typecheck`
Build: `bun run build`
Lint + typecheck: `bash /home/user/arc-studio-helpers/check.sh`

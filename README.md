# knowless

> Fund it. Share it. They spend it.

Spendable USDC links on [Arc Mainnet](https://arc.io). The issuer connects a wallet, deposits USDC into a link, and shares its URL. The holder opens the link, scans the recipient's payment QR (or enters an address manually), and pays — without connecting a wallet. Cancel returns the unspent principal and remaining relay fee budget.

**Live app:** [knowless-pi.vercel.app](https://knowless-pi.vercel.app)  
**Relay health:** [knowless-pi.vercel.app/relay/health](https://knowless-pi.vercel.app/relay/health)  
**Repository:** [github.com/emeieiron/knowless](https://github.com/emeieiron/knowless)

Built with [Arc Studio](https://studio.arc.io).

---

## How it works

1. **Issue** — Connect a wallet on Arc Mainnet, approve USDC, choose an amount and expiry, and create a link.
2. **Share** — Send the link URL. The URL fragment holds the spending key and is not included in HTTP requests to servers. Anyone holding the URL can authorize spending; keep links private and out of logs or issue trackers.
3. **Spend** — The holder opens the link, scans the payment recipient's QR code (or enters an address), and signs a payment authorization locally. The relay submits the transaction to Arc and pays gas from its own account, deducting a small quoted relay fee from the link's budget.
4. **Cancel** — The issuer can cancel the link at any time and reclaim the remaining balance.

The link holder (spender) and the payment recipient are distinct roles. The payment recipient does not need to connect a wallet or sign in Knowless.

---

## Network

| Property | Value |
|---|---|
| Chain | Arc Mainnet (`5042`) |
| RPC | [`rpc.mainnet.arc.io`](https://rpc.mainnet.arc.io) |
| Explorer | [`explorer.arc.io`](https://explorer.arc.io) |
| USDC | `0x3600000000000000000000000000000000000000` |
| USDC decimals (ERC-20 transfers) | 6 |
| Native gas asset | USDC (18 decimals internally; same balance, no separate ETH required) |

---

## Contracts

| Contract | Address | Deploy tx |
|---|---|---|
| Spookly (escrow) | [`0xd93F67D2735e3Af22E699D65AeAa6147Db2c9214`](https://explorer.arc.io/address/0xd93F67D2735e3Af22E699D65AeAa6147Db2c9214) | [`0xa3eafb8b…`](https://explorer.arc.io/tx/0xa3eafb8b265cd6c10a0d923d4ccceb93f9119a4fa4e46fef13211c0ed22729b0) |
| KnowlessCctpRouter | [`0x86Eb182052582D814C37A127a712353087BA759A`](https://explorer.arc.io/address/0x86Eb182052582D814C37A127a712353087BA759A) | [`0x6a4df3db…`](https://explorer.arc.io/tx/0x6a4df3dbd704a9eaa99b924c33feafd48d948c3f2941208461aa206ea43ee42e) |

Source: [`contracts/Spookly.sol`](contracts/Spookly.sol), [`contracts/KnowlessCctpRouter.sol`](contracts/KnowlessCctpRouter.sol).

---

## CCTP cross-chain flows (Circle CCTP V2)

**Inbound funding (Ethereum or Base → Arc):** The issuer can fund a link from USDC held on Ethereum Mainnet (chain 1, domain 0) or Base (chain 8453, domain 6). The source wallet needs native ETH for gas on the source chain. Circle's attestation service and forwarding mechanism enable the destination mint to the issuer's Arc wallet; the issuer then creates a link normally. Cross-chain delivery is asynchronous — source burn success alone does not mean the destination mint has arrived.

**Outbound payout (Arc → Ethereum or Base):** The link holder can direct payment to a recipient on Ethereum Mainnet or Base. The relay calls `KnowlessCctpRouter`, which debits the link funds on Arc and initiates a CCTP V2 burn. The recipient receives USDC on the destination chain without connecting a wallet.

Supported domains: Arc 26, Ethereum Mainnet 0, Base 6. No other chains are currently configured.

---

## Architecture

- **Frontend:** Vite + React + TypeScript + wagmi/viem + ConnectKit, served as prebuilt static output on Vercel.
- **Relay proxy:** [`vercel.json`](vercel.json) rewrites `/relay/**` to the Cloudflare Worker at `https://knowless-relay.em-eieiron.workers.dev`. No Vercel backend signer or KV storage.
- **Cloudflare Worker (`knowless-relay`):** Handles quote, submit, and status. A SQLite-backed Durable Object (`RelayDO`) stores the transaction journal, coordinates signing-account nonces, and supports recovery on restart.
- **Escrow:** The `Spookly` contract holds link funds and validates EIP-712 payment authorizations. The relay's signing account pays Arc gas and charges a quoted fee from the link budget.

Frontend chain and wallet configuration: [`src/config.ts`](src/config.ts). Deployed contract addresses: [`src/lib/contract.ts`](src/lib/contract.ts).

The link holder never connects a wallet. The issuer requires one for funding, approvals, and cancellation.

---

## Development

### Prerequisites

- [Bun](https://bun.sh)
- [Foundry](https://getfoundry.sh) (for contract compilation and tests only)
- A connected wallet with Arc Mainnet USDC is required for issuer flows, not for building the frontend

### Install

```sh
bun install
```

### Frontend (development)

```sh
bun run dev:frontend
```

The Vite dev server starts at `http://localhost:5173`. It forwards `/relay` requests to `localhost:4001` (see [`vite.config.ts`](vite.config.ts)), so payment APIs require a separately configured local relay. In production, [`vercel.json`](vercel.json) rewrites those requests to the Cloudflare Worker instead.

`bun run dev` also starts the older Bun relay in `server/relay.ts`; it is not the Cloudflare Worker used in production. Use [`wrangler.toml`](wrangler.toml) as the production relay configuration reference.

### Type-check and build

```sh
bun run typecheck   # TypeScript check only
bun run build       # Production Vite build → dist/
```

### Contracts

```sh
bun run contracts:build   # forge build
bun run contracts:test    # forge test
```

### Worker (Cloudflare)

Public configuration is in [`wrangler.toml`](wrangler.toml). Key public variables:

| Variable | Value |
|---|---|
| `RELAY_CHAIN_ID` | `5042` |
| `RELAY_RPC_URL` | `https://rpc.drpc.mainnet.arc.io` |
| `RELAY_CONTRACT_ADDRESS` | `0xd93F67D2735e3Af22E699D65AeAa6147Db2c9214` |
| `RELAY_CCTP_ROUTER_ADDRESS` | `0x86Eb182052582D814C37A127a712353087BA759A` |
| `ALLOWED_ORIGIN` | `https://knowless-pi.vercel.app` |

`RELAY_PRIVATE_KEY` is a Cloudflare secret and is never stored in the repository or frontend. Keep `.env*`, `server/.relay-key`, and transaction journals out of version control (covered by `.gitignore`).

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE), except where a file or bundled dependency specifies otherwise.

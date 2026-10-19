# knowless

Spendable USDC links on Arc Testnet. Create a funded link, share it, and let its holder pay an EVM address without connecting a wallet. The issuer can cancel the link and reclaim the unspent principal and fee budget.

**Frontend:** https://knowless-pi.vercel.app

## Architecture

- Vite/React frontend served as prebuilt static output on Vercel.
- Same-origin `/relay`, `/relay/quote`, and `/relay/health` requests proxy to https://knowless-relay.em-eieiron.workers.dev.
- Cloudflare Worker with a SQLite-backed Durable Object stores the transaction journal and coordinates relay-account nonces and recovery.
- The relay requires a funded Arc Testnet signing key in the Cloudflare secret `RELAY_PRIVATE_KEY`. Keys are never included in the frontend or repository. Coordinate the old signer shutdown before activating the same account on Cloudflare.

This deployment uses Cloudflare storage for the relay; it does not require Vercel KV or a Vercel backend signer.

## Network

- Arc Testnet chain ID: `5042002`.
- Contract: `0xbe223821c0925e87cde1ca397fdce253a8ce7b22`.
- USDC: `0x3600000000000000000000000000000000000000`.
- This application uses testnet tokens.

## Flow

1. Connect an issuer wallet on Arc Testnet, approve USDC, and create a link.
2. Share its URL. The fragment contains the spend key and stays in the holder's browser.
3. The holder signs a payment authorization locally; the relay submits the transaction and returns its hash.
4. The issuer can cancel and refund the remaining funds.

Issuer dashboard history is local to the browser origin. The public Vercel site does not automatically inherit issuer records from the Arc preview origin. The existing payment-fragment format is preserved.

## Project scripts

```sh
bun install
bun run dev:frontend
bun run typecheck
bun run smoke:worker
bun run build
forge test
```

See `server/relay-env-example.txt` for development relay settings and `wrangler.toml` for the Worker bindings. Keep private environment files, `server/.relay-key`, and transaction journals out of version control. Production releases are built in the Arc Studio project and uploaded as prebuilt Vercel and Cloudflare artifacts.

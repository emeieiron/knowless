import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

/**
 * Vite plugin: early request guard for server-only secret/state paths.
 *
 * Vite's fs.deny uses glob matching but does NOT reliably deny /@fs/ directory
 * traversal to files inside subdirectories when the deny entry is a bare dir name.
 * This plugin intercepts ALL requests before static/SPA handling and rejects
 * normalized /@fs/, raw, import, and direct variants of every protected path.
 *
 * Strips query strings and URL-decodes before matching so ?raw, ?import,
 * %2F traversal, and similar variants are all covered.
 *
 * Returns 403 with an empty body. Never logs the request URL (it might
 * contain the path to a secret). Harmless on production builds (dev-only).
 */
function secretPathGuardPlugin(): Plugin {
  // All patterns are matched against the decoded pathname (no query string)
  const BLOCKED_SEGMENTS = [
    '.relay-key',
    '.relay-journal',
    '.relay-pending',
    // Normalize both with and without leading dot variants
    'relay-key',
    'relay-journal',
    'relay-pending',
  ]

  function isBlocked(rawUrl: string): boolean {
    // Strip query string, URL-decode, normalize slashes
    let p: string
    try { p = decodeURIComponent(rawUrl.split('?')[0].split('#')[0]) }
    catch { p = rawUrl.split('?')[0] }
    const lower = p.toLowerCase()
    // Strip /@fs/<absolute> prefix for normalized comparison
    const stripped = lower.replace(/^\/@fs\/[^/]*/, '').replace(/^\/+/, '')
    return BLOCKED_SEGMENTS.some(seg => stripped.includes(seg))
  }

  return {
    name: 'secret-path-guard',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (isBlocked(req.url ?? '')) {
          res.writeHead(403, { 'Content-Type': 'text/plain', 'Content-Length': '0' })
          res.end()
          return
        }
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), nodePolyfills(), secretPathGuardPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      '@tanstack/react-query',
      'wagmi',
      'wagmi/chains',
      'wagmi/connectors',
      'viem',
      'viem/chains',
      'connectkit',
      'framer-motion',
      'lucide-react',
      'sonner',
      'clsx',
      'tailwind-merge',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
    ],
  },
  server: {
    allowedHosts: true,
    cors: true,
    // Belt-and-suspenders: deny at the fs layer in addition to the middleware above.
    fs: {
      deny: [
        path.resolve(__dirname, 'server/.relay-key'),
        path.resolve(__dirname, '.relay-pending'),
        path.resolve(__dirname, '.relay-journal'),
        '**/.relay-key',
        '**/.relay-journal/**',
        '**/.relay-pending/**',
        '.env',
        '.env.*',
      ],
    },
    // Proxy /relay/* to the local relay server during development.
    proxy: {
      '/relay': {
        target: 'http://localhost:4001',
        changeOrigin: false,
      },
    },
  },
})

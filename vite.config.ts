import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

// The Cloudflare Vite plugin runs the app — and its Durable Objects and
// container — inside `workerd` for both `vite dev` and `wrangler deploy`,
// reading the bindings and the custom `main` (src/server.ts) from
// wrangler.jsonc. Docker Desktop must be running for the container to build.
//
// No tunnel is needed for local agent runs: the container reaches the dev
// server's /_bridge at `host.docker.internal:3001` via the Docker host gateway.
// Browser-facing PREVIEWS do not go through this dev server at all — they use a
// Cloudflare quick tunnel served by `cloudflared` inside the sandbox, which
// deliberately bypasses Vite. Routing previews through Vite instead breaks the
// page, because Vite's middleware hijacks the preview's `/@vite/client`,
// `/src/*` and `/@fs/*` requests and serves them from the host, not the
// container.
const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    // Bind ALL interfaces, not just loopback, so the container can reach the
    // dev server for the /_bridge callback. The default loopback-only binding
    // is exactly why that call gets ECONNREFUSED.
    host: true,
    // Accept the bridge callback's Host header.
    allowedHosts: ['host.docker.internal'],
  },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config

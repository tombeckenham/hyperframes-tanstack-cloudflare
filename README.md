# HyperFrames Studio

A HyperFrames authoring studio: chat with a coding agent that writes
[HyperFrames](https://www.npmjs.com/package/hyperframes) HTML video
compositions inside a Cloudflare Sandbox container, previews them live, and
renders them to MP4 — all shipped as **one Cloudflare Worker**.

Built on **TanStack Start**, **TanStack AI**, **Cloudflare Durable Objects +
Containers**, and shadcn/Base UI chat components.

## How it works

```
Browser ──POST /api/run──▶ Start server route ──DO RPC──▶ RunCoordinator DO ──▶ Sandbox container
   ▲                          (SSE bridge)                  (drives chat())      (claude CLI +
   └──────── SSE ─────────────────┘                                               hyperframes CLI)
```

- The browser chats through `POST /api/run`, which bridges `useChat`'s SSE
  expectation to the coordinator's POST-then-WebSocket run protocol — over the
  `RUN_COORDINATOR` binding, never a self-`fetch`.
- The **`RunCoordinator` Durable Object** owns each run: it drives the agent
  loop under `ctx.waitUntil`, appends every chunk to a durable, `seq`-indexed
  log, and serves resumable WebSocket tails. No Worker invocation ever holds a
  multi-minute agent loop.
- The **sandbox container** carries the `claude` CLI and the whole HyperFrames
  toolchain (Node 22, Chromium, ffmpeg). Host tools — preview tunnels, R2
  publishing, the authoring recipe — are served to the in-sandbox agent over
  MCP at `/_bridge/:runId`, gated by a per-run bearer token.
- Live previews reach the browser through a Cloudflare **quick tunnel**
  (`*.trycloudflare.com`); published compositions and MP4 renders live in
  **R2**, served by `/p/*` and `/r/*`.

## Requirements

- [Bun](https://bun.sh) — the only package manager used here.
- **Docker Desktop** (macOS/Windows) — the Cloudflare Vite plugin builds and
  runs the sandbox container locally. OrbStack cannot run Cloudflare
  containers.
- A **Cloudflare Workers Paid** plan — Cloudflare Containers require it.
- An **Anthropic API key** for the in-sandbox `claude` CLI.

## Local development

```bash
bun install
cp .dev.vars.example .dev.vars   # add your ANTHROPIC_API_KEY
bun run dev                      # http://localhost:3001 (Docker Desktop must be running)
```

No tunnel or public hostname is needed locally: the container reaches the
Worker at `host.docker.internal:3001`, and previews come through quick
tunnels.

### Commands

```bash
bun run dev          # vite dev on :3001 — Worker + DOs + container in workerd
bun run build        # also regenerates src/routeTree.gen.ts (commit it)
bun run deploy       # bun run build && wrangler deploy
bun run typecheck    # tsc --noEmit
bun run test         # bun test
bun run lint         # oxlint
bun run format       # oxfmt
bun run cf-typegen   # wrangler types (after editing wrangler.jsonc)
```

### Port map

| Port | Owner |
| --- | --- |
| 3000 | Reserved by the sandbox control plane — never bind it |
| 3001 | The Worker dev server (`bun run dev`) |
| 3002 | `hyperframes preview` studio inside the sandbox |
| 8787 | `wrangler dev` (if used directly) |

## Deploy

One `wrangler deploy` ships everything — SSR UI, agent Durable Objects, and
the container image.

```bash
bunx wrangler r2 bucket create hyperframes-studio-renders   # once
bun run deploy                                              # builds + deploys
bunx wrangler secret put ANTHROPIC_API_KEY                  # once
```

The first deploy also builds and pushes the container image, which takes a few
minutes. If the `*.workers.dev` URL 404s after a first (or interrupted) deploy,
run `bunx wrangler triggers deploy` — it registers the workers.dev route and
prints the URL.

## Failure modes worth knowing

- **"the tanstack MCP server hasn't come up"** — almost always a 404 on the
  container's callback to `/_bridge`, meaning the bridge origin is wrong.
  Locally: keep `server.host: true` in `vite.config.ts`. Deployed: the origin
  derives from the request host; `PUBLIC_HOSTNAME` is an override only.
- **Previews break under Vite** if switched to `exposePort` + hostname
  proxying — the dev middleware hijacks `/@vite/client`. Quick tunnels avoid
  the whole class; leave them be.
- **Tunnels require `SANDBOX_TRANSPORT: "rpc"`** (set in `wrangler.jsonc`) —
  on the default `http` transport `sandbox.tunnels` throws.

## Security model (short version)

- A visitor's `threadId` is `SHA-256(sessionId ‖ threadKey)` — derived
  server-side from an HttpOnly cookie, never taken from the request body. The
  package's unauthenticated `/runs` trigger is deliberately not routed.
- Containers are pinned per-thread and carry the app's `ANTHROPIC_API_KEY`,
  which is why the two lines above are load-bearing.
- LLM-authored composition HTML is served from `/p/*` with
  `Content-Security-Policy: sandbox allow-scripts` — an opaque origin, no
  cookies, no same-origin fetch, no network (`connect-src 'none'`).
- The R2 bucket mixes public artifacts with single-use upload tickets; every
  public route allowlists exactly one key prefix.

# Hyperframes Web

A HyperFrames authoring studio: chat with a coding agent that writes
[HyperFrames](https://www.npmjs.com/package/hyperframes) HTML video
compositions inside a Cloudflare Sandbox container, plays them live in the
browser, and renders them to MP4 — all shipped as **one Cloudflare Worker**.

Built on **TanStack Start**, **TanStack AI**, **Cloudflare Durable Objects +
Containers**, and shadcn/Base UI chat components.

## The studio

- **Chat** (left of a resizable split on desktop; a flat Chat | Player |
  Renders tab row on mobile): every message is a video brief. One-click demo
  briefs skip the interview entirely.
- **Player** tab: the thread's *live* composition — authored, not yet
  rendered — in `<hyperframes-player>`, with transport controls and
  frame-accurate scrubbing. It auto-refreshes whenever the agent finishes a
  turn, and starts life showing a preset 5-second intro baked into the
  sandbox image, so there is something to look at before the agent types a
  line.
- **Renders** tab: the thread's published MP4s and bundled compositions out
  of R2.
- **Hyperframes Studio** (header button): opens the sandbox's full
  `hyperframes preview` studio in its own window, via a Cloudflare quick
  tunnel. Deliberately not embedded — it is a whole app.

The preview sandbox boots on page load (`POST /api/preview` "ensure"), its
tunnel is health-polled without waking a sleeping container ("probe"), and a
stopped sandbox surfaces as an explicit *Resume* button rather than a dead
pane.

## How it works

```
Browser ──POST /api/run──▶ Start server route ──DO RPC──▶ RunCoordinator DO ──▶ Sandbox container
   ▲                          (SSE bridge)                  (drives chat())      (claude CLI +
   └──────── SSE ─────────────────┘                                               hyperframes CLI)
```

- The browser chats through `POST /api/run`, which bridges `useChat`'s SSE
  expectation to the coordinator's POST-then-WebSocket run protocol — over
  the `RUN_COORDINATOR` binding, never a self-`fetch`.
- The **`RunCoordinator` Durable Object** owns each run: it drives the agent
  loop under `ctx.waitUntil`, appends every chunk to a durable, `seq`-indexed
  log, and serves resumable WebSocket tails. No Worker invocation ever holds
  a multi-minute agent loop.
- The **sandbox container** carries the `claude` CLI and the whole
  HyperFrames toolchain (Node 22, Chromium, ffmpeg), plus a ready-made
  project at `/workspace/studio` the agent authors in — its running preview
  hot-reloads straight into what the user is watching. Host tools — preview
  tunnels, R2 publishing, the authoring recipe — are served to the
  in-sandbox agent over MCP at `/_bridge/:runId`, gated by a per-run bearer
  token.
- The **Player** plays the live composition through `GET /api/player`, a
  same-origin proxy of the preview server's bundled-composition route —
  same-origin because the player drives compositions via `contentWindow`,
  which a cross-origin tunnel URL forbids.
- Published compositions and MP4 renders live in **R2**, served by `/p/*`
  and `/r/*`.

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
bun run deploy       # bun run build && wrangler deploy (manual fallback)
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

The repo is **connected to Cloudflare Workers Builds**: pushing to `main`
builds and deploys everything — SSR UI, Durable Objects, and the container
image. Two things the pipeline taught us the hard way:

- **Branch builds do not build the container.** They run
  `wrangler versions upload`, which skips the docker image entirely — so a
  green branch build proves nothing about the Dockerfile. Image problems
  only surface on the `main` build.
- **Container rollout lags the deploy.** The new image goes
  `provisioning → ready` over a few minutes, and existing threads stay
  pinned to containers from the old image until they recycle. Check with a
  fresh thread.

One-time account setup (already done for this deployment):

```bash
bunx wrangler r2 bucket create hyperframes-studio-renders
bunx wrangler secret put ANTHROPIC_API_KEY
```

Manual deploys still work via `bun run deploy`.

## Failure modes worth knowing

- **"the tanstack MCP server hasn't come up"** — almost always a 404 on the
  container's callback to `/_bridge`, meaning the bridge origin is wrong.
  Locally: keep `server.host: true` in `vite.config.ts`. Deployed: the
  origin derives from the request host; `PUBLIC_HOSTNAME` is an override
  only.
- **Quick-tunnel hostnames may not resolve through your local DNS** —
  fresh `*.trycloudflare.com` names can be invisible to ISP/VPN resolvers
  while the browser (secure DNS) sees them fine. That is why tunnel
  verification runs *inside the container* and the health probe falls back
  to DNS-over-HTTPS before declaring a tunnel dead.
- **The hyperframes CLI ships a detached auto-updater** that spawns a
  background `npm install -g` and exits without waiting — lethal inside a
  docker build and wrong in a version-pinned image. The Dockerfile disables
  it (`HYPERFRAMES_NO_AUTO_INSTALL=1`) before the CLI's first invocation.
  Five consecutive deploys failed before this was found.
- **Previews break under Vite** if switched to `exposePort` + hostname
  proxying — the dev middleware hijacks `/@vite/client`. Quick tunnels avoid
  the whole class; leave them be.
- **Tunnels require `SANDBOX_TRANSPORT: "rpc"`** (set in `wrangler.jsonc`) —
  on the default `http` transport `sandbox.tunnels` throws.

## Security model (short version)

- A visitor's `threadId` is `SHA-256(sessionId ‖ threadKey)` — derived
  server-side from an HttpOnly cookie, never taken from the request body.
  The package's unauthenticated `/runs` trigger is deliberately not routed.
- Containers are pinned per-thread and carry the app's `ANTHROPIC_API_KEY`,
  which is why the two lines above are load-bearing.
- Published, shareable LLM-authored HTML is served from `/p/*` with
  `Content-Security-Policy: sandbox allow-scripts` — an opaque origin, no
  cookies, no same-origin fetch.
- The live Player composition (`/api/player`) is served **same-origin
  without that sandbox** — a deliberate, documented trade: the player needs
  `contentWindow` access, and the route only ever serves a composition to
  the session cookie that owns the thread which authored it.
- The R2 bucket mixes public artifacts with single-use upload tickets;
  every public route allowlists exactly one key prefix.

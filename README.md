# Hyperframes Web

Chat with an AI agent that makes videos for you — live, in your browser, on
your own Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tombeckenham/hyperframes-tanstack-cloudflare)

Describe a video ("a 10-second launch teaser for my app", "explain how jet
engines work") and a coding agent authors a
[HeyGen HyperFrames](https://hyperframes.heygen.com) HTML video composition
inside a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/)
container, orchestrated by [TanStack AI](https://tanstack.com/ai). You watch
it take shape in a live player, open the full editing studio in another
window, and render the result to MP4 — all served by **one Cloudflare
Worker**.

## Powered by

- **[HeyGen HyperFrames](https://hyperframes.heygen.com)** — the video
  framework doing the actual work: compositions are plain HTML + GSAP
  timelines, previewed in a browser studio, linted and rendered
  deterministically to MP4 by the
  [`hyperframes` CLI](https://www.npmjs.com/package/hyperframes). If an
  agent can write HTML, it can make video.
- **[TanStack AI](https://tanstack.com/ai)** — the agent plumbing:
  `useChat` on the client, typed tool definitions on the server, and the
  `@tanstack/ai-sandbox-cloudflare` topology this app forks — a Durable
  Object coordinator driving a coding agent that lives inside a sandbox,
  with host tools bridged over MCP.
- **[Cloudflare Sandboxes](https://developers.cloudflare.com/sandbox/)** —
  full Linux containers addressable from a Worker: the `claude` CLI, Node,
  Chromium, and ffmpeg run *there*, per-thread, with exec/file APIs and
  quick tunnels back out. Plus [TanStack Start](https://tanstack.com/start)
  for the app shell and shadcn/Base UI for the chat components.

## What you'll see

- **Chat** — every message is a video brief. One-click demo briefs (product
  teaser, kinetic quote, logo sting…) skip the interview and start authoring
  immediately.
- **Player tab** — the thread's *live* composition, before any render, with
  transport controls and frame-accurate scrubbing. It refreshes itself every
  time the agent finishes a turn, and opens on a preset 5-second intro baked
  into the sandbox image so there's something to watch from the first page
  load.
- **Renders tab** — the MP4s and bundled compositions the agent has
  published, straight out of R2.
- **Hyperframes Studio** (header button) — the sandbox's full
  `hyperframes preview` editing studio, opened in its own window through a
  Cloudflare quick tunnel.

## What you need

- A **Cloudflare Workers Paid** plan — Cloudflare Containers require it.
- An **Anthropic API key** — the in-sandbox `claude` CLI is the agent.
- For local development only: [Bun](https://bun.sh) and **Docker Desktop**
  (the Cloudflare Vite plugin builds and runs the sandbox container locally;
  OrbStack cannot run Cloudflare containers).

## Deploy it

### One click

1. Hit **Deploy to Cloudflare** above. Cloudflare clones this repo into your
   GitHub/GitLab account, provisions the R2 bucket, sets up CI (Workers
   Builds), and deploys. You can rename the Worker, repo, and bucket on the
   setup page.
2. **Add your Anthropic key** — the one thing the button can't do for you.
   In the Cloudflare dashboard: your Worker → *Settings* → *Variables and
   Secrets* → add a **secret** named `ANTHROPIC_API_KEY`. (Or from a checkout:
   `bunx wrangler secret put ANTHROPIC_API_KEY`.) Without it, deploys succeed
   but every agent run fails at startup with a clear error.
3. **Give the container a few minutes.** The sandbox image finishes
   `provisioning → ready` after the Worker deploy. When the studio loads,
   the Player should show the intro animation — that's your proof the
   container is up.

From then on, every push to `main` on your new repo builds and deploys
automatically.

### From a checkout

```bash
git clone <your fork> && cd hyperframes-tanstack-cloudflare
bun install
bunx wrangler r2 bucket create hyperframes-studio-renders   # match wrangler.jsonc
bunx wrangler secret put ANTHROPIC_API_KEY
bun run deploy                                              # build + wrangler deploy
```

Want CI without the button? Connect the repo to
[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
(Worker → *Settings* → *Builds*) — the Worker name in the dashboard must
match `name` in `wrangler.jsonc`.

### Renaming things

Everything configurable lives in `wrangler.jsonc`: the Worker `name`, the R2
`bucket_name` (must match the bucket you create), and the container
`instance_type` (default `standard-4`; renders are CPU- and memory-hungry).

### Two pipeline facts worth knowing

- **Branch builds do not build the container.** They run
  `wrangler versions upload`, which skips the docker image entirely — a green
  branch build proves nothing about the Dockerfile. Image problems only
  surface on the `main` build.
- **Container rollout lags the deploy** by a few minutes, and existing chat
  threads stay pinned to containers from the old image until they recycle.
  Test image changes with a fresh thread.

## Run it locally

```bash
bun install
cp .dev.vars.example .dev.vars   # put your ANTHROPIC_API_KEY in it
bun run dev                      # http://localhost:3001 — Docker Desktop must be running
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
- The preview sandbox boots on page load (`POST /api/preview` "ensure"), its
  tunnel is health-polled without waking a sleeping container ("probe"), and
  a stopped sandbox surfaces as an explicit *Resume* button rather than a
  dead pane.
- The **Player** plays the live composition through `GET /api/player`, a
  same-origin proxy of the preview server's bundled-composition route —
  same-origin because the player drives compositions via `contentWindow`,
  which a cross-origin tunnel URL forbids.
- Published compositions and MP4 renders live in **R2**, served by `/p/*`
  and `/r/*`.

## When something breaks

- **"the tanstack MCP server hasn't come up"** — almost always a 404 on the
  container's callback to `/_bridge`, meaning the bridge origin is wrong.
  Locally: keep `server.host: true` in `vite.config.ts`. Deployed: the
  origin derives from the request host; `PUBLIC_HOSTNAME` is an override
  only.
- **Player says "the preview has stopped"** — the sandbox slept after
  inactivity. Hit *Resume*; published compositions and renders are safe,
  anything unpublished lived on the container's ephemeral disk.
- **Quick-tunnel hostnames may not resolve through your local DNS** — fresh
  `*.trycloudflare.com` names can be invisible to ISP/VPN resolvers while
  the browser (secure DNS) sees them fine. That is why tunnel verification
  runs *inside the container* and the health probe falls back to
  DNS-over-HTTPS before declaring a tunnel dead.
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

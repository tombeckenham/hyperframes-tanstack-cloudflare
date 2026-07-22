# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

**The app is not scaffolded yet.** This directory currently holds only `CLAUDE.md` and
`PLAN.md`. Read `PLAN.md` first — it is the build order, and it records the decisions
(and their rationale) that this file summarises. Update both as the code lands.

## What this is

A HyperFrames authoring studio: a **TanStack Start** app on **Cloudflare Workers** where
the user chats with a coding agent that authors HyperFrames HTML video compositions
**inside a Cloudflare Sandbox container**, previews them live, and renders them to MP4.

One `wrangler deploy` ships everything — SSR UI, agent Durable Objects, and the
container — as a single Worker.

## Commands

Package manager is **bun**. Never use npm/pnpm/yarn for installs or scripts here.

```bash
bun install
bun run dev          # vite dev on :3001 — Worker + DOs + container in workerd (needs Docker Desktop)
bun run build
bun run deploy       # bun run build && wrangler deploy
bun run typecheck    # tsc --noEmit
bun run test         # bun test
bun run lint         # oxlint
bun run lint:fix     # oxlint --fix
bun run format       # oxfmt
bun run format:check # oxfmt --check
bun run cf-typegen   # wrangler types → worker-configuration.d.ts (run after editing wrangler.jsonc)
```

`lefthook` runs lint + format:check + typecheck on `pre-commit` (see `lefthook.yml`).
Install hooks with `bun run prepare` (or `bunx lefthook install`) after a fresh clone.
CI (`.github/workflows/ci.yml`) runs the same three plus `test` and `build`, and
separately builds the sandbox image — the hook is skippable with `--no-verify`, CI is not.

**`src/routeTree.gen.ts` is written by the `tanstackStart()` Vite plugin**, so regenerate
it with `bun run dev` or `bun run build` and commit the result. Do **not** use the
standalone `tsr generate` CLI: it emits a tree WITHOUT the trailing
`declare module '@tanstack/react-start'` Register block (`ssr`, `router`), and the
downgraded file still typechecks — so nothing catches the loss. The scaffold's
`generate-routes` script was removed for that reason. CI asserts the committed tree
matches what the build produces.

Adding UI:

```bash
bunx shadcn@latest add <component>   # primitives and chat components, same registry
```

## Local dev prerequisites

- **Docker Desktop must be running.** The Cloudflare Vite plugin builds and runs the
  sandbox container image locally. OrbStack cannot run Cloudflare containers.
- `.dev.vars` (gitignored) with `ANTHROPIC_API_KEY` for the in-sandbox `claude` CLI.
  Copy from `.dev.vars.example`.
- No tunnel or public hostname is needed locally. See "Two host surfaces" below.

## Architecture

Three tiers, one Worker:

```
Browser ──POST /api/run──▶ Start server route ──DO RPC──▶ RunCoordinator DO ──▶ Sandbox container
   ▲                          (SSE bridge)                  (drives chat())      (claude CLI +
   └──────── SSE ─────────────────┘                                               hyperframes CLI)
```

1. **Worker (`src/server.ts`)** — custom Cloudflare entry. Re-exports the DO classes so
   wrangler's `class_name` bindings resolve, and routes in strict order:
   `proxyToSandbox` (hostname-routed preview traffic) → **`/_bridge`** → TanStack Start
   SSR + `/api/*`. `/_bridge` is **reserved for the agent** — do not add app routes there.

   `/runs` and `/tool-exec` are **deliberately not routed**. The package's `/runs`
   trigger has no authentication — it takes `threadId` straight from the body and does
   `idFromName(threadId)` — so exposing it let anyone start a run in any thread, and a
   thread's container holds `ANTHROPIC_API_KEY`. Nothing needs it over HTTP (the browser
   goes through `/api/run` over the binding). `/tool-exec` is `colocated`-mode only, and
   this app runs `do-drives`. Removing them beats authenticating them.
2. **`RunCoordinator` Durable Object** — owns a run. `startRun()` over the binding
   registers it; the DO drives `chat()` under `ctx.waitUntil` plus a watchdog
   alarm, appends every `StreamChunk` to a `seq`-indexed durable log, and serves
   resumable WebSocket tails. A Worker invocation never holds a multi-minute agent loop.
3. **Sandbox container** — the `claude` CLI *and* the HyperFrames toolchain (Node 22,
   Chromium, ffmpeg, `hyperframes`) live in the image. The agent authors compositions,
   runs `hyperframes preview`/`lint`/`render` there.

### Why `/api/run` talks to the DO, not to `/runs`

`useChat` speaks "POST a body, read SSE back"; the coordinator speaks
"POST-then-WebSocket". `src/routes/api.run.ts` bridges the two. It addresses the
coordinator **over the `RUN_COORDINATOR` binding**, not via `fetch('/runs')` — for two
independent reasons. A Worker fetching its own hostname is a same-zone self-subrequest,
which Cloudflare blocks in production (error 1042 → 404) even though it resolves fine in
local `workerd`; and `/runs` is no longer routed publicly at all (see above).

### Thread identity — never trust a client-supplied `threadId`

A run's container is pinned to its `threadId` and every container carries
`ANTHROPIC_API_KEY`, so whoever can name a `threadId` can reach that container. `/api/run`
must therefore derive it via `src/lib/session.ts`:

```
sessionId  256-bit random, HttpOnly cookie (opaque — nothing stored, nothing verified)
threadKey  client-chosen, one per chat thread, not a secret
threadId   SHA-256(sessionId \0 threadKey)
```

Two visitors picking the same `threadKey` get different threads, and reaching someone
else's means guessing 256 bits. The hash matters: `threadId` becomes a container DO name
and appears in R2 keys and the run log, so it must not carry the session id in recoverable
form. This is tenant scoping, not authentication — when real accounts arrive, seed the
session id from the authenticated user and the rest holds.

`deriveThreadId` returns a **branded `ThreadId`**, so a raw `string` from a request body
will not compile at the `startRun` call site. That is deliberate: a comment cannot enforce
this invariant, the type can.

### The `/api/run` contract

Three things it MUST do, none of which the type system can supply for you:

1. `threadId` — from `deriveThreadId(sessionId, threadKey)`. Never from the body.
2. `setCookie` — attach `resolveSession()`'s value to the response when non-null, or the
   visitor gets a fresh namespace on every request and loses their threads.
3. **`publicHost`** — pass `new URL(request.url).host` into `startRun()`. The package's
   `/runs` route used to set this and we no longer route it, so it is now the caller's
   job. `StartRunInput.publicHost` is optional, so omitting it typechecks and deploys —
   then `resolveBridgeOrigin` has no host to derive and the run fails at the container's
   first callback, surfacing as "the tanstack MCP server hasn't come up" (really a 404).

### Host tools and the MCP bridge

Tools passed to `createCloudflareSandboxAgent({ tools })` run **on the host** and are
exposed to the in-sandbox agent over MCP, served from the coordinator DO's own `fetch`
handler at `/_bridge/:runId` (gated by a per-run bearer token, constant-time compared
with Web Crypto). No TCP listener is ever opened — a DO cannot open one.

This is the lane for anything the sandbox must not do itself: minting preview URLs,
publishing renders to R2, handing the agent the HyperFrames recipe.

### Two host surfaces

- **Bridge** (container → Worker `/_bridge`): local → `host.docker.internal:3001`,
  deployed → derived from the request host. `PUBLIC_HOSTNAME` is an *override only*; a
  wrong value surfaces as "the tanstack MCP server hasn't come up" (a 404).
  `vite.config.ts` must keep `server.host: true` or the container's bridge call gets
  `ECONNREFUSED`.
- **Preview** (browser → in-sandbox server): a Cloudflare quick tunnel
  (`*.trycloudflare.com`) opened by `sandbox.tunnels.get(port)`. Needs no wildcard DNS,
  works locally and deployed. Do **not** switch to `exposePort` + `proxyToSandbox` in
  dev: Vite's middleware hijacks the preview's `/@vite/client` and `/src/*` requests and
  breaks the page.

Tunnels require `SANDBOX_TRANSPORT: "rpc"`; on the default `http` transport
`sandbox.tunnels` throws. Every `getSandbox()` call for an id must pass the same
transport.

### Sandbox naming

The sandbox is pinned to the run's `threadId` (a custom provider, not the package
default which uses a random UUID). Host tools like `exposePreview` and the render
publisher have to address *the same* container the agent is working in, and pinning also
survives DO eviction for `lifecycle: { reuse: 'thread' }`.

### Port map

`3000` is reserved by the sandbox control plane — never bind it.
`3002` = `hyperframes preview` studio. `8787`/`3001` = the Worker dev server.

## Conventions

- **TypeScript is maximally strict**: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`,
  `erasableSyntaxOnly`, `noUnusedLocals`/`Parameters`. No `any`, no non-null `!`, no
  `as` casts to paper over a type — model the type properly or use a type guard.
  `oxlint` enforces `typescript/no-explicit-any` and friends as errors.
- **oxfmt is the only formatter.** Do not add Prettier, ESLint, or Biome; the TanStack
  CLI scaffold is created with `--no-toolchain` for exactly this reason.
- Validate every request body with zod at the route boundary; share the type guards
  between the UI and the server route (see `src/sandbox-options.ts` pattern).
- **UI primitives are Base UI** (`@base-ui/react`), not Radix. `components.json` is on
  style `base-nova`; `shadcn add` resolves the Base variants automatically. The
  composition idiom is the **`render` prop**, never `asChild` — a Radix-flavoured shadcn
  snippet copied off the web will not compile here.
- **Chat UI is shadcn's own chat components** (`message-scroller`, `message`, `bubble`,
  `attachment`, `marker`) driven directly by TanStack AI's `UIMessage`/`MessagePart`
  types. They have no AI-library coupling — they render children, not a message model, so
  there is no adapter layer and none should be introduced. Do **not** add Vercel AI
  Elements (`registry.ai-sdk.dev`); it is written against Vercel AI SDK types.
- `src/styles.css` is `@import "shadcn/tailwind.css"` (written by `shadcn init`). The
  `scroll-fade` and `shimmer` utilities that `message-scroller` and `attachment` depend
  on live there, not in the registry — do not replace it with a hand-rolled stylesheet.
- Cloudflare binding types come from `worker-configuration.d.ts` — regenerate with
  `bun run cf-typegen` after any `wrangler.jsonc` change; never hand-edit it.

## Known constraints

- **No writable host→process stdin** in the Cloudflare sandbox
  (`capabilities.writableStdin: false`). The Claude Code adapter handles this by writing
  the prompt to a file and redirecting stdin in-shell. Interactive/duplex ACP harnesses
  will not work.
- **Container disk is ephemeral** (`durableFilesystem: false`). Anything that must
  survive a cold start has to be persisted by the host — that is what R2 is for.
- **Sandbox secrets are host-controlled**, identical for every caller. The run trigger
  carries only `threadId` + `messages` + `metadata`. Do not put one user's secret in a
  sandbox another user can reach; the sandbox runs LLM-authored code.
- Cloudflare Containers require a **Workers Paid** plan.

## Reference implementations

Local checkouts worth reading before changing the agent wiring:

- `/Users/tom/code/TanStack/ai/examples/sandbox-cloudflare` — the topology this app
  forks (agent, DO coordinator, SSE bridge, named sandbox provider, Dockerfile). Its
  `README.md` is the best explanation of the run protocol.
- `/Users/tom/code/heygen-com/hyperframes-cloudflare-template` — container-based
  `hyperframes render` → R2 streaming, and `bundleToSingleHtml` for self-contained
  preview HTML.
- `/Users/tom/code/heygen-com/hyperframes` — the HyperFrames monorepo: `packages/cli`
  README for commands, `skills/` for the composition-authoring knowledge the in-sandbox
  agent needs.

# Plan — HyperFrames Studio on TanStack Start + Cloudflare

Chat with a coding agent that authors **HyperFrames** video compositions inside a
**Cloudflare Sandbox** container, preview them live in the browser, and render them to
MP4 stored in R2. One TanStack Start app, one Worker, one `wrangler deploy`.

---

## 1. Decisions (and why)

| Decision | Choice | Why |
| --- | --- | --- |
| App shell | TanStack Start (React 19, file router) | SSR + server routes + Worker in one build via `@cloudflare/vite-plugin`. |
| Scaffold | `@tanstack/cli create … --intent`, then `shadcn init -b base` | The TanStack CLI owns the Cloudflare add-on and writes TanStack Intent skill mappings for coding agents (both for our repo *and* for what the sandbox agent scaffolds); shadcn owns its own setup. Its `shadcn` add-on is skipped deliberately — it would pin us to Radix. |
| Agent runtime | `@tanstack/ai-sandbox-cloudflare` `createCloudflareSandboxAgent()` | Ships the whole edge topology: stateless trigger Worker, run-coordinator DO, durable resumable run-log, DO-served MCP tool bridge. Building this by hand is the bulk of the work. |
| Execution model | `do-drives` (default) | The DO runs `chat()`; the container only runs the CLI. The `colocated` mode needs a second bundled build target inside the image. |
| Harness | Claude Code only (`claudeCodeText('sonnet')`) | The upstream example is a 3-harness demo; this app is a HyperFrames studio, not a harness comparison. One key, one code path. Codex/Grok can be added later — the topology is adapter-agnostic. |
| Compositions live | In the sandbox container workspace | HyperFrames authoring is a filesystem workflow (`hyperframes init/lint/preview/render`). Persist to R2 explicitly; container disk is ephemeral. |
| Live preview | `hyperframes preview` in-sandbox on **:3002** → Cloudflare quick tunnel → iframe | Zero DNS config, works local and deployed, forwards WebSockets so live-reload works. `exposePort` + `proxyToSandbox` breaks under Vite dev (its middleware hijacks `/@vite/client`, `/src/*`). |
| Durable preview | `bundleToSingleHtml` in-sandbox → upload to R2 → `<hyperframes-player src>` | A tunnel dies with the container. A bundled single HTML in R2 is shareable and outlives the run. |
| Render | `hyperframes render` **in the same sandbox container** | The template uses a second `RenderContainer` DO; that means shipping composition files across a Worker on every render. Baking Chromium + ffmpeg into the sandbox image renders in place, where the files already are. |
| Render → R2 | In-sandbox `curl` PUT to a token-gated Worker route, streamed into R2 | The sandbox fs bridge is base64-over-exec — fine for HTML, wasteful and memory-heavy for an MP4. |
| Primitives | **Base UI** (`@base-ui/react` 1.6.0) via `shadcn init -b base`, style `base-nova` | shadcn's current default (`--defaults` resolves to the base preset). Verified: **every** component this app needs exists in the `base-nova` style, and the Base variants carry *fewer* deps than the Radix ones — `bubble`/`marker`/`attachment` drop `radix-ui` entirely for `@base-ui/react/use-render`. `asChild` becomes the `render` prop, which is the idiom shadcn's newer components were already authored against. |
| Chat UI | shadcn's own **chat components** (June 2026): `message-scroller`, `message`, `bubble`, `attachment`, `marker` | Verified against the registry: **zero AI-library coupling**. They take *rendered children*, not a message model — so TanStack AI's `UIMessage`/parts drive them directly with no adapter layer. Only `message-scroller` pulls a real dep (`@shadcn/react`, the new headless primitives package). |
| Message rendering | `@tanstack/ai-react-ui` for the parts model, shadcn for the skin | It is genuinely headless (className/render-prop only, no styling opinions), so the two compose rather than compete. Take `ThinkingPart` + the parts types from it; draw with `Bubble`/`Message`. This is what the upstream `ts-react-chat` example does. |
| Composer | Hand-built from `input-group` + `textarea` + `button-group` | The shadcn chat set ships **no** prompt input. `input-group` is the intended primitive for it. |
| Lint / format | oxlint + oxfmt, `--no-toolchain` on scaffold | Explicit user requirement. Do not let any add-on reintroduce Prettier/ESLint/Biome. |
| Hooks | lefthook v2 pre-commit: oxlint → oxfmt --check → tsc | Explicit user requirement. |
| Package manager | bun | Explicit user requirement (`--package-manager bun`). |

### Open risks

1. **`sonner` under `base-nova` pulls `next-themes`** — a Next.js-ism with no place in a
   TanStack Start app. Either wire the toaster's `theme` prop to our own theme signal and
   drop the dep, or skip `sonner` and surface errors as `Marker` rows in the transcript
   (probably better here — run failures belong in the run log, not a corner toast).
2. **No tool-call / reasoning components in the set.** The five components cover the
   *conversation shell*, not agent affordances. Tool calls and the agent's thinking are
   ours to build — `marker` for status lines, `Collapsible` + `Bubble variant="outline"`
   for tool calls, `ThinkingPart` from `@tanstack/ai-react-ui` for reasoning. Cheaper than
   the AI Elements adapter would have been, but it is not free.
3. **`--intent` + `--no-toolchain` + oxlint interaction.** The scaffold's generated
   config may still reference a toolchain. Verify `bun run lint` is clean on a bare
   scaffold before adding app code.
4. **Image size / cold start.** Chromium + ffmpeg + `chrome-headless-shell` on top of the
   `cloudflare/sandbox` base is a large image. Bake everything at build time (never
   install at render time) and consider `instance_type: standard-4`.
5. **Upstream example is a reference, not runtime-verified.** Its README says so. Expect
   to debug the bridge on first run; the classic symptom is "the tanstack MCP server
   hasn't come up".

---

## 2. Build order

### Phase 0 — repo bootstrap

```bash
git init
bunx @tanstack/cli@latest create . \
  --framework react \
  --package-manager bun \
  --add-ons cloudflare,tanstack-query,store \
  --no-toolchain --no-examples --no-git --intent -y --force

# NOT the tanstack `shadcn` add-on — it writes a Radix `components.json` and a
# hand-rolled styles.css. Let shadcn own its own setup, on Base UI:
bunx shadcn@latest init -b base -p nova -y
```

`shadcn init` in an existing project only writes `components.json`, rewrites
`src/styles.css` to `@import "shadcn/tailwind.css"`, and installs `@base-ui/react` — it
does not touch routing or the Cloudflare wiring.

Then:

- Rename/replace the scaffolded `wrangler.jsonc` app name → `hyperframes-studio`.
- `bun run dev` once to confirm a bare scaffold boots before touching anything.

**Exit criteria:** `bun run dev` serves the scaffold; `bun run build` succeeds.

### Phase 1 — strict toolchain

Files: `tsconfig.json`, `.oxlintrc.json`, `.oxfmtrc.json`, `lefthook.yml`, `package.json`.

- `tsconfig.json` compiler options: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `noUnusedLocals`,
  `noUnusedParameters`, `verbatimModuleSyntax`, `erasableSyntaxOnly`,
  `useUnknownInCatchVariables`, `isolatedModules`, `noEmit`, `moduleResolution: bundler`.
- `.oxlintrc.json`: categories `correctness`/`suspicious`/`perf` = error, `pedantic` =
  warn; plugins `["typescript","react","react-perf","import","promise","unicorn"]`; rules
  `typescript/no-explicit-any`, `typescript/no-non-null-assertion`,
  `no-console` (allow `warn`/`error`) = error. Ignore `src/routeTree.gen.ts`,
  `worker-configuration.d.ts`, `src/components/ui/**` (vendored shadcn), `.wrangler/`.
- `.oxfmtrc.json`: `singleQuote: true`, `semi: false`, `printWidth: 80`,
  `trailingComma: "all"` (match TanStack house style).
- `lefthook.yml` — pre-commit, parallel:
  `lint` = `bunx oxlint {staged_files}`;
  `format` = `bunx oxfmt --check --no-error-on-unmatched-pattern {staged_files}`;
  `typecheck` = `bun run typecheck` (whole project; TS has no useful staged mode).
  Add `"prepare": "lefthook install"` to `package.json`.

**Exit criteria:** `bun run lint && bun run format:check && bun run typecheck` all clean;
a deliberate `any` blocks a commit.

### Phase 2 — Cloudflare + agent wiring

Ported from `/Users/tom/code/TanStack/ai/examples/sandbox-cloudflare`, trimmed to one
harness.

Deps: `@cloudflare/sandbox`, `@tanstack/ai`, `@tanstack/ai-react`, `@tanstack/ai-sandbox`,
`@tanstack/ai-sandbox-cloudflare`, `@tanstack/ai-claude-code`, `zod`.
Dev: `wrangler`, `@cloudflare/vite-plugin`.

| File | Contents |
| --- | --- |
| `src/server.ts` | Re-export `RunCoordinator` + `Sandbox`; route `proxyToSandbox` → agent paths (`/runs`, `/_bridge`, `/tool-exec`) → Start handler. |
| `src/agent.ts` | `createCloudflareSandboxAgent<AppEnv>({ adapter, systemPrompts, tools, sandbox })`. |
| `src/sandbox-provider.ts` | `namedCloudflareSandbox` — pin the container DO to `threadId`, `transport: 'rpc'`. |
| `wrangler.jsonc` | `main: src/server.ts`, `nodejs_compat`, containers (`Sandbox`, `./Dockerfile`, `standard-4`), DO bindings `RUN_COORDINATOR` + `Sandbox`, sqlite migration `v1`, R2 `RENDERS`, `vars: { SANDBOX_TRANSPORT: "rpc" }`, observability on. |
| `vite.config.ts` | `cloudflare({ viteEnvironment: { name: 'ssr' } })`, `tanstackStart()`, `viteReact()`, `tailwindcss()`; `server.host: true`, `allowedHosts: ['host.docker.internal']`. |
| `.dev.vars.example` | `ANTHROPIC_API_KEY=`. |

`Dockerfile` — extend `cloudflare/sandbox:<pinned>` with the whole HyperFrames toolchain:

1. `npm i -g @anthropic-ai/claude-code --include=optional` (optional deps carry the
   native binary; a plain `-g` install yields a `claude` that errors).
2. Chromium system libs (`libnss3`, `libxcomposite1`, `libpango`, …) — same set as the
   HyperFrames Cloudflare template.
3. `npm i -g hyperframes ffmpeg-static` + symlink ffmpeg onto `PATH`.
4. `npx hyperframes browser ensure` to bake `chrome-headless-shell` into the image.
5. `npx hyperframes doctor` as a build-time assertion — fail the image, not the run.
   **CORRECTED:** `doctor` ALWAYS exits 0, so a bare `RUN hyperframes doctor` asserts
   nothing — which is precisely how a missing `ffprobe` shipped unnoticed
   (`ffmpeg-static` carries only `ffmpeg`). Gate on `doctor --json` and the specific
   checks the image owns (Node.js, FFmpeg, FFprobe, Chrome), NOT on top-level `.ok`,
   which is false whenever optional TTS/MusicGen are absent and would make the image
   unbuildable.

**Exit criteria:** `bun run cf-typegen` types resolve; `bun run dev` boots the Worker,
both DOs, and the container; `docker run` of the image passes `hyperframes doctor`.

### Phase 3 — host tools (the HyperFrames lane)

All in `src/tools/`, registered via `tools: (input, env) => [...]` so they bridge to the
in-sandbox agent over MCP.

- **`hyperframesRecipe`** — the canonical authoring recipe, sectioned
  (`scaffold` | `author` | `preview` | `render` | `all`), mirroring the upstream
  `tanstackStartRecipe` pattern. Contents: `npx hyperframes init <name>`; the composition
  contract (`class="clip"`, `data-*` timing attributes, deterministic/seek-safe motion);
  `hyperframes lint --json` before every preview; start `hyperframes preview --port 3002
  --host 0.0.0.0` (never :3000); then call `exposePreview`. Seed it from
  `/Users/tom/code/heygen-com/hyperframes/skills/hyperframes*/SKILL.md`.

  **CORRECTED** — four of those are wrong against the CLI 0.7.68 in the image. See
  `src/tools/recipe.ts`, which is the source of truth:
    - `preview` has **no `--host` flag**. It binds `127.0.0.1` unless
      `HYPERFRAMES_PREVIEW_HOST=0.0.0.0` (now baked into the image as an `ENV`), so the
      quick tunnel would reach nothing while appearing to work.
    - `preview` also needs **`--background`**, or the server dies the moment the agent's
      shell call returns and `exposePreview` has nothing to tunnel to. Use `--status` to
      read the REAL port — the server scans forward from `--port`, so 3002 is not
      guaranteed.
    - `init` **requires `--example`** in a non-TTY, and the sandbox is non-TTY:
      `init <name> --non-interactive --example blank`.
    - `check`, not `lint`, is the gate — and it reruns lint itself, so a preceding
      standalone `lint` is redundant. `validate`/`inspect`/`layout` are deprecated
      aliases and must not appear in new instructions.
- **`exposePreview`** — the package's `exposePreviewTool(input, env)`, unmodified.
- **`publishComposition`** — run `bundleToSingleHtml` in-sandbox, read the single HTML
  back over the fs bridge, `PUT` to R2 under `previews/<threadId>/<slug>.html`, return the
  public `/p/<key>` URL.
- **`publishRender`** — the agent renders to a local path, then calls this with
  `{ path, name }`; the tool mints a short-lived per-run upload token and returns a
  `curl` instruction. The sandbox streams the MP4 to `PUT /api/uploads/:runId/:name`,
  which validates the token and pipes the body straight into R2. Returns `/r/<key>`.
- **`listArtifacts`** — enumerate this thread's R2 objects so the UI gallery and the agent
  agree on what exists.

Worker routes to add (Start server routes, outside the agent's reserved roots):
`PUT /api/uploads/:runId/:name`, `GET /r/:key` (MP4, range-aware), `GET /p/:key` (HTML,
served with `frame-ancestors 'self'; object-src 'none'`).

**Exit criteria:** a scripted run drives init → lint → preview → tunnel URL → render →
R2 object, with no manual steps.

### Phase 4 — UI

`components.json` is already on `base-nova` from Phase 0, so `add` resolves Base UI
variants automatically:

```bash
bunx shadcn@latest add message-scroller message bubble attachment marker
bunx shadcn@latest add button button-group input-group textarea scroll-area tabs \
  card badge separator dialog dropdown-menu select tooltip collapsible \
  skeleton resizable spinner
bun add @tanstack/ai-react-ui
```

All of the above are confirmed present under `base-nova`. Only `resizable`
(`react-resizable-panels`) carries a non-Base dependency; `sonner` is deliberately
omitted (see risk 1).

Component map — what draws what:

| Surface | Built from |
| --- | --- |
| Transcript | `MessageScrollerProvider` / `Viewport` / `Content` / `Item` / `Button`. This is the piece worth taking: it owns anchored turns, streamed-reply autoscroll, thread restore, and jump-to-message — exactly the behaviour a multi-minute agent run needs, and the part nobody wants to write twice. |
| A turn | `MessageGroup` → `Message align` → `MessageAvatar` / `MessageHeader` / `MessageContent` / `MessageFooter`. |
| Text | `Bubble variant="default"` (user) / `variant="ghost"` (assistant, full width for markdown). |
| Tool call | `Bubble variant="outline"` + `Collapsible`; header = tool name + `Spinner`, body = args/result JSON. |
| Reasoning | `ThinkingPart` from `@tanstack/ai-react-ui`, wrapped in a `Collapsible`. |
| Run status | `Marker variant="separator"` for "sandbox booting", "render started", date breaks; `shimmer` on the live one. |
| Rendered MP4 / bundled HTML | `Attachment` with `AttachmentMedia variant="image"` (poster frame) + upload/processing `state`. |
| Composer | `InputGroup` + `Textarea` + `ButtonGroup` (send / stop / model). Not shipped by the chat set — ours to build. |
| Preview pane | Plain `Tabs` + `iframe` + `<hyperframes-player>`. AI Elements' `web-preview` was the one thing worth borrowing; it is ~80 lines of URL bar + iframe, so reimplement it rather than take the dependency. |

- `src/routes/api.run.ts` — the SSE bridge. Port from upstream, drop the harness/grok
  fields; keep the zod `preprocess` flattening of `data`/`forwardedProps`, and keep
  addressing the coordinator over the **binding** (self-subrequest → error 1042).
- `src/routes/index.tsx` — two-pane resizable layout: transcript left, preview right
  (tabs: **Live** quick-tunnel studio / **Player** `<hyperframes-player src="/p/<key>">` /
  **Renders** R2 gallery).
- `src/components/chat/message-parts.tsx` — the one piece of real UI logic: switch over
  TanStack AI's `MessagePart` union (`text` / `tool-call` / `tool-result` / `thinking`)
  and pick the shadcn shell above. No type adapter needed — that was the AI Elements tax.
- Thread persistence: `threadId` in the URL search param so a reload resumes the same
  sandbox (`lifecycle: { reuse: 'thread' }`) and the same run-log cursor.

**Exit criteria:** type a prompt → watch tool calls stream → live preview appears in the
right pane → "Render" produces a playable MP4 in the gallery.

### Phase 5 — ship

- `wrangler secret put ANTHROPIC_API_KEY`; `bun run deploy`.
- `README.md`: architecture diagram, the port map, the Docker Desktop requirement, the
  Workers Paid requirement.
- Fold anything learned into `CLAUDE.md` — especially bridge/tunnel failure modes.

---

## 3. Target layout

```
src/
  server.ts                 # Worker entry: proxyToSandbox → agent → Start SSR
  agent.ts                  # createCloudflareSandboxAgent + AppEnv
  sandbox-provider.ts       # threadId-pinned container, transport: 'rpc'
  tools/
    recipe.ts               # hyperframesRecipe
    publish.ts              # publishComposition / publishRender / listArtifacts
  routes/
    __root.tsx
    index.tsx               # chat + preview studio
    api.run.ts              # POST-then-WS → SSE bridge
    api.uploads.$runId.$name.ts
    r.$key.ts               # MP4 from R2
    p.$key.ts               # bundled composition HTML from R2
  components/
    ui/                     # shadcn primitives + chat components (vendored, lint-ignored)
    chat/
      transcript.tsx        # MessageScroller + Message/Bubble composition
      message-parts.tsx     # MessagePart union → shadcn shell
      composer.tsx          # InputGroup + Textarea + ButtonGroup
    studio/
      preview-pane.tsx      # Tabs: live tunnel / player / renders
Dockerfile                  # sandbox base + claude CLI + hyperframes + chromium + ffmpeg
wrangler.jsonc  vite.config.ts  lefthook.yml  .oxlintrc.json  .oxfmtrc.json
```

## 4. Gotchas to carry into every phase

- Port **3000 is the sandbox control plane** — never bind it. Preview studio is 3002.
- `SANDBOX_TRANSPORT: "rpc"` is mandatory for tunnels, and every `getSandbox()` for an id
  must pass the same transport.
- `vite.config.ts` `server.host: true` or the container's `/_bridge` call gets
  `ECONNREFUSED`.
- Never `fetch()` the app's own hostname from the Worker — use the DO binding.
- `/runs`, `/_bridge`, `/tool-exec` are the agent's; app routes go elsewhere.
- Re-run `bun run cf-typegen` after every `wrangler.jsonc` edit.
- Primitives are **Base UI, not Radix**: it is `render={<X/>}`, never `asChild`. Copying a
  Radix-flavoured shadcn snippet off the web will not compile.
- Docker Desktop specifically (not OrbStack), and a Workers Paid plan for Containers.

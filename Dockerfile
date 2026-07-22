# Sandbox container image for the HyperFrames authoring studio.
#
# One image, two toolchains:
#   1. the `claude` CLI — the coding agent the RunCoordinator DO drives via
#      chat(); it authors the composition inside this container.
#   2. the HyperFrames toolchain (Node 22, Chromium libs, chrome-headless-shell,
#      ffmpeg, `hyperframes`) — what that agent then runs to preview, lint and
#      render the composition it just wrote.
#
# Everything is baked at build time. Container disk is ephemeral
# (`durableFilesystem: false`), so anything installed at run time would be paid
# for on every cold start; and a run-time `npm install` inside a sandbox that is
# executing LLM-authored code is exactly the failure mode we don't want.
#
# This tag MUST equal the @cloudflare/sandbox version in package.json, so the
# in-container control server (port 3000 — exec/files/processes/ports) speaks
# the same protocol as the SDK the Worker is built against. package.json pins
# that dependency EXACTLY ("0.12.4", no caret) for this reason: under a caret
# range a routine `bun install` would resolve a newer SDK against this fixed
# image, and the mismatch would surface as an opaque control-plane error inside
# an agent run rather than at build time. Bump both together, never one.
#
# Base is Ubuntu 22.04 "jammy", published amd64-only. That matters twice:
#   - package names follow jammy, NOT Debian bookworm and NOT Ubuntu 24.04
#     (24.04 renamed libasound2 -> libasound2t64 for the time_t transition;
#     on jammy the plain name is the correct one).
#   - on an arm64 workstation this image only builds under emulation
#     (`docker build --platform linux/amd64`). Cloudflare Containers run amd64,
#     so amd64 is the right target regardless.
FROM docker.io/cloudflare/sandbox:0.12.4

# Claude Code CLI. `node` + `npm` are already on the base image.
# `--include=optional` is REQUIRED, not a nicety: the CLI's native binary ships
# as a platform-specific OPTIONAL dependency, and a plain `-g` install can skip
# it, leaving a `claude` on PATH that errors "native binary not installed" the
# first time an agent run touches it. `claude --version` asserts that here so a
# bad install fails the build rather than the run.
RUN npm install -g @anthropic-ai/claude-code --include=optional \
 && claude --version

# Chromium runtime libraries. `hyperframes` renders frames by driving
# chrome-headless-shell; the shell binary is self-contained except for these
# system .so's, and without them it dies at launch with a bare
# "error while loading shared libraries". List mirrors the one proven in
# hyperframes-cloudflare-template's render image, adjusted for jammy.
#
# `apt-get clean` + removing the lists keeps ~40MB of index metadata out of the
# layer; it is never useful at run time.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    wget \
    xdg-utils \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# The HyperFrames CLI plus static ffmpeg AND ffprobe builds.
#
# `hyperframes render` shells out to `ffmpeg` by name, so the ffmpeg-static
# payload has to be reachable on PATH under that name — hence the symlink out of
# the global node_modules prefix.
#
# `ffprobe-static` is a SEPARATE package and is not optional: ffmpeg-static
# ships only the `ffmpeg` binary, while hyperframes probes every media asset
# (duration, stream layout) with `ffprobe`. Without it `hyperframes doctor`
# reports "FFprobe is required to probe media assets" and any composition that
# references audio or video fails at author time.
#
# Both symlinks resolve the binary through each package's OWN api rather than by
# guessing a path. That is not fussiness: ffprobe-static ships every platform it
# supports (bin/{linux,darwin,win32}/{x64,arm64,ia32}/ffprobe), so a
# `find -name ffprobe | head -n1` picks whichever the filesystem lists first —
# here it picked the DARWIN build, and the layer died with
#   "Cannot run macOS (Mach-O) executable in isolated machine: Exec format error"
# `require("ffprobe-static").path` resolves for the platform node is running on,
# which inside this image is linux/x64. `ffmpeg-static` exports its path as a
# bare string; `ffprobe-static` exports `{ path }`.
#
# NODE_PATH is needed because these are GLOBAL installs, which `require` does
# not otherwise resolve from an arbitrary cwd.
#
# KNOWN SKEW: no npm package ships a matched ffmpeg/ffprobe pair. Here ffmpeg
# is 7.0.2 (2024) and ffprobe is a 2023 snapshot (N-66595) — both johnvansickle
# static builds, so at least the same vendor and close in age.
# `@ffprobe-installer/ffprobe` is used over `ffprobe-static` specifically
# because the latter still pins 4.0.2, from 2018.
#
# Probing is metadata-only over ordinary containers (mp4/mov/webm/mp3/wav), so
# the remaining skew is low-risk and `hyperframes doctor` accepts it. If it ever
# does bite, the alternatives are: install the distro `ffmpeg` package for a
# matched-but-older 4.4.2 pair, or unpack a johnvansickle tarball, which carries
# both binaries at one version at the cost of pinning a URL upstream rotates.
#
# The `-version` calls then assert both symlinks resolve AND that the binaries
# match the image architecture, so a cross-arch mistake surfaces right here
# instead of halfway through a render.
RUN npm install -g hyperframes ffmpeg-static @ffprobe-installer/ffprobe \
 && ln -sf "$(NODE_PATH="$(npm root -g)" node -p 'require("ffmpeg-static")')" \
      /usr/local/bin/ffmpeg \
 && ln -sf "$(NODE_PATH="$(npm root -g)" node -p 'require("@ffprobe-installer/ffprobe").path')" \
      /usr/local/bin/ffprobe \
 && /usr/local/bin/ffmpeg -version \
 && /usr/local/bin/ffprobe -version \
 && hyperframes --version

# Bake chrome-headless-shell into the image. Without this the first render in a
# cold container pays a multi-hundred-MB download before it draws a single
# frame — inside a sandbox whose disk is thrown away afterwards, so every cold
# start would pay it again.
RUN hyperframes browser ensure

# Build-time assertion: `doctor` checks node/ffmpeg/ffprobe/browser wiring end
# to end. Running it here means a broken image fails `docker build` — visible to
# whoever changed this file — instead of failing an agent run in production,
# where it surfaces as an opaque tool error many layers away from the cause.
#
# `hyperframes doctor` ALWAYS exits 0, even with failing checks, so `RUN
# hyperframes doctor` on its own asserts nothing. Grep its report instead, and
# only for the checks this image is responsible for. Deliberately NOT asserted:
#   - /dev/shm  — sized by the container runtime (`--shm-size`), not the image.
#     Chrome wants >=256MB and Docker's default is 64MB. Cloudflare's runtime
#     sets this, and hyperframes passes --disable-dev-shm-usage; locally, add
#     `--shm-size=512m` if a render dies mid-frame.
#   - Docker  — doctor looks for a Docker daemon for its own containerised
#     render mode. We are already inside a container; renders here are local.
#   - whisper-cpp / Kokoro TTS / MusicGen — optional local model backends
#     (transcription, voice, music). Each pulls hundreds of MB of Python and
#     model weights. Media generation goes through hosted providers instead;
#     bake them in only if an offline path is ever required.
# Gate on the --json payload rather than grepping the human-readable report:
# the text form is a rendering (check glyph, column padding, colour) and would
# silently stop matching if it ever changed, turning this assertion back into a
# no-op. Note we do NOT gate on the top-level `.ok`, which is false whenever any
# OPTIONAL check fails — the image would then never build.
RUN hyperframes doctor --json > /tmp/doctor.json \
 && cat /tmp/doctor.json \
 && node -e " \
      const r = require('/tmp/doctor.json'); \
      const required = ['Node.js', 'FFmpeg', 'FFprobe', 'Chrome']; \
      const failed = required.filter((name) => { \
        const check = r.checks.find((c) => c.name === name); \
        return !check || !check.ok; \
      }); \
      if (failed.length > 0) { \
        console.error('FATAL: hyperframes doctor failed required checks: ' + failed.join(', ')); \
        process.exit(1); \
      } \
      console.log('hyperframes doctor: all required checks pass'); \
    " \
 && rm /tmp/doctor.json

# `hyperframes preview` has NO `--host` flag. From the CLI source:
#
#   const host = bindHost ?? (process.env.HYPERFRAMES_PREVIEW_HOST?.trim() || "127.0.0.1")
#
# so it binds loopback by default — unreachable from outside the container, and
# the quick tunnel `exposePreview` opens would resolve to nothing while looking
# like it worked. Setting it here, at image level, makes it impossible for the
# in-sandbox agent to get wrong.
ENV HYPERFRAMES_PREVIEW_HOST=0.0.0.0

# No CMD/ENTRYPOINT: the base image already sets the sandbox control-server
# entrypoint and EXPOSEs 3000. We only layer tools on top. Overriding either
# would break the SandboxHandle RPC the Worker depends on.
#
# Port map reminder (see CLAUDE.md): 3000 is the sandbox control plane — never
# bind it. 3002 is `hyperframes preview` — but note the preview server scans
# FORWARD from `--port` for a free port, so callers must not assume it landed on
# 3002; probe `/__hyperframes_config` to confirm before exposing a tunnel.

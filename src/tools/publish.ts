/**
 * The publishing lane: host tools that move work out of the ephemeral container
 * and into R2, where it outlives the sandbox.
 *
 * These run on the HOST and are exposed to the in-sandbox agent over MCP, so
 * they can do things the sandbox must not do itself — hold the R2 binding, mint
 * upload credentials, and decide the public key space.
 */
import { toolDefinition } from '@tanstack/ai'
import { getSandbox } from '@cloudflare/sandbox'
import { resolveBridgeOrigin } from '@tanstack/ai-sandbox-cloudflare/agent'
import { z } from 'zod'
import type { Sandbox } from '@cloudflare/sandbox'
import type { StartRunInput } from '@tanstack/ai-sandbox-cloudflare/agent'

/** Must match every other getSandbox() for this id — see sandbox-provider.ts. */
const SANDBOX_OPTIONS = { transport: 'rpc' } as const

/** Where `bundle.mjs` is baked into the image (see Dockerfile). */
const BUNDLE_SCRIPT = '/usr/local/lib/hyperframes/bundle.mjs'

/** How long an upload ticket stays valid. Long enough for a big MP4, no more. */
const UPLOAD_TTL_MS = 30 * 60 * 1000

/** The env these tools need. `AppEnv` satisfies it structurally. */
export interface PublishToolEnv {
  Sandbox: DurableObjectNamespace<Sandbox>
  RENDERS: R2Bucket
  PUBLIC_HOSTNAME?: string
}

/**
 * A minted upload ticket, stored in R2 and consumed by the upload route.
 *
 * Stateful by choice: an HMAC would be stateless but needs a signing secret
 * this app does not otherwise have, and adding one is deploy burden for no
 * gain. Storing the ticket lets it be single-use, which a bare signature is not.
 */
export interface UploadTicket {
  token: string
  threadId: string
  /** Epoch ms. */
  expiresAt: number
  /** The R2 key the upload lands on once validated. */
  targetKey: string
  contentType: string
}

export const uploadTicketKey = (runId: string, name: string): string =>
  `tickets/${runId}/${name}`

/** Slugs become URL path segments and R2 keys, so keep them boring. */
const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/u,
    'lowercase letters, digits and hyphens only, and must not start with a hyphen',
  )

/**
 * A filename the agent chooses. Rejects anything that could climb out of its
 * prefix — the agent is an LLM writing into a key space the Worker serves.
 */
const fileNameSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(
    /^[a-z0-9][a-z0-9._-]*\.mp4$/u,
    'must be a simple lowercase .mp4 filename with no path separators',
  )

/** Reject absolute-path escapes and traversal in an agent-supplied directory. */
const projectDirSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('..'), {
    message: 'must not contain ".."',
  })

export const previewKey = (threadId: string, slug: string): string =>
  `previews/${threadId}/${slug}.html`

export const renderKey = (threadId: string, name: string): string =>
  `renders/${threadId}/${name}`

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * `publishComposition` — bundle the project to one self-contained HTML file and
 * store it, so the composition outlives the container that produced it.
 *
 * The bundling itself must happen in-sandbox: `bundleToSingleHtml` is
 * filesystem-based and cannot run in a Worker.
 */
export function publishCompositionTool(
  input: StartRunInput,
  env: PublishToolEnv,
) {
  return toolDefinition({
    name: 'publishComposition',
    description:
      'Bundle a HyperFrames project into a single self-contained HTML file and publish it to durable storage. Returns a URL that keeps working after this sandbox is gone. Use this to give the user something shareable, and before rendering so there is a fallback if the render fails.',
    inputSchema: z.object({
      projectDir: projectDirSchema.describe(
        'Path to the project directory inside the sandbox, e.g. /workspace/my-video',
      ),
      slug: slugSchema.describe(
        'Short URL-safe name for this composition, e.g. product-launch',
      ),
    }),
  }).server(async ({ projectDir, slug }) => {
    const sandbox = getSandbox(env.Sandbox, input.threadId, SANDBOX_OPTIONS)

    // Single-quote the path so an agent-chosen directory cannot inject shell.
    // projectDirSchema already blocks "..", and a single-quoted argument cannot
    // be broken out of without a literal quote, which the regex-free schema
    // still permits — so reject it explicitly.
    if (projectDir.includes("'")) {
      return { ok: false as const, error: 'projectDir must not contain quotes' }
    }

    const result = await sandbox.exec(`node ${BUNDLE_SCRIPT} '${projectDir}'`, {
      cwd: projectDir,
    })

    if (!result.success) {
      return {
        ok: false as const,
        error: `bundle failed (exit ${result.exitCode}): ${result.stderr.slice(0, 2000)}`,
      }
    }

    const html = result.stdout
    if (html.length === 0) {
      return { ok: false as const, error: 'bundle produced no output' }
    }

    const key = previewKey(input.threadId, slug)
    await env.RENDERS.put(key, html, {
      httpMetadata: {
        contentType: 'text/html; charset=utf-8',
        cacheControl: 'no-store',
      },
    })

    return {
      ok: true as const,
      url: `/p/${key}`,
      bytes: html.length,
      note: 'Share this URL with the user. It is served from durable storage and survives the sandbox.',
    }
  })
}

/**
 * `publishRender` — hand the agent a one-time ticket to stream an MP4 out.
 *
 * The file never travels through this tool. The sandbox fs bridge is
 * base64-over-exec: fine for an HTML string, wasteful and memory-hungry for a
 * video. So the agent `curl`s the file straight into a token-gated route that
 * pipes the body into R2.
 */
export function publishRenderTool(input: StartRunInput, env: PublishToolEnv) {
  return toolDefinition({
    name: 'publishRender',
    description:
      'Publish a rendered MP4. Returns a curl command to run in the sandbox that streams the file to durable storage, plus the URL it will be available at. Render the file first, then call this. Do not try to read the MP4 yourself — stream it with the command returned here.',
    inputSchema: z.object({
      path: projectDirSchema.describe(
        'Absolute path of the rendered .mp4 inside the sandbox',
      ),
      name: fileNameSchema.describe(
        'Filename to publish it under, e.g. product-launch.mp4',
      ),
    }),
  }).server(async ({ path, name }) => {
    if (path.includes("'")) {
      return { ok: false as const, error: 'path must not contain quotes' }
    }

    const token = randomToken()
    const targetKey = renderKey(input.threadId, name)
    const ticket: UploadTicket = {
      token,
      threadId: input.threadId,
      expiresAt: Date.now() + UPLOAD_TTL_MS,
      targetKey,
      contentType: 'video/mp4',
    }

    await env.RENDERS.put(
      uploadTicketKey(input.runId, name),
      JSON.stringify(ticket),
      { httpMetadata: { contentType: 'application/json' } },
    )

    // Same origin the MCP bridge uses, so it is correct both locally
    // (host.docker.internal) and deployed (derived from the trigger request).
    const origin = resolveBridgeOrigin(env, input)
    const uploadUrl = `${origin}/api/uploads/${input.runId}/${name}`

    return {
      ok: true as const,
      runCommand: `curl -fsS --fail-with-body -X PUT '${uploadUrl}' -H 'authorization: Bearer ${token}' -H 'content-type: video/mp4' --data-binary @'${path}'`,
      url: `/r/${targetKey}`,
      expiresInMinutes: UPLOAD_TTL_MS / 60000,
      note: 'Run runCommand with the Bash tool. The ticket is single-use; call publishRender again if you need to re-upload.',
    }
  })
}

/**
 * `listArtifacts` — what this thread has already published, so the UI gallery
 * and the agent agree on what exists.
 */
export function listArtifactsTool(input: StartRunInput, env: PublishToolEnv) {
  return toolDefinition({
    name: 'listArtifacts',
    description:
      'List the compositions and renders already published in this thread, with their URLs.',
    inputSchema: z.object({}),
  }).server(async () => {
    const [previews, renders] = await Promise.all([
      env.RENDERS.list({ prefix: `previews/${input.threadId}/` }),
      env.RENDERS.list({ prefix: `renders/${input.threadId}/` }),
    ])

    return {
      ok: true as const,
      compositions: previews.objects.map((o) => ({
        url: `/p/${o.key}`,
        bytes: o.size,
        uploadedAt: o.uploaded.toISOString(),
      })),
      renders: renders.objects.map((o) => ({
        url: `/r/${o.key}`,
        bytes: o.size,
        uploadedAt: o.uploaded.toISOString(),
      })),
    }
  })
}

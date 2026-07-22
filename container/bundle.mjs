/**
 * Bundle a HyperFrames project into one self-contained HTML file.
 *
 *   node /usr/local/lib/hyperframes/bundle.mjs <project-dir>   # → stdout
 *
 * Why this file exists rather than a `node -e` one-liner in the host tool:
 *
 *  - `@hyperframes/core` exports `./compiler` with an `import` condition ONLY.
 *    A CJS `require('@hyperframes/core/compiler')` fails with
 *    ERR_PACKAGE_PATH_NOT_EXPORTED, which reads like a missing export but is
 *    really just ESM-only.
 *  - `NODE_PATH` does not apply to ESM resolution, so a bare specifier cannot
 *    find the GLOBALLY installed package. The Dockerfile installs this file
 *    beside a `node_modules` symlink so ordinary resolution finds it.
 *
 * `bundleToSingleHtml` is filesystem-based, so it cannot run in a Worker — it
 * runs here, in the sandbox, and the host reads the result back over the fs
 * bridge and puts it in R2.
 */
import { bundleToSingleHtml } from '@hyperframes/core/compiler'

const projectDir = process.argv[2]

if (projectDir === undefined || projectDir === '') {
  process.stderr.write('usage: bundle.mjs <project-dir>\n')
  process.exit(1)
}

try {
  // `runtime: 'inline'` is the default and what we want: it embeds the runtime
  // IIFE so the output is genuinely self-contained and keeps working from R2
  // long after the sandbox that produced it is gone.
  const html = await bundleToSingleHtml(projectDir, { runtime: 'inline' })
  process.stdout.write(html)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`bundle failed: ${message}\n`)
  process.exit(1)
}

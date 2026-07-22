/// <reference types="@tanstack/react-start" />

/**
 * Loads the TanStack Start module augmentation that adds the `server` property
 * (HTTP method handlers) to `createFileRoute` options.
 *
 * It is declared inside `@tanstack/start-client-core` as a
 * `declare module '@tanstack/router-core'` block, so it only applies once that
 * declaration file is part of the program. Route files import `createFileRoute`
 * from `@tanstack/react-router`, which does NOT pull it in — without this,
 * every server route fails to compile with
 * "'server' does not exist in type ...".
 *
 * Declared once here rather than per route file. A `.d.ts` is erased entirely,
 * so this costs nothing at runtime, whereas a side-effect
 * `import '@tanstack/react-start'` in each route would pull the package into
 * the client bundle.
 */

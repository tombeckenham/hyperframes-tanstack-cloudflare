import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'

import appCss from '../styles.css?url'
import { THEME_INIT_SCRIPT } from '../lib/theme'

import type { QueryClient } from '@tanstack/react-query'

interface MyRouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'HyperFrames Studio',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
    // Applies `.dark` before first paint — see src/lib/theme.ts.
    scripts: [
      {
        children: THEME_INIT_SCRIPT,
      },
    ],
  }),
  shellComponent: RootDocument,
})

// Hoisted out of RootDocument so they are not reallocated on every render —
// `react-perf/jsx-no-new-object-as-prop` and `jsx-no-new-array-as-prop`.
const devtoolsConfig = { position: 'bottom-right' } as const

const devtoolsPlugins = [
  {
    name: 'Tanstack Router',
    render: <TanStackRouterDevtoolsPanel />,
  },
  TanStackQueryDevtools,
]

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the theme boot script adds `.dark` to <html>
    // before hydration, so the server-rendered class attribute never matches.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <TanStackDevtools config={devtoolsConfig} plugins={devtoolsPlugins} />
        <Scripts />
      </body>
    </html>
  )
}

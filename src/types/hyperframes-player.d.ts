/**
 * `@hyperframes/player` registers the `<hyperframes-player>` custom element but
 * ships no JSX augmentation, so the app declares the intrinsic element itself.
 * Attribute names follow the element's `observedAttributes` (kebab-case, since
 * these pass through as HTML attributes, not properties).
 */
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

interface HyperframesPlayerAttributes extends HTMLAttributes<HTMLElement> {
  src?: string
  srcdoc?: string
  'audio-src'?: string
  width?: number | string
  height?: number | string
  controls?: boolean
  muted?: boolean
  poster?: string
  'playback-rate'?: number
  autoplay?: boolean
  loop?: boolean
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'hyperframes-player': DetailedHTMLProps<
        HyperframesPlayerAttributes,
        HTMLElement
      >
    }
  }
}

import type { CSSProperties } from 'react'

/** Identity colors a block can be given; stored on the block as hex. */
export const BLOCK_COLORS = [
  '#6366f1', // indigo
  '#0ea5e9', // sky
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#64748b', // slate
]

export const DEFAULT_BLOCK_COLOR = BLOCK_COLORS[0]

/** AI-made blocks are saved with this color by the server. */
export const AI_BLOCK_COLOR = '#8b5cf6'

// Blocks are drawn as a soft tint with dark text (light) or a deep tint with light
// text (dark), so labels stay readable whatever color was picked.
// [light bg, light ink, dark bg, dark ink]
const TONES: Record<string, [string, string, string, string]> = {
  '#6366f1': ['#dce6ff', '#1d3b8f', '#1f2b55', '#c9d6ff'],
  '#0ea5e9': ['#d6eefb', '#0b4f71', '#12344a', '#bfe5fb'],
  '#10b981': ['#d3f1ea', '#0d584a', '#123a33', '#b5ecdf'],
  '#f59e0b': ['#fcebc7', '#6e4300', '#3d2e10', '#fbdba0'],
  '#ef4444': ['#fbdcda', '#8a1c17', '#45201e', '#fcc6c2'],
  '#ec4899': ['#fadce5', '#86193f', '#43202d', '#f9c4d5'],
  '#8b5cf6': ['#e9e3ff', '#3f23a8', '#2a2350', '#d6cbff'],
  '#64748b': ['#e6e9ee', '#2f3744', '#262a33', '#d3d8e0'],
}

/** CSS variables for a block's tone; pair with the `block-tone` utility classes. */
export function toneVars(color: string | null): CSSProperties {
  const [bg, ink, bgDark, inkDark] = TONES[(color ?? DEFAULT_BLOCK_COLOR).toLowerCase()] ?? TONES['#64748b']
  return { '--tone-bg': bg, '--tone-ink': ink, '--tone-bg-dark': bgDark, '--tone-ink-dark': inkDark } as CSSProperties
}

export const TONE_CLASS = 'bg-[var(--tone-bg)] text-[var(--tone-ink)] dark:bg-[var(--tone-bg-dark)] dark:text-[var(--tone-ink-dark)]'

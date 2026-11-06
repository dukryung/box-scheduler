/** Shared class strings for recurring controls. */

export const iconButton =
  'flex h-10 w-10 items-center justify-center rounded-[10px] text-ink-2 hover:bg-subtle md:h-9 md:w-9 md:border md:border-line md:bg-surface'

/** A card: hairline border and a soft two-layer shadow so it sits just above the ground. */
export const card = 'rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(28,25,23,0.04),0_8px_24px_rgba(28,25,23,0.04)]'

export const primaryButton =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40'

export const secondaryButton =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-sm font-medium text-ink-2 hover:bg-subtle disabled:opacity-40'

export const aiButton =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-ai px-4 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40'

export const aiOutlineButton =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-ai-line bg-surface px-4 text-sm font-semibold text-ai-ink hover:bg-ai-soft disabled:opacity-40'

export const srOnly = 'absolute h-px w-px overflow-hidden whitespace-nowrap [clip:rect(0_0_0_0)]'

/** Strikethrough for completed items: a thicker red line so "done" reads at a glance. */
/** Finished work: teal and solid, never struck through. */
export const doneText = 'font-semibold text-done-ink'

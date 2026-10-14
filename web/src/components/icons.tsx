import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Stroke({ size = 16, children, strokeWidth = 2, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const ChevronLeft = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M15 18l-6-6 6-6" />
  </Stroke>
)

export const ChevronRight = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M9 18l6-6-6-6" />
  </Stroke>
)

export const Plus = (p: IconProps) => (
  <Stroke strokeWidth={2.2} {...p}>
    <path d="M12 5v14M5 12h14" />
  </Stroke>
)

export const Close = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Stroke>
)

export const Check = (p: IconProps) => (
  <Stroke strokeWidth={2.6} {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Stroke>
)

export const ArrowRight = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Stroke>
)

export const Sparkle = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
  </Stroke>
)

export const CalendarPlus = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="3" y="5" width="18" height="16" rx="3" />
    <path d="M3 10h18M12 13v5M9.5 15.5h5" />
  </Stroke>
)

export const TabDay = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M8 9h8M8 13h5" />
  </Stroke>
)

export const TabMonth = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="3" y="5" width="18" height="16" rx="3" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Stroke>
)

export const TabStats = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M5 20V11M12 20V5M19 20v-7" />
  </Stroke>
)

export function Grip(p: SVGProps<SVGSVGElement>) {
  return (
    <svg width="14" height="20" viewBox="0 0 14 20" aria-hidden="true" {...p}>
      {[4, 10, 16].flatMap((y) => [4, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" fill="currentColor" />))}
    </svg>
  )
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true" className="text-accent">
      <rect x="1" y="1" width="11" height="11" rx="3" fill="currentColor" />
      <rect x="14" y="1" width="11" height="11" rx="3" fill="currentColor" opacity="0.35" />
      <rect x="1" y="14" width="11" height="11" rx="3" fill="currentColor" opacity="0.35" />
      <rect x="14" y="14" width="11" height="11" rx="3" fill="currentColor" opacity="0.7" />
    </svg>
  )
}

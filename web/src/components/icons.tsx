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

export const UserIcon = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </Stroke>
)

export const LogOut = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" />
  </Stroke>
)

export const Mail = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
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

export const Trash = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
  </Stroke>
)

export const Gear = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
  </Stroke>
)

export const Bell = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
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

export const Mic = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Stroke>
)

export const ArrowUp = (p: IconProps) => (
  <Stroke strokeWidth={2.2} {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
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

export const TabTasks = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M4 13l2.5-8h11L20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
    <path d="M4 13h4.5l1 2h5l1-2H20" />
  </Stroke>
)

export const Archive = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="3" y="4" width="18" height="5" rx="1.5" />
    <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
  </Stroke>
)

export const Flag = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
  </Stroke>
)

export const TabStats = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M5 20V11M12 20V5M19 20v-7" />
  </Stroke>
)

export const Sun = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Stroke>
)

export const Moon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </Stroke>
)

export const Monitor = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
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
    // Orange (to do) and teal (done), as in the app.
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
      <rect x="1" y="1" width="11" height="11" rx="3" fill="#f97316" />
      <rect x="14" y="1" width="11" height="11" rx="3" fill="#f97316" opacity="0.35" />
      <rect x="1" y="14" width="11" height="11" rx="3" fill="#14b8a6" opacity="0.35" />
      <rect x="14" y="14" width="11" height="11" rx="3" fill="#14b8a6" />
    </svg>
  )
}

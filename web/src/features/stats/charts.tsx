import { useEffect, useRef, useState, type ReactNode } from 'react'
import { hm } from '../../lib/hm'
import { formatDuration } from '../../lib/slots'

// Planned vs done is drawn as one blue ramp: the lighter planned column with the
// darker done column on top of it (done never exceeds planned).
const PLANNED = 'var(--viz-planned)'
const DONE = 'var(--viz-done)'

const BAR_MAX = 24
const RADIUS = 4

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

/** A column with a 4px rounded top and a square base. */
function columnPath(x: number, y: number, w: number, h: number) {
  if (h <= 0) return ''
  const r = Math.min(RADIUS, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

/** Clean y-axis maximum (in hours) and step for up to four gridlines. */
function niceHours(maxBoxes: number) {
  const maxHours = Math.max(maxBoxes / 6, 0.5)
  const step = [0.5, 1, 2, 3, 4, 6, 8, 12, 24, 48, 96].find((s) => maxHours / s <= 4) ?? 200
  return { step, top: Math.ceil(maxHours / step) * step }
}

const hourLabel = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)}h`

export function Legend() {
  return (
    <div className="flex items-center gap-4 text-xs text-ink-2">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: PLANNED }} />
        계획
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: DONE }} />
        완료
      </span>
    </div>
  )
}

function TooltipRows({ planned, done }: { planned: number; done: number }) {
  const row = (color: string, value: number, label: string) => (
    <div className="flex items-center gap-2">
      <span className="h-0.5 w-3 rounded" style={{ background: color }} />
      <span className="font-semibold text-ink">{value ? formatDuration(value) : '없음'}</span>
      <span className="text-muted">{label}</span>
    </div>
  )
  return (
    <>
      {row(DONE, done, '완료')}
      {row(PLANNED, planned, '계획')}
    </>
  )
}

export interface ColumnDatum {
  key: string
  /** Axis label, or '' to skip this tick. */
  tick: string
  title: string
  planned: number
  done: number
}

const M = { top: 8, right: 4, bottom: 22, left: 52 }

export function ColumnChart({ data, height = 200, label }: { data: ColumnDatum[]; height?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [active, setActive] = useState<number | null>(null)

  const innerW = Math.max(width - M.left - M.right, 0)
  const innerH = height - M.top - M.bottom
  const { step, top } = niceHours(Math.max(...data.map((d) => d.planned), 0))
  const y = (boxes: number) => M.top + innerH - (boxes / 6 / top) * innerH
  const band = data.length ? innerW / data.length : 0
  const barW = Math.max(Math.min(BAR_MAX, band * 0.7), 2)
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)

  const activeDatum = active !== null ? data[active] : null
  const tipX = active !== null ? M.left + band * (active + 0.5) : 0

  return (
    <div ref={ref} className="relative min-w-0 overflow-hidden" onPointerLeave={() => setActive(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={y(t * 6)} y2={y(t * 6)} stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} />
              <text x={M.left - 8} y={y(t * 6)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--viz-muted)" className="tabular-nums">
                {hourLabel(t)}
              </text>
            </g>
          ))}

          {data.map((d, i) => {
            const x = M.left + band * i + (band - barW) / 2
            return (
              <g key={d.key}>
                {active === i && <rect x={M.left + band * i} y={M.top} width={band} height={innerH} fill="var(--viz-hover)" />}
                <path d={columnPath(x, y(d.planned), barW, y(0) - y(d.planned))} fill={PLANNED} />
                <path d={columnPath(x, y(d.done), barW, y(0) - y(d.done))} fill={DONE} />
                {d.tick && (
                  <text x={x + barW / 2} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--viz-muted)" className="tabular-nums">
                    {d.tick}
                  </text>
                )}
                {/* The whole band is the hit target, not just the painted column. */}
                <rect
                  x={M.left + band * i}
                  y={M.top}
                  width={band}
                  height={innerH}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${d.title}: 완료 ${formatDuration(d.done)}, 계획 ${formatDuration(d.planned)}`}
                  onPointerEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className="outline-none"
                />
              </g>
            )
          })}
        </svg>
      )}

      {activeDatum && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-xl border border-line bg-surface px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(tipX - 70, 0), Math.max(width - 140, 0)), width: 140 }}
        >
          <div className="mb-1 text-muted">{activeDatum.title}</div>
          <TooltipRows planned={activeDatum.planned} done={activeDatum.done} />
        </div>
      )}
    </div>
  )
}

/** Horizontal planned-vs-done bars with the value written at the bar's end. */
export function BarList({ data }: { data: Array<{ title: string; planned: number; done: number }> }) {
  const max = Math.max(...data.map((d) => d.planned), 1)
  return (
    <ul className="flex flex-col gap-2.5">
      {data.map((d) => (
        <li key={d.title} className="grid grid-cols-[minmax(0,7rem)_1fr] items-center gap-3 text-[13px] sm:grid-cols-[minmax(0,10rem)_1fr]">
          <span className="truncate" title={d.title}>
            {d.title}
          </span>
          {/* The value sits right at the bar's end; 70% caps the bar so it always has room. */}
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative h-3 min-w-1 shrink" style={{ width: `${(d.planned / max) * 70}%` }}>
              <div className="absolute inset-0 rounded-r" style={{ background: PLANNED }} />
              <div className="absolute inset-y-0 left-0 rounded-r" style={{ width: `${(d.done / d.planned) * 100}%`, background: DONE }} />
            </div>
            <span className="shrink-0 text-xs text-muted">
              <span className="font-mono text-ink">{hm(d.planned)}</span>
              {` · 완료 ${Math.round((d.done / d.planned) * 100)}%`}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** The same numbers as a chart, readable without hovering. */
export function TableView({ head, rows }: { head: string; rows: Array<{ key: string; label: string; planned: number; done: number }> }) {
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted hover:text-ink">표로 보기</summary>
      <div className="mt-2 max-h-64 overflow-y-auto">
        <table className="w-full text-left tabular-nums">
          <thead className="text-muted">
            <tr>
              <th className="py-1 font-normal">{head}</th>
              <th className="py-1 text-right font-normal">계획</th>
              <th className="py-1 text-right font-normal">완료</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-grid">
                <td className="py-1">{r.label}</td>
                <td className="py-1 text-right">{r.planned ? formatDuration(r.planned) : '–'}</td>
                <td className="py-1 text-right">{r.done ? formatDuration(r.done) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

export function Card({ title, subtitle, children, aside }: { title: string; subtitle?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="min-w-0 rounded-2xl border border-line bg-surface p-4 md:p-5">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  )
}

// Sequential blue ramp (validated): lightest = little planned time, darkest = most.
const RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95']

/** 24 cells, one per hour, shaded by how much time was planned in that hour. */
export function HourStrip({ hours }: { hours: Array<{ hour: number; planned: number; done: number }> }) {
  const max = Math.max(...hours.map((h) => h.planned), 1)
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-12 gap-[3px] md:grid-cols-24" role="list" aria-label="시간대별 계획 시간">
        {hours.map((h) => {
          const step = h.planned === 0 ? -1 : Math.min(RAMP.length - 1, Math.floor((h.planned / max) * RAMP.length))
          const label = `${h.hour}:00–${h.hour + 1}:00 · 계획 ${h.planned ? formatDuration(h.planned) : '없음'}${h.done ? ` · 완료 ${formatDuration(h.done)}` : ''}`
          return (
            <div
              key={h.hour}
              role="listitem"
              tabIndex={0}
              title={label}
              aria-label={label}
              className={`h-[30px] rounded-[5px] outline-none focus-visible:ring-2 focus-visible:ring-accent md:h-11 ${step < 0 ? 'bg-subtle' : ''}`}
              style={step >= 0 ? { background: RAMP[step] } : undefined}
            />
          )
        })}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-faint md:grid md:grid-cols-4 md:text-[11px]">
        <span>0시</span>
        <span className="hidden md:inline">6시</span>
        <span>12시</span>
        <span className="hidden md:inline">18시</span>
        <span className="md:hidden">23시</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted">
        적음
        <span className="flex gap-0.5">
          {RAMP.map((c) => (
            <span key={c} className="h-2.5 w-4 rounded-sm" style={{ background: c }} />
          ))}
        </span>
        많음
      </div>
    </div>
  )
}

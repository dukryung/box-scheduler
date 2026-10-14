import { useEffect, useRef, useState, type ReactNode } from 'react'
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

const hourLabel = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)}시간`

export function Legend() {
  return (
    <div className="flex items-center gap-4 text-xs text-zinc-500">
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
      <span className="font-semibold text-zinc-900 dark:text-zinc-100">{value ? formatDuration(value) : '없음'}</span>
      <span className="text-zinc-500">{label}</span>
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
          className="pointer-events-none absolute top-0 z-10 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          style={{ left: Math.min(Math.max(tipX - 70, 0), Math.max(width - 140, 0)), width: 140 }}
        >
          <div className="mb-1 text-zinc-500">{activeDatum.title}</div>
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
        <li key={d.title} className="grid grid-cols-[minmax(0,8rem)_1fr] items-center gap-3 text-sm sm:grid-cols-[minmax(0,12rem)_1fr]">
          <span className="truncate" title={d.title}>
            {d.title}
          </span>
          {/* The value sits right at the bar's end; 70% caps the bar so it always has room. */}
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative h-3 min-w-1 shrink" style={{ width: `${(d.planned / max) * 70}%` }}>
              <div className="absolute inset-0 rounded-r" style={{ background: PLANNED }} />
              <div className="absolute inset-y-0 left-0 rounded-r" style={{ width: `${(d.done / d.planned) * 100}%`, background: DONE }} />
            </div>
            <span className="shrink-0 text-xs text-zinc-500 tabular-nums">
              {formatDuration(d.planned)}
              {d.done > 0 && ` · 완료 ${Math.round((d.done / d.planned) * 100)}%`}
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
      <summary className="cursor-pointer text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">표로 보기</summary>
      <div className="mt-2 max-h-64 overflow-y-auto">
        <table className="w-full text-left tabular-nums">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-1 font-normal">{head}</th>
              <th className="py-1 text-right font-normal">계획</th>
              <th className="py-1 text-right font-normal">완료</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-zinc-100 dark:border-zinc-800">
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
    <section className="min-w-0 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  )
}

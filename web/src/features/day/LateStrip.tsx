import type { Block } from '../../api/types'
import { Check } from '../../components/icons'
import { slotToTime } from '../../lib/slots'

interface Props {
  /** Blocks whose time is over but not marked done, earliest first. */
  late: Block[]
  /** Where the first one could go later today, or null when nothing fits. */
  laterStart: number | null
  onDone: (b: Block) => void
  onLater: (b: Block, start: number) => void
  onTomorrow: (b: Block) => void
}

/** One line under the day's summary that settles a block left behind: done, later today, or tomorrow. */
export function LateStrip({ late, laterStart, onDone, onLater, onTomorrow }: Props) {
  const b = late[0]
  if (!b) return null
  const chip = 'flex h-8 shrink-0 items-center justify-center rounded-lg px-2.5 text-xs font-semibold'
  return (
    <section
      aria-label="지난 블록 정리"
      className="rise-in flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px] shadow-[0_1px_2px_rgba(28,25,23,0.04)]"
    >
      <span className="flex min-w-0 basis-full items-center gap-2 sm:basis-0 sm:flex-1">
        <span className="shrink-0 rounded-full border border-line-strong px-2 py-px text-[11px] font-bold text-ink-2">끝냈나요?</span>
        <span className="min-w-0 truncate font-semibold">{b.title}</span>
        <span className="hidden shrink-0 font-mono text-xs text-muted sm:inline">
          {slotToTime(b.startSlot)}–{slotToTime(b.endSlot)}
        </span>
        {late.length > 1 && <span className="shrink-0 text-xs text-muted">외 {late.length - 1}개</span>}
      </span>
      <span className="flex flex-1 items-center gap-1.5 sm:flex-none [&>button]:flex-1 sm:[&>button]:flex-none">
        <button onClick={() => onDone(b)} className={`${chip} gap-1 bg-done text-done-on hover:brightness-110`}>
          <Check size={12} strokeWidth={3} /> 끝냈어요
        </button>
        {laterStart !== null && (
          <button onClick={() => onLater(b, laterStart)} className={`${chip} border border-line-strong text-ink-2 hover:bg-subtle`}>
            이따 {slotToTime(laterStart)}
          </button>
        )}
        <button onClick={() => onTomorrow(b)} className={`${chip} border border-line-strong text-ink-2 hover:bg-subtle`}>
          내일로
        </button>
      </span>
    </section>
  )
}

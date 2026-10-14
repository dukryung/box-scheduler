import { useState, type Ref } from 'react'
import type { BrainDumpItem } from '../../api/types'
import { ArrowRight, CalendarPlus, Close, Grip, Plus } from '../../components/icons'
import { secondaryButton, srOnly } from '../../components/styles'
import { addDays, parseISODate, todayISO } from '../../lib/date'
import { formatDuration } from '../../lib/slots'
import { isTempId, useDayStore } from '../../store/dayStore'
import { dropBoxes, scheduledBoxes, type DraggedItem } from './drop'

const STATUS_ORDER: Record<BrainDumpItem['status'], number> = { open: 0, scheduled: 0, done: 1, carried: 2, dropped: 2 }

function shortDate(iso: string) {
  const d = parseISODate(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

interface Props {
  onDragItem: (dragged: DraggedItem | null) => void
  onNavigate: (date: string) => void
  /** Phone flow: open the "시간표에 넣기" sheet instead of dragging. */
  onPlace: (dragged: DraggedItem) => void
  inputRef?: Ref<HTMLInputElement>
}

export function BrainDumpPanel({ onDragItem, onNavigate, onPlace, inputRef }: Props) {
  const { date, blocks, brainDump, addBrainDump, updateBrainDump, deleteBrainDump, carryOver } = useDayStore()
  const [text, setText] = useState('')
  const [carried, setCarried] = useState<{ count: number; to: string } | null>(null)

  const items = [...brainDump].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
  const openCount = brainDump.filter((it) => it.status === 'open').length
  const carryTarget = date < todayISO() ? todayISO() : addDays(date, 1)

  return (
    <section className="flex h-full flex-col gap-4">
      <header className="hidden flex-col gap-1 md:flex">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold">Brain Dump</h2>
          <span className="rounded-full bg-subtle px-2 text-xs font-semibold text-ink-2" aria-label={`남은 일 ${openCount}개`}>
            {openCount}
          </span>
        </div>
        <p className="text-[13px] text-muted">머릿속의 할 일을 모두 적고, 시간표로 끌어다 놓으세요.</p>
      </header>

      <div className="flex flex-col gap-1.5">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void addBrainDump(text)
            setText('')
          }}
        >
          <label htmlFor="brain-dump-input" className={srOnly}>
            Brain Dump 항목 추가
          </label>
          <input
            id="brain-dump-input"
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="예: 기획서 작성 40분"
            className="h-12 min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3.5 text-[15px] outline-none focus:border-accent md:h-11 md:rounded-[10px] md:text-sm"
          />
          <button
            type="submit"
            aria-label="추가"
            disabled={!text.trim()}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-white disabled:opacity-40 md:h-11 md:w-11 md:rounded-[10px]"
          >
            <Plus size={18} />
          </button>
        </form>
        <p className="text-xs text-muted">끝에 ‘40분’, ‘1시간’을 붙이면 예상 시간이 돼요.</p>
      </div>

      <ul className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1">
        {items.length === 0 && (
          <li className="px-1 py-8 text-center text-sm leading-relaxed text-muted">
            머릿속에 있는 일을 모두 적어보세요.
            <br />
            적은 항목은 시간표에 넣을 수 있어요.
          </li>
        )}
        {items.map((item) => (
          <BrainDumpRow
            key={item.id}
            item={item}
            scheduled={scheduledBoxes(item.id, blocks)}
            onDragItem={onDragItem}
            onPlace={onPlace}
            onUpdate={(patch) => void updateBrainDump(item.id, patch)}
            onDelete={() => void deleteBrainDump(item.id)}
          />
        ))}
      </ul>

      {carried && (
        <p className="text-xs text-muted">
          {carried.count}개를 {shortDate(carried.to)}로 넘겼어요.{' '}
          <button className="font-medium text-accent underline" onClick={() => onNavigate(carried.to)}>
            보러 가기
          </button>
        </p>
      )}
      {openCount > 0 && (
        <button
          onClick={async () => {
            const count = await carryOver(carryTarget)
            if (count) setCarried({ count, to: carryTarget })
          }}
          className={`${secondaryButton} h-11`}
        >
          남은 일 {openCount}개 → {carryTarget === todayISO() ? '오늘' : shortDate(carryTarget)}로 넘기기
          <ArrowRight size={16} />
        </button>
      )}
    </section>
  )
}

interface RowProps {
  item: BrainDumpItem
  scheduled: number
  onDragItem: (dragged: DraggedItem | null) => void
  onPlace: (dragged: DraggedItem) => void
  onUpdate: (patch: { title?: string; estimateBoxes?: number; status?: BrainDumpItem['status'] }) => void
  onDelete: () => void
}

function BrainDumpRow({ item, scheduled, onDragItem, onPlace, onUpdate, onDelete }: RowProps) {
  const [editing, setEditing] = useState(false)
  const pending = isTempId(item.id)
  const open = item.status === 'open'
  const draggable = open && !pending && !editing
  const estimate = item.estimateBoxes
  const stepper = 'flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-subtle disabled:opacity-30'

  function commitTitle(value: string) {
    setEditing(false)
    const t = value.trim()
    if (t && t !== item.title) onUpdate({ title: t })
  }

  return (
    <li
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', item.title)
        e.dataTransfer.effectAllowed = 'copy'
        onDragItem({ item, boxes: dropBoxes(item, scheduled) })
      }}
      onDragEnd={() => onDragItem(null)}
      className={[
        'group flex items-start gap-2.5 rounded-xl border border-grid p-3',
        item.status === 'done' ? 'bg-ground/60' : 'bg-surface',
        draggable ? 'md:cursor-grab md:active:cursor-grabbing md:hover:border-line-strong' : '',
        pending ? 'opacity-60' : '',
        item.status === 'carried' || item.status === 'dropped' ? 'opacity-55' : '',
      ].join(' ')}
    >
      <Grip className={`mt-0.5 hidden shrink-0 text-faint md:block ${draggable ? '' : 'invisible'}`} />
      <input
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--app-accent)] md:h-[18px] md:w-[18px]"
        aria-label={`${item.title} 완료`}
        checked={item.status === 'done'}
        disabled={pending || item.status === 'carried'}
        onChange={(e) => onUpdate({ status: e.target.checked ? 'done' : 'open' })}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {editing ? (
          <input
            autoFocus
            defaultValue={item.title}
            onBlur={(e) => commitTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle(e.currentTarget.value)
              if (e.key === 'Escape') setEditing(false)
            }}
            className="w-full rounded-md border border-accent bg-transparent px-1.5 text-[15px] outline-none md:text-sm"
          />
        ) : (
          <div
            onDoubleClick={() => open && !pending && setEditing(true)}
            className={`text-[15px] leading-snug font-medium break-words md:text-sm ${item.status === 'done' ? 'text-faint line-through' : ''}`}
          >
            {item.title}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
          {open && (
            <span className="flex items-center rounded-md bg-subtle">
              <button
                aria-label="예상 시간 줄이기"
                disabled={pending || !estimate || estimate <= 1}
                onClick={() => estimate && onUpdate({ estimateBoxes: estimate - 1 })}
                className={stepper}
              >
                −
              </button>
              <span className="px-0.5 font-mono text-ink-2">{estimate ? formatDuration(estimate) : '시간 미정'}</span>
              <button
                aria-label="예상 시간 늘리기"
                disabled={pending || (estimate ?? 0) >= 144}
                onClick={() => onUpdate({ estimateBoxes: (estimate ?? 0) + 1 })}
                className={stepper}
              >
                +
              </button>
            </span>
          )}
          {scheduled > 0 && (
            <span className="flex items-center gap-1.5">
              {estimate ? (
                <span className="h-1 w-11 rounded-full bg-line">
                  <span className="block h-1 rounded-full bg-accent" style={{ width: `${Math.min(100, (scheduled / estimate) * 100)}%` }} />
                </span>
              ) : null}
              <span className={estimate && scheduled >= estimate ? 'font-medium text-good' : ''}>배정 {formatDuration(scheduled)}</span>
            </span>
          )}
          {item.carriedFrom && <span>↩ {shortDate(item.carriedFrom)}부터</span>}
          {item.status === 'carried' && <span>→ 다음 날로 넘김</span>}
        </div>
      </div>
      {draggable && (
        <button
          onClick={() => onPlace({ item, boxes: dropBoxes(item, scheduled) })}
          className="flex h-10 shrink-0 items-center gap-1.5 self-center rounded-[10px] border border-line-strong bg-surface px-3 text-[13px] font-semibold md:hidden"
        >
          <CalendarPlus size={16} />
          넣기
        </button>
      )}
      {!pending && (
        <button
          aria-label={`${item.title} 삭제`}
          onClick={onDelete}
          className="shrink-0 rounded-md p-1 text-faint hover:text-danger focus:opacity-100 md:opacity-0 md:group-hover:opacity-100"
        >
          <Close size={14} />
        </button>
      )}
    </li>
  )
}

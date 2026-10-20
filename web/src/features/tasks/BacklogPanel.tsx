import { useState } from 'react'
import { Link } from 'react-router'
import type { BacklogItem } from '../../api/types'
import { ConfirmInline } from '../../components/ConfirmInline'
import { ArrowRight, CalendarPlus, Close, Grip, Plus } from '../../components/icons'
import { srOnly } from '../../components/styles'
import { groupBacklog } from '../../lib/backlog'
import { todayISO } from '../../lib/date'
import { formatDuration } from '../../lib/slots'
import { useTasksStore } from '../../store/tasksStore'
import { dropBoxes, type DraggedItem } from '../braindump/drop'
import { DueBadge, PriorityBadge, Progress } from './parts'

interface Props {
  /** The day being viewed; "가져오기" moves an item onto this day's Brain Dump. */
  date: string
  onDragItem: (dragged: DraggedItem | null) => void
  onPlace: (dragged: DraggedItem) => void
  onMovedToDay: (title: string) => void
}

/** Backlog in the day view: drag (desktop) or 넣기 (phone) into the timetable. */
export function BacklogPanel({ date, onDragItem, onPlace, onMovedToDay }: Props) {
  const { items, add, moveToDay, remove } = useTasksStore()
  const [text, setText] = useState('')
  const today = todayISO()
  const open = groupBacklog(items, today)
    .filter((g) => g.key !== 'done')
    .flatMap((g) => g.items)

  return (
    <section className="flex h-full flex-col gap-4">
      <header className="hidden items-baseline justify-between md:flex">
        <p className="text-[13px] text-muted">날짜 없이 모아 둔 일이에요. 시간표로 끌어다 놓으세요.</p>
      </header>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void add(text)
          setText('')
        }}
      >
        <label htmlFor="backlog-input" className={srOnly}>
          보관함에 추가
        </label>
        <input
          id="backlog-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="예: 여권 갱신 ~11/3"
          className="h-12 min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3.5 text-[15px] outline-none focus:border-accent md:h-11 md:rounded-[10px] md:text-sm"
        />
        <button
          type="submit"
          aria-label="보관함에 추가"
          disabled={!text.trim()}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-white disabled:opacity-40 md:h-11 md:w-11 md:rounded-[10px]"
        >
          <Plus size={18} />
        </button>
      </form>

      <ul className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1" aria-label="보관함 할 일">
        {open.length === 0 && <li className="px-1 py-8 text-center text-sm text-muted">보관함이 비어 있어요.</li>}
        {open.map((it) => (
          <BacklogRow
            key={it.id}
            item={it}
            today={today}
            dayLabel={date === today ? '오늘 하기' : '이 날로'}
            onDragItem={onDragItem}
            onPlace={onPlace}
            onMove={async () => {
              if (await moveToDay(it.id, date)) onMovedToDay(it.title)
            }}
            onDelete={() => void remove(it.id)}
          />
        ))}
      </ul>

      <Link to="/tasks" className="flex items-center justify-center gap-1 text-[13px] font-semibold text-accent dark:text-accent-bright">
        보관함 전체 보기
        <ArrowRight size={14} />
      </Link>
    </section>
  )
}

interface RowProps {
  item: BacklogItem
  today: string
  dayLabel: string
  onDragItem: (dragged: DraggedItem | null) => void
  onPlace: (dragged: DraggedItem) => void
  onMove: () => void
  onDelete: () => void
}

function BacklogRow({ item, today, dayLabel, onDragItem, onPlace, onMove, onDelete }: RowProps) {
  const [confirming, setConfirming] = useState(false)
  const dragged = () => ({ item, boxes: dropBoxes(item, item.scheduledBoxes) })
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', item.title)
        e.dataTransfer.effectAllowed = 'copy'
        onDragItem(dragged())
      }}
      onDragEnd={() => onDragItem(null)}
      className="group flex flex-col gap-2 rounded-xl border border-grid bg-surface p-3 md:cursor-grab md:hover:border-line-strong md:active:cursor-grabbing"
    >
      <div className="flex items-start gap-2.5">
        <Grip className="mt-0.5 hidden shrink-0 text-faint md:block" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-[15px] leading-snug font-medium break-words md:text-sm">{item.title}</span>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <PriorityBadge priority={item.priority} />
            {item.dueDate && <DueBadge due={item.dueDate} today={today} />}
            <span className="font-mono text-ink-2">{item.estimateBoxes ? formatDuration(item.estimateBoxes) : '시간 미정'}</span>
            <Progress item={item} />
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5 self-center md:flex-row md:items-center">
          <button
            onClick={() => onPlace(dragged())}
            className="flex h-10 items-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-3 text-[13px] font-semibold md:hidden"
          >
            <CalendarPlus size={16} />
            넣기
          </button>
          <button
            onClick={onMove}
            className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink-2 hover:bg-subtle"
          >
            {dayLabel}
          </button>
        </div>
        <button
          aria-label={`${item.title} 삭제`}
          onClick={() => (item.blockCount > 0 ? setConfirming(true) : onDelete())}
          className="shrink-0 rounded-md p-1 text-faint hover:text-danger"
        >
          <Close size={14} />
        </button>
      </div>
      {confirming && (
        <ConfirmInline
          message={`보관함에서 지우면 시간표의 블록 ${item.blockCount}개도 함께 지워져요.`}
          onConfirm={onDelete}
          onCancel={() => setConfirming(false)}
        />
      )}
    </li>
  )
}

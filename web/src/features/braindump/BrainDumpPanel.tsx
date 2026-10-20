import { useState, type ReactNode, type Ref } from 'react'
import { ConfirmInline } from '../../components/ConfirmInline'
import { Archive, ArrowRight, CalendarPlus, Close, Grip, Plus, Sparkle } from '../../components/icons'
import { doneStrike, secondaryButton, srOnly } from '../../components/styles'
import { groupBrainDump, type Row } from '../../lib/brainDumpGroups'
import { urgentBacklog } from '../../lib/backlog'
import { addDays, parseISODate, todayISO } from '../../lib/date'
import { formatDuration, slotToTime } from '../../lib/slots'
import { isTempId, useDayStore } from '../../store/dayStore'
import { useTasksStore } from '../../store/tasksStore'
import { dropBoxes, type DraggedItem } from './drop'

function shortDate(iso: string) {
  const d = parseISODate(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

interface Props {
  onDragItem: (dragged: DraggedItem | null) => void
  onNavigate: (date: string) => void
  /** Phone flow: open the "시간표에 넣기" sheet instead of dragging. */
  onPlace: (dragged: DraggedItem) => void
  /** A time chip was pressed: show that block on the timetable. */
  onFocusBlock: (blockId: string) => void
  /** Opens the AI planner for the items still without a time. */
  onOpenAI: () => void
  inputRef?: Ref<HTMLInputElement>
}

export function BrainDumpPanel({ onDragItem, onNavigate, onPlace, onFocusBlock, onOpenAI, inputRef }: Props) {
  const { date, blocks, brainDump, linkedItems, addBrainDump, carryOver } = useDayStore()
  const backlog = useTasksStore((s) => s.items)
  const [text, setText] = useState('')
  const [carried, setCarried] = useState<{ count: number; to: string } | null>(null)

  const groups = groupBrainDump(brainDump, linkedItems, blocks)
  const openCount = brainDump.filter((it) => it.status === 'open').length
  const carryTarget = date < todayISO() ? todayISO() : addDays(date, 1)
  const empty = brainDump.length === 0 && linkedItems.length === 0
  const rowProps = { onDragItem, onPlace, onFocusBlock }

  // What the AI planner would work on: items without a time, items with part of
  // their estimate still unplaced, and urgent backlog items.
  const partial = groups.scheduled.filter((r) => !r.linked && r.item.estimateBoxes !== null && scheduledOf(r) < r.item.estimateBoxes).length
  const urgent = urgentBacklog(backlog, date).length
  const canPlan = groups.unscheduled.length + partial + urgent > 0
  const planButton = canPlan ? (
    <button
      onClick={onOpenAI}
      title={partial || urgent ? '남은 시간이 있는 일과 보관함의 급한 일도 함께 배치해요' : undefined}
      className="flex h-8 items-center gap-1.5 rounded-lg border border-ai-line px-2.5 text-xs font-semibold text-ai-ink hover:bg-ai-soft"
    >
      <Sparkle size={14} />
      AI로 시간 정하기
    </button>
  ) : null

  return (
    <section className="flex h-full flex-col gap-4">
      <p className="hidden text-[13px] text-muted md:block">머릿속의 할 일을 모두 적어 두세요. 시간표에서 만든 일정도 여기에 함께 보여요.</p>

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

      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
        {empty && (
          <p className="px-1 py-8 text-center text-sm leading-relaxed text-muted">
            머릿속에 있는 일을 모두 적어보세요.
            <br />
            적은 항목은 시간표에 넣을 수 있어요.
          </p>
        )}
        <Group label="아직 시간표에 없음" rows={groups.unscheduled} action={planButton} showEmpty={canPlan} {...rowProps} />
        {!empty && !canPlan && groups.unscheduled.length === 0 && (
          <p className="px-1 text-xs text-muted">모든 일이 시간표에 있어요.</p>
        )}
        <Group label="시간표에 있음" rows={groups.scheduled} {...rowProps} />
        <Group label="완료" rows={groups.done} {...rowProps} />
        <Group label="넘김" rows={groups.closed} {...rowProps} />
      </div>

      {carried && (
        <p className="text-xs text-muted">
          {carried.count}개를 {shortDate(carried.to)}로 넘겼어요.{' '}
          <button className="font-medium text-accent dark:text-accent-bright underline" onClick={() => onNavigate(carried.to)}>
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

const scheduledOf = (r: Row) => r.sessions.reduce((n, b) => n + b.endSlot - b.startSlot, 0)

interface GroupProps {
  label: string
  rows: Row[]
  /** Shown at the right of the heading. */
  action?: ReactNode
  /** Keep the heading (and its action) even with no rows. */
  showEmpty?: boolean
  onDragItem: (dragged: DraggedItem | null) => void
  onPlace: (dragged: DraggedItem) => void
  onFocusBlock: (blockId: string) => void
}

function Group({ label, rows, action, showEmpty, ...rowProps }: GroupProps) {
  if (rows.length === 0 && !showEmpty) return null
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <div className="flex min-h-8 items-center justify-between gap-2 px-1">
        <h3 className="text-xs font-semibold text-muted">
          {label} <span className="font-normal">{rows.length}</span>
        </h3>
        {action}
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <BrainDumpRow key={row.item.id} row={row} {...rowProps} />
        ))}
      </ul>
    </section>
  )
}

interface RowProps {
  row: Row
  onDragItem: (dragged: DraggedItem | null) => void
  onPlace: (dragged: DraggedItem) => void
  onFocusBlock: (blockId: string) => void
}

function BrainDumpRow({ row, onDragItem, onPlace, onFocusBlock }: RowProps) {
  const { updateBrainDump, deleteBrainDump, moveToBacklog } = useDayStore()
  const { item, sessions, linked } = row
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const pending = isTempId(item.id)
  const open = item.status === 'open'
  const unscheduled = open && sessions.length === 0
  // Linked rows belong to the backlog or another day; schedule or edit them there.
  const draggable = open && !pending && !editing && !linked
  const estimate = item.estimateBoxes
  const scheduled = sessions.reduce((n, b) => n + b.endSlot - b.startSlot, 0)
  const stepper = 'flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-subtle disabled:opacity-30'
  const update = (patch: Parameters<typeof updateBrainDump>[1]) => void updateBrainDump(item.id, patch)

  function commitTitle(value: string) {
    setEditing(false)
    const t = value.trim()
    if (t && t !== item.title) update({ title: t })
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
        'group flex flex-col gap-2 rounded-xl border p-3',
        unscheduled ? 'border-dashed border-line-strong bg-surface' : 'border-grid bg-surface',
        item.status === 'done' ? 'bg-ground/60' : '',
        draggable ? 'md:cursor-grab md:active:cursor-grabbing md:hover:border-line-strong' : '',
        pending ? 'opacity-60' : '',
        item.status === 'carried' || item.status === 'dropped' ? 'opacity-55' : '',
      ].join(' ')}
    >
      <div className="flex items-start gap-2.5">
        <Grip className={`mt-0.5 hidden shrink-0 text-faint md:block ${draggable ? '' : 'invisible'}`} />
        <input
          type="checkbox"
          className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--app-accent)] md:h-[18px] md:w-[18px]"
          aria-label={`${item.title} 완료`}
          checked={item.status === 'done'}
          disabled={pending || item.status === 'carried'}
          onChange={(e) => update({ status: e.target.checked ? 'done' : 'open' })}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {editing ? (
            <input
              autoFocus
              defaultValue={item.title}
              aria-label="할 일 이름"
              onBlur={(e) => commitTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle(e.currentTarget.value)
                if (e.key === 'Escape') setEditing(false)
              }}
              className="w-full rounded-md border border-accent bg-transparent px-1.5 text-[15px] outline-none md:text-sm"
            />
          ) : (
            <div
              onDoubleClick={() => open && !pending && !linked && setEditing(true)}
              className={`text-[15px] leading-snug font-medium break-words md:text-sm ${item.status === 'done' ? `text-faint ${doneStrike}` : ''}`}
            >
              {item.title}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted">
            {unscheduled && (
              <span className="rounded-md border border-line-strong px-1.5 py-0.5 text-[11px] font-semibold text-ink-2">미배정</span>
            )}
            {linked && (
              <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-semibold text-accent-ink">
                {linked === 'backlog' ? '보관함' : `${shortDate(item.date!)} 할 일`}
              </span>
            )}
            {sessions.map((b) => (
              <button
                key={b.id}
                onClick={() => onFocusBlock(b.id)}
                aria-label={`시간표에서 ${slotToTime(b.startSlot)} 블록 보기`}
                className={`rounded-md bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-ink-2 hover:bg-line ${b.done ? 'line-through decoration-danger' : ''}`}
              >
                {slotToTime(b.startSlot)}–{slotToTime(b.endSlot)}
              </button>
            ))}
            {open && !linked && (
              <span className="flex items-center rounded-md bg-subtle">
                <button
                  aria-label="예상 시간 줄이기"
                  disabled={pending || !estimate || estimate <= 1}
                  onClick={() => estimate && update({ estimateBoxes: estimate - 1 })}
                  className={stepper}
                >
                  −
                </button>
                <span className="px-0.5 font-mono text-ink-2">{estimate ? formatDuration(estimate) : '시간 미정'}</span>
                <button
                  aria-label="예상 시간 늘리기"
                  disabled={pending || (estimate ?? 0) >= 144}
                  onClick={() => update({ estimateBoxes: (estimate ?? 0) + 1 })}
                  className={stepper}
                >
                  +
                </button>
              </span>
            )}
            {open && !linked && scheduled > 0 && estimate && scheduled < estimate && (
              <span>
                배정 {formatDuration(scheduled)} / {formatDuration(estimate)}
              </span>
            )}
            {item.carriedFrom && <span>↩ {shortDate(item.carriedFrom)}부터</span>}
            {item.status === 'carried' && <span>→ 다음 날로 넘김</span>}
          </div>
        </div>
        {draggable && unscheduled && (
          <button
            onClick={() => onPlace({ item, boxes: dropBoxes(item, scheduled) })}
            className="flex h-10 shrink-0 items-center gap-1.5 self-center rounded-[10px] border border-line-strong bg-surface px-3 text-[13px] font-semibold md:hidden"
          >
            <CalendarPlus size={16} />
            넣기
          </button>
        )}
        {/* Any open item can wait in the backlog; blocks already placed stay on the timetable. */}
        {open && !pending && !linked && (
          <button
            aria-label={`${item.title} 보관함으로 보내기`}
            title="나중에 (보관함으로)"
            onClick={() => void moveToBacklog(item.id)}
            className="shrink-0 rounded-md p-1 text-muted hover:bg-subtle hover:text-accent dark:hover:text-accent-bright"
          >
            <Archive size={15} />
          </button>
        )}
        {!pending && !linked && (
          <button
            aria-label={`${item.title} 삭제`}
            onClick={() => (sessions.length > 0 ? setConfirmDelete(true) : void deleteBrainDump(item.id))}
            className="shrink-0 rounded-md p-1 text-faint hover:text-danger focus:opacity-100 md:opacity-0 md:group-hover:opacity-100"
          >
            <Close size={14} />
          </button>
        )}
      </div>

      {confirmDelete && (
        <ConfirmInline
          message={`시간표의 블록 ${sessions.length}개도 함께 지워져요.`}
          onConfirm={() => void deleteBrainDump(item.id)}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </li>
  )
}

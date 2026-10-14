import { useState } from 'react'
import type { Block, BrainDumpItem } from '../../api/types'
import { addDays, parseISODate, todayISO } from '../../lib/date'
import { formatDuration } from '../../lib/slots'
import { isTempId, useDayStore } from '../../store/dayStore'

/** Item being dragged onto the grid and how many boxes it should take. */
export interface DraggedItem {
  item: BrainDumpItem
  boxes: number
}

const DEFAULT_DROP_BOXES = 3
const STATUS_ORDER: Record<BrainDumpItem['status'], number> = { open: 0, scheduled: 0, done: 1, carried: 2, dropped: 2 }

function shortDate(iso: string) {
  const d = parseISODate(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function scheduledBoxes(itemId: string, blocks: Block[]) {
  return blocks.reduce((n, b) => n + (b.brainDumpId === itemId ? b.endSlot - b.startSlot : 0), 0)
}

/** A partly scheduled item drops with just the remainder of its estimate. */
function dropBoxes(item: BrainDumpItem, scheduled: number) {
  if (!item.estimateBoxes) return DEFAULT_DROP_BOXES
  const remaining = item.estimateBoxes - scheduled
  return remaining > 0 ? remaining : item.estimateBoxes
}

interface Props {
  onDragItem: (dragged: DraggedItem | null) => void
  onNavigate: (date: string) => void
}

export function BrainDumpPanel({ onDragItem, onNavigate }: Props) {
  const { date, blocks, brainDump, addBrainDump, updateBrainDump, deleteBrainDump, carryOver } = useDayStore()
  const [text, setText] = useState('')
  const [carried, setCarried] = useState<{ count: number; to: string } | null>(null)

  const items = [...brainDump].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
  const openCount = brainDump.filter((it) => it.status === 'open').length
  const carryTarget = date < todayISO() ? todayISO() : addDays(date, 1)

  return (
    <section className="flex h-full flex-col gap-3 p-4">
      <header className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Brain Dump</h2>
        <span className="text-xs text-zinc-500">남은 일 {openCount}개</span>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void addBrainDump(text)
          setText('')
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="떠오르는 할 일 (예: 기획서 40분)"
          aria-label="Brain Dump 항목 추가"
          className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700"
        />
      </form>

      <ul className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {items.length === 0 && (
          <li className="px-1 py-6 text-center text-sm text-zinc-400">
            머릿속에 있는 일을 모두 적어보세요.
            <br />
            적은 항목은 시간표로 끌어다 놓을 수 있어요.
          </li>
        )}
        {items.map((item) => (
          <BrainDumpRow
            key={item.id}
            item={item}
            scheduled={scheduledBoxes(item.id, blocks)}
            onDragItem={onDragItem}
            onUpdate={(patch) => void updateBrainDump(item.id, patch)}
            onDelete={() => void deleteBrainDump(item.id)}
          />
        ))}
      </ul>

      {carried && (
        <p className="text-xs text-zinc-500">
          {carried.count}개를 {shortDate(carried.to)}로 넘겼어요.{' '}
          <button className="text-indigo-600 underline dark:text-indigo-400" onClick={() => onNavigate(carried.to)}>
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
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          남은 일 {openCount}개 → {carryTarget === todayISO() ? '오늘' : shortDate(carryTarget)}로 넘기기
        </button>
      )}
    </section>
  )
}

interface RowProps {
  item: BrainDumpItem
  scheduled: number
  onDragItem: (dragged: DraggedItem | null) => void
  onUpdate: (patch: { title?: string; estimateBoxes?: number; status?: BrainDumpItem['status'] }) => void
  onDelete: () => void
}

function BrainDumpRow({ item, scheduled, onDragItem, onUpdate, onDelete }: RowProps) {
  const [editing, setEditing] = useState(false)
  const pending = isTempId(item.id)
  const open = item.status === 'open'
  const draggable = open && !pending && !editing
  const estimate = item.estimateBoxes

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
        'group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm',
        draggable ? 'cursor-grab hover:bg-zinc-100 active:cursor-grabbing dark:hover:bg-zinc-900' : '',
        pending ? 'opacity-60' : '',
        item.status === 'carried' || item.status === 'dropped' ? 'opacity-50' : '',
      ].join(' ')}
    >
      <input
        type="checkbox"
        className="mt-0.5"
        aria-label={`${item.title} 완료`}
        checked={item.status === 'done'}
        disabled={pending || item.status === 'carried'}
        onChange={(e) => onUpdate({ status: e.target.checked ? 'done' : 'open' })}
      />
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            defaultValue={item.title}
            onBlur={(e) => commitTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle(e.currentTarget.value)
              if (e.key === 'Escape') setEditing(false)
            }}
            className="w-full rounded border border-indigo-400 bg-transparent px-1 outline-none"
          />
        ) : (
          <div
            onDoubleClick={() => open && !pending && setEditing(true)}
            className={`break-words ${item.status === 'done' ? 'text-zinc-400 line-through' : ''}`}
          >
            {item.title}
          </div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
          {open && (
            <span className="flex items-center gap-1">
              <button
                aria-label="예상 시간 줄이기"
                disabled={pending || !estimate || estimate <= 1}
                onClick={() => estimate && onUpdate({ estimateBoxes: estimate - 1 })}
                className="rounded px-1 hover:bg-zinc-200 disabled:opacity-30 dark:hover:bg-zinc-800"
              >
                −
              </button>
              <span className="tabular-nums">{estimate ? formatDuration(estimate) : '시간 미정'}</span>
              <button
                aria-label="예상 시간 늘리기"
                disabled={pending || (estimate ?? 0) >= 144}
                onClick={() => onUpdate({ estimateBoxes: (estimate ?? 0) + 1 })}
                className="rounded px-1 hover:bg-zinc-200 disabled:opacity-30 dark:hover:bg-zinc-800"
              >
                +
              </button>
            </span>
          )}
          {scheduled > 0 && (
            <span className={estimate && scheduled >= estimate ? 'text-emerald-600 dark:text-emerald-400' : ''}>
              배정 {formatDuration(scheduled)}
            </span>
          )}
          {item.carriedFrom && <span>↩ {shortDate(item.carriedFrom)}부터</span>}
          {item.status === 'carried' && <span>→ 다음 날로 넘김</span>}
        </div>
      </div>
      {!pending && (
        <button
          aria-label={`${item.title} 삭제`}
          onClick={onDelete}
          className="text-zinc-400 opacity-0 hover:text-red-500 group-hover:opacity-100 focus:opacity-100"
        >
          ×
        </button>
      )}
    </li>
  )
}

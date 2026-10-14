import { useCallback, useEffect, useState } from 'react'
import { OVERLAP_MESSAGE } from '../../api/client'
import { addDays, formatDayTitle, todayISO } from '../../lib/date'
import { SLOT_MINUTES, type SlotRange } from '../../lib/slots'
import { useDayStore } from '../../store/dayStore'
import { BlockPopover } from './BlockPopover'
import { TimeGrid, type GridAnchor } from './TimeGrid'

type Popover = { mode: 'create'; range: SlotRange; at: GridAnchor } | { mode: 'edit'; id: string; at: GridAnchor }

function currentSlot(): number {
  const now = new Date()
  return Math.floor((now.getHours() * 60 + now.getMinutes()) / SLOT_MINUTES)
}

function useNowSlot(): number {
  const [slot, setSlot] = useState(currentSlot)
  useEffect(() => {
    const id = setInterval(() => setSlot(currentSlot()), 30_000)
    return () => clearInterval(id)
  }, [])
  return slot
}

export function DayView() {
  const { date, blocks, error, setDate, createBlock, updateBlock, deleteBlock, setError } = useDayStore()
  const [popover, setPopover] = useState<Popover | null>(null)
  const nowSlot = useNowSlot()
  const isToday = date === todayISO()

  useEffect(() => {
    void setDate(date)
    // Load once on mount; navigation calls setDate directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!error) return
    const id = setTimeout(() => setError(null), 3000)
    return () => clearTimeout(id)
  }, [error, setError])

  const go = (d: string) => {
    setPopover(null)
    void setDate(d)
  }
  const closePopover = useCallback(() => setPopover(null), [])

  const editingBlock = popover?.mode === 'edit' ? blocks.find((b) => b.id === popover.id) : undefined
  const plannedBoxes = blocks.reduce((n, b) => n + b.endSlot - b.startSlot, 0)
  const doneBoxes = blocks.reduce((n, b) => n + (b.done ? b.endSlot - b.startSlot : 0), 0)

  return (
    <div className="flex h-dvh flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <button onClick={() => go(addDays(date, -1))} className="rounded-md px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="이전 날">
          ◀
        </button>
        <h1 className="min-w-48 text-center text-lg font-semibold">{formatDayTitle(date)}</h1>
        <button onClick={() => go(addDays(date, 1))} className="rounded-md px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="다음 날">
          ▶
        </button>
        {!isToday && (
          <button onClick={() => go(todayISO())} className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            오늘
          </button>
        )}
        <div className="ml-auto text-sm text-zinc-500 tabular-nums">
          완료 {doneBoxes} / 계획 {plannedBoxes} 박스
        </div>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col px-4 py-3">
        <TimeGrid
          key={date}
          blocks={blocks}
          nowSlot={isToday ? nowSlot : null}
          pendingRange={popover?.mode === 'create' ? popover.range : null}
          onSelect={(range, at) => setPopover({ mode: 'create', range, at })}
          onBlockClick={(id, at) => setPopover({ mode: 'edit', id, at })}
          onBlockChange={(id, range) => void updateBlock(id, { startSlot: range.start, endSlot: range.end })}
          onInvalidDrop={() => setError(OVERLAP_MESSAGE)}
        />
      </main>

      {popover?.mode === 'create' && (
        <BlockPopover
          mode="create"
          range={popover.range}
          at={popover.at}
          onClose={closePopover}
          onCreate={(title, color) =>
            void createBlock({ date, startSlot: popover.range.start, endSlot: popover.range.end, title, color })
          }
        />
      )}
      {editingBlock && popover && (
        <BlockPopover
          mode="edit"
          block={editingBlock}
          at={popover.at}
          onClose={closePopover}
          onSave={(patch) => void updateBlock(editingBlock.id, patch)}
          onDelete={() => void deleteBlock(editingBlock.id)}
        />
      )}

      {error && (
        <div role="alert" className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900">
          {error}
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { OVERLAP_MESSAGE } from '../../api/client'
import { addDays, formatDayTitle, todayISO } from '../../lib/date'
import { SLOT_MINUTES, type SlotRange } from '../../lib/slots'
import { useDayStore } from '../../store/dayStore'
import { AIPanel } from '../ai/AIPanel'
import { useAISuggestion } from '../ai/useAISuggestion'
import { BrainDumpPanel, type DraggedItem } from '../braindump/BrainDumpPanel'
import { ViewSwitch } from '../nav/ViewSwitch'
import { BlockPopover } from './BlockPopover'
import { DEFAULT_BLOCK_COLOR } from './colors'
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

export function DayView({ date }: { date: string }) {
  const { blocks, error, setDate, reload, createBlock, updateBlock, deleteBlock, setError } = useDayStore()
  const navigate = useNavigate()
  const [popover, setPopover] = useState<Popover | null>(null)
  const [dragged, setDragged] = useState<DraggedItem | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const ai = useAISuggestion(date)
  const nowSlot = useNowSlot()
  const isToday = date === todayISO()

  // The URL is the source of truth for which day is shown.
  useEffect(() => {
    setPopover(null)
    void setDate(date)
  }, [date, setDate])

  useEffect(() => {
    if (!error) return
    const id = setTimeout(() => setError(null), 3000)
    return () => clearTimeout(id)
  }, [error, setError])

  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(null), 3000)
    return () => clearTimeout(id)
  }, [notice])

  const closeAI = () => {
    ai.reset()
    setAiOpen(false)
  }
  const ghosts =
    aiOpen && ai.suggestion
      ? ai.accepted.map((b) => ({
          key: ai.blockKey(b),
          range: { start: b.startSlot, end: b.endSlot },
          title: b.title,
          highlighted: ai.hovered === ai.blockKey(b),
        }))
      : []

  const go = (d: string) => navigate(`/day/${d}`)
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
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => (aiOpen ? closeAI() : setAiOpen(true))}
            aria-pressed={aiOpen}
            className={`rounded-md px-3 py-1 text-sm ${aiOpen ? 'bg-violet-600 text-white' : 'border border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950'}`}
          >
            ✨ AI 제안
          </button>
          <span className="hidden text-sm text-zinc-500 tabular-nums sm:inline">
            완료 {doneBoxes} / 계획 {plannedBoxes} 박스
          </span>
          <ViewSwitch view="day" date={date} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-zinc-200 lg:max-h-none lg:w-80 lg:border-r lg:border-b-0 dark:border-zinc-800">
          {aiOpen ? (
            <AIPanel
              key={date}
              ai={ai}
              nowSlot={isToday ? nowSlot : null}
              onClose={closeAI}
              onApplied={(count) => {
                setAiOpen(false)
                void reload()
                setNotice(`AI 제안 ${count}개를 시간표에 추가했어요`)
              }}
            />
          ) : (
            <BrainDumpPanel key={date} onDragItem={setDragged} onNavigate={go} />
          )}
        </aside>

        <main className="flex min-h-0 w-full max-w-5xl flex-1 flex-col px-4 py-3">
          <TimeGrid
            key={date}
            blocks={blocks}
            nowSlot={isToday ? nowSlot : null}
            pendingRange={popover?.mode === 'create' ? popover.range : null}
            onSelect={(range, at) => setPopover({ mode: 'create', range, at })}
            onBlockClick={(id, at) => setPopover({ mode: 'edit', id, at })}
            onBlockChange={(id, range) => void updateBlock(id, { startSlot: range.start, endSlot: range.end })}
            onInvalidDrop={() => setError(OVERLAP_MESSAGE)}
            dropBoxes={dragged?.boxes ?? null}
            ghosts={ghosts}
            onItemDrop={(range) => {
              if (!dragged) return
              void createBlock({
                date,
                startSlot: range.start,
                endSlot: range.end,
                title: dragged.item.title,
                color: DEFAULT_BLOCK_COLOR,
                brainDumpId: dragged.item.id,
              })
              setDragged(null)
            }}
          />
        </main>
      </div>

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

      {(error ?? notice) && (
        <div role={error ? 'alert' : 'status'} className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900">
          {error ?? notice}
        </div>
      )}
    </div>
  )
}

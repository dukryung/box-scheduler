import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { OVERLAP_MESSAGE, api } from '../../api/client'
import type { AssistantOp } from '../../api/types'
import { ChevronLeft, ChevronRight, Flag, Mic, Plus } from '../../components/icons'
import { card, iconButton } from '../../components/styles'
import { WEEKDAYS, addDays, parseISODate, todayISO } from '../../lib/date'
import { SLOT_MINUTES, nextBoundary, slotToTime, type SlotRange } from '../../lib/slots'
import { hm } from '../../lib/hm'
import { useIsMobile } from '../../lib/useIsMobile'
import { useDayStore } from '../../store/dayStore'
import { useTasksStore } from '../../store/tasksStore'
import { deadlineCounts } from '../../lib/backlog'
import { BacklogPanel } from '../tasks/BacklogPanel'
import { AIPanel } from '../ai/AIPanel'
import { useAISuggestion } from '../ai/useAISuggestion'
import { AssistantBar, AssistantPanel } from '../assistant/Assistant'
import { useAssistant } from '../assistant/useAssistant'
import { BrainDumpPanel } from '../braindump/BrainDumpPanel'
import type { DraggedItem } from '../braindump/drop'
import { PlaceSheet } from '../braindump/PlaceSheet'
import { BottomTabs, TopBar, ViewSwitch } from '../nav/ViewSwitch'
import { BlockPopover } from './BlockPopover'
import { DEFAULT_BLOCK_COLOR } from './colors'
import { TimeGrid, type GhostBlock, type GridAnchor } from './TimeGrid'

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
  const { blocks, brainDump, error, setDate, reload, createBlock, updateBlock, deleteBlock, setError } = useDayStore()
  const navigate = useNavigate()
  const mobile = useIsMobile()
  const [popover, setPopover] = useState<Popover | null>(null)
  const [dragged, setDragged] = useState<DraggedItem | null>(null)
  const [placing, setPlacing] = useState<DraggedItem | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [mobileTab, setMobileTab] = useState<'grid' | 'braindump' | 'backlog'>('grid')
  const [sideTab, setSideTab] = useState<'braindump' | 'backlog'>('braindump')
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null)
  const { items: backlog, load: loadBacklog } = useTasksStore()
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const assistantInputRef = useRef<HTMLInputElement>(null)
  const [assistantSheet, setAssistantSheet] = useState(false)
  const [undoable, setUndoable] = useState<{ ops: AssistantOp[]; count: number } | null>(null)
  const ai = useAISuggestion(date)
  const assistant = useAssistant(date)
  const resetAssistant = assistant.reset
  const nowSlot = useNowSlot()
  const isToday = date === todayISO()
  const d = parseISODate(date)

  // The URL is the source of truth for which day is shown.
  useEffect(() => {
    setPopover(null)
    setPlacing(null)
    resetAssistant()
    void setDate(date)
  }, [date, setDate, resetAssistant])

  useEffect(() => {
    void loadBacklog()
  }, [loadBacklog])

  useEffect(() => {
    if (!undoable) return
    const id = setTimeout(() => setUndoable(null), 10_000)
    return () => clearTimeout(id)
  }, [undoable])

  // ⌘K / Ctrl+K jumps to the request bar on desktop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        assistantInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
  const openAI = () => {
    setPlacing(null)
    setMobileTab('grid')
    setAiOpen(true)
  }
  const suggestionGhosts: GhostBlock[] =
    aiOpen && ai.suggestion
      ? ai.accepted.map((b) => ({
          key: ai.blockKey(b),
          range: { start: b.startSlot, end: b.endSlot },
          title: b.title,
          highlighted: ai.hovered === ai.blockKey(b),
        }))
      : []
  // Pending assistant edits on this day: new/moved positions in violet, deletions in red.
  const assistantGhosts: GhostBlock[] =
    assistant.status === 'ready' && assistant.preview
      ? assistant.preview.changes.flatMap((c, i): GhostBlock[] => {
          if ((c.kind === 'add' || c.kind === 'move') && c.after?.date === date)
            return [{ key: `asst-${i}`, range: { start: c.after.startSlot, end: c.after.endSlot }, title: c.title, highlighted: false }]
          if (c.kind === 'remove' && c.before?.date === date)
            return [{ key: `asst-${i}`, range: { start: c.before.startSlot, end: c.before.endSlot }, title: c.title, highlighted: false, variant: 'remove' }]
          return []
        })
      : []
  const ghosts = [...suggestionGhosts, ...assistantGhosts]

  const closeAssistant = () => {
    assistant.reset()
    setAssistantSheet(false)
  }
  const onAssistantApplied = (res: { undo: AssistantOp[]; count: number }) => {
    setAssistantSheet(false)
    void reload()
    setUndoable({ ops: res.undo, count: res.count })
  }
  const undoAssistant = async () => {
    if (!undoable) return
    const ops = undoable.ops
    setUndoable(null)
    try {
      await api.assistantApply(ops)
      setNotice('되돌렸어요')
    } catch (e) {
      setError((e as Error).message)
    }
    void reload()
  }

  const go = (iso: string) => navigate(`/day/${iso}`)
  const closePopover = useCallback(() => setPopover(null), [])
  const closePlacing = useCallback(() => setPlacing(null), [])

  const occupied = blocks.map((b) => ({ start: b.startSlot, end: b.endSlot }))
  const editingBlock = popover?.mode === 'edit' ? blocks.find((b) => b.id === popover.id) : undefined
  const plannedBoxes = blocks.reduce((n, b) => n + b.endSlot - b.startSlot, 0)
  const doneBoxes = blocks.reduce((n, b) => n + (b.done ? b.endSlot - b.startSlot : 0), 0)
  // Items still without a time today ("미배정"), counted on the Brain Dump tab.
  const unscheduledItems = brainDump.filter((it) => it.status === 'open' && !blocks.some((b) => b.brainDumpId === it.id)).length

  const scheduleItem = async (item: DraggedItem, range: SlotRange) => {
    await createBlock({
      date,
      startSlot: range.start,
      endSlot: range.end,
      title: item.item.title,
      color: DEFAULT_BLOCK_COLOR,
      brainDumpId: item.item.id,
    })
    // Backlog items show progress across days; refresh it.
    if (item.item.date === null) void loadBacklog()
  }

  const openBacklogItems = backlog.filter((it) => it.status === 'open').length
  const deadlines = deadlineCounts(backlog, todayISO())
  const showDeadlines = isToday && (deadlines.overdue > 0 || deadlines.soon > 0)
  const openBacklog = () => {
    closeAI()
    setSideTab('backlog')
    setMobileTab('backlog')
  }
  const onMovedToDay = (title: string) => {
    void reload()
    setSideTab('braindump')
    if (mobile) setMobileTab('braindump')
    setNotice(`‘${title}’을(를) ${isToday ? '오늘' : '이 날'} Brain Dump로 가져왔어요`)
  }
  const sidePanel = (tab: 'braindump' | 'backlog') =>
    tab === 'backlog' ? (
      <BacklogPanel date={date} onDragItem={setDragged} onPlace={setPlacing} onMovedToDay={onMovedToDay} />
    ) : (
      <BrainDumpPanel
        key={date}
        inputRef={inputRef}
        onDragItem={setDragged}
        onNavigate={go}
        onPlace={setPlacing}
        onOpenAI={openAI}
        onFocusBlock={(id) => {
          if (mobile) setMobileTab('grid')
          setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }))
        }}
      />
    )

  const aiPanel = (
    <AIPanel
      key={date}
      ai={ai}
      nowSlot={isToday ? nowSlot : null}
      onClose={closeAI}
      onApplied={({ blocks, moved, skipped }) => {
        setAiOpen(false)
        void reload()
        const changed = [moved > 0 && `${moved}개는 겹치지 않게 시간을 옮겼어요`, skipped > 0 && `${skipped}개는 빈 시간이 없어 뺐어요`].filter(Boolean)
        setNotice([`AI 제안 ${blocks.length}개를 시간표에 추가했어요`, ...changed].join(' · '))
      }}
    />
  )
  const showAside = !mobile || (mobileTab !== 'grid' && !aiOpen)
  const showGrid = !mobile || mobileTab === 'grid' || aiOpen

  return (
    <div className="flex h-dvh flex-col bg-ground text-ink">
      <TopBar>
        <div className="flex flex-1 items-center gap-1 md:flex-none">
          <button onClick={() => go(addDays(date, -1))} className={iconButton} aria-label="이전 날">
            <ChevronLeft size={18} />
          </button>
          <div className="flex flex-1 flex-col items-center md:flex-none md:flex-row md:items-baseline md:gap-2 md:px-2.5">
            <h1 className="text-[17px] font-semibold tracking-tight md:text-lg">
              {d.getMonth() + 1}월 {d.getDate()}일
            </h1>
            <span className="text-xs text-muted md:text-sm">
              {WEEKDAYS[d.getDay()]}요일{isToday && <span className="md:hidden"> · 오늘</span>}
            </span>
          </div>
          <button onClick={() => go(addDays(date, 1))} className={iconButton} aria-label="다음 날">
            <ChevronRight size={18} />
          </button>
          {isToday ? (
            <span className="ml-1.5 hidden rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent-ink md:inline">오늘</span>
          ) : (
            <button onClick={() => go(todayISO())} className="ml-1.5 h-9 rounded-[10px] border border-line px-3 text-sm text-ink-2 hover:bg-subtle">
              오늘
            </button>
          )}
        </div>

        <div className="order-last flex w-full items-center gap-2.5 text-xs text-muted md:order-none md:ml-auto md:w-[200px] md:flex-col md:items-stretch md:gap-1.5">
          <div className="flex shrink-0 justify-between gap-2.5">
            <span>{isToday ? '오늘 완료' : '완료'}</span>
            <span className="hidden font-mono text-ink md:inline">
              {hm(doneBoxes)} / {hm(plannedBoxes)}
            </span>
          </div>
          <div className="h-1.5 flex-1 rounded-full bg-subtle md:flex-none">
            <div
              className="h-1.5 rounded-full bg-accent-bright transition-[width]"
              style={{ width: plannedBoxes ? `${(doneBoxes / plannedBoxes) * 100}%` : 0 }}
            />
          </div>
          <span className="shrink-0 font-mono text-ink md:hidden">
            {hm(doneBoxes)} / {hm(plannedBoxes)}
          </span>
        </div>

        <ViewSwitch view="day" date={date} />
        <button
          onClick={() => {
            closeAI()
            setAssistantSheet(true)
          }}
          aria-label="말로 요청하기"
          className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-ai-line text-ai-ink md:hidden"
        >
          <Mic size={18} />
        </button>
      </TopBar>

      {showDeadlines && (
        <button
          onClick={openBacklog}
          className="mx-4 mt-3 flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3.5 py-2 text-left text-[13px] text-ink-2 md:mx-6 md:mt-4"
        >
          <Flag size={14} className="shrink-0 text-danger" />
          <span className="min-w-0 flex-1">
            {deadlines.overdue > 0 && <span className="font-semibold text-danger">기한 지남 {deadlines.overdue}개</span>}
            {deadlines.overdue > 0 && deadlines.soon > 0 && ' · '}
            {deadlines.soon > 0 && <span className="font-semibold">오늘·내일 마감 {deadlines.soon}개</span>}
          </span>
          <span className="shrink-0 font-semibold text-accent dark:text-accent-bright">보관함 보기</span>
        </button>
      )}

      {!mobile && (
        <div className="relative px-6 pt-4">
          <div className="max-w-[720px]">
            <AssistantBar assistant={assistant} inputRef={assistantInputRef} showShortcut />
          </div>
          {(assistant.status !== 'idle' || assistant.error) && (
            <div className="absolute top-full left-6 z-30 mt-2 w-[min(720px,calc(100%-48px))] rounded-2xl border border-line bg-surface p-4 shadow-xl">
              <AssistantPanel assistant={assistant} viewDate={date} onApplied={onAssistantApplied} onClose={closeAssistant} />
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3 pb-[88px] md:flex-row md:gap-5 md:px-6 md:pt-4 md:pb-5">
        {mobile && !aiOpen && (
          <div role="tablist" aria-label="일간 보기" className="flex rounded-[10px] bg-subtle p-[3px]">
            {(
              [
                ['grid', '시간표'],
                ['braindump', 'Brain Dump'],
                ['backlog', '보관함'],
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                role="tab"
                aria-selected={mobileTab === tab}
                onClick={() => setMobileTab(tab)}
                className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm ${
                  mobileTab === tab ? 'bg-surface font-semibold shadow-[0_1px_2px_rgba(21,23,28,0.08)]' : 'text-muted'
                }`}
              >
                {label}
                {tab === 'braindump' && unscheduledItems > 0 && (
                  <span className="rounded-full bg-line-strong px-1.5 text-[11px] font-semibold text-ink-2" aria-label={`미배정 ${unscheduledItems}개`}>
                    {unscheduledItems}
                  </span>
                )}
                {tab === 'backlog' && openBacklogItems > 0 && (
                  <span className="rounded-full bg-line-strong px-1.5 text-[11px] font-semibold text-ink-2">{openBacklogItems}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {showAside && (
          <aside className={`${card} flex min-h-0 flex-1 flex-col p-4 md:w-[320px] md:flex-none md:shrink-0 md:p-5`}>
            {aiOpen && !mobile ? (
              aiPanel
            ) : mobile ? (
              sidePanel(mobileTab === 'backlog' ? 'backlog' : 'braindump')
            ) : (
              <>
                <div role="tablist" aria-label="할 일 목록" className="mb-4 flex rounded-[10px] bg-subtle p-[3px]">
                  {(
                    [
                      ['braindump', 'Brain Dump', unscheduledItems],
                      ['backlog', '보관함', openBacklogItems],
                    ] as const
                  ).map(([tab, label, count]) => (
                    <button
                      key={tab}
                      role="tab"
                      aria-selected={sideTab === tab}
                      onClick={() => setSideTab(tab)}
                      className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm ${
                        sideTab === tab ? 'bg-surface font-semibold shadow-[0_1px_2px_rgba(21,23,28,0.08)]' : 'text-muted'
                      }`}
                    >
                      {label}
                      {count > 0 && <span className="rounded-full bg-line-strong px-1.5 text-[11px] font-semibold text-ink-2">{count}</span>}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1">{sidePanel(sideTab)}</div>
              </>
            )}
          </aside>
        )}

        {showGrid && (
          <main className={`${card} flex min-h-0 flex-1 flex-col px-2.5 pt-2.5 pb-3 md:px-5 md:pt-4 md:pb-5`}>
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
              focus={focus}
              onItemDrop={(range) => {
                if (!dragged) return
                void scheduleItem(dragged, range)
                setDragged(null)
              }}
            />
            <p className="mt-2 text-center text-xs text-muted md:hidden">빈 칸을 누르면 그 시각에 일정을 추가해요</p>
          </main>
        )}
      </div>

      {mobile && !aiOpen && mobileTab === 'grid' && (
        <button
          aria-label="할 일 추가"
          onClick={() => {
            setMobileTab('braindump')
            setTimeout(() => inputRef.current?.focus(), 0)
          }}
          className="fixed right-4 bottom-24 z-30 flex h-14 w-14 items-center justify-center rounded-[18px] bg-accent text-white shadow-[0_6px_16px_rgba(21,23,28,0.18)]"
        >
          <Plus size={22} />
        </button>
      )}

      <BottomTabs view="day" date={date} />

      {mobile && aiOpen && (
        <section
          role="dialog"
          aria-label="AI 일정 제안"
          className="fixed inset-x-0 bottom-0 z-40 flex max-h-[62dvh] flex-col rounded-t-[22px] border border-line bg-surface px-4 pt-2.5 pb-[max(env(safe-area-inset-bottom),20px)] shadow-[0_-8px_24px_rgba(21,23,28,0.14)]"
        >
          <span className="mb-2 h-[5px] w-10 shrink-0 self-center rounded-full bg-line-strong" />
          <div className="min-h-0 flex-1 overflow-y-auto">{aiPanel}</div>
        </section>
      )}

      {mobile && assistantSheet && (
        <>
          <div className="fixed inset-0 z-40 bg-[rgba(21,23,28,0.42)]" onPointerDown={closeAssistant} />
          <section
            role="dialog"
            aria-label="말로 요청하기"
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80dvh] flex-col gap-3 overflow-y-auto rounded-t-[22px] border border-line bg-surface px-4 pt-2.5 pb-[max(env(safe-area-inset-bottom),20px)] shadow-[0_-8px_24px_rgba(21,23,28,0.14)]"
          >
            <span className="h-[5px] w-10 shrink-0 self-center rounded-full bg-line-strong" />
            <h2 className="text-[17px] font-bold">말로 요청하기</h2>
            <AssistantBar assistant={assistant} listenOnMount />
            <AssistantPanel assistant={assistant} viewDate={date} onApplied={onAssistantApplied} onClose={closeAssistant} />
            {assistant.status === 'idle' && !assistant.error && (
              <p className="text-[13px] leading-relaxed text-muted">
                예: “헬스장 8시로 미뤄줘”, “내일 오후 3시에 치과 1시간 넣어줘”, “코드 리뷰 완료했어”
              </p>
            )}
          </section>
        </>
      )}

      {undoable && (
        <div
          role="status"
          className="fixed bottom-24 left-1/2 z-50 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 rounded-xl bg-ink py-2 pr-2 pl-4 text-sm text-surface shadow-lg md:bottom-6"
        >
          {undoable.count}개를 바꿨어요
          <button onClick={() => void undoAssistant()} className="rounded-lg px-3 py-1.5 font-semibold text-accent-soft hover:bg-white/10">
            되돌리기
          </button>
        </div>
      )}

      {placing && (
        <PlaceSheet
          placing={placing}
          blocks={blocks}
          nowSlot={isToday ? nowSlot : null}
          onClose={closePlacing}
          onAskAI={openAI}
          onPlace={(range) => {
            void scheduleItem(placing, range)
            setPlacing(null)
            setNotice(`${placing.item.title}을(를) ${slotToTime(range.start)}에 넣었어요`)
          }}
        />
      )}

      {popover?.mode === 'create' && (
        <BlockPopover
          mode="create"
          range={popover.range}
          maxEnd={nextBoundary(popover.range.start, occupied)}
          onRangeChange={(range) => setPopover({ ...popover, range })}
          at={popover.at}
          onClose={closePopover}
          onCreate={(title, color) => void createBlock({ date, startSlot: popover.range.start, endSlot: popover.range.end, title, color })}
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
          deleteHint={
            // A dated item goes with its last block; backlog items stay.
            brainDump.some((it) => it.id === editingBlock.brainDumpId) &&
            blocks.filter((b) => b.brainDumpId === editingBlock.brainDumpId).length === 1
              ? '삭제하면 Brain Dump에서도 지워져요.'
              : undefined
          }
        />
      )}

      {(error ?? notice) && (
        <div
          role={error ? 'alert' : 'status'}
          className="fixed bottom-24 left-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-xl bg-ink px-4 py-2.5 text-sm text-surface shadow-lg md:bottom-6"
        >
          {error ?? notice}
        </div>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import type { Block } from '../../api/types'
import { Close } from '../../components/icons'
import { primaryButton } from '../../components/styles'
import { formatDuration, formatRange, type SlotRange } from '../../lib/slots'
import { useIsMobile } from '../../lib/useIsMobile'
import { BLOCK_COLORS, DEFAULT_BLOCK_COLOR } from './colors'
import type { GridAnchor } from './TimeGrid'

const WIDTH = 304
const EST_HEIGHT = 300
const MARGIN = 8
const LENGTHS = [1, 2, 3, 6] // boxes: 10분, 20분, 30분, 1시간

type Props = {
  at: GridAnchor
  onClose: () => void
} & (
  | {
      mode: 'create'
      range: SlotRange
      /** Latest end slot before the next block, so length chips never overlap it. */
      maxEnd: number
      onRangeChange: (range: SlotRange) => void
      onCreate: (title: string, color: string) => void
    }
  | {
      mode: 'edit'
      block: Block
      onSave: (patch: { title?: string; color?: string; done?: boolean }) => void
      onDelete: () => void
      /** Explains what else a delete removes, e.g. the brain dump item. */
      deleteHint?: string
    }
)

/** Create/edit form for a block: a popover by the pointer, or a bottom sheet on phones. */
export function BlockPopover(props: Props) {
  const { at, onClose } = props
  const mobile = useIsMobile()
  const editing = props.mode === 'edit' ? props.block : null
  const [title, setTitle] = useState(editing?.title ?? '')
  const [color, setColor] = useState(editing?.color ?? DEFAULT_BLOCK_COLOR)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const range = editing ? { start: editing.startSlot, end: editing.endSlot } : (props as { range: SlotRange }).range

  function submit() {
    const t = title.trim()
    if (props.mode === 'create') {
      if (t) props.onCreate(t, color)
    } else if (t && (t !== props.block.title || color !== props.block.color)) {
      props.onSave({ title: t, color })
    }
    onClose()
  }

  const placement = mobile
    ? 'fixed inset-x-0 bottom-0 z-50 rounded-t-[22px] px-5 pt-2.5 pb-[max(env(safe-area-inset-bottom),24px)] shadow-[0_-8px_24px_rgba(21,23,28,0.14)]'
    : 'fixed z-50 rounded-2xl p-4 shadow-xl'
  const position = mobile
    ? undefined
    : {
        left: Math.max(MARGIN, Math.min(at.x, window.innerWidth - WIDTH - MARGIN)),
        top: Math.max(MARGIN, Math.min(at.y + MARGIN, window.innerHeight - EST_HEIGHT - MARGIN)),
        width: WIDTH,
      }

  return (
    <>
      {/* Clicking outside saves (edit) or discards an empty draft (create). */}
      <div className={`fixed inset-0 z-40 ${mobile ? 'bg-[rgba(21,23,28,0.42)]' : ''}`} onPointerDown={submit} />
      <form
        role="dialog"
        aria-label={props.mode === 'create' ? '블록 추가' : '블록 편집'}
        className={`${placement} flex flex-col gap-3.5 border border-line bg-surface`}
        style={position}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {mobile && <span className="h-[5px] w-10 self-center rounded-full bg-line-strong" />}
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs text-muted">{formatRange(range)}</span>
          <button type="button" onClick={onClose} aria-label="닫기" className="-mr-1 rounded-lg p-1 text-muted hover:bg-subtle">
            <Close size={16} />
          </button>
        </div>
        <input
          autoFocus={!mobile}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="무엇을 할까요?"
          className="h-11 rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] outline-none focus:border-accent md:text-sm"
        />

        {props.mode === 'create' && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="길이">
            {LENGTHS.map((boxes) => {
              const end = props.range.start + boxes
              const fits = end <= props.maxEnd
              const selected = props.range.end - props.range.start === boxes
              return (
                <button
                  key={boxes}
                  type="button"
                  disabled={!fits}
                  aria-pressed={selected}
                  onClick={() => props.onRangeChange({ start: props.range.start, end })}
                  className={`h-9 rounded-lg border px-3 font-mono text-[13px] disabled:opacity-30 ${
                    selected ? 'border-accent bg-accent/10 font-medium text-accent-ink' : 'border-line-strong text-ink-2 hover:bg-subtle'
                  }`}
                >
                  {formatDuration(boxes)}
                </button>
              )
            })}
          </div>
        )}

        <div className="flex gap-2" role="group" aria-label="색상">
          {BLOCK_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`색상 ${c}`}
              aria-pressed={c === color}
              onClick={() => setColor(c)}
              className={`h-6 w-6 rounded-full ${c === color ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface' : ''}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>

        {editing && props.mode === 'edit' && props.deleteHint && <p className="-mb-1 text-xs text-muted">{props.deleteHint}</p>}
        {editing && props.mode === 'edit' ? (
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-[18px] w-[18px] accent-[var(--app-accent)]"
                checked={editing.done}
                onChange={(e) => props.onSave({ done: e.target.checked })}
              />
              완료
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  props.onDelete()
                  onClose()
                }}
                className="h-10 rounded-xl px-3 text-sm font-medium text-danger hover:bg-danger/10"
              >
                삭제
              </button>
              <button type="submit" className={`${primaryButton} h-10`}>
                저장
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="h-10 rounded-xl px-3 text-sm text-ink-2 hover:bg-subtle">
              취소
            </button>
            <button type="submit" disabled={!title.trim()} className={`${primaryButton} h-10 ${mobile ? 'flex-1' : ''}`}>
              추가
            </button>
          </div>
        )}
      </form>
    </>
  )
}

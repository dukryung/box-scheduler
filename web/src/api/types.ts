export interface Block {
  id: string
  date: string
  startSlot: number
  endSlot: number
  title: string
  color: string | null
  brainDumpId: string | null
  done: boolean
  source: 'manual' | 'ai'
}

// 'carried' = copied forward to a later day (the copy is a new open item there).
export type BrainDumpStatus = 'open' | 'scheduled' | 'done' | 'dropped' | 'carried'

export interface BrainDumpItem {
  id: string
  /** null for backlog items ("할 일 보관함"), which stay until done. */
  date: string | null
  title: string
  estimateBoxes: number | null
  priority: number | null
  category: string | null
  status: BrainDumpStatus
  carriedFrom: string | null
  dueDate: string | null
  note: string | null
  /** The backlog item this is a piece of (AI로 세분화). */
  parentId: string | null
}

/** A backlog item with its progress across every day it was scheduled on. */
export interface BacklogItem extends BrainDumpItem {
  scheduledBoxes: number
  doneBoxes: number
  /** Timetable blocks that deleting the item also deletes. */
  blockCount: number
  /** Day items it was split into (AI로 세분화), and how many are done. */
  pieces: number
  piecesDone: number
}

export interface BreakdownSub {
  title: string
  boxes: number
}

/** A task's pieces spread over working days (server-side, from the policy below). */
export interface BreakdownPlan {
  days: { date: string; free: number; reserve: boolean; total: number; pieces: { sub: number; title: string; boxes: number }[] }[]
  total: number
  placed: number
  shortage: number
}

export interface BreakdownPreview {
  item: BrainDumpItem
  subtasks: BreakdownSub[]
  reasons?: string[]
  notes?: string
  plan: BreakdownPlan
  period: { from: string; to: string; workingDays: number }
  policy: { workStart: string; workEnd: string; lunchStart: string; lunchEnd: string; capacity: number; perTaskMax: number }
  /** Earlier open, unplaced pieces in the period; applying with replace swaps them. */
  existing: number
}

export interface Day {
  date: string
  weekday: number
  note: string | null
  blocks: Block[]
  brainDump: BrainDumpItem[]
  /** Backlog or other-day items that have a block on this day. */
  linkedItems: BrainDumpItem[]
}

export interface CalendarItem {
  title: string
  color: string | null
  startSlot: number
  done: boolean
}

export interface CalendarDay {
  items: CalendarItem[] // earliest few blocks of the day
  total: number
  plannedBoxes: number
  doneBoxes: number
}

export interface CalendarMonth {
  month: string
  days: Record<string, CalendarDay>
  /** Titles of open backlog items due on each date. */
  dues: Record<string, string[]>
}

export interface SuggestedBlock {
  taskId: string
  title: string
  startSlot: number
  endSlot: number
  reason: string
  /** The time asked for in a revision was taken; this is the nearest free one. */
  shifted?: boolean
}

/** Asks the AI to change the suggestion on screen. */
export interface ReviseRequest {
  previous: Array<{ taskId: string; title: string; startSlot: number; endSlot: number; unchecked: boolean }>
  /** Changes asked for before, already applied. */
  earlier: string[]
  request: string
}

export interface Suggestion {
  blocks: SuggestedBlock[]
  unplaced: Array<{ taskId: string; title: string; boxes: number }>
  /** AI estimates for tasks that had none; saved when the plan is applied. */
  estimates: Array<{ taskId: string; estimateBoxes: number }>
  notes: string
  /** Minutes kept free between blocks in this suggestion. */
  breakMinutes: number
}

/** What applying a plan saved; blocks move or drop out when the day changed meanwhile. */
export interface AppliedPlan {
  blocks: Block[]
  moved: number
  skipped: number
}

export interface BoxCount {
  plannedBoxes: number
  doneBoxes: number
}

export interface Stats {
  from: string
  to: string
  totals: BoxCount & { blocks: number; doneBlocks: number; activeDays: number; aiBoxes: number }
  /** Same-length period right before `from`, for comparison. */
  previous: BoxCount
  daily: Array<BoxCount & { date: string }>
  hourly: Array<BoxCount & { hour: number }>
  topTasks: Array<BoxCount & { title: string }>
  brainDump: Record<'open' | 'done' | 'carried' | 'dropped', number>
  /** Planned days in a row, up to `to`, with everything done (today counts once finished). */
  streak: number
}

/** One edit proposed by the assistant; sent back unchanged to apply it. */
export interface AssistantOp {
  kind: string
  blockId?: string
  itemId?: string
  date?: string
  startSlot?: number
  endSlot?: number
  title?: string
  done?: boolean
  color?: string
  brainDumpId?: string
  source?: string
  estimateBoxes?: number
  status?: string
}

export interface AssistantSpan {
  date: string
  startSlot: number
  endSlot: number
}

export interface AssistantChange {
  kind: 'add' | 'move' | 'edit' | 'done' | 'undone' | 'remove' | 'item-add' | 'item-edit' | 'item-remove'
  title: string
  before?: AssistantSpan
  after?: AssistantSpan
  detail?: string
}

export interface AssistantPreview {
  reply: string
  clarification: string
  ops: AssistantOp[]
  changes: AssistantChange[]
  warnings: string[]
}

export interface AssistantTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface User {
  id: string
  email: string
  name: string
  status: 'active' | 'suspended'
  isOwner: boolean
  createdAt: string
  lastLoginAt: string | null
  hasPassword: boolean
  /** A Google account is linked. */
  google: boolean
  /** Chose personal or team use after signing up. */
  onboarded: boolean
}

/** One of the account's own AIs; the key itself never comes back, only its last characters. */
export interface AIConnection {
  id: string
  kind: 'anthropic' | 'openai'
  label: string
  baseUrl: string | null
  model: string
  keyHint: string
  createdAt: string
  checkedAt: string | null
  lastError: string
}

/** Which AI each feature uses: 'server' (owner's subscription), a connection id, or '' (none). */
export interface AISettings {
  plan: string
  request: string
  tidy: string
}

export interface AIState {
  connections: AIConnection[]
  settings: AISettings
  serverAvailable: boolean
  /** The service's own AI (set up by admins): models per feature and today's use against the daily limit. */
  service: { enabled: boolean; models: Record<'plan' | 'request' | 'tidy', string>; dailyLimit: number; usedToday: number; unlimited: boolean }
  anthropicModels: string[]
  keysEnabled: boolean
}

export type TeamRole = 'owner' | 'manager' | 'member'

export interface Team {
  id: string
  name: string
  /** The signed-in person's role. */
  role: TeamRole
  members: number
  createdAt: string
}

export interface TeamMember {
  userId: string
  email: string
  name: string
  role: TeamRole
  joinedAt: string
}

export interface TeamInvite {
  id: string
  email: string
  role: Exclude<TeamRole, 'owner'>
  invitedBy: string
  createdAt: string
  expiresAt: string
  sentAt: string | null
}

export interface TeamDetail extends Team {
  memberList: TeamMember[]
  /** Pending invites (managers and the owner only). */
  invites: TeamInvite[]
  mailEnabled: boolean
}

export type TeamTaskStatus = 'todo' | 'doing' | 'done'

export interface TaskAssignee {
  userId: string
  name: string
  email: string
  /** This person's share of the work, in 10-minute boxes. */
  boxes: number | null
  /** Once split for them (AI로 세분화): the pieces in their Brain Dump, and how much of it is done. */
  split: boolean
  plannedBoxes: number
  doneBoxes: number
}

export interface TeamTask {
  id: string
  title: string
  note: string
  status: TeamTaskStatus
  startDate: string | null
  dueDate: string | null
  estimateBoxes: number | null
  createdBy: string
  createdByName: string
  createdAt: string
  updatedAt: string
  doneAt: string | null
  assignees: TaskAssignee[]
  /** The parts it was split into ("AI로 업무 나누기"), each given to one person. */
  subtasks: TeamSubtask[]
  /** What the signed-in person may do with it. */
  canEdit: boolean
  canSetStatus: boolean
  /** May split it into subtasks (its creator, its assignees, managers and the owner). */
  canPlan: boolean
}

export interface TeamSubtask {
  id: string
  title: string
  boxes: number
  /** '' when no one has it (they left the team). */
  assigneeId: string
  position: number
  /** From the pieces in its owner's Brain Dump. */
  plannedBoxes: number
  doneBoxes: number
  status: TeamTaskStatus
  /** A piece is done or on the timetable: splitting again keeps it. */
  started: boolean
}

export interface PlanSub {
  title: string
  boxes: number
  assigneeId: string
  reason?: string
}

export interface PlanPerson {
  userId: string
  name: string
  /** Boxes meant for them (0: not set). */
  share: number
  /** In subtasks already started, and in the ones being planned. */
  kept: number
  new: number
  /** Working days the new pieces land on, and the first and last of them. */
  days: number
  from: string
  to: string
  /** Did not fit before the due date. */
  shortage: number
}

export interface TeamPlan {
  subtasks: PlanSub[]
  kept: TeamSubtask[]
  people: PlanPerson[]
  notes?: string
  period: { from: string; to: string; workingDays: number }
  policy: { workStart: string; workEnd: string; lunchStart: string; lunchEnd: string; capacity: number; perTaskMax: number }
}

/** Create sends every field; update sends only what changed ("" clears a date, 0 the estimate). */
export interface TeamTaskInput {
  title?: string
  note?: string
  status?: TeamTaskStatus
  startDate?: string
  dueDate?: string
  estimateBoxes?: number
  assignees?: { userId: string; boxes: number | null }[]
}

export interface InviteResult {
  email: string
  ok: boolean
  sent: boolean
  /** When no email went out: the link to pass on by hand. */
  link?: string
  error?: string
}

export interface InviteInfo {
  teamId: string
  team: string
  email: string
  role: Exclude<TeamRole, 'owner'>
  invitedBy: string
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
}

export interface AppNotification {
  id: string
  kind: 'assigned' | 'split' | 'subtasks' | 'reminder' | 'ending' | 'test' | 'meeting'
  title: string
  body: string
  /** In-app path to open, e.g. /day/2026-10-21. */
  link: string
  createdAt: string
  readAt: string | null
}

export interface NotifySettings {
  /** 10 minutes before each timetable block. */
  reminders: boolean
  /** Assigned to a team task, or a share split by someone else. */
  team: boolean
  timezone: string
}

/** What the AI (then a person) writes from a meeting. */
export interface Minutes {
  summary: string
  decisions: string[]
  topics: { title: string; points: string[] }[]
}

export interface MeetingTask {
  id?: string
  title: string
  note: string
  /** The words of the meeting the task comes from ('' when none were found). */
  evidence: string
  dueDate: string | null
  /** '' when no one has it yet. */
  assigneeId: string
  /** Once confirmed: the team task it became. */
  teamTaskId?: string
}

/** draft: text only · processing: the AI is at work · ready: minutes and tasks to check · confirmed: tasks made. */
export type MeetingStatus = 'draft' | 'processing' | 'ready' | 'confirmed'

export interface Meeting {
  id: string
  title: string
  heldOn: string
  /** Only when one meeting is read. */
  transcript?: string
  minutes: Minutes | null
  status: MeetingStatus
  /** Why the last AI write-up failed ('' when it did not). */
  aiError: string
  /** How far the AI is, in parts of the meeting. */
  aiDone: number
  aiParts: number
  createdBy: string
  createdByName: string
  confirmedByName: string
  confirmedAt: string | null
  createdAt: string
  updatedAt: string
  taskCount: number
  tasks: MeetingTask[]
  /** Recordings, oldest first (only when one meeting is read). */
  audio: MeetingAudio[]
  canEdit: boolean
  canConfirm: boolean
  canDelete: boolean
  /** Recordings can be transcribed on the Mac mini (set up on this server, and the person may edit). */
  canTranscribe: boolean
}

export interface MeetingInput {
  title?: string
  heldOn?: string
  transcript?: string
  minutes?: Minutes
  tasks?: MeetingTask[]
}

/** A meeting recording, uploaded piece by piece while it was made. */
export interface MeetingAudio {
  id: string
  mime: string
  bytes: number
  /** Pieces received so far; the next one sent is number `chunks`. */
  chunks: number
  durationSec: number
  /** Recording stopped (else it is still going, or the tab closed mid-way). */
  finished: boolean
  createdByName: string
  createdAt: string
  /** Careful transcription on the Mac mini, with the speakers told apart. */
  sttStatus: TranscribeStatus
  /** While running: decode, transcribe or diarize. */
  sttStage: string
  sttError: string
  segments: TranscriptSegment[] | null
  /** Who "화자 1", "화자 2", ... are: {"1": "김민지"}. */
  speakerNames: Record<string, string>
  /** The meeting's text becomes the transcription and the AI writes the minutes when it is done. */
  sttThenMinutes: boolean
  sttStartedAt: string | null
}

export type TranscribeStatus = 'none' | 'queued' | 'running' | 'done' | 'failed'

export interface TranscriptSegment {
  /** Seconds into the recording. */
  start: number
  end: number
  speaker: number
  text: string
}

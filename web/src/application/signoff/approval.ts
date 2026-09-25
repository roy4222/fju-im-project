import { err, type Err } from '@/shared/result'
import type { Participants, SignoffState, SupersedeCause } from '@/application/signoff/version'
import { describeCause } from '@/application/signoff/version'

/**
 * 逐人表態、老師最後同意、重置／重開／作廢、提醒的純規則（票 26；模組實作設計 07 §2、§3、§6；
 * 產品模組 07 §4「8.1」「8.2 管理員能力與限制」「同意紀錄內容與匯出」）。
 *
 * - **每人只有自己一票**：投票的人永遠是登入者本人（用例只收 actor，沒有「替誰投」的欄位）；
 *   角色看這一版的參與者快照——快照裡的學生只能同意／不同意，快照裡的主指導只能同意／退回。
 * - 全部學生同意才輪到主指導；任何一人不同意或主指導退回 → 退回修正中（理由必填）。
 * - 重開（Roy 2026-09-25 定案取代舊 D-01）＝**建立新版本**，舊版留歷史；重置同理。兩者都要填理由。
 * - 表態綁在「這一版＋這份內容」：頁面帶來的內容核對碼要等於版本的 checksum，舊頁送出一律被拒。
 */

export type VoteRole = 'student' | 'advisor'
export type VoteResult = 'agree' | 'disagree' | 'return'
/** 畫面上的兩個動作：同意，或不同意／退回（依角色）。 */
export type VoteDecision = 'agree' | 'reject'

export const VOTE_RESULT_LABEL: Readonly<Record<VoteResult, string>> = {
  agree: '同意',
  disagree: '不同意',
  return: '退回',
}

/**
 * 按鈕原文（附錄 A `approvals.button_text`）。由伺服器依角色與動作決定，不收畫面傳來的字——
 * 紀錄上的「按鈕原文」就是畫面上那顆按鈕實際寫的字，兩邊用同一份常數。
 */
export const BUTTON_TEXT: Readonly<Record<VoteRole, Readonly<Record<VoteDecision, string>>>> = {
  student: { agree: '我已閱讀並同意', reject: '不同意並退回修正' },
  advisor: { agree: '以指導老師身分同意', reject: '不同意並退回修正' },
}

export function resultFor(role: VoteRole, decision: VoteDecision): VoteResult {
  if (decision === 'agree') return 'agree'
  return role === 'student' ? 'disagree' : 'return'
}

/** 不同意、退回、重置、重開、作廢的理由上限。 */
export const MAX_REASON_CHARS = 500

/** 理由：去頭尾空白；要理由的動作沒給就拒絕，太長也拒絕。 */
export function normalizeReason(raw: unknown, required: boolean, what: string): { ok: true; reason: string | null } | Err {
  const reason = typeof raw === 'string' ? raw.trim() : ''
  if (reason.length > MAX_REASON_CHARS) {
    return err('VALIDATION_FAILED', `${what}的理由最多 ${MAX_REASON_CHARS} 字。`, { details: { field: 'reason' } })
  }
  if (required && reason === '') return err('VALIDATION_FAILED', `請填寫${what}的理由。`, { details: { field: 'reason' } })
  return { ok: true, reason: reason === '' ? null : reason }
}

/** 登入者在這一版裡是什麼角色；不是參與者回 null。 */
export function roleIn(participants: Participants, userId: string): VoteRole | null {
  if (participants.students.some((s) => s.userId === userId)) return 'student'
  if (participants.advisor.userId === userId) return 'advisor'
  return null
}

/** 一次表態要核對的事實（全部由伺服器在鎖內讀出來）。 */
export type VoteFacts = {
  /** 這一版是不是簽核包目前那一版。 */
  readonly isCurrent: boolean
  readonly state: SignoffState
  readonly cause: string | null
  /** 頁面帶來的內容核對碼等不等於版本的 checksum。 */
  readonly checksumMatches: boolean
  /** 登入者在快照裡的角色；不在快照裡是 null。 */
  readonly role: VoteRole | null
  /** 此刻還是不是這一組的有效組員（學生）或目前的主指導（老師）。 */
  readonly stillEligible: boolean
  /** 這一版已經投過了。 */
  readonly alreadyVoted: boolean
}

/**
 * 能不能收這一票（模組 07 §3 的拒絕欄）。順序有意義：先說版本已失效（舊頁最常見），
 * 再說你不是參與者，再說你投過了，最後才看狀態輪不輪得到你。
 */
export function checkVote(facts: VoteFacts): Err | null {
  if (facts.state === 'superseded' || (!facts.isCurrent && facts.state !== 'void')) {
    const cause = describeCause(facts.cause)
    return err(
      'VERSION_SUPERSEDED',
      `此版本已失效（${cause ?? '已有新版本'}），${facts.isCurrent ? '等待管理員建立新版後再重新閱讀。' : '請重新整理頁面看目前的版本。'}`,
    )
  }
  if (facts.state === 'void') return err('CONFLICT', '此版本已作廢，不能再表態；請等系辦建立新版。')
  if (!facts.checksumMatches) {
    return err('VERSION_SUPERSEDED', '你看到的內容和伺服器上這一版不一致（頁面可能過期），請重新整理頁面、重新閱讀後再表態。')
  }
  if (facts.role === null || !facts.stillEligible) {
    return err('NOT_PARTICIPANT', '你不是這一版簽核的參與者，不能表態；每個人只能替自己同意。')
  }
  if (facts.alreadyVoted) return err('ALREADY_VOTED', '你已經對這一版表態過了；每人一票，不能改票或重投。')
  if (facts.state === 'complete') return err('ALREADY_VOTED', '這一版已經完成簽核。')
  if (facts.state === 'revision') {
    return err('CONFLICT', '這一版已被退回修正，不再收新的表態；請等系辦重開新版。')
  }
  if (facts.role === 'student' && facts.state !== 'collecting') {
    return err('CONFLICT', '學生都已表態完畢，這一版正在等指導老師。')
  }
  if (facts.role === 'advisor' && facts.state === 'collecting') {
    return err('STUDENTS_PENDING', '學生還沒有全部同意，輪到你之前不能表態。')
  }
  return null
}

/**
 * 這一票收下之後版本轉到哪裡；不變回 null。
 * - 學生不同意、老師退回 → revision。
 * - 學生同意且（含這一票）全部學生都同意了 → teacher_pending。
 * - 老師同意 → complete。
 */
export function nextStateAfterVote(
  role: VoteRole,
  result: VoteResult,
  counts: { readonly studentsTotal: number; readonly studentsAgreedIncludingThis: number },
): SignoffState | null {
  if (result !== 'agree') return 'revision'
  if (role === 'advisor') return 'complete'
  return counts.studentsAgreedIncludingThis >= counts.studentsTotal ? 'teacher_pending' : null
}

// ── 進度 ────────────────────────────────────────────────────────────────────

/** 一筆表態（進度與匯出用）。 */
export type VoteRecord = {
  readonly userId: string
  readonly role: VoteRole
  readonly result: VoteResult
  readonly reason: string | null
  readonly realAt: Date
}

export type ParticipantProgress = {
  readonly userId: string
  readonly displayName: string
  readonly studentNo: string | null
  readonly result: VoteResult | null
  readonly reason: string | null
  readonly at: Date | null
}

export type VersionProgress = {
  readonly students: readonly ParticipantProgress[]
  readonly advisor: ParticipantProgress
  /** 已同意的學生數／應同意的學生數（三人組就是 3）。 */
  readonly agreed: number
  readonly total: number
  /** 還沒表態的人（學生；輪到老師或還在收集時也列老師）。 */
  readonly missing: readonly string[]
}

/** 參與者快照＋這一版的表態 → 進度。三個角色的畫面都用這一份，所以看到的數字與缺誰一致（SGN-10）。 */
export function buildProgress(participants: Participants, votes: readonly VoteRecord[], state: SignoffState): VersionProgress {
  const voteOf = (userId: string) => votes.find((v) => v.userId === userId) ?? null
  const students = participants.students.map((s): ParticipantProgress => {
    const v = voteOf(s.userId)
    return { userId: s.userId, displayName: s.displayName, studentNo: s.studentNo, result: v?.result ?? null, reason: v?.reason ?? null, at: v?.realAt ?? null }
  })
  const a = voteOf(participants.advisor.userId)
  const advisor: ParticipantProgress = {
    userId: participants.advisor.userId,
    displayName: participants.advisor.displayName,
    studentNo: null,
    result: a?.result ?? null,
    reason: a?.reason ?? null,
    at: a?.realAt ?? null,
  }
  const pendingStates: readonly SignoffState[] = ['collecting', 'teacher_pending']
  const missing = pendingStates.includes(state)
    ? [...students.filter((s) => s.result === null).map((s) => s.displayName), ...(advisor.result === null ? [`${advisor.displayName}（主指導）`] : [])]
    : []
  return { students, advisor, agreed: students.filter((s) => s.result === 'agree').length, total: students.length, missing }
}

// ── 重置、重開、作廢 ─────────────────────────────────────────────────────────

/**
 * 管理員「以這一版的內容建新版本重新收集」的兩個入口（Roy 2026-09-25：重開＝建新版本）：
 * - 重置：還在收集、等老師、或已完成的版本（已完成的留作歷史完成紀錄，不改狀態）。
 * - 重開：退回修正中、已失效（組員或老師變更）、已作廢的版本。
 * 兩個都要理由、都建新版、都讓參與者依**此刻**的組員與主指導重新快照。
 */
export type RestartKind = 'reset' | 'reopen'

export const RESTART_LABEL: Readonly<Record<RestartKind, string>> = { reset: '重置', reopen: '重開新版' }

export function restartKindFor(state: SignoffState): RestartKind {
  return state === 'collecting' || state === 'teacher_pending' || state === 'complete' ? 'reset' : 'reopen'
}

/** 重置／重開時舊版要不要改成已失效：收集中、等老師、退回的改；已完成、已失效、已作廢的不動（留歷史）。 */
export function supersedesOnRestart(state: SignoffState): boolean {
  return state === 'collecting' || state === 'teacher_pending' || state === 'revision'
}

/**
 * 新版的建版原因（附錄 A `supersede_cause`；CHECK 只有四種，沒有 reopen）：
 * 舊版是因為組員／主指導變更而失效 → 沿用那個原因（這一版是為了它重建的）；其他一律 reset（系辦重置）。
 */
export function causeForRestart(previous: { state: SignoffState; cause: string | null }): SupersedeCause {
  if (previous.state === 'superseded' && (previous.cause === 'member_change' || previous.cause === 'advisor_change')) {
    return previous.cause
  }
  return 'reset'
}

/** 作廢：已作廢的不能再作廢；其他都可以（已完成的作廢等於撤回授權，S11-10 `isValid=false`）。 */
export function checkVoid(state: SignoffState): Err | null {
  return state === 'void' ? err('CONFLICT', '這一版已經作廢了。') : null
}

// ── 提醒 ────────────────────────────────────────────────────────────────────

/** 同一版 24 小時內只能提醒一次（S11-11）。 */
export const REMIND_COOLDOWN_MS = 24 * 60 * 60 * 1000

export function remindable(state: SignoffState): boolean {
  return state === 'collecting' || state === 'teacher_pending'
}

/** 提醒名單：還沒表態的學生＋還沒表態的主指導（含還沒輪到但待簽的老師，S11-11）。 */
export function remindRecipients(progress: VersionProgress): string[] {
  return [
    ...progress.students.filter((s) => s.result === null).map((s) => s.userId),
    ...(progress.advisor.result === null ? [progress.advisor.userId] : []),
  ]
}

/** 下一次可以提醒的時間；現在就可以回 null。 */
export function nextRemindAt(lastRemindedAt: Date | null, now: Date): Date | null {
  if (!lastRemindedAt) return null
  const next = new Date(lastRemindedAt.getTime() + REMIND_COOLDOWN_MS)
  return next.getTime() > now.getTime() ? next : null
}

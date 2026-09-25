import { err, type Err } from '@/shared/result'

/**
 * 簽核版本的純規則（模組實作設計 07 §2、§3「→collecting」、附錄 A；產品模組 07 §4「8.1」「8.3」「參與者版本與失效」；票 25／S11-04）。
 *
 * - 用途只有兩種（8.3 v1 類型）：期中結果確認、最終文件授權。不擴張成任意 workflow。
 * - 參與者＝建版當下**實際有效**的組員（不是固定五人）＋目前主指導，快照進版本、之後不跟著組別變。
 * - 最終文件授權的版本帶**從精選草稿凍結**的授權範圍（題目、摘要、海報、影片連結、用途），列在全文之後讓人讀完再同意；
 *   之後草稿再改也不影響這一版（RR06）。期中結果確認不帶。
 * - 同一組同一用途再建一版，舊的那一版就失效（superseded）；舊同意留歷史、不計入新版。
 */

export type SignoffPurpose = 'final_document' | 'result_confirmation'

export const SIGNOFF_PURPOSES: readonly SignoffPurpose[] = ['result_confirmation', 'final_document']

export const PURPOSE_LABEL: Readonly<Record<SignoffPurpose, string>> = {
  result_confirmation: '期中結果確認',
  final_document: '最終文件授權',
}

export type SignoffState = 'collecting' | 'teacher_pending' | 'complete' | 'revision' | 'superseded' | 'void'

export const STATE_LABEL: Readonly<Record<SignoffState, string>> = {
  collecting: '收集學生同意中',
  teacher_pending: '等待指導老師',
  complete: '已完成',
  revision: '退回修正中',
  superseded: '已失效',
  void: '已作廢',
}

/** 版本是因為什麼而建／因為什麼失效（附錄 A `supersede_cause`、`signoff_version_status.cause`）。 */
export type SupersedeCause = 'member_change' | 'advisor_change' | 'content_change' | 'reset'

export const CAUSE_LABEL: Readonly<Record<SupersedeCause, string>> = {
  member_change: '組員變更',
  advisor_change: '指導老師變更',
  content_change: '內容變更',
  reset: '系辦重置',
}

/** 失效或作廢的原因給人看的樣子：是四種代碼之一就翻成中文，否則是管理員填的理由原文。 */
export function describeCause(cause: string | null): string | null {
  if (cause === null) return null
  return (CAUSE_LABEL as Record<string, string>)[cause] ?? cause
}

/** 版本頁固定標示（產品 07 §4「同意紀錄內容與匯出」：不宣稱校方已核可）。 */
export const ACCEPTANCE_NOTICE = '站內內容確認與同意紀錄，行政採認待確認'

/** 已經不會再收票的狀態（失效、作廢）。 */
export function isTerminal(state: SignoffState): boolean {
  return state === 'superseded' || state === 'void'
}

// ── 參與者快照 ──────────────────────────────────────────────────────────────

export type StudentParticipant = {
  readonly userId: string
  readonly displayName: string
  readonly studentNo: string | null
  readonly membershipId: string
}

export type AdvisorParticipant = {
  readonly userId: string
  readonly displayName: string
  readonly assignmentId: string
}

export type Participants = {
  readonly students: readonly StudentParticipant[]
  readonly advisor: AdvisorParticipant
}

/**
 * 建版當下的有效組員與主指導 → 參與者快照。人數照實際（三人組就三人，產品 Q8、SGN-07）；
 * 沒有組員或沒有主指導不能建版（沒有人能完成簽核）。依學號排序，畫面與匯出順序固定。
 */
export function buildParticipants(
  members: readonly StudentParticipant[],
  advisor: AdvisorParticipant | null,
  groupCode: string,
): { ok: true; value: Participants } | Err {
  if (members.length === 0) return err('VALIDATION_FAILED', `${groupCode} 目前沒有有效組員，不能建立簽核版本。`)
  if (!advisor) {
    return err('VALIDATION_FAILED', `${groupCode} 目前沒有主指導老師；請先到「分組」指派，再建立簽核版本。`)
  }
  const students = [...members].sort((a, b) =>
    (a.studentNo ?? '￿').localeCompare(b.studentNo ?? '￿') || a.displayName.localeCompare(b.displayName, 'zh-Hant'),
  )
  return { ok: true, value: { students, advisor } }
}

/** 從資料庫讀回來的 jsonb → 參與者（形狀不對就當作沒有人，不丟例外）。 */
export function readParticipants(raw: unknown): Participants | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as { students?: unknown; advisor?: unknown }
  if (!Array.isArray(value.students) || typeof value.advisor !== 'object' || value.advisor === null) return null
  return value as Participants
}

/**
 * 顯示前把已去識別化的參與者換成代稱（票 40；產品模組 01 §2.5）。
 *
 * 快照本身不可變、不改寫（契約 01 §1）；只在讀出來給人看的時候換。`pseudonyms` 是
 * 「已去識別化的使用者 ID → 代稱」，不在裡面的人照快照原樣。學號一併拿掉。
 */
export function withPseudonyms(participants: Participants, pseudonyms: ReadonlyMap<string, string>): Participants {
  if (pseudonyms.size === 0) return participants
  const advisorName = pseudonyms.get(participants.advisor.userId)
  return {
    students: participants.students.map((s) => {
      const name = pseudonyms.get(s.userId)
      return name === undefined ? s : { ...s, displayName: name, studentNo: null }
    }),
    advisor: advisorName === undefined ? participants.advisor : { ...participants.advisor, displayName: advisorName },
  }
}

/** 參與者快照裡的全部使用者 ID（查誰已去識別化用）。 */
export function participantUserIds(participants: Participants): string[] {
  return [...participants.students.map((s) => s.userId), participants.advisor.userId].filter((id) => id !== '')
}

// ── 附件 ────────────────────────────────────────────────────────────────────

/** 綁在版本上的附件版本（附錄 A `attachment_file_versions`）。 */
export type AttachmentVersion = {
  readonly fileId: string
  readonly checksum: string
  readonly name: string
  /** 來源：這一組哪一份收件的第幾次正式送出。 */
  readonly source: { readonly itemTitle: string; readonly versionNo: number }
}

export const MAX_ATTACHMENTS = 20

// ── 全文 ────────────────────────────────────────────────────────────────────

/** 全文上限：貼一份同意書綽綽有餘，擋掉誤貼整本報告。 */
export const MAX_CONTENT_CHARS = 100_000

/** 清洗後的 HTML 還有沒有字（全是空段落、空白也算空）。 */
export function hasVisibleText(html: string): boolean {
  return (
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .trim() !== ''
  )
}

// ── 授權範圍 ────────────────────────────────────────────────────────────────

export type ScopeAsset = { readonly fileId: string; readonly checksum: string; readonly kind: 'poster'; readonly name: string }

/**
 * 不可變授權範圍（模組 07 §2 RR06、附錄 A `authorization_scope`）。附錄 A 的欄位之外多存 `summary` 原文——
 * 版本頁要把摘要本身列給參與者讀（只有 checksum 讀不出內容）；比對仍用 `summaryChecksum`。
 */
export type AuthorizationScope = {
  readonly usages: readonly ['public_showcase']
  readonly title: string
  readonly summary: string
  readonly summaryChecksum: string
  readonly assets: readonly ScopeAsset[]
  readonly videoUrl: string | null
  readonly validUntil: null
  readonly scopeSource: { readonly entryId: string; readonly draftRevision: number; readonly contentHash: string }
}

export type DraftSnapshot = {
  readonly entryId: string
  readonly revision: number
  readonly title: string
  readonly summary: string
  readonly summaryChecksum: string
  readonly videoUrl: string | null
  readonly poster: { readonly fileId: string; readonly checksum: string; readonly name: string } | null
}

/**
 * 精選草稿「此刻」的內容 → 凍結的授權範圍。題目與摘要是空的不能凍結（同意一份空白的公開範圍沒有意義）。
 * `contentHash` 由呼叫端（infrastructure）對 `scopeContent(draft)` 算 sha256，這裡不碰雜湊。
 */
export function freezeAuthorizationScope(
  draft: DraftSnapshot,
  contentHash: string,
  groupCode: string,
): { ok: true; value: AuthorizationScope } | Err {
  if (draft.title.trim() === '' || draft.summary.trim() === '') {
    return err('VALIDATION_FAILED', `${groupCode} 的精選草稿還沒有題目或摘要；請先到「精選」補齊再建立最終文件授權。`, {
      details: { field: 'showcaseEntryId' },
    })
  }
  return {
    ok: true,
    value: {
      usages: ['public_showcase'],
      title: draft.title,
      summary: draft.summary,
      summaryChecksum: draft.summaryChecksum,
      assets: draft.poster ? [{ fileId: draft.poster.fileId, checksum: draft.poster.checksum, kind: 'poster', name: draft.poster.name }] : [],
      videoUrl: draft.videoUrl,
      validUntil: null,
      scopeSource: { entryId: draft.entryId, draftRevision: draft.revision, contentHash },
    },
  }
}

/** 算 `contentHash` 的依據：會影響公開內容的欄位（不含草稿版本號與誰改的）。 */
export function scopeContent(draft: DraftSnapshot): Record<string, unknown> {
  return {
    title: draft.title,
    summaryChecksum: draft.summaryChecksum,
    videoUrl: draft.videoUrl,
    poster: draft.poster ? { fileId: draft.poster.fileId, checksum: draft.poster.checksum } : null,
  }
}

export function readAuthorizationScope(raw: unknown): AuthorizationScope | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Partial<AuthorizationScope>
  return typeof value.title === 'string' && Array.isArray(value.assets) ? (value as AuthorizationScope) : null
}

// ── 新版的建版原因 ───────────────────────────────────────────────────────────

/**
 * 同一個簽核包再建一版時，這一版的 `supersede_cause`（附錄 A「建版原因」）：
 * - 沒有上一版：第一版，null。
 * - 上一版已經因為組員／主指導變更或重置而失效：沿用那個原因（這一版就是為了它重建的）。
 * - 其他（上一版還在收集、完成、退回、作廢）：管理員改了內容重發，content_change。
 */
export function causeForNewVersion(previous: { state: SignoffState; cause: string | null } | null): SupersedeCause | null {
  if (!previous) return null
  if (previous.state === 'superseded' && (previous.cause === 'member_change' || previous.cause === 'advisor_change' || previous.cause === 'reset')) {
    return previous.cause
  }
  return 'content_change'
}

import { err, type Err } from '@/shared/result'

/**
 * 管理員調整組員與換組長的型別與純規則（票 14；產品模組 03 §5.2 的 2026-09-24 定案、「組長」、§5.5「換成員」）。
 *
 * 2026-09-24 Roy 定案：沒有「例外組」。特殊情況由管理員直接把學生加入或移出某組（理由必填；
 * 只能選同屆、已核准、未停用、沒有其他有效組別的學生）；人數和設定不符時**提醒但允許**。
 * 移出最後一人要走解散（解散在之後的票，這裡先擋下）；移出組長要同時指定接任。
 * 只換組長不重簽；成員集合改變才重簽（簽核模組還沒做，先發 `group.members_changed` 事件當掛點）。
 *
 * 這個檔沒有資料庫：理由整理、人數提醒、移出與換組長的前置條件都在這裡單獨測。
 */

export const CHANGE_REASON_MAX_LENGTH = 200

/** 管理員動作的理由：必填、去前後空白、有長度上限。`what` 是動作名稱（「加入組員」「作廢」…）。 */
export function normalizeReason(reason: string, what: string): { ok: true; value: string } | Err {
  const trimmed = reason.trim()
  if (!trimmed) return err('VALIDATION_FAILED', `${what}一定要填理由。`, { details: { field: 'reason' } })
  if (trimmed.length > CHANGE_REASON_MAX_LENGTH) {
    return err('VALIDATION_FAILED', `理由最多 ${CHANGE_REASON_MAX_LENGTH} 個字。`, { details: { field: 'reason' } })
  }
  return { ok: true, value: trimmed }
}

/**
 * 組別人數和屆別設定不符時的提醒句；相符回 null。
 * 管理員調整就是處理特殊情況的方式，所以只提醒、不擋（2026-09-24 定案）。
 */
export function groupSizeWarning(count: number, size: { readonly min: number; readonly max: number }): string | null {
  if (count < size.min) return `人數與設定不符：${count} 人，少於本屆每組最少 ${size.min} 人`
  if (count > size.max) return `人數與設定不符：${count} 人，超過本屆每組最多 ${size.max} 人`
  return null
}

export type AddMemberInput = {
  readonly groupId: string
  /** 管理員看到的組別版本（`groups.revision`）；別人先改過就 `CONFLICT`。 */
  readonly revision: number
  readonly studentNo: string
  readonly reason: string
}

export type RemoveMemberInput = {
  readonly groupId: string
  readonly revision: number
  readonly userId: string
  readonly reason: string
  /** 移出的是組長時必填：接任的組長（要是留下來的有效成員）。 */
  readonly successorLeaderUserId: string | null
}

export type ChangeLeaderInput = {
  readonly groupId: string
  readonly revision: number
  readonly newLeaderUserId: string
  readonly reason: string
}

/**
 * 移出的前置條件（產品「組長」：移出組長要同時指定接任；§5.2：移出最後一人走解散）。
 * 回 `leaderChange: true` 表示這次移出要順便換組長。
 */
export function decideRemoval(input: {
  readonly memberIds: readonly string[]
  readonly leaderId: string | null
  readonly targetId: string
  readonly successorId: string | null
}): { ok: true; leaderChange: boolean } | Err {
  const { memberIds, leaderId, targetId, successorId } = input
  if (!memberIds.includes(targetId)) {
    return err('NOT_MEMBER', '這位同學已經不在這個組別裡了，請重新整理頁面。')
  }
  if (memberIds.length === 1) {
    return err('VALIDATION_FAILED', '這是這組最後一位成員：移出最後一人要走「解散」，解散功能之後才會開放，請先保留。')
  }
  if (targetId !== leaderId) {
    if (successorId) return err('VALIDATION_FAILED', '移出的不是組長，不需要指定接任。', { details: { field: 'successorLeaderUserId' } })
    return { ok: true, leaderChange: false }
  }
  if (!successorId) {
    return err('VALIDATION_FAILED', '要移出的是組長：請同時指定接任的組長。', { details: { field: 'successorLeaderUserId' } })
  }
  if (successorId === targetId || !memberIds.includes(successorId)) {
    return err('VALIDATION_FAILED', '接任的組長要是留在這組的其他成員。', { details: { field: 'successorLeaderUserId' } })
  }
  return { ok: true, leaderChange: true }
}

/** 換組長的前置條件：新組長要是這組的有效成員，而且不是現任組長。 */
export function decideLeaderChange(input: {
  readonly memberIds: readonly string[]
  readonly leaderId: string | null
  readonly newLeaderId: string
}): { ok: true } | Err {
  if (!input.memberIds.includes(input.newLeaderId)) {
    return err('VALIDATION_FAILED', '新組長要是這組目前的成員。', { details: { field: 'newLeaderUserId' } })
  }
  if (input.newLeaderId === input.leaderId) {
    return err('VALIDATION_FAILED', '這位同學已經是組長了。', { details: { field: 'newLeaderUserId' } })
  }
  return { ok: true }
}

// ── 回執 ────────────────────────────────────────────────────────────────────

export type MemberChangeReceipt = {
  readonly groupId: string
  readonly groupCode: string
  readonly change: 'added' | 'removed'
  readonly memberName: string
  /** 異動後的人數。 */
  readonly memberCount: number
  /** 人數和屆別設定不符的提醒（允許，只提醒）；相符是 null。 */
  readonly sizeWarning: string | null
  /** 移出組長時接任的新組長；其他情況 null。 */
  readonly newLeaderName: string | null
}

export type LeaderChangeReceipt = {
  readonly groupId: string
  readonly groupCode: string
  readonly previousLeaderName: string | null
  readonly leaderName: string
}

export function describeMemberChangeReceipt(receipt: MemberChangeReceipt): string {
  const head =
    receipt.change === 'added'
      ? `已把 ${receipt.memberName} 加入 ${receipt.groupCode}`
      : `已把 ${receipt.memberName} 移出 ${receipt.groupCode}`
  const leader = receipt.newLeaderName ? `，組長改由 ${receipt.newLeaderName} 接任` : ''
  const warning = receipt.sizeWarning ? `（${receipt.sizeWarning}）` : ''
  return `${head}${leader}；現在 ${receipt.memberCount} 人${warning}。全組已收到通知。`
}

export function describeLeaderChangeReceipt(receipt: LeaderChangeReceipt): string {
  const from = receipt.previousLeaderName ? `從 ${receipt.previousLeaderName} ` : ''
  return `${receipt.groupCode} 的組長已${from}換成 ${receipt.leaderName}，全組已收到通知；成員沒變，不需要重簽。`
}

// ── 停用組長時指定接任（票 42；產品模組 03「組長」、GRP-18） ─────────────────

/**
 * 停用帳號時，這個人目前擔任組長的一組（屆別未封存、組別未解散）。
 * `candidates` 是可以接任的人：這組目前的其他有效成員，而且帳號是 active（停用中的人不能接任）。
 */
export type LeadershipToSucceed = {
  readonly groupId: string
  readonly groupCode: string
  readonly cohortCode: string
  readonly candidates: readonly { readonly userId: string; readonly name: string; readonly studentNo: string | null }[]
}

/** 停用時管理員指定的接任：哪一組、由誰接。 */
export type SuccessorChoice = { readonly groupId: string; readonly userId: string }

/** 停用同交易完成的一次組長接任（回執用）。 */
export type LeaderSuccession = {
  readonly groupId: string
  readonly groupCode: string
  readonly previousLeaderUserId: string
  readonly leaderUserId: string
  readonly leaderName: string
}

/**
 * 停用帳號時的接任規則（產品模組 03「組長」：移出或停用組長時要同時指定接任；GRP-18：否則不能完成操作）。
 *
 * - 不是任何組的組長：不能帶接任（跟移出非組長一樣，避免誤會）。
 * - 是組長：每一組都要恰好指定一位接任，接任要在 `candidates` 裡（這組其他有效成員、帳號 active）。
 * - 這組沒有任何可接任的人：不能停用，要先到分組頁處理（加入組員；移出最後一人走解散）。
 */
export function decideDisableSuccession(input: {
  readonly leaderships: readonly LeadershipToSucceed[]
  readonly choices: readonly SuccessorChoice[]
}): { ok: true; successions: readonly SuccessorChoice[] } | Err {
  const { leaderships, choices } = input
  const field = { details: { field: 'successorLeaderUserId' } }
  if (leaderships.length === 0) {
    if (choices.length > 0) return err('CONFLICT', '這個帳號現在不是組長，不需要指定接任；請關閉對話框、重新整理後再停用。', field)
    return { ok: true, successions: [] }
  }
  const byGroup = new Map<string, SuccessorChoice>()
  for (const choice of choices) {
    if (byGroup.has(choice.groupId)) return err('VALIDATION_FAILED', '同一組只能指定一位接任的組長。', field)
    byGroup.set(choice.groupId, choice)
  }
  if (choices.some((choice) => !leaderships.some((l) => l.groupId === choice.groupId))) {
    return err('CONFLICT', '組長資料剛剛有變動，請關閉對話框、重新整理後再停用。', field)
  }
  for (const leadership of leaderships) {
    if (leadership.candidates.length === 0) {
      return err(
        'VALIDATION_FAILED',
        `這位同學是 ${leadership.groupCode} 的組長，但這組沒有其他可以接任的有效成員。請先到「分組總覽」處理這組（加入組員或解散）再停用。`,
        field,
      )
    }
    const choice = byGroup.get(leadership.groupId)
    if (!choice) {
      return err('VALIDATION_FAILED', `這位同學是 ${leadership.groupCode} 的組長：停用前請同時指定接任的組長。`, field)
    }
    if (!leadership.candidates.some((c) => c.userId === choice.userId)) {
      return err('VALIDATION_FAILED', `接任 ${leadership.groupCode} 組長的人要是這組其他有效成員，而且帳號沒有停用。`, field)
    }
  }
  return { ok: true, successions: leaderships.map((l) => byGroup.get(l.groupId)!) }
}

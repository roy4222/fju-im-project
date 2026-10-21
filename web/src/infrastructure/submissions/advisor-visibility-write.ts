import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { PoolClient } from 'pg'
import type { ResponsePresence } from '@/application/items'
import type { AuditWriter } from '@/application/ops'
import { err, type Err } from '@/shared/result'

/**
 * 「指導老師閱覽」設定的讀與寫（票 22 `setAdvisorVisibility`；C 收尾 CL-13 起表單存檔也走這裡）。
 *
 * 兩條寫入路徑共用：舊的 `SubmissionCommand.setAdvisorVisibility`，和公告／作業表單存檔（`ItemCommand` 的
 * create／saveDraft／updatePublished，同一個交易一起存）。
 *
 * **呼叫前必須已經照鎖序拿好鎖**：屆別 `FOR SHARE` → 項目 `FOR UPDATE`。學生存草稿與送出拿項目的 `FOR SHARE`，
 * 所以「看有沒有人作答」到「插設定」之間不會有人剛好交進來（否則那個人沒看到告知，回答卻開給老師）。
 * 這裡不加鎖、不動 `revision`（表單路徑由 `#writeHead` +1，舊路徑自己 +1）。
 */

export type AdvisorVisibilityState = { readonly enabled: boolean; readonly effectiveFromVersionNo: number | null }

/** 最新一列的開關；沒設過＝不開放。 */
export async function readAdvisorVisibility(tx: PoolClient, itemId: string): Promise<AdvisorVisibilityState> {
  const latest = await tx.query<{ enabled: boolean; effective_from_version_no: number }>(
    `select enabled, effective_from_version_no from advisor_visibility_settings
      where item_id = $1 order by set_at desc, id desc limit 1`,
    [itemId],
  )
  const row = latest.rows[0]
  return row ? { enabled: row.enabled, effectiveFromVersionNo: row.effective_from_version_no } : { enabled: false, effectiveFromVersionNo: null }
}

export type AdvisorVisibilityWrite = {
  readonly itemId: string
  readonly cohortId: string
  readonly enabled: boolean
  /** 目前的欄位版本（還沒發布過是 null＝第 1 版）。 */
  readonly schemaVersionNo: number | null
  readonly userId: string
  readonly realAt: Date
  readonly businessAt: Date
}

/**
 * 只插不改：跟最新一列一樣回 `{ changed: false }`（呼叫端決定要不要當錯）；要開但已經有人作答回 `ITEM_HAS_RESPONSES`。
 * 生效版本＝目前的欄位版本；關閉時沿用上一列的生效版本，只把開關關掉。
 */
export async function writeAdvisorVisibility(
  tx: PoolClient,
  deps: { readonly audit: AuditWriter<PoolClient>; readonly responses: ResponsePresence<PoolClient> },
  input: AdvisorVisibilityWrite,
): Promise<{ readonly ok: true; readonly changed: boolean; readonly effectiveFromVersionNo: number } | Err> {
  const current = await readAdvisorVisibility(tx, input.itemId)
  if (current.enabled === input.enabled) {
    return { ok: true, changed: false, effectiveFromVersionNo: current.effectiveFromVersionNo ?? 1 }
  }
  if (input.enabled && (await deps.responses.hasAnyResponse(tx, input.itemId))) {
    return err(
      'ITEM_HAS_RESPONSES',
      '已經有人作答，不能直接開放指導老師閱覽：那些同學填寫時沒看到「指導老師可查看」的告知，舊回答不能因此給老師看。' +
        '需要老師看的話，請另建一個作業並在發布前開好（改表單版本的功能在後續版本）。',
    )
  }
  const effectiveFromVersionNo = input.enabled ? (input.schemaVersionNo ?? 1) : (current.effectiveFromVersionNo ?? 1)
  await tx.query(
    `insert into advisor_visibility_settings (id, item_id, enabled, effective_from_version_no, set_by_user_id, set_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [uuidv7(), input.itemId, input.enabled, effectiveFromVersionNo, input.userId, input.realAt],
  )
  const previous = current.effectiveFromVersionNo === null ? null : { enabled: current.enabled, effectiveFromVersionNo: current.effectiveFromVersionNo }
  await deps.audit.append(tx, {
    actorKind: 'user',
    actorUserId: input.userId,
    role: 'admin',
    action: input.enabled ? 'submission.advisor_visibility.enable' : 'submission.advisor_visibility.disable',
    targetType: 'item',
    targetId: input.itemId,
    scope: 'cohort',
    cohortId: input.cohortId,
    realAt: input.realAt,
    businessAt: input.businessAt,
    payload: { enabled: input.enabled, effectiveFromVersionNo, previous },
  })
  return { ok: true, changed: true, effectiveFromVersionNo }
}

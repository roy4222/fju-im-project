'use server'
import { currentActor } from '@/app/_ui/guard'
import type { EditorVocabulary } from '@/app/dashboard/admin/affairs/item-form-model'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import type { ItemDetail } from '@/application/items'
import { actorHasRole } from '@/composition/accounts'
import { avatarUrl } from '@/composition/avatar-url'
import { getCohortStatusQuery } from '@/composition/cohorts'
import { getItemQuery } from '@/composition/items'

/**
 * 前台直接編輯（A8）開①的表單時要的脈絡（C 階段規格① §11.3 第 1、2 步）：屆別、表單選項、要編輯的那一筆完整資料。
 *
 * - 只有狀態正常的系辦拿得到（`ItemQuery.get` 是「呼叫端守門」，這裡就是那一道門）。
 * - 有 `itemId`：以 `ItemQuery.get` 載完整 `ItemDetail`（附件、指定組別、繳交欄位都在），表單用 `toInitial(detail)` 當初值、
 *   revision 也取自它——前台標記上的 `FeFields` 只是提示，裝不下陣列，拿它當初值會把附件與組別清掉（AC-6a）。
 *   屆別一律是那一筆自己的屆別。
 * - 沒有 `itemId`（新增）：`cohortId` 沒給就用預設工作屆別（②§6.3.1）。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type FrontEditContext =
  | { ok: true; cohortId: string; options: EditorVocabulary; detail: ItemDetail | null; avatarUrls: readonly string[] }
  | { ok: false; message: string }

export async function frontEditContextAction(input: { cohortId: string | null; itemId?: string | null }): Promise<FrontEditContext> {
  const actor = await currentActor()
  if (actor.kind !== 'authenticated' || actor.status !== 'active' || !actorHasRole(actor, 'admin')) {
    return { ok: false, message: '只有系辦可以在前台編輯；請重新登入。' }
  }
  const itemId = typeof input?.itemId === 'string' && input.itemId !== '' ? input.itemId : null
  if (itemId !== null) {
    if (!UUID.test(itemId)) return { ok: false, message: '找不到這一筆，請重新整理頁面。' }
    const detail = await getItemQuery().get(itemId)
    if (!detail) return { ok: false, message: '這一筆已經不在了（可能剛被刪除），請重新整理頁面。' }
    return { ok: true, cohortId: detail.cohortId, options: await editorVocabulary(detail.cohortId), detail, avatarUrls: publicationAvatarUrls(detail) }
  }
  const wanted = typeof input?.cohortId === 'string' && UUID.test(input.cohortId) ? input.cohortId : null
  // 區塊標了屆別就用它（榮譽可以補登到封存屆別，能不能發由用例判）；沒標就用預設工作屆別。
  const cohorts = await getCohortStatusQuery().list()
  const cohort = cohorts.find((c) => c.id === wanted) ?? cohorts.find((c) => c.isDefaultWorking && c.status !== 'archived') ?? null
  if (!cohort) return { ok: false, message: '還沒有可以發布的屆別；先到後台「屆別」設定工作屆別。' }
  return { ok: true, cohortId: cohort.id, options: await editorVocabulary(cohort.id), detail: null, avatarUrls: [] }
}

/** 發布紀錄操作者的頭像網址（`toInitial` 的第三個參數；表單不在 client 算頭像，見 `item-form-model.ts` 的 `PublicationLog`）。 */
function publicationAvatarUrls(detail: ItemDetail): string[] {
  return detail.publications.map((p) =>
    avatarUrl({ id: p.actorUserId, name: p.actorName, avatarPreset: p.actorAvatarPreset, avatarFileId: p.actorAvatarFileId }),
  )
}

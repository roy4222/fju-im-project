'use server'
import { currentActor } from '@/app/_ui/guard'
import type { NormalizedOpportunity, OpportunityField, OpportunityStatus } from '@/application/groups'
import { actorHasRole } from '@/composition/accounts'
import { describeOpportunityReceipt, getGroupQuery, getOpportunityCommand, getOpportunityQuery, OPPORTUNITY_FIELD_LABEL, OPPORTUNITY_LIMITS } from '@/composition/groups'

/**
 * 前台直接編輯「合作案」的 Server Function（C3-10；規格③ §8、§14.4；②§6.3.1 `FeFormModule`）。
 *
 * 延遲表單 `./opportunity.tsx` 不直接 import 這個檔（會把 Server Function 的客戶端接線拆進共用 chunk，全站變大），
 * 由 `_ui/front-edit/forms.ts` 的登錄行在載入模組時用 `provideOpportunityFeActions` 交進去。
 *
 * - `opportunityFeContextAction`：開窗要的脈絡——欄位名稱與上限、系辦新增時的負責老師選項；編輯時再帶那一案的
 *   原始欄位與目前 revision（前台卡片的 `data-fe-fields` 只有公司名稱、也沒帶 `data-fe-rev`，不能當初值）。
 * - `saveOpportunityFeAction`：新增（系辦要選負責老師）或編輯，走既有用例；**不 `refresh()`**，刷新是框架的事（§14.4）。
 * - `removeOpportunityFeAction`：既有刪除用例；不能刪（發布中、連著組別）回 `{ ok:false, message }` 由框架顯示。
 *   前台標記沒帶 revision 時先讀目前的 revision 再刪（用例要整數 revision 做樂觀鎖）。
 *
 * 只有狀態正常的系辦拿得到（前台編輯模式本來就只開給系辦，§6.1）；誰能做什麼仍由用例再判一次。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type OpportunityFeTeacher = { readonly userId: string; readonly name: string; readonly loginEmail: string }

type OpportunityFeContext =
  | {
      ok: true
      labels: { fields: Record<OpportunityField, string>; limits: Record<OpportunityField, number> }
      /** 系辦新增時的負責老師選項（帳號正常、目前是老師）。 */
      teachers: readonly OpportunityFeTeacher[]
      /** 編輯時那一案目前的內容；新增是 null。 */
      current: { revision: number; status: OpportunityStatus; values: NormalizedOpportunity; name: string } | null
    }
  | { ok: false; message: string }

type OpportunityFeSaveResult =
  | { ok: true; id: string; status: OpportunityStatus; message: string }
  | { ok: false; message: string; field?: string }

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '')
const whole = (formData: FormData, name: string) => {
  const raw = text(formData, name).trim()
  return raw === '' ? Number.NaN : Number(raw)
}

function fields(formData: FormData) {
  return {
    companyName: text(formData, 'companyName'),
    department: text(formData, 'department'),
    content: text(formData, 'content'),
    requirements: text(formData, 'requirements'),
    notes: text(formData, 'notes'),
    notesVisibility: text(formData, 'notesVisibility'),
    address: text(formData, 'address'),
    contactName: text(formData, 'contactName'),
    contactPhone: text(formData, 'contactPhone'),
    contactEmail: text(formData, 'contactEmail'),
  }
}

async function officeActor() {
  const actor = await currentActor()
  if (actor.kind !== 'authenticated' || actor.status !== 'active' || !actorHasRole(actor, 'admin')) return null
  return actor
}

export async function opportunityFeContextAction(input: { id: string | null }): Promise<OpportunityFeContext> {
  const actor = await officeActor()
  if (!actor) return { ok: false, message: '只有系辦可以在前台編輯；請重新登入。' }
  const labels = { fields: OPPORTUNITY_FIELD_LABEL, limits: OPPORTUNITY_LIMITS }
  const id = typeof input?.id === 'string' && input.id !== '' ? input.id : null
  if (id === null) {
    const teachers = (await getGroupQuery().teacherOptions()).map((t) => ({ userId: t.userId, name: t.name, loginEmail: t.loginEmail }))
    return { ok: true, labels, teachers, current: null }
  }
  if (!UUID.test(id)) return { ok: false, message: '找不到這個合作案，請重新整理頁面。' }
  const managed = (await getOpportunityQuery().manageList(actor)).find((o) => o.id === id)
  if (!managed) return { ok: false, message: '這個合作案已經不在了（可能剛被刪除），請重新整理頁面。' }
  return {
    ok: true,
    labels,
    teachers: [],
    current: { revision: managed.revision, status: managed.status, values: managed.fields, name: `${managed.fields.companyName}・${managed.fields.department}` },
  }
}

export async function saveOpportunityFeAction(formData: FormData): Promise<OpportunityFeSaveResult> {
  const actor = await officeActor()
  if (!actor) return { ok: false, message: '只有系辦可以在前台編輯；請重新登入。' }
  const command = getOpportunityCommand()
  const opportunityId = text(formData, 'opportunityId')
  const result = opportunityId
    ? await command.update(actor, { ...fields(formData), opportunityId, revision: whole(formData, 'revision') }, text(formData, 'requestId'))
    : await command.create(
        actor,
        { ...fields(formData), publish: text(formData, 'publish') === 'true', ownerTeacherUserId: text(formData, 'ownerTeacherUserId') },
        text(formData, 'requestId'),
      )
  if (!result.ok) {
    const field = typeof result.details?.field === 'string' ? result.details.field : undefined
    return { ok: false, message: result.message, field }
  }
  return { ok: true, id: result.receipt.opportunityId, status: result.receipt.status, message: describeOpportunityReceipt(result.receipt) }
}

export async function removeOpportunityFeAction(input: {
  id: string
  revision: number | null
  requestId: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const actor = await officeActor()
  if (!actor) return { ok: false, message: '只有系辦可以在前台編輯；請重新登入。' }
  const id = String(input?.id ?? '')
  if (!UUID.test(id)) return { ok: false, message: '找不到這個合作案，請重新整理頁面。' }
  let revision = input.revision
  if (revision === null || !Number.isInteger(revision)) {
    // 前台卡片沒帶 `data-fe-rev`：以目前的版本刪，被別人同時改到會由用例回 CONFLICT。
    const managed = (await getOpportunityQuery().manageList(actor)).find((o) => o.id === id)
    if (!managed) return { ok: false, message: '這個合作案已經不在了（可能剛被刪除），請重新整理頁面。' }
    revision = managed.revision
  }
  const result = await getOpportunityCommand().delete(actor, { opportunityId: id, revision }, String(input.requestId ?? ''))
  return result.ok ? { ok: true } : { ok: false, message: result.message }
}

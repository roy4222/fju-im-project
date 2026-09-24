'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { IndustryActionState } from '@/app/dashboard/_industry/opportunity-forms'
import { describeLinkReceipt, describeOpportunityReceipt, getOpportunityCommand } from '@/composition/groups'

/**
 * 合作案管理的動作（票 20；老師「我的合作案」與系辦「合作案」共用）：建立、編輯、發布、下架、重新發布、解除連結。
 *
 * 這裡只做「表單 → 用例 → 畫面回饋」的翻譯；誰能做、欄位對不對、版本有沒有被別人改過，全部在用例裡判
 * （直接打這個 Server Action 的人一樣會被擋）。請求編號由頁面在伺服器端產生、放在隱藏欄位。
 */

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

function failed(result: { message: string; details?: Record<string, unknown> }): IndustryActionState {
  const field = typeof result.details?.field === 'string' ? result.details.field : undefined
  return { ok: false, message: result.message, field }
}

export async function saveOpportunityAction(_state: IndustryActionState, formData: FormData): Promise<IndustryActionState> {
  const command = getOpportunityCommand()
  const actor = await currentActor()
  const opportunityId = text(formData, 'opportunityId')
  const result = opportunityId
    ? await command.update(actor, { ...fields(formData), opportunityId, revision: whole(formData, 'revision') }, text(formData, 'requestId'))
    : await command.create(actor, { ...fields(formData), publish: text(formData, 'publish') === 'true' }, text(formData, 'requestId'))
  if (!result.ok) return failed(result)
  refresh()
  return { ok: true, message: describeOpportunityReceipt(result.receipt) }
}

export async function changeOpportunityStatusAction(
  _state: IndustryActionState,
  formData: FormData,
): Promise<IndustryActionState> {
  const command = getOpportunityCommand()
  const input = { opportunityId: text(formData, 'opportunityId'), revision: whole(formData, 'revision') }
  const kind = text(formData, 'kind')
  if (kind !== 'publish' && kind !== 'withdraw') return { ok: false, message: '不認得這個動作，請重新整理頁面。' }
  const actor = await currentActor()
  const result =
    kind === 'publish'
      ? await command.publish(actor, input, text(formData, 'requestId'))
      : await command.withdraw(actor, input, text(formData, 'requestId'))
  if (!result.ok) return failed(result)
  refresh()
  return { ok: true, message: describeOpportunityReceipt(result.receipt) }
}

export async function unlinkOpportunityAction(_state: IndustryActionState, formData: FormData): Promise<IndustryActionState> {
  const result = await getOpportunityCommand().unlink(
    await currentActor(),
    { linkId: text(formData, 'linkId'), reason: text(formData, 'reason') },
    text(formData, 'requestId'),
  )
  if (!result.ok) return failed(result)
  refresh()
  return { ok: true, message: describeLinkReceipt(result.receipt) }
}

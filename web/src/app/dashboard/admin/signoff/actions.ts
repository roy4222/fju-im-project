'use server'
import { refresh } from 'next/cache'
import { redirect } from 'next/navigation'
import { currentActor } from '@/app/_ui/guard'
import type { SignoffActionState } from '@/app/dashboard/admin/signoff/signoff-forms'
import {
  describeCreateVersionReceipt,
  describeRemindReceipt,
  describeVoidReceipt,
  getSignoffCommand,
} from '@/composition/signoff'

/**
 * 管理員「簽核」頁的動作（票 25：建立簽核版本；票 26：重置、重開、作廢、提醒未同意者）。
 * 規則全在用例裡判（全文必填、附件屬本組、用途與精選草稿、參與者快照、舊版失效、理由必填、24 小時提醒一次、帳本冪等）；
 * 這裡只把表單收斂成用例要的形狀、把結果翻成一句話。**沒有任何一個動作能替別人表態。**
 */

const text = (formData: FormData, name: string, max = 200) => String(formData.get(name) ?? '').slice(0, max)

export async function createVersionAction(_state: SignoffActionState, formData: FormData): Promise<SignoffActionState> {
  const purpose = text(formData, 'purpose', 40) === 'final_document' ? 'final_document' : 'result_confirmation'
  const entryId = text(formData, 'showcaseEntryId', 100)
  const result = await getSignoffCommand().createVersion(
    await currentActor(),
    {
      groupId: text(formData, 'groupId', 100),
      purpose,
      // 上限由用例判（說得出是多少）；這裡只擋掉離譜的大小。
      content: text(formData, 'content', 200_000),
      attachmentFileIds: formData.getAll('attachmentFileIds').map(String).slice(0, 50),
      // 照送來的樣子交給用例判（期中卻帶了精選草稿 → 用例拒絕），不在這裡默默丟掉。
      showcaseEntryId: entryId !== '' ? entryId : null,
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeCreateVersionReceipt(result.receipt), versionId: result.receipt.versionId }
}

function reasoned(formData: FormData) {
  return { versionId: text(formData, 'versionId', 100), reason: text(formData, 'reason', 5_000) }
}

/** 重置或重開（表單 `kind` 決定；用例再依版本狀態判該用哪一個，不符就拒絕）。 */
export async function restartAction(_state: SignoffActionState, formData: FormData): Promise<SignoffActionState> {
  const command = getSignoffCommand()
  const actor = await currentActor()
  const input = reasoned(formData)
  const requestId = text(formData, 'requestId')
  const result =
    text(formData, 'kind', 20) === 'reopen' ? await command.reopen(actor, input, requestId) : await command.reset(actor, input, requestId)
  if (!result.ok) return { ok: false, message: result.message }
  // 舊版已經不是目前版本（這一頁不再有管理按鈕），直接帶到新版，那一頁上方顯示回執。
  redirect(`/dashboard/admin/signoff/${result.receipt.versionId}?restarted=${result.receipt.kind}&from=${result.receipt.fromVersionNo}`)
}

export async function voidAction(_state: SignoffActionState, formData: FormData): Promise<SignoffActionState> {
  const result = await getSignoffCommand().voidVersion(await currentActor(), reasoned(formData), text(formData, 'requestId'))
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeVoidReceipt(result.receipt) }
}

export async function remindAction(_state: SignoffActionState, formData: FormData): Promise<SignoffActionState> {
  const result = await getSignoffCommand().remind(
    await currentActor(),
    { versionId: text(formData, 'versionId', 100) },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeRemindReceipt(result.receipt) }
}

'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { SignoffActionState } from '@/app/dashboard/admin/signoff/signoff-forms'
import { describeCreateVersionReceipt, getSignoffCommand } from '@/composition/signoff'

/**
 * 管理員「簽核」頁的動作（票 25）：建立簽核版本。
 * 規則全在用例裡判（全文必填、附件屬本組、用途與精選草稿、參與者快照、舊版失效、帳本冪等）；
 * 這裡只把表單收斂成用例要的形狀、把結果翻成一句話。
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

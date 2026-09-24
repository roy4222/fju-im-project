'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { AdminGroupActionState } from '@/app/dashboard/admin/groups/admin-group-forms'
import { describeGroupingSettingsReceipt, getCohortCommand } from '@/composition/cohorts'
import { describeTerminateReceipt, getGroupCommand } from '@/composition/groups'

/**
 * 管理員「分組總覽」的動作（票 13）：分組設定（每組人數、提案預設天數）、作廢提案。
 * 規則全在用例裡判；這裡只翻譯表單與回饋。
 */

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '')
const whole = (formData: FormData, name: string) => {
  const raw = text(formData, name).trim()
  return raw === '' ? Number.NaN : Number(raw)
}

export async function saveGroupingSettingsAction(
  _state: AdminGroupActionState,
  formData: FormData,
): Promise<AdminGroupActionState> {
  const result = await getCohortCommand().setGroupingSettings(
    await currentActor(),
    text(formData, 'cohortId'),
    {
      groupSizeMin: whole(formData, 'groupSizeMin'),
      groupSizeMax: whole(formData, 'groupSizeMax'),
      proposalDefaultDays: whole(formData, 'proposalDefaultDays'),
    },
    Number(text(formData, 'revision')),
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeGroupingSettingsReceipt(result.receipt) }
}

export async function voidProposalAction(
  _state: AdminGroupActionState,
  formData: FormData,
): Promise<AdminGroupActionState> {
  const result = await getGroupCommand().voidProposal(
    await currentActor(),
    text(formData, 'proposalId'),
    text(formData, 'reason'),
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeTerminateReceipt(result.receipt) }
}

'use server'
import { headers } from 'next/headers'
import type { ProfileEditReceipt, ProfileEditView } from '@/application/accounts'
import { getProfileEditCommand, resolveActor } from '@/composition/accounts'
import type { Result } from '@/shared/result'

/**
 * 帳號列「編輯」的兩個 Server Action（C2-08；設計方案 §3.2、§3.8、§3.9）。
 *
 * 授權、前置條件、學號占用都在用例裡再判一次（只有狀態正常的管理員），直接呼叫這裡繞不過去。
 * 管理員勾跟個資一起送、同一個交易（Review 第 1 輪第 3 項）：任何一步失敗全部回滾。
 * 不在這裡 revalidate：視窗先顯示結果，關掉後才由畫面自己刷新列表（同其他帳號對話框）。
 */

type ActionOutcome<T> = { ok: true; data: T } | { ok: false; code: string; message: string; field?: string }

function toOutcome<T>(result: Result<T>): ActionOutcome<T> {
  if (!result.ok) {
    const field = typeof result.details?.field === 'string' ? result.details.field : undefined
    return { ok: false, code: result.code, message: result.message, ...(field ? { field } : {}) }
  }
  return { ok: true, data: result.receipt }
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

/** 開視窗時讀：目前欄位、屆別選項、各種不能存的原因。 */
export async function profileEditViewAction(input: { userId: string }): Promise<ActionOutcome<ProfileEditView>> {
  const userId = text(input?.userId, 100) ?? ''
  const actor = await resolveActor(await headers())
  return toOutcome(await getProfileEditCommand().view(actor, userId))
}

export async function editAccountAction(input: {
  userId: string
  name: string
  role: string | null
  studentNo: string
  cohortId: string
  requestId: string
  admin?: boolean
}): Promise<ActionOutcome<ProfileEditReceipt>> {
  const userId = text(input?.userId, 100)
  const name = text(input?.name, 500)
  const role = input?.role === null ? null : text(input?.role, 20)
  const studentNo = text(input?.studentNo ?? '', 100)
  const cohortId = text(input?.cohortId ?? '', 100)
  const requestId = text(input?.requestId, 100)
  if (userId === null || name === null || (role === null && input?.role !== null) || studentNo === null || cohortId === null || requestId === null) {
    return { ok: false, code: 'VALIDATION_FAILED', message: '欄位格式不對，請重新打開視窗再試。' }
  }
  const actor = await resolveActor(await headers())
  return toOutcome(
    await getProfileEditCommand().edit(actor, {
      userId,
      name,
      role,
      studentNo,
      cohortId,
      requestId,
      ...(typeof input?.admin === 'boolean' ? { admin: input.admin } : {}),
    }),
  )
}

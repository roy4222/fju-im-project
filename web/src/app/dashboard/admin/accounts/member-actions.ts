'use server'
import { headers } from 'next/headers'
import type { MemberReceipt } from '@/application/accounts'
import { getAccountCommand, resolveActor } from '@/composition/accounts'

/**
 * 「新增成員」的 Server Action（C2-09；設計方案 §3.7）：老師、管理員、學生三選一。
 *
 * 三種都不問核實方式、不發臨時密碼：系辦親手加的人直接開通，並寄一封「請設定密碼」信（Q-C2-9）。
 * 授權、欄位規則、學號占用、冪等（建帳號、授權管理員、寄信共用一個請求編號與一把帳本）
 * 都在用例 `createMember` 裡；直接呼叫這裡繞不過去。
 */

type ActionOutcome<T> = { ok: true; data: T } | { ok: false; code: string; message: string; field?: string }

export type MemberCreation = MemberReceipt

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

export async function createMemberAction(input: {
  kind: string
  name: string
  email: string
  studentNo: string
  cohortId: string
  requestId: string
}): Promise<ActionOutcome<MemberCreation>> {
  const kind = text(input?.kind, 20)
  const name = text(input?.name, 500)
  const email = text(input?.email, 500)
  const studentNo = text(input?.studentNo ?? '', 100)
  const cohortId = text(input?.cohortId ?? '', 100)
  const requestId = text(input?.requestId, 100) ?? ''
  if (kind === null || name === null || email === null || studentNo === null || cohortId === null) {
    return { ok: false, code: 'VALIDATION_FAILED', message: '欄位內容不正確，請檢查後再送出。' }
  }

  const incoming = await headers()
  const actor = await resolveActor(incoming)
  const result = await getAccountCommand().createMember(actor, new Headers(incoming), {
    kind,
    name,
    email,
    studentNo,
    cohortId,
    requestId,
  })
  if (!result.ok) {
    const field = typeof result.details?.field === 'string' ? result.details.field : undefined
    return { ok: false, code: result.code, message: result.message, ...(field ? { field } : {}) }
  }
  return { ok: true, data: result.receipt }
}

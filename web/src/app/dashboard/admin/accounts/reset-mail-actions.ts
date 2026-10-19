'use server'
import { headers } from 'next/headers'
import { getAccountDirectoryCommand, resolveActor } from '@/composition/accounts'

/**
 * 帳號列「寄重設密碼信」的 Server Action（C2-11；A15）。
 *
 * 授權、有沒有帳密、帳號是否停用都在用例裡判（`sendResetMail`，只有狀態正常的管理員），
 * 直接呼叫這裡繞不過去。寄信走內部入口，不經訪客忘記密碼那道人機驗證與限流。
 * 信裡的連結不會回到畫面，也不進稽核。
 */

export type ResetMailOutcome =
  | { ok: true; data: { email: string; validMinutes: number } }
  | { ok: false; code: string; message: string }

export async function sendResetMailAction(input: { userId: string }): Promise<ResetMailOutcome> {
  const userId = typeof input?.userId === 'string' && input.userId.length <= 100 ? input.userId : ''
  const incoming = await headers()
  const actor = await resolveActor(incoming)
  const result = await getAccountDirectoryCommand().sendResetMail(actor, { userId }, { headers: new Headers(incoming) })
  if (!result.ok) return { ok: false, code: result.code, message: result.message }
  return { ok: true, data: { email: result.receipt.email, validMinutes: result.receipt.validMinutes } }
}

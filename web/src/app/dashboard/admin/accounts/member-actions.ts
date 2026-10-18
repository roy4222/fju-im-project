'use server'
import { createHash } from 'node:crypto'
import { headers } from 'next/headers'
import { getAccountCommand, normalizeNewMember, resolveActor } from '@/composition/accounts'
import { isSecretOnce, type Result } from '@/shared/result'

/**
 * 「新增成員」的 Server Action（C2-09；設計方案 §3.7）：老師、管理員、學生三選一。
 *
 * 三種都不問核實方式、不發臨時密碼：系辦親手加的人直接開通，並寄一封「請設定密碼」信（Q-C2-9）。
 * 授權、欄位規則、學號占用都在用例裡再判一次（只有狀態正常的管理員），直接呼叫這裡繞不過去。
 * 管理員＝先建老師帳號、再設為管理員（第二步用由同一個請求編號推出來的編號，重送不會重複授予）。
 */

type ActionOutcome<T> = { ok: true; data: T } | { ok: false; code: string; message: string; field?: string }

export type MemberCreation = {
  readonly kind: 'student' | 'teacher' | 'admin'
  readonly userId: string
  readonly name: string
  readonly email: string
  /** 「請設定密碼」信有沒有交給寄信那一層；`null`＝重送同一個請求，不知道上次的結果。 */
  readonly setupMailRequested: boolean | null
  /** 帳號已建好、但後面某一步沒完成時，要告訴系辦的那句話（例如還沒設成管理員）。 */
  readonly notice: string | null
}

function failure(result: Extract<Result<unknown>, { ok: false }>): Extract<ActionOutcome<never>, { ok: false }> {
  const field = typeof result.details?.field === 'string' ? result.details.field : undefined
  return { ok: false, code: result.code, message: result.message, ...(field ? { field } : {}) }
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

/** 由同一個請求編號推出另一個固定的 UUID 形狀編號（第二步的請求編號）。 */
function derivedRequestId(requestId: string, purpose: string): string {
  const h = createHash('sha256').update(`${requestId}:${purpose}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const MAIL_NOTICE = '帳號已建好，但「請設定密碼」信沒有寄出。請到列上按「發臨時密碼」，把臨時密碼交給他。'

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
  // 先在這裡驗一次欄位，管理員那條路才不會「帳號建了、才發現學號格式不對」（學號與屆別老師不用）。
  const normalized = normalizeNewMember({ kind, name, email, studentNo, cohortId })
  if (!normalized.ok) return failure(normalized)
  const member = normalized.value

  const incoming = await headers()
  const actor = await resolveActor(incoming)
  const command = getAccountCommand()
  const authHeaders = new Headers(incoming)

  if (member.kind === 'student') {
    const result = await command.createStudent(actor, authHeaders, {
      name: member.name,
      email: member.email,
      studentNo: member.studentNo,
      cohortId: member.cohortId,
      requestId,
    })
    if (!result.ok) return failure(result)
    const mailRequested = result.receipt.setupMailRequested
    return {
      ok: true,
      data: {
        kind: 'student',
        userId: result.receipt.userId,
        name: result.receipt.name,
        email: result.receipt.email,
        setupMailRequested: mailRequested,
        notice: mailRequested === false ? MAIL_NOTICE : null,
      },
    }
  }

  // 老師、管理員：只用 Email 預先建立（不發密碼），之後本人用信裡的連結設定密碼，或用 Google 登入。
  const created = await command.createTeacher(actor, authHeaders, {
    mode: 'preauthorize',
    email: member.email,
    name: member.name,
    verificationMethod: '',
    verificationNote: '',
    requestId,
  })
  if (isSecretOnce(created)) return { ok: false, code: 'INTERNAL', message: '新增失敗，請稍後再試。' }
  if (!created.ok) return failure(created)
  const account = created.receipt

  let notice: string | null = null
  if (member.kind === 'admin') {
    const granted = await command.grantRole(actor, {
      userId: account.userId,
      role: 'admin',
      reason: '新增成員',
      requestId: derivedRequestId(requestId, 'grant-admin'),
    })
    if (!granted.ok) notice = `帳號已建好，但還沒設成管理員（${granted.message}）。請到列上按「設為管理員」。`
  }

  const mail = await command.sendSetupMail(actor, authHeaders, { userId: account.userId })
  const setupMailRequested = mail.ok ? mail.receipt.requested : false
  if (!setupMailRequested && !notice) notice = MAIL_NOTICE
  return {
    ok: true,
    data: {
      kind: member.kind,
      userId: account.userId,
      name: account.name ?? member.name,
      email: account.email,
      setupMailRequested,
      notice,
    },
  }
}

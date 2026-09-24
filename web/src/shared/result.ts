/**
 * 契約 02 §1 的 Result 型別。
 *
 * 所有 application 用例都回 `Result<R>`：成功一定帶 receipt（含 requestId 與 serverTime），
 * 失敗一定帶錯誤碼與下一步。不要在用例裡 throw 給 UI 看。
 */
import { defaultNextStep, type ErrorCode, type NextStep } from '@/shared/errors'

export type Receipt<R> = R & { requestId: string; serverTime: string }

export type Ok<R> = { ok: true; receipt: Receipt<R> }

export type Err = {
  ok: false
  code: ErrorCode
  message: string
  next?: NextStep
  details?: Record<string, unknown>
}

export type Result<R> = Ok<R> | Err

/**
 * 一次性秘密（母 spec §4.12、契約 02 §1）。刻意不是 Result：
 * 秘密只活在這個型別裡，不進帳本、audit 或 log。
 *
 * `expiresAt`：契約寫的是 string，但 Better Auth 的密碼沒有到期機制，要做到期得加欄位
 * （migration），票 8 不能加；所以目前一律 `null`＝「用到本人改掉為止」——本人登入後
 * 一定被逼著改密碼，改完這組就失效。
 */
export type SecretOnce = {
  ok: true
  secret: string
  issuedAt: string
  expiresAt: string | null
  receipt: { requestId: string; kind: 'temp_password'; issuedBy: string }
}

/** 這個回應是不是一次性秘密（跟 Result 分開判斷）。 */
export function isSecretOnce(value: unknown): value is SecretOnce {
  return typeof value === 'object' && value !== null && typeof (value as { secret?: unknown }).secret === 'string'
}

export function ok<R>(payload: R, meta: { requestId: string; serverTime: string }): Ok<R> {
  return { ok: true, receipt: { ...payload, requestId: meta.requestId, serverTime: meta.serverTime } }
}

export function err(
  code: ErrorCode,
  message: string,
  options?: { next?: NextStep; details?: Record<string, unknown> },
): Err {
  return {
    ok: false,
    code,
    message,
    next: options?.next ?? defaultNextStep(code),
    ...(options?.details ? { details: options.details } : {}),
  }
}

export function isOk<R>(result: Result<R>): result is Ok<R> {
  return result.ok
}

export function isErr<R>(result: Result<R>): result is Err {
  return !result.ok
}

/** 只在確定是 Ok 時取值；拿錯會 throw，給測試與組裝層用，不給 UI 用。 */
export function unwrap<R>(result: Result<R>): Receipt<R> {
  if (!result.ok) {
    throw new Error(`unwrap() 收到失敗結果：${result.code} ${result.message}`)
  }
  return result.receipt
}

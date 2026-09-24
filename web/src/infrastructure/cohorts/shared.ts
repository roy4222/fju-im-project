import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import { canManageCohorts } from '@/application/cohorts'
import { err, type Err, type Receipt, type Result } from '@/shared/result'

/**
 * 模組 02 各個寫入用例共用的外殼（票 5 起；票 11 從 pg-cohorts 抽出來給階段、活動、模擬鐘共用）。
 *
 * 每個寫入都是同一個形狀（契約 01 §8）：
 * 開交易 → 帳本 `begin`（同一個請求編號重送只做一次）→ 業務寫入 → 稽核／事件／到期工作 → 帳本 `commit` → COMMIT。
 * 用例回 `Err` 時整個交易回滾，帳本不會留下「失敗」的那一筆，同一個編號修正後還能再送。
 */

export type PoolSource = () => Pick<Pool, 'connect'>

/** 先過帳號狀態閘門（停用、待審、必須改密），再看角色（契約 03 §1：授權在用例層）。 */
export function authorizeAdmin(actor: ResolvedActor, what = '管理屆別'): Err | null {
  const blocked = statusGate(actor, 'business')
  if (blocked) return err(blocked, '請先登入並完成帳號設定。')
  if (!canManageCohorts(actor)) return err('FORBIDDEN', `只有系辦管理員可以${what}。`)
  return null
}

export function actorUserId(actor: ResolvedActor): string {
  return actor.kind === 'authenticated' ? actor.userId : ''
}

export function badRequestId(): Err {
  return err('VALIDATION_FAILED', '這次送出缺少請求編號，請重新整理頁面再試。')
}

export function cohortNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
}

export function staleRevision(): Err {
  return err('CONFLICT', '剛剛有人改過這份資料，請重新整理頁面看最新的內容再改。')
}

/** 同一個請求編號第二次送達：回第一次的回執，不再做一次（契約 01 §8）。 */
export function replayed<R>(
  begun: { outcome: 'replay'; receipt: unknown; receiptExpired: boolean } | { outcome: 'mismatch' },
): Result<R> {
  if (begun.outcome === 'mismatch') {
    return err('REQUEST_MISMATCH', '這個請求編號已經用在別的內容上，請重新整理頁面再送一次。')
  }
  if (begun.receiptExpired) return err('RECEIPT_EXPIRED', '這個動作之前已經處理過了。')
  return { ok: true, receipt: begun.receipt as Receipt<R> }
}

/**
 * 成功才 COMMIT；回 `Err` 或丟例外都 ROLLBACK，帳本、稽核、事件、到期工作一起消失。
 *
 * `onUniqueViolation`：唯一鍵被同時送出的另一筆搶先時，要回給使用者的那句話（依撞到哪條約束）。
 */
export async function inTransaction<R>(
  pool: PoolSource,
  label: string,
  body: (tx: PoolClient) => Promise<Result<R>>,
  onUniqueViolation: (constraint: string | undefined) => Err = () =>
    err('CONFLICT', '剛剛有人同時修改了同一份資料，請重新整理頁面再試一次。'),
): Promise<Result<R>> {
  const client = await pool().connect()
  try {
    await client.query('begin')
    const result = await body(client)
    await client.query(result.ok ? 'commit' : 'rollback')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    const pgError = error as { code?: string; constraint?: string }
    if (pgError?.code === '23505') return onUniqueViolation(pgError.constraint)
    console.error(`[${label}] 寫入失敗`, error)
    return err('INTERNAL', '系統暫時無法處理，請稍後再試。')
  } finally {
    client.release()
  }
}

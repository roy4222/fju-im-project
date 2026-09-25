import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import type { RevocationOutcome } from '@/application/accounts'
import { RealClock, type Clock } from '@/shared/time'
import { internalAuth } from '@/infrastructure/auth/wrapper'

/**
 * 撤 session 的工作列與執行器（工程模組 01 附錄 A `session_revocations` 規則 1–4；票 9）。
 *
 * 停用／恢復的用例在**業務交易內**呼叫 `enqueue`（規則 1），commit 之後呼叫 `runForUser`
 * （規則 2–4）：認領最新一筆排隊工作 → 交易外呼叫 Better Auth → 用租約守住的短交易寫結果。
 *
 * **這裡不做規則 5 的收斂核對**（完成後核對、每 5 分鐘週期核對、round 上限與告警）——
 * 那需要背景 worker，由票 12 承接。失敗的列留著 `failed`／`outcome_unknown`，收斂工作之後會找到。
 *
 * 失敗不影響停用本身：入口層與 ActorResolver 每次都重讀 `users.status`（規則 6），
 * Better Auth 的 banned 只是第二層。
 */

/** 認領後幾秒內要完成，否則別人可以接手（附錄 A）。 */
const LEASE_SECONDS = 30
/** 單次外部呼叫的逾時（附錄 A 規則 3）。 */
const CALL_TIMEOUT_MS = 10_000
/** 一次 `runForUser` 最多處理幾筆（前一筆完成後又有新的排隊工作時接著做；防無窮迴圈）。 */
const MAX_ROUNDS = 3

export type ExpectedUserStatus = 'disabled' | 'active' | 'deidentified'
type Kind = 'ban' | 'unban' | 'revoke_all'

function kindFor(expected: ExpectedUserStatus): Kind {
  return expected === 'disabled' ? 'ban' : expected === 'active' ? 'unban' : 'revoke_all'
}

/** 真正對 Better Auth 做的事（測試可以換掉）。 */
export type RevocationCall = (kind: Kind, userId: string, headers: Headers) => Promise<void>

export const betterAuthRevocationCall: RevocationCall = async (kind, userId, headers) => {
  if (kind === 'ban') await internalAuth.banUser(headers, { userId })
  else if (kind === 'unban') await internalAuth.unbanUser(headers, { userId })
  else {
    await internalAuth.revokeUserSessions(headers, { userId })
    await internalAuth.banUser(headers, { userId })
  }
}

type Row = {
  id: string
  state: 'queued' | 'executing' | 'done' | 'failed' | 'cancelled'
  status_event_id: string
  lease_expires_at: Date | null
}

export class SessionRevocationExecutor {
  readonly #db: () => Pool
  readonly #clock: Clock
  readonly #call: RevocationCall
  readonly #owner = `app:${process.pid}:${uuidv7()}`

  constructor(deps: { db: () => Pool; clock?: Clock; call?: RevocationCall }) {
    this.#db = deps.db
    this.#clock = deps.clock ?? new RealClock()
    this.#call = deps.call ?? betterAuthRevocationCall
  }

  /**
   * 規則 1：在業務交易裡排一筆主工作，並把這個人其他還在排隊的工作（含收斂工作）標成 cancelled。
   * **不動 executing**——已經開始的外部呼叫取消不了，只能等它結束再由新工作覆蓋。
   */
  async enqueue(
    tx: PoolClient,
    input: { userId: string; statusEventId: string; expected: ExpectedUserStatus; now: Date; actorUserId: string },
  ): Promise<string> {
    await tx.query(
      `update session_revocations
          set state = 'cancelled', cancel_reason = 'superseded_by_event', completed_real_at = $2,
              revision = revision + 1, updated_at = $2, updated_by_user_id = $3
        where user_id = $1 and state = 'queued'`,
      [input.userId, input.now, input.actorUserId],
    )
    const id = uuidv7()
    await tx.query(
      `insert into session_revocations
         (id, user_id, status_event_id, trigger, kind, state, expected_user_status, requested_real_at,
          created_at, updated_at, updated_by_user_id)
       values ($1, $2, $3, 'status_event', $4, 'queued', $5, $6, $6, $6, $7)`,
      [id, input.userId, input.statusEventId, kindFor(input.expected), input.expected, input.now, input.actorUserId],
    )
    return id
  }

  /**
   * 規則 2–4：把這個人排隊中的工作做掉。回最後一筆的結果；
   * 有別人正在執行（租約未過期）時回 `pending`——那一位做完會接著處理。
   */
  async runForUser(userId: string, headers: Headers): Promise<RevocationOutcome> {
    let outcome: RevocationOutcome = 'pending'
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const claimed = await this.#claim(userId)
      if (claimed === 'busy') return 'pending'
      if (claimed === null) return outcome

      let failure: { message: string; unknown: boolean } | null = null
      try {
        await withTimeout(this.#call(claimed.kind, userId, headers), CALL_TIMEOUT_MS)
      } catch (error) {
        const timedOut = error instanceof TimeoutError
        failure = { message: describe(error), unknown: timedOut }
      }
      outcome = (await this.#complete(claimed.id, failure)) ? (failure ? 'failed' : 'done') : 'pending'
    }
    return outcome
  }

  /** 規則 2：短交易認領。 */
  async #claim(userId: string): Promise<{ id: string; kind: Kind } | 'busy' | null> {
    const now = this.#clock.now()
    const tx = await this.#db().connect()
    try {
      await tx.query('begin')
      // 先鎖這個人：同一個人的認領排隊，不會兩個人同時認到同一批列。
      const user = await tx.query<{ status: string; deidentified_at: Date | null }>(
        'select status, deidentified_at from users where id = $1 for update',
        [userId],
      )
      const open = await tx.query<Row>(
        `select id, state, status_event_id, lease_expires_at
           from session_revocations
          where user_id = $1 and state in ('queued','executing')
          order by requested_real_at desc, id desc
          for update`,
        [userId],
      )
      for (const row of open.rows.filter((r) => r.state === 'executing')) {
        if (row.lease_expires_at && row.lease_expires_at.getTime() > now.getTime()) {
          await tx.query('commit')
          return 'busy'
        }
        // 租約過期＝外部結果未知：標 failed，讓這個人留在收斂觀察集合裡（規則 5，票 12）。
        await tx.query(
          `update session_revocations
              set state = 'failed', cancel_reason = 'lease_expired', outcome_unknown = true,
                  completed_real_at = $2, revision = revision + 1, updated_at = $2
            where id = $1`,
          [row.id, now],
        )
      }

      const queued = open.rows.filter((r) => r.state === 'queued')
      const [latest, ...older] = queued
      if (!latest) {
        await tx.query('commit')
        return null
      }
      if (older.length > 0) {
        await tx.query(
          `update session_revocations
              set state = 'cancelled', cancel_reason = 'superseded_by_event', completed_real_at = $2,
                  revision = revision + 1, updated_at = $2
            where id = any($1::uuid[])`,
          [older.map((r) => r.id), now],
        )
      }

      const event = await tx.query<{ id: string }>(
        `select id from user_status_events where user_id = $1 order by real_at desc, id desc limit 1`,
        [userId],
      )
      if (event.rows[0]?.id !== latest.status_event_id) {
        await tx.query(
          `update session_revocations
              set state = 'cancelled', cancel_reason = 'status_mismatch', completed_real_at = $2,
                  revision = revision + 1, updated_at = $2
            where id = $1`,
          [latest.id, now],
        )
        await tx.query('commit')
        return null
      }

      // 以認領當下的 users.status 為準覆寫要做的事（規則 2 最後一句）。待審跟 active 一樣＝解除封鎖（`revocationTargetOf`）。
      const row = user.rows[0]
      const expected: ExpectedUserStatus | null = !row
        ? null
        : row.deidentified_at
          ? 'deidentified'
          : row.status === 'disabled'
            ? 'disabled'
            : row.status === 'active' || row.status === 'pending'
              ? 'active'
              : null
      if (!expected) {
        await tx.query(
          `update session_revocations
              set state = 'cancelled', cancel_reason = 'status_mismatch', completed_real_at = $2,
                  revision = revision + 1, updated_at = $2
            where id = $1`,
          [latest.id, now],
        )
        await tx.query('commit')
        return null
      }
      const kind = kindFor(expected)
      await tx.query(
        `update session_revocations
            set state = 'executing', lease_owner = $2, lease_expires_at = $3,
                expected_user_status = $4, kind = $5, revision = revision + 1, updated_at = $6
          where id = $1`,
        [latest.id, this.#owner, new Date(now.getTime() + LEASE_SECONDS * 1000), expected, kind, now],
      )
      await tx.query('commit')
      return { id: latest.id, kind }
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
  }

  /** 規則 4：只有仍是 executing 而且租約是自己的，才寫結果；否則代表被接手了，結果丟掉。 */
  async #complete(id: string, failure: { message: string; unknown: boolean } | null): Promise<boolean> {
    const now = this.#clock.now()
    const tx = await this.#db().connect()
    try {
      await tx.query('begin')
      const found = await tx.query<{ state: string; lease_owner: string | null }>(
        'select state, lease_owner from session_revocations where id = $1 for update',
        [id],
      )
      const row = found.rows[0]
      if (!row || row.state !== 'executing' || row.lease_owner !== this.#owner) {
        await tx.query('commit')
        return false
      }
      await tx.query(
        `update session_revocations
            set state = $2, last_error = $3, outcome_unknown = $4, completed_real_at = $5,
                revision = revision + 1, updated_at = $5
          where id = $1`,
        [id, failure ? 'failed' : 'done', failure?.message ?? null, failure?.unknown ?? false, now],
      )
      await tx.query('commit')
      return true
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
  }
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError('逾時')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 錯誤摘要：只留代碼與狀態，不寫進任何請求內容（`last_error` 不含秘密）。 */
function describe(error: unknown): string {
  if (error instanceof TimeoutError) return 'TIMEOUT'
  const e = error as { status?: unknown; body?: { code?: unknown } }
  const parts = [e?.status, e?.body?.code].filter((p) => typeof p === 'string' || typeof p === 'number')
  return (parts.length > 0 ? parts.join(' ') : 'ERROR').slice(0, 200)
}

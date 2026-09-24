import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { readBanned, SqlBanStateGateway, type BanStateGateway } from '@/infrastructure/accounts/ban-state'
import { PgSessionRevocationExecutor } from '@/infrastructure/accounts/session-revocation-executor'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'

/**
 * 票 12「做完的樣子」4：停用／恢復帳號後，背景工作每 5 分鐘核對是否真的生效，過期的工作回收
 * （模組實作設計 01 附錄 A `session_revocations` v2.4 規則 2–5；§10 D1 釘版測試 (4)–(7)）。
 *
 * 停用／恢復的用例是票 9 的；這裡直接照附錄 A 的欄位寫「狀態事件＋主工作」列，驗背景工作這一半。
 * 全部以 `fju_app` 連線（worker 用的就是這個角色）。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string

const events = new PgEventPublisher()
const businessClock = { now: async () => new Date() }

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'revocation', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  adminId = await newUser('active')
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'admin', $1, now())`,
    [adminId],
  )
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

async function newUser(status: 'active' | 'disabled', banned = false): Promise<string> {
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status, banned)
     values (gen_random_uuid(), 'U', $1, false, now(), $2, $3) returning id`,
    [`u-${randomUUID()}@example.com`, status, banned],
  )
  return String(row.rows[0]!.id)
}

async function addSession(userId: string) {
  await owner.sql(
    `insert into sessions (id, expires_at, token, created_at, updated_at, user_id, login_method)
     values (gen_random_uuid(), now() + interval '1 day', $1, now(), now(), $2, 'password')`,
    [randomUUID(), userId],
  )
}

/** 管理員把帳號改成某個狀態：寫 users.status、狀態事件，並排一筆主工作（票 9 用例會做的事）。 */
async function statusEvent(userId: string, to: 'active' | 'disabled', at = new Date()): Promise<{ eventId: string; jobId: string }> {
  const eventId = randomUUID()
  const jobId = randomUUID()
  const from = to === 'disabled' ? 'active' : 'disabled'
  await owner.sql('update users set status = $2 where id = $1', [userId, to])
  await owner.sql(
    `insert into user_status_events (id, user_id, from_status, to_status, actor_kind, actor_user_id, real_at)
     values ($1, $2, $3, $4, 'user', $5, $6)`,
    [eventId, userId, from, to, adminId, at],
  )
  await owner.sql(`update session_revocations set state = 'cancelled', cancel_reason = 'superseded_by_event' where user_id = $1 and state = 'queued'`, [userId])
  await owner.sql(
    `insert into session_revocations (id, user_id, status_event_id, kind, state, expected_user_status, requested_real_at)
     values ($1, $2, $3, $4, 'queued', $5, $6)`,
    [jobId, userId, eventId, to === 'disabled' ? 'ban' : 'unban', to, at],
  )
  return { eventId, jobId }
}

function executor(options: { gateway?: BanStateGateway; owner?: string; leaseSeconds?: number } = {}) {
  return new PgSessionRevocationExecutor({
    pool: () => app,
    gateway: options.gateway ?? new SqlBanStateGateway(() => app),
    audit: new PgAuditWriter(),
    events,
    businessClock,
    owner: options.owner ?? `test:${randomUUID()}`,
    leaseSeconds: options.leaseSeconds,
    log: () => undefined,
  })
}

const rows = async (userId: string) =>
  (
    await owner.sql(
      `select trigger, reconcile_reason, reconcile_round, state, kind, expected_user_status, cancel_reason,
              outcome_unknown, last_error, status_event_id, reconcile_of_id
         from session_revocations where user_id = $1 order by requested_real_at, created_at`,
      [userId],
    )
  ).rows

describe('等價寫入（不經 admin plugin，worker 沒有 session 也能做）', () => {
  it('ban：banned=true 而且這個人的 session 全部刪掉；unban：banned=false', async () => {
    const userId = await newUser('active')
    await addSession(userId)
    const gateway = new SqlBanStateGateway(() => app)
    await gateway.apply(userId, 'disabled')
    expect(await readBanned(app, userId)).toBe(true)
    expect(Number((await owner.sql('select count(*) as n from sessions where user_id = $1', [userId])).rows[0]!.n)).toBe(0)
    await gateway.apply(userId, 'active')
    expect(await readBanned(app, userId)).toBe(false)
  })
})

describe('執行器：主工作', () => {
  it('停用後排著的主工作：worker 週期把它做掉，banned 跟著變、舊 session 失效', async () => {
    const userId = await newUser('active')
    await addSession(userId)
    await statusEvent(userId, 'disabled')

    await executor().periodic()
    expect(await readBanned(app, userId)).toBe(true)
    expect((await rows(userId))[0]).toMatchObject({ trigger: 'status_event', state: 'done', kind: 'ban' })
  })

  it('停用→恢復→停用連續三個事件：只執行最後一個，結果跟最後的業務狀態一致', async () => {
    const userId = await newUser('active')
    const t = Date.now()
    await statusEvent(userId, 'disabled', new Date(t - 3000))
    await statusEvent(userId, 'active', new Date(t - 2000))
    await statusEvent(userId, 'disabled', new Date(t - 1000))

    await executor().runForUser(userId)
    const states = (await rows(userId)).map((r) => r.state)
    expect(states).toEqual(['cancelled', 'cancelled', 'done'])
    expect(await readBanned(app, userId)).toBe(true)
  })

  it('外部呼叫失敗：failed＋結果未知；下一輪週期核對排收斂工作把它拉回來', async () => {
    const userId = await newUser('active')
    await statusEvent(userId, 'disabled')
    const failing: BanStateGateway = { apply: async () => Promise.reject(new Error('Better Auth 暫時掛了')) }
    await executor({ gateway: failing }).runForUser(userId)
    expect((await rows(userId))[0]).toMatchObject({ state: 'failed', outcome_unknown: true })
    expect(await readBanned(app, userId)).toBe(false)

    await executor().periodic()
    const after = await rows(userId)
    expect(after.at(-1)).toMatchObject({ trigger: 'reconcile', reconcile_reason: 'periodic', reconcile_round: 1, state: 'done', kind: 'ban' })
    expect(await readBanned(app, userId)).toBe(true)
  })
})

describe('票 9（PR #253）用例留下的失敗列：背景工作重試到成功', () => {
  /** 照 #253 `SessionRevocationExecutor.#complete` 寫失敗的樣子：failed、last_error、outcome_unknown=false。 */
  async function failLikeTicket9(jobId: string) {
    await owner.sql(
      `update session_revocations set state = 'failed', last_error = '403 FORBIDDEN', outcome_unknown = false,
              completed_real_at = now(), updated_at = now()
        where id = $1`,
      [jobId],
    )
  }

  it('停用時封鎖失敗：下一輪週期核對把 banned 補成 true、舊 session 刪掉', async () => {
    const userId = await newUser('active')
    await addSession(userId)
    const { jobId } = await statusEvent(userId, 'disabled')
    await failLikeTicket9(jobId)

    await executor().periodic()
    expect(await readBanned(app, userId)).toBe(true)
    expect(Number((await owner.sql('select count(*) as n from sessions where user_id = $1', [userId])).rows[0]!.n)).toBe(0)
    expect((await rows(userId)).at(-1)).toMatchObject({ trigger: 'reconcile', reconcile_reason: 'periodic', kind: 'ban', state: 'done' })
  })

  it('恢復時解除封鎖失敗（本人暫時登不進去）：下一輪週期核對把 banned 改回 false', async () => {
    const userId = await newUser('disabled', true)
    const { jobId } = await statusEvent(userId, 'active')
    await failLikeTicket9(jobId)
    expect(await readBanned(app, userId)).toBe(true)

    await executor().periodic()
    expect(await readBanned(app, userId)).toBe(false)
    expect((await rows(userId)).at(-1)).toMatchObject({ trigger: 'reconcile', kind: 'unban', expected_user_status: 'active', state: 'done' })
  })

  it('外部一直失敗：每輪核對只多一筆收斂工作（不在同一輪把 10 輪額度燒完）', async () => {
    const userId = await newUser('active')
    const { jobId } = await statusEvent(userId, 'disabled')
    await failLikeTicket9(jobId)
    const failing: BanStateGateway = { apply: async () => Promise.reject(new Error('Better Auth 掛了')) }

    await executor({ gateway: failing }).periodic()
    await executor({ gateway: failing }).periodic()
    const reconciles = (await rows(userId)).filter((r) => r.trigger === 'reconcile')
    expect(reconciles.map((r) => r.reconcile_round)).toEqual([1, 2])
    expect(reconciles.every((r) => r.state === 'failed')).toBe(true)

    await executor().periodic() // Better Auth 恢復了
    expect(await readBanned(app, userId)).toBe(true)
  })
})

describe('過期回收與租約', () => {
  it('租約過期還在 executing 的列：回收成 failed（lease_expired、結果未知），接著核對收斂', async () => {
    const userId = await newUser('active')
    const { jobId } = await statusEvent(userId, 'disabled')
    await owner.sql(
      `update session_revocations set state = 'executing', lease_owner = 'dead-worker', lease_expires_at = now() - interval '1 minute' where id = $1`,
      [jobId],
    )

    const summary = await executor().periodic()
    expect(summary.leasesRecovered).toBe(1)
    const all = await rows(userId)
    expect(all[0]).toMatchObject({ state: 'failed', cancel_reason: 'lease_expired', outcome_unknown: true })
    expect(all.at(-1)).toMatchObject({ trigger: 'reconcile', state: 'done' })
    expect(await readBanned(app, userId)).toBe(true)
  })

  it('租約被接手後，原執行者的完成結果丟棄（fencing）', async () => {
    const userId = await newUser('active')
    await statusEvent(userId, 'disabled')
    const slow = executor({ owner: 'slow', leaseSeconds: -1 }) // 認領下來的租約立刻過期
    const claimed = await slow.claim(userId)
    expect(claimed.kind).toBe('claimed')

    // 新事件（恢復）進來、另一個執行者接手：過期的那筆被標 failed，恢復那筆被認領並做完。
    await statusEvent(userId, 'active')
    await executor({ owner: 'fast' }).runForUser(userId)

    if (claimed.kind !== 'claimed') return
    expect(await slow.complete(claimed.job.id, { ok: true })).toBe(false)
    const all = await rows(userId)
    expect(all[0]).toMatchObject({ state: 'failed', cancel_reason: 'lease_expired' })
    expect(all[1]).toMatchObject({ state: 'done', kind: 'unban' })
    expect(await readBanned(app, userId)).toBe(false)
  })
})

describe('收斂核對（規則 5）', () => {
  it('一致就不插入；排著或執行中就不插入', async () => {
    const userId = await newUser('active')
    await statusEvent(userId, 'disabled')
    expect(await executor().reconcile(userId, 'periodic')).toBe('busy')
    await executor().runForUser(userId)
    expect(await executor().reconcile(userId, 'periodic')).toBe('consistent')
  })

  it('舊的 ban 晚到（Better Auth 被改成 banned，業務是 active）：週期核對插收斂工作、拉回來', async () => {
    const userId = await newUser('active')
    await statusEvent(userId, 'active')
    await executor().runForUser(userId)
    await owner.sql('update users set banned = true where id = $1', [userId]) // 晚到的舊呼叫

    await executor().periodic()
    expect((await rows(userId)).at(-1)).toMatchObject({
      trigger: 'reconcile',
      reconcile_reason: 'periodic',
      reconcile_round: 1,
      kind: 'unban',
      expected_user_status: 'active',
      state: 'done',
    })
    expect(await readBanned(app, userId)).toBe(false)
  })

  it('兩個核對者同時插入：只留一筆（唯一鍵③＋ON CONFLICT DO NOTHING）', async () => {
    const userId = await newUser('active')
    await statusEvent(userId, 'disabled')
    await executor().runForUser(userId)
    await owner.sql('update users set banned = false where id = $1', [userId])

    const results = await Promise.all([executor().reconcile(userId, 'periodic'), executor().reconcile(userId, 'periodic')])
    expect(results.filter((r) => r === 'inserted')).toHaveLength(1)
    const open = (await rows(userId)).filter((r) => r.trigger === 'reconcile')
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ state: 'queued', reconcile_round: 1 })
  })

  it('自動收斂到第 10 輪：直接 failed RECONCILE_LIMIT＋稽核＋告警；之後週期不再插入，manual_retry 仍可', async () => {
    const userId = await newUser('active')
    const { eventId, jobId } = await statusEvent(userId, 'disabled')
    await executor().runForUser(userId)
    // 模擬前 9 輪都沒收斂成功（Better Auth 一直被別的東西改回去）。
    for (let round = 1; round <= 9; round += 1) {
      await owner.sql(
        `insert into session_revocations (id, user_id, status_event_id, trigger, reconcile_reason, reconcile_of_id, reconcile_round,
           kind, state, expected_user_status, requested_real_at, completed_real_at)
         values (gen_random_uuid(), $1, $2, 'reconcile', 'periodic', $3, $4, 'ban', 'done', 'disabled', now(), now())`,
        [userId, eventId, jobId, round],
      )
    }
    await owner.sql('update users set banned = false where id = $1', [userId])

    expect(await executor().reconcile(userId, 'periodic')).toBe('limit')
    expect((await rows(userId)).at(-1)).toMatchObject({ reconcile_round: 10, state: 'failed', last_error: 'RECONCILE_LIMIT' })
    const audit = await owner.sql(`select count(*) as n from audit_events where action = 'account.session_revocation.reconcile_limit' and target_id = $1`, [userId])
    expect(Number(audit.rows[0]!.n)).toBe(1)
    const alert = await owner.sql(`select recipients from domain_events where type = 'ops.worker_alert' and source_id = $1`, [userId])
    expect(alert.rows[0]!.recipients).toEqual([adminId])

    expect(await executor().reconcile(userId, 'periodic')).toBe('limit_reached')
    expect(await executor().reconcile(userId, 'manual_retry')).toBe('inserted')
  })
})

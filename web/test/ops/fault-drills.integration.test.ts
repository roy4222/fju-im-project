import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Pool } from 'pg'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../db'
import { migratedSchema } from '../migrations'

/**
 * 票 28：四種故障演練的本機證明（真 PostgreSQL、真的背景工作迴圈；VM 上的實跑用 ops/fault-drill.sh）。
 *
 * 1. 服務重啟：worker 停掉再起來，重新拿到單一實例鎖、心跳換成新版本、/api/health 回 ok；
 *    worker 被硬砍（連線直接斷）時 PostgreSQL 自己放鎖，下一個拿得到。
 * 2. 背景工作停擺：心跳超過 5 分鐘 → /api/health ok=false（503），部署的完整六項判定也不過；
 *    worker 回來後恢復。
 * 3. 毒事件：處理不了的到期工作退避、第 5 次 failed＋管理員告警；同一輪的其他到期工作照常完成。
 * 4. 磁碟 80%：量到 ≥80% 記成「警戒」，系辦首頁的磚第一段就寫「警戒」；不發任何通知。
 *
 * 全部以正式執行角色 `fju_app` 連線（背景工作與 app 在 VM 上就是用它）。
 */

const exec = promisify(execFile)
const repoRoot = path.join(import.meta.dirname, '..', '..', '..')

let owner: IsolatedDatabase
let app: Pool
let filesRoot: string

type Modules = {
  worker: typeof import('@/composition/worker')
  health: typeof import('@/infrastructure/health/health-reader')
  runtime: typeof import('@/infrastructure/notifications/worker-runtime')
  runner: typeof import('@/infrastructure/notifications/pg-due-work-runner')
  storage: typeof import('@/infrastructure/ops/storage-stats')
  ops: typeof import('@/application/ops')
  notifications: typeof import('@/composition/notifications')
  cohorts: typeof import('@/composition/cohorts')
  db: typeof import('@/infrastructure/db/client')
}
let m: Modules

const logs: string[] = []
const log = (message: string, detail?: Record<string, unknown>) => logs.push(`${message} ${JSON.stringify(detail ?? {})}`)

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'drill', setup: migratedSchema })
  await owner.sql("insert into schema_meta (key, value) values ('schema_version', '0008_s07_group_submissions')")
  app = await poolAsRole(owner, 'fju_app')

  // 組裝層（composition）用全域連線池：指到 fju_app＋這個測試自己的 schema。
  const url = new URL(TEST_DATABASE_URL)
  url.username = 'fju_app'
  url.password = process.env.TEST_FJU_APP_PASSWORD ?? 'fju_app_local_test'
  url.searchParams.set('options', `-c search_path=${owner.schemaName}`)
  filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-drill-files-'))
  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BUSINESS_CLOCK_OVERRIDE_ENABLED', 'true')
  vi.stubEnv('FILES_ROOT', filesRoot)
  m = {
    worker: await import('@/composition/worker'),
    health: await import('@/infrastructure/health/health-reader'),
    runtime: await import('@/infrastructure/notifications/worker-runtime'),
    runner: await import('@/infrastructure/notifications/pg-due-work-runner'),
    storage: await import('@/infrastructure/ops/storage-stats'),
    ops: await import('@/application/ops'),
    notifications: await import('@/composition/notifications'),
    cohorts: await import('@/composition/cohorts'),
    db: await import('@/infrastructure/db/client'),
  }

  const admin = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'Admin', 'admin-drill@example.com', false, now(), 'active') returning id`,
  )
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'admin', $1, now())`,
    [admin.rows[0]!.id],
  )
})

afterAll(async () => {
  await m?.db.getPool().end()
  await app?.end()
  await owner?.close()
  vi.unstubAllEnvs()
  if (filesRoot) fs.rmSync(filesRoot, { recursive: true, force: true })
})

/** 部署用的健康判定（ops/check-health.mjs，預設完整六項）。 */
async function deployHealthCheck(health: unknown, tag: string) {
  return exec('node', [path.join(repoRoot, 'ops/check-health.mjs')], {
    env: { ...process.env, HEALTH_JSON: JSON.stringify(health), EXPECT_TAG: tag },
  })
}

function startWorker(version: string, lockName: string) {
  return m.worker.startWorker({
    version,
    lockName,
    projectionIntervalMs: 100,
    dueWorkIntervalMs: 100,
    reconcileIntervalMs: 60_000,
    storageIntervalMs: 60_000,
    log,
  })
}

describe('演練 1：服務重啟', () => {
  it('worker 停掉再起來：重新拿到鎖、心跳換成新版本、/api/health ok，部署判定完整六項通過', async () => {
    const lockName = `drill-restart-${owner.schemaName}`
    const first = await startWorker('v1', lockName)
    expect(first).not.toBeNull()
    await vi.waitFor(async () => expect((await m.runtime.readWorkerHealth(app)).version).toBe('v1'), { timeout: 5_000 })
    // 同一時間只有一個 worker：第二個拿不到鎖。
    expect(await startWorker('v1', lockName)).toBeNull()

    await first!.stop()
    const second = await startWorker('v2', lockName)
    expect(second, '停掉之後新的 worker 要拿得到鎖').not.toBeNull()
    try {
      await vi.waitFor(async () => expect((await m.runtime.readWorkerHealth(app)).version).toBe('v2'), { timeout: 5_000 })
      const snapshot = await m.health.readHealth()
      expect(snapshot.ok).toBe(true)
      const { stdout } = await deployHealthCheck({ ...snapshot, commit: 'v2' }, 'v2')
      expect(stdout).toContain('健康判定通過')
    } finally {
      await second!.stop()
    }
  })

  it('worker 被硬砍（拿鎖的連線直接斷掉）：PostgreSQL 自己放鎖，下一個 worker 拿得到', async () => {
    const lockName = `drill-kill-${owner.schemaName}`
    const lock = await m.runtime.acquireWorkerLock(app, lockName)
    expect(lock).not.toBeNull()
    expect(await m.runtime.acquireWorkerLock(app, lockName)).toBeNull()
    // 模擬進程被 kill：不 unlock，連線直接毀掉。
    lock!.client.release(new Error('模擬 worker 被 kill'))
    await vi.waitFor(
      async () => {
        const next = await m.runtime.acquireWorkerLock(app, lockName)
        expect(next).not.toBeNull()
        await next!.release()
      },
      { timeout: 5_000 },
    )
  })
})

describe('演練 2：背景工作停擺', () => {
  it('心跳停超過 5 分鐘：/api/health ok=false、部署判定不過；worker 回來後恢復', async () => {
    await owner.sql(
      `insert into worker_heartbeat (id, version, last_tick_real_at, updated_at) values (1, 'v2', now() - interval '6 minutes', now())
       on conflict (id) do update set version = 'v2', last_tick_real_at = now() - interval '6 minutes'`,
    )
    const stalled = await m.health.readHealth()
    expect(stalled.ok).toBe(false)
    await expect(deployHealthCheck({ ...stalled, commit: 'v2' }, 'v2')).rejects.toThrow(/ok 是 false/)

    const worker = await startWorker('v2', `drill-stall-${owner.schemaName}`)
    try {
      await vi.waitFor(async () => expect((await m.health.readHealth()).ok).toBe(true), { timeout: 5_000 })
    } finally {
      await worker!.stop()
    }
  })
})

describe('演練 3：毒事件（處理不了的到期工作）', () => {
  async function insertDue(subjectType: string) {
    const id = randomUUID()
    await owner.sql(
      `insert into due_work (id, kind, subject_type, subject_id, deadline_version, due_business_at)
       values ($1, 'test_noop', $2, gen_random_uuid(), 1, now() - interval '1 minute')`,
      [id, subjectType],
    )
    return id
  }
  const state = async (id: string) =>
    (await owner.sql('select state, attempts, last_error from due_work where id = $1', [id])).rows[0]!

  it('毒工作退避、第 5 次 failed＋告警；同一輪排在它後面的正常工作照常完成，不會被卡住', async () => {
    const poison = await insertDue(m.runner.FAULT_DRILL_POISON_SUBJECT_TYPE)
    const normalA = await insertDue('test')
    const normalB = await insertDue('test')
    const runner = new m.runner.PgDueWorkRunner({
      pool: () => app,
      handlers: m.worker.dueWorkHandlers(log),
      events: m.notifications.getEventPublisher(),
      businessClock: m.cohorts.getBusinessClock(),
      log,
    })

    const first = await runner.runOnce()
    expect(first).toMatchObject({ done: 2, retried: 1 })
    expect((await state(normalA)).state).toBe('done')
    expect((await state(normalB)).state).toBe('done')
    expect(await state(poison)).toMatchObject({ state: 'pending', attempts: 1 })

    for (let i = 0; i < 4; i += 1) {
      await owner.sql('update due_work set next_attempt_at = null where id = $1', [poison])
      await runner.runOnce()
    }
    expect(await state(poison)).toMatchObject({ state: 'failed', attempts: 5 })
    expect(String((await state(poison)).last_error)).toContain('毒工作')
    const alerts = await owner.sql(
      `select count(*)::int as n from domain_events where type = 'ops.worker_alert' and source_id = $1`,
      [poison],
    )
    expect(alerts.rows[0]!.n).toBe(1)

    // 標成 failed 之後不會再被撿：新的正常工作一輪就做完。
    const later = await insertDue('test')
    expect(await runner.runOnce()).toMatchObject({ done: 1, failed: 0, retried: 0 })
    expect((await state(later)).state).toBe('done')
  })
})

describe('演練 4：磁碟 80%', () => {
  const GiB = 1024 ** 3
  /** 假的 statfs：總共 100 個 1 GiB 的區塊，已用 `used` 個，其餘都給一般使用者用。 */
  const fakeStatfs = (used: number) => async () => ({ bsize: GiB, blocks: 100, bfree: 100 - used, bavail: 100 - used })

  it('量到 85%：記成警戒，磚上第一段寫「警戒」；量回 40% 之後恢復正常；全程不發通知', async () => {
    fs.mkdirSync(path.join(filesRoot, 'files', '2026', '09'), { recursive: true })
    fs.writeFileSync(path.join(filesRoot, 'files', '2026', '09', 'a'), Buffer.alloc(3000))
    fs.mkdirSync(path.join(filesRoot, 'tmp'), { recursive: true })
    fs.writeFileSync(path.join(filesRoot, 'tmp', 'b'), Buffer.alloc(500))
    const eventsBefore = (await owner.sql('select count(*)::int as n from domain_events')).rows[0]!.n

    const high = await m.storage.measureStorage({ root: filesRoot, db: app, statfs: fakeStatfs(85), drill: true })
    await m.storage.recordStorageMeasurement(app, high)
    const latest = await m.storage.readLatestStorage(app)
    expect(latest).toMatchObject({ usedPercent: 85, alertLevel: 'warn80', drill: true, filesBytes: 3000, tmpBytes: 500 })
    expect(latest!.dbBytes).toBeGreaterThan(0)
    expect(m.ops.storageTileText(latest, new Date(), '09/25 12:00').hint.startsWith('警戒（≥80%）')).toBe(true)

    const normal = await m.storage.measureStorage({ root: filesRoot, db: app, statfs: fakeStatfs(40) })
    await m.storage.recordStorageMeasurement(app, normal)
    expect(await m.storage.readLatestStorage(app)).toMatchObject({ usedPercent: 40, alertLevel: 'ok', drill: false })

    // 只看站內、不推播（D-04）：量測不發事件，也就不會有通知。
    expect((await owner.sql('select count(*)::int as n from domain_events')).rows[0]!.n).toBe(eventsBefore)
    expect((await owner.sql('select count(*)::int as n from notifications')).rows[0]!.n).toBe(0)
  })

  it('背景工作一啟動就量一次真的檔案系統（每小時一次的第一次）', async () => {
    const before = await m.storage.readLatestStorage(app)
    const worker = await startWorker('v3', `drill-storage-${owner.schemaName}`)
    try {
      await vi.waitFor(
        async () => {
          const latest = await m.storage.readLatestStorage(app)
          expect(latest?.measuredRealAt.getTime()).toBeGreaterThan(before?.measuredRealAt.getTime() ?? 0)
          expect(latest?.path).toBe(filesRoot)
          expect(latest?.totalBytes).toBeGreaterThan(0)
        },
        { timeout: 5_000 },
      )
    } finally {
      await worker!.stop()
    }
  })
})

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StoredFileReceipt, UploadRules } from '@/application/ops'
import type { Result } from '@/shared/result'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * #824 CL-8：上傳傳到一半屆別被封存，不能留下「已儲存」的孤兒檔。
 * 發 ticket 時、開始寫暫存檔前都還沒封存；最後標成 stored 那一步要對屆別上鎖再查一次。
 * 兩條連線：上傳走 `fju_app`，封存交易走 owner 連線並持鎖不放，證明收尾真的等鎖、放鎖後看到封存。
 * 榮譽附件（ticket 沒標 rejectWhenCohortArchived）照舊放行。
 */

let db: IsolatedDatabase
let app: Pool
let root: string
let storage: FsFileStorage
let adminId: string
let sequence = 0

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
const WAIT_MS = 10_000

async function newCohort(): Promise<string> {
  const r = await db.sql(
    `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
    [`cl8-${++sequence}`, `CL-8 測試屆 ${sequence}`],
  )
  return String(r.rows[0]!.id)
}

function rules(cohortId: string, rejectWhenCohortArchived: boolean): UploadRules {
  return {
    purpose: 'attachment', allowedTypes: ['pdf'], maxBytes: 1024 * 1024,
    scope: { kind: 'cohort', cohortId }, ...(rejectWhenCohortArchived ? { rejectWhenCohortArchived: true } : {}),
  }
}

/** 先給第一段，等測試放行才給剩下的；`started` 在上傳開始讀資料時（已過開頭的封存檢查）完成。 */
function gatedStream(bytes: Uint8Array) {
  let markStarted!: () => void
  let open!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const gate = new Promise<void>(resolve => { open = resolve })
  let step = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (step === 0) {
        step = 1
        controller.enqueue(bytes.subarray(0, 8))
        markStarted()
        return
      }
      await gate
      controller.enqueue(bytes.subarray(8))
      controller.close()
    },
  }, { highWaterMark: 0 })
  return { stream, started, open }
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}：${WAIT_MS / 1000} 秒內沒有結束`)), WAIT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function startUpload(cohortId: string, reject: boolean) {
  const issued = await storage.issueUploadTicket(adminId, { fileName: '說明.pdf', declaredMime: 'application/pdf' }, rules(cohortId, reject))
  if (!issued.ok) throw new Error(issued.message)
  const gated = gatedStream(PDF)
  const result = storage.upload(adminId, issued.receipt.ticket, gated.stream, PDF.length)
  await withTimeout(gated.started, '上傳開始讀資料')
  return { fileId: issued.receipt.fileId, result, open: gated.open }
}

async function fileState(fileId: string) {
  const row = (await db.sql('select status, storage_key from stored_files where id = $1', [fileId])).rows[0]!
  const onDisk = await fs.stat(path.join(root, String(row.storage_key))).then(() => true, () => false)
  const temps = await fs.readdir(path.join(root, 'tmp')).catch(() => [] as string[])
  return { status: row.status, onDisk, temps }
}

/** 輪詢到有連線卡在等鎖；上限 WAIT_MS，逾時給清楚的訊息。 */
async function waitForLockWaiter(): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    const r = await db.sql(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    )
    if (Number(r.rows[0]!.n) > 0) return
    if (Date.now() > deadline) throw new Error(`上傳收尾 ${WAIT_MS / 1000} 秒內都沒有在等屆別的鎖`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'cl8_upload_race', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-cl8-'))
  const r = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'admin', 'cl8-admin@example.com', true, now(), 'active') returning id`,
  )
  adminId = String(r.rows[0]!.id)
  storage = new FsFileStorage({
    root: () => root, environmentMaxBytes: () => 1024 * 1024, ticketSecret: () => 'cl-8-local-integration-ticket-secret',
    policies: {}, db: () => app,
  })
})

afterAll(async () => {
  await app?.end()
  await db?.close()
  if (root) await fs.rm(root, { recursive: true, force: true })
})

describe('#824 上傳傳到一半屆別被封存', () => {
  it('屆別沒封存：標了記號的上傳照常存成 stored', async () => {
    const cohortId = await newCohort()
    const upload = await startUpload(cohortId, true)
    upload.open()
    const result = await withTimeout(upload.result, '上傳')
    expect(result.ok).toBe(true)
    expect(await fileState(upload.fileId)).toEqual({ status: 'stored', onDisk: true, temps: [] })
  })

  it('傳輸中途封存：回 COHORT_ARCHIVED，檔案列不是 stored，正式位置沒有檔', async () => {
    const cohortId = await newCohort()
    const upload = await startUpload(cohortId, true)
    await db.sql(`update cohorts set status = 'archived' where id = $1`, [cohortId])
    upload.open()
    const result: Result<StoredFileReceipt> = await withTimeout(upload.result, '上傳')
    expect(result).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
    expect(await fileState(upload.fileId)).toEqual({ status: 'uploading', onDisk: false, temps: [] })
  })

  it('兩條連線：封存交易持鎖時收尾要等，提交後看到封存而拒絕', async () => {
    const cohortId = await newCohort()
    const upload = await startUpload(cohortId, true)
    const archiver: PoolClient = await db.pool.connect()
    let open = false
    try {
      await archiver.query('begin')
      open = true
      await archiver.query(`select id from cohorts where id = $1 for update`, [cohortId])
      await archiver.query(`update cohorts set status = 'archived' where id = $1`, [cohortId])

      let settled = false
      const tracked = upload.result.finally(() => { settled = true })
      upload.open()
      await waitForLockWaiter()
      expect(settled).toBe(false)

      await archiver.query('commit')
      open = false
      const result = await withTimeout(tracked, '放鎖後的上傳收尾')
      expect(result).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
      expect(await fileState(upload.fileId)).toEqual({ status: 'uploading', onDisk: false, temps: [] })
    } finally {
      if (open) await archiver.query('rollback').catch(() => undefined)
      archiver.release()
      // 失敗時也要讓上傳串流結束，不留懸著的 promise。
      upload.open()
      await withTimeout(upload.result, '清理：上傳').catch(() => undefined)
    }
  })

  it('榮譽附件（沒標記號）：傳輸中途封存照樣存成 stored', async () => {
    const cohortId = await newCohort()
    const upload = await startUpload(cohortId, false)
    await db.sql(`update cohorts set status = 'archived' where id = $1`, [cohortId])
    upload.open()
    const result = await withTimeout(upload.result, '上傳')
    expect(result.ok).toBe(true)
    expect(await fileState(upload.fileId)).toEqual({ status: 'stored', onDisk: true, temps: [] })
  })
})

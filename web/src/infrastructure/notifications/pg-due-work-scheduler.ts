import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { PoolClient } from 'pg'
import {
  checkDueWork,
  type DueWorkIdentity,
  type DueWorkScheduler,
  type ScheduleDueWorkInput,
  type ScheduledDueWork,
} from '@/application/notifications'

/**
 * 「排到期工作」的寫入（契約 01 §4.7、§9；模組 08 §5、§6 生命週期表）。
 *
 * identity＝（kind、subject_type、subject_id、deadline_version），DB 有唯一鍵。
 * 排程用 `ON CONFLICT DO NOTHING`：同一個動作重試、或兩個交易同時排同一件，都只留一列；
 * 後到的交易會等前者 commit 或 rollback 才知道結果（同帳本的 ON CONFLICT 行為）。
 *
 * 期限改了的標準做法是在同一筆交易裡「取消舊版本＋排新版本」，這兩個方法就是那兩半。
 */
export class PgDueWorkScheduler implements DueWorkScheduler<PoolClient> {
  readonly #testKindsEnabled: boolean

  /** `testKindsEnabled`：只有測試站（`BUSINESS_CLOCK_OVERRIDE_ENABLED=true`）才准排 `test_noop`。 */
  constructor(options: { testKindsEnabled: boolean }) {
    this.#testKindsEnabled = options.testKindsEnabled
  }

  async schedule(tx: PoolClient, work: ScheduleDueWorkInput): Promise<ScheduledDueWork> {
    checkDueWork(work, { testKindsEnabled: this.#testKindsEnabled })
    if (Number.isNaN(work.dueBusinessAt.getTime())) throw new RangeError('到期時間不是有效的時間')

    const inserted = await tx.query<{ id: string }>(
      `insert into due_work (id, kind, subject_type, subject_id, deadline_version, due_business_at, state)
       values ($1, $2, $3, $4, $5, $6, 'pending')
       on conflict on constraint due_work_identity do nothing
       returning id`,
      [uuidv7(), work.kind, work.subject.type, work.subject.id, work.deadlineVersion, work.dueBusinessAt],
    )
    if (inserted.rows[0]) return { dueWorkId: inserted.rows[0].id, created: true }

    const existing = await tx.query<{ id: string }>(
      `select id from due_work
        where kind = $1 and subject_type = $2 and subject_id = $3 and deadline_version = $4`,
      [work.kind, work.subject.type, work.subject.id, work.deadlineVersion],
    )
    return { dueWorkId: existing.rows[0]!.id, created: false }
  }

  async cancel(tx: PoolClient, work: DueWorkIdentity): Promise<number> {
    // 取消不受「測試種類」限制：正式站若真有舊的 test_noop 列，也要能收掉。
    checkDueWork(work, { testKindsEnabled: true })
    const cancelled = await tx.query(
      `update due_work set state = 'cancelled'
        where kind = $1 and subject_type = $2 and subject_id = $3 and deadline_version = $4
          and state = 'pending'`,
      [work.kind, work.subject.type, work.subject.id, work.deadlineVersion],
    )
    return cancelled.rowCount ?? 0
  }
}

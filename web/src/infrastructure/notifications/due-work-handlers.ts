import 'server-only'
import type { PoolClient } from 'pg'
import type { ProposalExpiryHandler } from '@/application/groups'
import type { DueWorkHandler } from '@/application/notifications'

/**
 * 各模組掛到背景工作到期迴圈上的處理器（模組實作設計 08 §6 生命週期表）。
 *
 * 真正的業務在各模組的用例；這裡只把「到期工作」翻成那個用例的呼叫，並把結果翻回生命週期：
 * 做完或本來就不用做 → `done`；前置還沒就緒 → `defer`（保持等待、不累計次數）；丟例外 → 累計失敗。
 */

/**
 * 提案到期（票 13；`due_work(kind='proposal_expiry', subject_type='group_proposal')`）。
 *
 * `expire()` 自己開交易，終止時在同一筆交易把這件工作改成 cancelled，所以用 `own_transaction` 掛：
 * worker 不拿著這一列的鎖呼叫它，回來時看到 cancelled 就不覆蓋。
 * - `expired`：已終止（工作被它改成 cancelled）。
 * - `not_open`／`stale_version`／`not_found`：已經成立或終止、期限改過、提案不存在——這件工作沒事可做，標 done。
 * - `not_due`：業務時間還沒到（模擬鐘被往回撥）→ `defer`，之後再試，不標完成。
 */
export function proposalExpiryDueWorkHandler(expiry: Pick<ProposalExpiryHandler, 'expire'>): DueWorkHandler<PoolClient> {
  return {
    mode: 'own_transaction',
    async handle(work) {
      const outcome = await expiry.expire(work.subject.id, work.deadlineVersion)
      if (outcome === 'not_due') return { kind: 'defer', reason: '提案的業務到期時間還沒到' }
      return { kind: 'done', resultRef: { outcome } }
    },
  }
}

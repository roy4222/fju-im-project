/**
 * 「排到期工作」的型別與純規則（模組 08 §5、§6；契約 01 §4.7、§9）。
 *
 * 一件到期工作＝「到某個業務時間要做的事」，例如截止時拍快照、提案到期終止。
 * identity 是（種類、對象、期限版本）：同一個版本重排只會有一列；期限改了就排新版本、
 * 把舊版本取消——兩件事跟業務寫入在同一筆交易。
 *
 * 誰來執行是票 12 的背景工作；這裡只管「排進去」與「取消」。
 */

/** `due_work.kind` 的 CHECK 白名單（契約 01 §4.7）。改這裡要一起改 migration。 */
export const DUE_WORK_KINDS = [
  'proposal_expiry',
  'deadline_snapshot',
  'snapshot_reconcile',
  'overdue_digest',
  'stage_end_unassigned',
  'file_gc',
  'receipt_purge',
  'test_noop',
] as const

export type DueWorkKind = (typeof DUE_WORK_KINDS)[number]

/**
 * 只給測試站用的種類：`test_noop` 只在 `BUSINESS_CLOCK_OVERRIDE_ENABLED=true` 的環境
 * 有 handler，正式站排程一律拒絕（契約 01 §4.7）。
 */
export const TEST_ONLY_DUE_WORK_KINDS: readonly DueWorkKind[] = ['test_noop']

export function isDueWorkKind(value: string): value is DueWorkKind {
  return (DUE_WORK_KINDS as readonly string[]).includes(value)
}

/** 到期工作指向的對象，例如 `{ type: 'item', id }`、`{ type: 'group_proposal', id }`。 */
export type DueWorkSubject = { readonly type: string; readonly id: string }

export type DueWorkIdentity = {
  readonly kind: DueWorkKind
  readonly subject: DueWorkSubject
  /** 期限版本，從 1 開始；期限每改一次 +1。 */
  readonly deadlineVersion: number
}

export type ScheduleDueWorkInput = DueWorkIdentity & {
  /** 什麼時候到期（業務時間，UTC 瞬間）。 */
  readonly dueBusinessAt: Date
}

export type ScheduledDueWork = {
  readonly dueWorkId: string
  /** false＝同一個 identity 已經排過（重試同一個動作），這次沒有新增。 */
  readonly created: boolean
}

/** 同 `DomainEventRejected`：這是程式寫錯，丟例外讓整筆交易回滾。 */
export class DueWorkRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DueWorkRejected'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SUBJECT_TYPE = /^[a-z][a-z0-9_]*$/

/**
 * 檢查要排或要取消的那件工作。`testKindsEnabled` 由組裝層依環境變數給：
 * 正式站是 false，`test_noop` 會被拒。
 */
export function checkDueWork(identity: DueWorkIdentity, options: { testKindsEnabled: boolean }): void {
  if (!isDueWorkKind(identity.kind)) {
    throw new DueWorkRejected(`到期工作種類 ${String(identity.kind)} 不在白名單`)
  }
  if (TEST_ONLY_DUE_WORK_KINDS.includes(identity.kind) && !options.testKindsEnabled) {
    throw new DueWorkRejected(`${identity.kind} 只能在測試站排程（BUSINESS_CLOCK_OVERRIDE_ENABLED=true）`)
  }
  if (!SUBJECT_TYPE.test(identity.subject.type)) {
    throw new DueWorkRejected(`到期工作對象種類 ${identity.subject.type} 格式不對`)
  }
  if (!UUID.test(identity.subject.id)) throw new DueWorkRejected('到期工作對象 id 必須是 uuid')
  if (!Number.isInteger(identity.deadlineVersion) || identity.deadlineVersion < 1) {
    throw new DueWorkRejected('期限版本必須是 1 以上的整數')
  }
}

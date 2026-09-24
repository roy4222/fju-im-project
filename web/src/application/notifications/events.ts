import type { ActorKind, Scope } from '@/application/ops'

/**
 * 「發事件」的型別與純規則（模組 08 §2、§5；契約 01 §4.5、§9；產品模組 08 §4「去重、補建與保存」）。
 *
 * 事件寫進去就改不掉（`domain_events` 不可變），而且**收件人在寫入當下就固定**：
 * 之後補建通知只能照這份名單，不能重新展開成另一批人。
 * 事件跟業務寫入在同一筆交易（`EventPublisher.publish(tx, …)`），交易回滾事件就一起消失，
 * 不會有「動作沒成功卻通知了人」。
 */

/** 事件的下游消費者（`event_projections.consumer` 的 CHECK 白名單）。 */
export type EventConsumer = 'notifications' | 'digest' | 'showcase'

export const EVENT_CONSUMERS: readonly EventConsumer[] = ['notifications', 'digest', 'showcase']

/**
 * 通知匣裡的分類標籤（原型的「截止／繳交／簽核／評分／帳號／系統」）。
 * 真實業務事件由各自的票加進目錄時選一種；目前只有系統類。
 */
export type NotificationKind = 'due' | 'submission' | 'signoff' | 'grading' | 'account' | 'group' | 'system'

/** 事件投影成通知時的樣子：分類與沒有帶標題時的預設標題。 */
export type NotificationPresentation = {
  readonly kind: NotificationKind
  readonly defaultTitle: string
}

type CatalogEntry = {
  readonly consumers: readonly EventConsumer[]
  /** 有 `notifications` 消費者的事件必填：投影成通知時用。 */
  readonly notification?: NotificationPresentation
}

/**
 * 事件型別目錄（模組 08 §4：實作以產品事件矩陣為準，在這裡對照）。
 *
 * 每種事件在這裡登記一次，並寫明寫入時要替哪些消費者建「待投影」列。
 * **沒登記的型別一律拒絕寫入**——後面的票新增事件時，要先在這裡補一列並對照產品矩陣，
 * 才不會有人隨手發一種 worker 不認得、或不該進通知匣的事件。
 */
export const EVENT_CATALOG = {
  /**
   * 屆別從籌備中轉進行中（票 11）。產品矩陣沒有這一列：狀態變化不另發通知，
   * 進入該屆時直接顯示目前狀態（模組 08 §4「封存／解封」同理）。事件只留紀錄。
   */
  'cohort.activated': { consumers: [] },
  /**
   * 獨立活動新增、改期、取消（票 11；模組實作設計 02 §3「event upsert／cancel」）。
   * 站內日曆是查詢組出來的，不靠通知；產品矩陣也沒有「活動異動」通知，所以沒有消費者。
   */
  'calendar.changed': { consumers: [] },
  /**
   * 投影驗收用的測試事件（模組實作設計 08 §6；收件人由發送者指定）。
   * 管理端「發一則測試通知」只在測試站（`BUSINESS_CLOCK_OVERRIDE_ENABLED=true`）開放（票 12）。
   */
  'test.notification': {
    consumers: ['notifications'],
    notification: { kind: 'system', defaultTitle: '測試通知' },
  },
  /**
   * 背景工作的維運告警（票 12；模組實作設計 08 §6「≥5 標 failed＋管理員告警事件」、
   * 模組 01 附錄 A 規則 5「自動收斂到上限告警」）。收件人是發生當下所有有效的管理員。
   * 產品矩陣「備份失敗通知管理員」同一類：全站維運事件，用真實時間。
   */
  'ops.worker_alert': {
    consumers: ['notifications'],
    notification: { kind: 'system', defaultTitle: '背景工作需要處理' },
  },
  /**
   * 分組邀請（票 13；產品模組 08 §4「等待本人同意（分組邀請）→本人」）。收件人＝提案全員（含提案人，
   * 提案人也要按確認）。payload 帶 `title`、提案 id、到期時間，不帶其他人的聯絡資料。
   */
  'proposal.invited': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '你收到一份分組邀請' },
  },
  /** 組別成立（票 13；產品模組 08 §4「組別成立→成立後全員一則」）。收件人＝全體成員。 */
  'group.established': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '你的組別已成立' },
  },
  /**
   * 提案終止（票 13；產品模組 08 §4「提案終止→提案人與全部被邀請者，按使用者去重」）。
   * payload 帶終止種類，**不帶管理員作廢的理由**（S03-07：學生看到的通知不含內部備註）。
   */
  'proposal.terminated': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '分組提案已終止' },
  },
  /**
   * 管理員加入或移出組員（票 14；產品模組 08 §4「成員加入／移出→異動前後成員的聯集與目前主指導」）。
   * 收件人＝異動**後**的全體成員（加入時含新成員）；被移出的人改收下面的 `group.member_removed`，
   * 兩則合起來就是前後聯集。主指導在 S06 才有，到時候補進收件人。payload 帶 `title`、組別與異動的人，**不帶理由**。
   *
   * 這也是**重簽的掛點**：成員集合改變時，模組 07（S11）的 `supersedeForParticipantChange` 要讓目前簽核版本失效。
   * 簽核還沒做，所以現在只有通知消費者；只換組長不發這個事件（不重簽）。
   */
  'group.members_changed': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '你的組別成員有異動' },
  },
  /** 被移出的本人（票 14；產品 08 §4「被移出者只取得本人異動說明」）：只說他離開了哪一組，不帶組別內容與理由。 */
  'group.member_removed': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '你已被移出組別' },
  },
  /** 換組長（票 14；產品 08 §4「組長更換→全組，清楚列出新組長」）。收件人＝全體成員；不帶理由。 */
  'group.leader_changed': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '你的組別換了組長' },
  },
  /**
   * 新收件發布（票 15；產品模組 08 §4「新收件發布→收件名單成員：個人收件通知本人，組別收件展開通知該組有效成員」）。
   * 一定發；發布更新時新加入收件名單的人也收這一種（「加入收件名單→與發布時同一種新收件通知」）。
   * payload 只帶項目 id、標題、位置與截止，不帶正文。
   */
  'item.published': {
    consumers: ['notifications'],
    notification: { kind: 'submission', defaultTitle: '有一份新的收件' },
  },
  /**
   * 公告、資源發布（票 15；產品模組 08 §4「重要公告發布→受眾」）：管理員選要通知才發。
   * 收件人＝對象展開（本屆學生、指定組別成員、全部老師）；公開與所有登入者不展開，只留事件。
   */
  'item.announced': {
    consumers: ['notifications'],
    notification: { kind: 'system', defaultTitle: '有新的專題事務公告' },
  },
  /** 已發布項目的發布更新（票 15；產品模組 08 §4「小幅修改→管理員選擇」）：管理員選通知才發。 */
  'item.updated': {
    consumers: ['notifications'],
    notification: { kind: 'system', defaultTitle: '專題事務已更新' },
  },
} as const satisfies Record<string, CatalogEntry>

export type EventType = keyof typeof EVENT_CATALOG

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_CATALOG, value)
}

export function consumersOf(type: EventType): readonly EventConsumer[] {
  return EVENT_CATALOG[type].consumers
}

/** 這種事件投影成通知時的樣子；不進通知匣的事件回 null。 */
export function notificationPresentationOf(type: EventType): NotificationPresentation | null {
  const entry: CatalogEntry = EVENT_CATALOG[type]
  return entry.notification ?? null
}

export type EventActor =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: Exclude<ActorKind, 'user'> }

/** 業務動作要發的一個事件。 */
export type DomainEventInput = {
  readonly type: EventType
  readonly scope: Scope
  /** `scope='cohort'` 時必填；`global` 時必須是空的（契約 01 §1 scope 規則）。 */
  readonly cohortId?: string | null
  /** 事件的來源物件與版本，例如 `{ type: 'project_event', id, version: 3 }`。 */
  readonly source: { readonly type: string; readonly id: string; readonly version?: number | null }
  readonly actor: EventActor
  /** 寫入當下就固定的收件人 user id。重複的會合併，順序不重要。 */
  readonly recipients: readonly string[]
  /** 收件人是怎麼算出來的（membership、名單版本、指派版本 ID），追溯用。 */
  readonly recipientBasis?: Record<string, unknown>
  /** 只放 ID 與標題；**不放私有正文**（契約 01 §4.5）。 */
  readonly payload?: Record<string, unknown>
  /** 真實時間與業務時間都要存（契約 01 §1）。 */
  readonly occurredRealAt: Date
  readonly occurredBusinessAt: Date
}

/** 寫入前整理好的事件：收件人已去重排序、消費者已依目錄決定。 */
export type NormalizedDomainEvent = Omit<DomainEventInput, 'recipients' | 'cohortId'> & {
  readonly cohortId: string | null
  readonly recipients: readonly string[]
  readonly consumers: readonly EventConsumer[]
}

/**
 * 事件內容不合規則。這是**程式寫錯**（型別不在目錄、scope 與屆別對不上），
 * 不是使用者輸入錯——所以丟例外讓整筆交易回滾，而不是回一個給使用者看的 Result。
 */
export class DomainEventRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainEventRejected'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function normalizeDomainEvent(input: DomainEventInput): NormalizedDomainEvent {
  if (!isEventType(input.type)) {
    throw new DomainEventRejected(`事件型別 ${String(input.type)} 沒有在 EVENT_CATALOG 登記`)
  }
  const cohortId = input.cohortId ?? null
  if ((input.scope === 'cohort') !== (cohortId !== null)) {
    throw new DomainEventRejected('scope=cohort 必須帶 cohortId；scope=global 不可以帶')
  }
  if (!UUID.test(input.source.id)) throw new DomainEventRejected('事件來源 id 必須是 uuid')
  for (const recipient of input.recipients) {
    if (!UUID.test(recipient)) throw new DomainEventRejected(`收件人 ${recipient} 不是 uuid`)
  }
  if (input.actor.kind === 'user' && !UUID.test(input.actor.userId)) {
    throw new DomainEventRejected('操作者 id 必須是 uuid')
  }

  // 同一人兼具多個收件身分也只收一則（產品模組 08 §4「去重」）：在寫入時就合併。
  const recipients = [...new Set(input.recipients.map((id) => id.toLowerCase()))].sort()

  return { ...input, cohortId, recipients, consumers: consumersOf(input.type) }
}

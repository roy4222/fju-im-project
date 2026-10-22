import type { ResolvedActor } from '@/application/accounts'
import type { ConsentPurpose } from '@/application/items/items'
import { err, ok, type Result } from '@/shared/result'

/**
 * 站內同意書作業跟簽核包的接點（C 階段規格① §1.2、§3.1）。
 *
 * 同意書是一種作業（`consent_mode='form'`）：作業模組在**自己的交易裡**呼叫這個 hook，由簽核模組建包、建新版、作廢；
 * 任何一步回 `Err`（例如最終文件授權有組沒有成果展示草稿）就整筆回滾，作業仍是草稿。
 * 實作在簽核模組（C1-03 的 `PgConsentPublishHook`），由 `composition/items.ts` 注入；還沒接上時是 `noopConsentPublishHook`
 * （什麼都不建、回 0），作業本身照常發布。
 *
 * `Tx` 是呼叫端交易（infrastructure 用 `PoolClient`）；application 不知道它的形狀。
 */

/** 交給 hook 的作業內容（發布或發布更新**之後**的樣子）。 */
export type ConsentItem = {
  readonly id: string
  readonly cohortId: string
  /** 目前名單上的對象組（整組一份，一組一包）。 */
  readonly groupIds: readonly string[]
  /** 清理後的正文（＝簽核版本的內容）。 */
  readonly bodyHtml: string
  /** 作業目前的附件（依畫面順序）；簽核版本以「作業附件」來源綁這幾個檔。 */
  readonly attachmentFileIds: readonly string[]
  /** 簽核包的用途（`managed_items.consent_purpose`）。 */
  readonly purpose: ConsentPurpose
  readonly dueAt: Date | null
}

export type ConsentSkip = { readonly groupId: string; readonly reason: 'no_advisor' | 'no_members' }

export type ConsentPublished = { readonly created: number; readonly skipped: readonly ConsentSkip[] }

export interface ConsentPublishHook<Tx = unknown> {
  /** 發布：每個對象組建包＋第 1 版（沒有主指導或沒有組員的組跳過、列在 `skipped`）。 */
  onPublished(tx: Tx, item: ConsentItem, actorUserId: string, requestId: string): Promise<Result<ConsentPublished>>
  /** 發布更新且正文或附件有變：每個進行中的包建新版（舊版取代、舊同意留歷史）。 */
  onContentChanged(
    tx: Tx,
    item: ConsentItem,
    actorUserId: string,
    requestId: string,
  ): Promise<Result<{ readonly superseded: number; readonly created: number }>>
  /** 系辦在繳交狀況頁對「尚未建立」的組按「建立」（指派老師後）。自己開交易，不在作業的交易裡。 */
  createForGroup(
    actor: ResolvedActor,
    input: { readonly itemId: string; readonly groupId: string },
    requestId: string,
  ): Promise<Result<{ readonly packageId: string; readonly versionId: string }>>
  /** 發布更新把組移出對象：那幾組目前的版本作廢（理由「系辦移出對象」）。 */
  onGroupsRemoved(
    tx: Tx,
    itemId: string,
    groupIds: readonly string[],
    actorUserId: string,
    requestId: string,
  ): Promise<Result<{ readonly voided: number }>>
}

function receipt(requestId: string) {
  return { requestId, serverTime: new Date().toISOString() }
}

/**
 * 還沒接上簽核模組時的預設：什麼都不建，作業照常發布（每一組都不算 skipped——不是因為缺老師或組員）。
 * `createForGroup` 沒有東西可建，回 `VALIDATION_FAILED`。
 */
export const noopConsentPublishHook: ConsentPublishHook = {
  async onPublished(_tx, _item, _actorUserId, requestId) {
    return ok({ created: 0, skipped: [] }, receipt(requestId))
  },
  async onContentChanged(_tx, _item, _actorUserId, requestId) {
    return ok({ superseded: 0, created: 0 }, receipt(requestId))
  },
  async createForGroup() {
    return err('VALIDATION_FAILED', '站內同意書還沒有接上簽核功能，暫時不能建立。')
  },
  async onGroupsRemoved(_tx, _itemId, _groupIds, _actorUserId, requestId) {
    return ok({ voided: 0 }, receipt(requestId))
  },
}

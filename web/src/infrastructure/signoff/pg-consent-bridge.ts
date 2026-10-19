import 'server-only'
import type { PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import { cohortLabel, type BusinessClockSource } from '@/application/cohorts'
import { sanitizeBody, type ConsentItem, type ConsentPublished, type ConsentPublishHook, type ConsentSkip } from '@/application/items'
import { canonicalJson, type OperationLedger } from '@/application/ops'
import {
  consentSkipReason,
  describeMissingDrafts,
  GROUP_REMOVED_REASON,
  hasVisibleText,
  isTerminal,
  readAuthorizationScope,
  rebuildsOnContentChange,
  type AuthorizationScope,
  type SignoffPurpose,
  type SignoffState,
} from '@/application/signoff'
import { authorizeAdmin, badRequestId, inTransaction, replayed, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import {
  currentAdvisor,
  currentMembers,
  groupNotFound,
  lockGroup,
  lockItemPackage,
  type CohortRow,
  type GroupRow,
  type LockedPackage,
  type PgSignoffCommand,
} from '@/infrastructure/signoff/pg-signoff'
import { err, ok, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 同意書作業 ↔ 簽核包的橋接（C 階段規格① §1.2、§3.1、§3.3、§6.4；C1-03）。實作 `ConsentPublishHook`，由 `composition/items.ts`
 * 注入給作業模組；`onPublished`／`onContentChanged`／`onGroupsRemoved` **跑在作業模組的交易裡**（回 `Err` 就整筆回滾，
 * 作業仍是草稿或沒更新），`createForGroup` 自己開交易（系辦在繳交狀況頁按「建立」補建）。
 *
 * 建版本體重用 `PgSignoffCommand.createVersionInTx`（和舊 API 同一段：參與者快照、凍結、綁附件、失效、通知、稽核）。
 * 附件以 **item 來源**綁（`purpose:'attachment'`＋`heldBy: item_attachment`），不冒充繳交檔。
 *
 * 鎖序（§1.2）：`cohorts FOR SHARE → groups FOR SHARE → managed_items FOR UPDATE → signoff_packages FOR UPDATE`。作業模組呼叫 hook 時
 * 已經拿著 `cohorts FOR SHARE` 與 `managed_items FOR UPDATE`，這裡再逐組拿 `groups FOR SHARE` 與簽核包；調組員的交易拿 `groups FOR UPDATE`
 * 再鎖簽核包、不碰 `managed_items`，所以發布同意書與同時改組員只會一先一後：先改組員 → 新版快照含新組員；先發布 → 改組員那筆把剛建的版本
 * 標失效（`supersedeForParticipantChange`）。`createForGroup` 自己按完整鎖序拿。
 */

type Deps = {
  signoff: PgSignoffCommand
  ledger: OperationLedger<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

type ItemRow = {
  id: string
  cohort_id: string
  title: string
  status: string
  body_html: string
  consent_mode: string | null
  consent_purpose: SignoffPurpose | null
  content_version_no: number
}

function receipt(requestId: string, serverTime: Date) {
  return { requestId, serverTime: serverTime.toISOString() }
}

export class PgConsentPublishHook implements ConsentPublishHook<PoolClient> {
  readonly #signoff: PgSignoffCommand
  readonly #ledger: OperationLedger<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#signoff = deps.signoff
    this.#ledger = deps.ledger
    this.#businessClock = deps.businessClock
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  /**
   * 發布：每個對象組建包＋第 1 版。沒有主指導或沒有組員的組跳過（`skipped`，之後由系辦補建）；最終文件授權**任一**對象組沒有
   * 成果展示草稿 → 整筆 `VALIDATION_FAILED`（列出組別），一包都不建（§1.2「缺老師＝跳過、缺草稿＝拒絕」）。
   * 第 1 版發既有 `signoff.version_created` 給組員（作業模組對站內同意書不另發 `item.published`）。
   * 撤回後重新發布：已有一版在跑的組，內容與附件都沒變就不動；有變就同內容改版（新版 cause `content_change`、沿用舊版凍結的範圍、
   * 只發 `signoff.content_changed`），也算進 `created`。
   */
  async onPublished(tx: PoolClient, item: ConsentItem, actorUserId: string, requestId: string): Promise<Result<ConsentPublished>> {
    const checked = await this.#contentOf(tx, item)
    if (!checked.ok) return checked
    const { content, contentChecksum, meta } = checked
    const businessAt = await this.#businessClock.now()
    const realAt = this.#realClock.now()

    // 先逐組把事實看完（老師、組員、既有版本、草稿）再動手：缺草稿要一次列出所有組，而且不能先建了幾包才發現。
    const skipped: ConsentSkip[] = []
    const missingDrafts: string[] = []
    type Plan =
      | { cohort: CohortRow; group: GroupRow; pkg: LockedPackage; mode: 'fresh'; entryId: string | null }
      | { cohort: CohortRow; group: GroupRow; pkg: LockedPackage; mode: 'content_changed'; live: LiveVersion }
    const plans: Plan[] = []
    for (const groupId of [...item.groupIds].sort()) {
      const locked = await lockGroup(tx, groupId)
      if (!locked) return groupNotFound()
      const { cohort, group } = locked
      if (group.status === 'dissolved') {
        skipped.push({ groupId, reason: 'no_members' })
        continue
      }
      const facts = { memberCount: (await currentMembers(tx, group.id)).length, hasAdvisor: (await currentAdvisor(tx, group.id)) !== null }
      const skip = consentSkipReason(facts)
      if (skip) {
        skipped.push({ groupId, reason: skip })
        continue
      }
      const pkg = await lockItemPackage(tx, { cohort, group, itemId: item.id, purpose: item.purpose, adminId: actorUserId, realAt, create: true })
      if (!pkg) return groupNotFound()
      // 撤回後重新發布：這組已經有一版在跑。內容與附件都沒變就不再建（免得同一份內容再發一次通知）；
      // 有變就跟「發布更新改內容」一樣建新版、沿用舊版凍結的範圍、只發 content_changed（§6.4：內容變＝全員重新同意；Review r1）。
      // 這條路不再查成果展示草稿：範圍是沿用舊版凍結的，不因此刻缺草稿把整筆擋下（Review r1 選用 3）。
      const live = pkg.current_version_id ? await liveVersionOf(tx, pkg.current_version_id) : null
      if (live) {
        if (live.contentChecksum === contentChecksum && sameSet(live.fileIds, item.attachmentFileIds)) continue
        plans.push({ cohort, group, pkg, mode: 'content_changed', live })
        continue
      }
      let entryId: string | null = null
      if (item.purpose === 'final_document') {
        entryId = await draftEntryOf(tx, group.id)
        if (!entryId) {
          missingDrafts.push(group.code)
          continue
        }
      }
      plans.push({ cohort, group, pkg, mode: 'fresh', entryId })
    }
    if (missingDrafts.length > 0) {
      return err('VALIDATION_FAILED', describeMissingDrafts(missingDrafts), { details: { field: 'consent_drafts', groups: missingDrafts } })
    }

    let created = 0
    for (const plan of plans) {
      const built = await this.#signoff.createVersionInTx(tx, {
        cohort: plan.cohort,
        group: plan.group,
        pkg: plan.pkg,
        content,
        contentChecksum,
        attachments: { source: 'item_attachment', itemId: item.id, itemTitle: meta.title, itemVersionNo: meta.content_version_no, fileIds: item.attachmentFileIds },
        scope:
          plan.mode === 'fresh'
            ? plan.entryId
              ? { kind: 'draft', entryId: plan.entryId }
              : { kind: 'none' }
            : { kind: 'carry_over', fromVersionId: plan.live.versionId, scope: plan.live.scope },
        notify: plan.mode === 'fresh' ? 'version_created' : 'content_changed',
        adminId: actorUserId,
        realAt,
        businessAt,
      })
      if (!built.ok) return built
      created += 1
    }
    return ok({ created, skipped }, receipt(requestId, realAt))
  }

  /**
   * 發布更新且正文或附件有變（#161，§6.4）：每個目前版本在收集中／等老師／已完成／退回修正中的包建新版（cause `content_change`，
   * 舊版 `superseded`、舊同意留歷史不計入新版）；授權範圍沿用舊版凍結的；附件以 item 來源重綁新集合。
   * 新版**只**發 `signoff.content_changed` 給被取代那一版的全部參與者（含已同意的學生與主指導）、不發 `version_created`；
   * `signoff.superseded` 照舊只留事件（系辦自己改的，recipients 空）。還沒建包的組（缺老師）、已失效／作廢的不動。
   */
  async onContentChanged(
    tx: PoolClient,
    item: ConsentItem,
    actorUserId: string,
    requestId: string,
  ): Promise<Result<{ readonly superseded: number; readonly created: number }>> {
    const checked = await this.#contentOf(tx, item)
    if (!checked.ok) return checked
    const { content, contentChecksum, meta } = checked
    const businessAt = await this.#businessClock.now()
    const realAt = this.#realClock.now()
    let created = 0
    let superseded = 0
    for (const groupId of [...item.groupIds].sort()) {
      const locked = await lockGroup(tx, groupId)
      if (!locked) continue
      const { cohort, group } = locked
      if (group.status === 'dissolved') continue
      const pkg = await lockItemPackage(tx, { cohort, group, itemId: item.id, purpose: item.purpose, adminId: actorUserId, realAt, create: false })
      if (!pkg?.current_version_id) continue
      if (!rebuildsOnContentChange(await stateOf(tx, pkg.current_version_id))) continue
      const previous = (
        await tx.query<{ authorization_scope: unknown }>('select authorization_scope from signoff_package_versions where id = $1', [pkg.current_version_id])
      ).rows[0]
      const built = await this.#signoff.createVersionInTx(tx, {
        cohort,
        group,
        pkg,
        content,
        contentChecksum,
        attachments: { source: 'item_attachment', itemId: item.id, itemTitle: meta.title, itemVersionNo: meta.content_version_no, fileIds: item.attachmentFileIds },
        scope: { kind: 'carry_over', fromVersionId: pkg.current_version_id, scope: readAuthorizationScope(previous?.authorization_scope ?? null) },
        notify: 'content_changed',
        adminId: actorUserId,
        realAt,
        businessAt,
      })
      if (!built.ok) return built
      created += 1
      if (built.value.supersededVersionNo !== null) superseded += 1
    }
    return ok({ superseded, created }, receipt(requestId, realAt))
  }

  /**
   * 系辦對「尚未建立」的組按「建立」（AC-25）：指派老師後補建這一組的包＋第 1 版，發 `signoff.version_created`。
   * 自己開交易、完整鎖序；同一請求編號重送回同一張回執。作業要是已發布的站內同意書、這組要在目前名單上、還沒有進行中的版本。
   */
  async createForGroup(
    actor: ResolvedActor,
    input: { readonly itemId: string; readonly groupId: string },
    requestId: string,
  ): Promise<Result<{ readonly packageId: string; readonly versionId: string }>> {
    const blocked = authorizeAdmin(actor, '建立同意書')
    if (blocked) return blocked
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.groupId)) return groupNotFound()
    if (!isUuid(input.itemId)) return notConsentItem()
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessAt = await this.#businessClock.now()

    return inTransaction(this.#pool, 'signoff', async (tx) => {
      const locked = await lockGroup(tx, input.groupId)
      if (!locked) return groupNotFound()
      const { cohort, group } = locked
      const item = (
        await tx.query<ItemRow>(
          `select m.id, m.cohort_id, m.title, m.status, m.body_html, m.consent_mode, m.consent_purpose, coalesce(v.version_no, 0)::int as content_version_no
             from managed_items m left join item_versions v on v.id = m.current_content_version_id
            where m.id = $1 and m.deleted_at is null for update of m`,
          [input.itemId],
        )
      ).rows[0]
      if (!item || item.consent_mode !== 'form' || !item.consent_purpose || item.cohort_id !== cohort.id) return notConsentItem()
      if (item.status !== 'published') return err('VALIDATION_FAILED', '這份同意書還沒發布（或已下架），發布後才能替組別建立。')
      const onRoster = await tx.query(
        `select 1 from response_rosters where item_id = $1 and receiver_kind = 'group' and receiver_id = $2 and eligible_to_business_at is null`,
        [item.id, group.id],
      )
      if ((onRoster.rowCount ?? 0) === 0) return err('VALIDATION_FAILED', `${group.code} 不在這份同意書的對象裡，請先把它加進對象再建立。`)

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'signoff.version_create',
          requestId,
          fingerprint: sha256(canonicalJson({ itemId: item.id, groupId: group.id })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<{ packageId: string; versionId: string }>(begun)
      if (cohort.status === 'archived') return err('COHORT_ARCHIVED', `${cohortLabel(cohort)}已封存，同意書只能查看。`)
      if (group.status === 'dissolved') return err('GROUP_DISSOLVED', `${group.code} 已解散，不能再建立同意書。`)

      const pkg = await lockItemPackage(tx, { cohort, group, itemId: item.id, purpose: item.consent_purpose, adminId, realAt, create: true })
      if (!pkg) return groupNotFound()
      if (pkg.current_version_id && !isTerminal(await stateOf(tx, pkg.current_version_id))) {
        return err('CONFLICT', `${group.code} 已經有這份同意書了，請重新整理頁面。`)
      }
      let entryId: string | null = null
      if (item.consent_purpose === 'final_document') {
        entryId = await draftEntryOf(tx, group.id)
        if (!entryId) return err('VALIDATION_FAILED', describeMissingDrafts([group.code]), { details: { field: 'consent_drafts', groups: [group.code] } })
      }
      const content = sanitizeBody(item.body_html)
      if (!hasVisibleText(content)) return err('VALIDATION_FAILED', '這份同意書的全文是空的，請先補上內容再建立。')
      const attachments = (
        await tx.query<{ file_id: string }>('select file_id from item_attachments where item_id = $1 order by sort, file_id', [item.id])
      ).rows.map((r) => r.file_id)
      const built = await this.#signoff.createVersionInTx(tx, {
        cohort,
        group,
        pkg,
        content,
        contentChecksum: sha256(content),
        attachments: { source: 'item_attachment', itemId: item.id, itemTitle: item.title, itemVersionNo: item.content_version_no, fileIds: attachments },
        scope: entryId ? { kind: 'draft', entryId } : { kind: 'none' },
        notify: 'version_created',
        adminId,
        realAt,
        businessAt,
      })
      if (!built.ok) return built
      const out = { packageId: pkg.id, versionId: built.value.versionId, ...receipt(requestId, realAt) }
      await this.#ledger.commit(tx, begun.recordId, { receipt: out, resultRef: { packageId: pkg.id, versionId: built.value.versionId } })
      return { ok: true as const, receipt: out }
    })
  }

  /** 發布更新把組移出對象（§6.4）：那幾組目前的版本作廢，`cause` 固定 `void`、理由「系辦移出對象」進稽核與事件。 */
  async onGroupsRemoved(
    tx: PoolClient,
    itemId: string,
    groupIds: readonly string[],
    actorUserId: string,
    requestId: string,
  ): Promise<Result<{ readonly voided: number }>> {
    const businessAt = await this.#businessClock.now()
    const realAt = this.#realClock.now()
    let voided = 0
    for (const groupId of [...groupIds].sort()) {
      const locked = await lockGroup(tx, groupId)
      if (!locked) continue
      const { cohort, group } = locked
      const pkg = await lockItemPackage(tx, { cohort, group, itemId, adminId: actorUserId, realAt, create: false })
      if (!pkg) continue
      if (await this.#signoff.voidCurrentInTx(tx, { cohort, group, pkg, reason: GROUP_REMOVED_REASON, adminId: actorUserId, realAt, businessAt })) voided += 1
    }
    return ok({ voided }, receipt(requestId, realAt))
  }

  /** 作業交來的正文 → 清洗後的全文與 checksum；作業標題與內容版本號（附件來源的標示）。 */
  async #contentOf(
    tx: PoolClient,
    item: ConsentItem,
  ): Promise<{ ok: true; content: string; contentChecksum: string; meta: { title: string; content_version_no: number } } | Err> {
    const content = sanitizeBody(String(item.bodyHtml ?? ''))
    if (!hasVisibleText(content)) return err('VALIDATION_FAILED', '同意書全文必填：請貼上要大家閱讀並同意的內容。', { details: { field: 'body' } })
    const meta = (
      await tx.query<{ title: string; content_version_no: number }>(
        `select m.title, coalesce(v.version_no, 0)::int as content_version_no
           from managed_items m left join item_versions v on v.id = m.current_content_version_id
          where m.id = $1`,
        [item.id],
      )
    ).rows[0]
    if (!meta) return notConsentItem()
    return { ok: true, content, contentChecksum: sha256(content), meta }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

function notConsentItem(): Err {
  return err('VALIDATION_FAILED', '找不到這份站內同意書作業，請重新整理頁面。', { details: { field: 'itemId' } })
}

type LiveVersion = { versionId: string; contentChecksum: string; fileIds: string[]; scope: AuthorizationScope | null }

/** 簽核包目前那一版還在跑（非失效／作廢）的話，回它的內容核對碼、附件集合與凍結範圍；終態回 null。狀態列 `FOR UPDATE`。 */
async function liveVersionOf(tx: PoolClient, versionId: string): Promise<LiveVersion | null> {
  const row = (
    await tx.query<{ state: SignoffState; content_checksum: string; attachment_file_versions: unknown; authorization_scope: unknown }>(
      `select s.state, v.content_checksum, v.attachment_file_versions, v.authorization_scope
         from signoff_version_status s join signoff_package_versions v on v.id = s.version_id
        where s.version_id = $1 for update of s`,
      [versionId],
    )
  ).rows[0]
  if (!row || isTerminal(row.state)) return null
  const attachments = Array.isArray(row.attachment_file_versions) ? (row.attachment_file_versions as { fileId?: unknown }[]) : []
  return {
    versionId,
    contentChecksum: row.content_checksum,
    fileIds: attachments.map((a) => String(a.fileId ?? '')),
    scope: readAuthorizationScope(row.authorization_scope),
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort()
  const right = [...new Set(b)].sort()
  return left.length === right.length && left.every((id, i) => id === right[i])
}

async function stateOf(tx: PoolClient, versionId: string): Promise<SignoffState> {
  const row = (await tx.query<{ state: SignoffState }>('select state from signoff_version_status where version_id = $1 for update', [versionId])).rows[0]
  return row?.state ?? 'void'
}

/** 這一組目前的成果展示條目（有草稿的）；沒有回 null（最終文件授權要凍結的來源）。 */
async function draftEntryOf(tx: PoolClient, groupId: string): Promise<string | null> {
  const row = (
    await tx.query<{ id: string }>(
      `select e.id from showcase_entries e join showcase_drafts d on d.entry_id = e.id
        where e.group_id = $1 and e.deleted_at is null order by e.created_at desc nulls last, e.id limit 1`,
      [groupId],
    )
  ).rows[0]
  return row?.id ?? null
}

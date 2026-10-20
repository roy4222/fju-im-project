import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'

/**
 * e2e 的測試準備：直接用 owner 連線建一版「舊同意書」（沒連作業的簽核包，`item_id is null`）。
 *
 * C2-22 起系辦的舊同意書頁（`/dashboard/admin/signoff`，「新增站內同意書」視窗）改成轉址到作業分頁，畫面上沒有建舊包的入口了；
 * 但同意、不同意、退回、組員或主指導變更後失效、舊版唯讀、匯出這些**行為**仍要驗，前提就由這裡建。
 *
 * 寫法照正式建版（`infrastructure/signoff/pg-signoff.ts` 的 `createVersion` → `lockLegacyPackage` → `createVersionInTx`）逐步照抄，
 * 同一個交易寫同樣的列：
 * - 簽核包：一組一用途一個、`item_id is null`（沒有就建）；
 * - 版本內容（不可變）＋狀態頭列 `collecting`；參與者快照＝此刻有效組員（依學號排序）＋主指導；
 * - 附件只能是這一組正式送出的繳交檔（`file_references` 綁到版本，`heldBy` 是那次繳交）；
 * - 最終文件授權的範圍從這一組的成果展示草稿「此刻」的內容凍結，海報一起綁到版本；
 * - 同一包原本的目前版本還沒失效或作廢 → `superseded`（cause `content_change`），新版 `supersede_cause` 照 `causeForNewVersion`；
 * - 事件：`signoff.version_created` 發給參與學生（通知匣「輪到你閱讀並同意」靠它），舊版失效另發一筆收件人為空的 `signoff.superseded`；
 * - 稽核：`signoff.version_create`（匯出的操作歷程讀它）、舊版的 `signoff.version_supersede`。
 *
 * 規則（全文必填、組別要有組員與主指導……）不在這裡判：那是用例的事，整合測試逐條驗；這裡只給 e2e 合法的前提。
 */

export type LegacyPurpose = 'result_confirmation' | 'final_document'

export type LegacyVersionInput = {
  groupId: string
  purpose: LegacyPurpose
  content: string
  /** 建版的系辦（`created_by_user_id`、稽核與事件的操作者）。 */
  adminId: string
  /** 這一組正式送出的繳交檔（`stored_files.id`）。 */
  attachmentFileIds?: readonly string[]
  /** 最終文件授權：從這一組的成果展示草稿凍結範圍（沒給就用這一組唯一一份未刪除的作品）。 */
  scopeFromDraft?: boolean
}

export type LegacyVersion = { versionId: string; versionNo: number; supersededVersionNo: number | null }

const PURPOSE_LABEL: Record<LegacyPurpose, string> = { result_confirmation: '期中結果確認', final_document: '最終文件授權' }

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 鍵排序後的 JSON（同 `application/ops/records.ts` 的 canonicalJson：只用來算範圍的 contentHash）。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export async function createLegacyVersion(pool: Pool, input: LegacyVersionInput): Promise<LegacyVersion> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const created = await insertLegacyVersion(client, input)
    await client.query('commit')
    return created
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

async function insertLegacyVersion(tx: PoolClient, input: LegacyVersionInput): Promise<LegacyVersion> {
  const { groupId, purpose, content, adminId } = input
  const group = (await tx.query<{ cohort_id: string; code: string }>('select cohort_id, code from groups where id = $1 for share', [groupId])).rows[0]
  if (!group) throw new Error(`legacy-signoff：找不到組別 ${groupId}`)
  const cohortId = group.cohort_id

  await tx.query(
    `insert into signoff_packages (id, group_id, cohort_id, purpose, created_at, created_by_user_id, updated_at, updated_by_user_id)
     values ($1, $2, $3, $4, now(), $5, now(), $5)
     on conflict (group_id, purpose) where item_id is null do nothing`,
    [uuidv7(), groupId, cohortId, purpose, adminId],
  )
  const pkg = (
    await tx.query<{ id: string; current_version_id: string | null }>(
      `select id, current_version_id from signoff_packages where group_id = $1 and purpose = $2 and item_id is null for update`,
      [groupId, purpose],
    )
  ).rows[0]!

  const previous = pkg.current_version_id
    ? (
        await tx.query<{ version_id: string; version_no: number; state: string; cause: string | null }>(
          `select s.version_id, v.version_no, s.state, s.cause
             from signoff_version_status s join signoff_package_versions v on v.id = s.version_id
            where s.version_id = $1 for update of s`,
          [pkg.current_version_id],
        )
      ).rows[0]!
    : null

  // 參與者快照（`currentMembers`／`currentAdvisor`／`buildParticipants`）。
  const members = await tx.query<{ membership_id: string; user_id: string; name: string; student_no: string | null }>(
    `select m.id as membership_id, m.user_id, coalesce(p.display_name, u.name) as name, si.student_no
       from group_memberships m
       join users u on u.id = m.user_id
       left join user_profiles p on p.user_id = m.user_id
       left join student_identities si on si.user_id = m.user_id and si.cohort_id = m.cohort_id
      where m.group_id = $1 and m.valid_to is null`,
    [groupId],
  )
  const advisorRow = (
    await tx.query<{ id: string; teacher_user_id: string; name: string }>(
      `select a.id, a.teacher_user_id, coalesce(p.display_name, u.name) as name
         from advisor_assignments a
         join users u on u.id = a.teacher_user_id
         left join user_profiles p on p.user_id = a.teacher_user_id
        where a.group_id = $1 and a.valid_to is null`,
      [groupId],
    )
  ).rows[0]
  if (members.rows.length === 0 || !advisorRow) throw new Error(`legacy-signoff：${group.code} 要有有效組員與主指導才能建版`)
  const students = members.rows
    .map((r) => ({ userId: r.user_id, displayName: r.name, studentNo: r.student_no, membershipId: r.membership_id }))
    .sort((a, b) => (a.studentNo ?? '￿').localeCompare(b.studentNo ?? '￿') || a.displayName.localeCompare(b.displayName, 'zh-Hant'))
  const participants = { students, advisor: { userId: advisorRow.teacher_user_id, displayName: advisorRow.name, assignmentId: advisorRow.id } }

  const versionId = uuidv7()
  const attach = async (fileId: string, heldByType: string, heldById: string) => {
    const held = await tx.query(`select 1 from file_references where file_id = $1 and ref_type = $2 and ref_id = $3 and released_at is null`, [
      fileId,
      heldByType,
      heldById,
    ])
    if ((held.rowCount ?? 0) === 0) throw new Error(`legacy-signoff：檔案 ${fileId} 沒有被 ${heldByType} 持有`)
    await tx.query(
      `insert into file_references (id, file_id, ref_type, ref_id) values ($1, $2, 'signoff_version', $3)
       on conflict (file_id, ref_type, ref_id) where released_at is null do nothing`,
      [uuidv7(), fileId, versionId],
    )
    return (await tx.query<{ checksum: string }>('select checksum from stored_files where id = $1', [fileId])).rows[0]!.checksum
  }

  // 授權範圍（`lockDraft`＋`freezeAuthorizationScope`）。
  let scope: Record<string, unknown> | null = null
  if (input.scopeFromDraft) {
    const d = (
      await tx.query<{
        entry_id: string
        revision: number
        title: string
        summary: string
        summary_checksum: string
        video_url: string | null
        poster_file_id: string | null
        poster_checksum: string | null
        poster_name: string | null
      }>(
        `select d.entry_id, d.revision, d.title, d.summary, d.summary_checksum, d.video_url, d.poster_file_id, d.poster_checksum,
                f.original_name as poster_name
           from showcase_entries e
           join showcase_drafts d on d.entry_id = e.id
           left join stored_files f on f.id = d.poster_file_id
          where e.group_id = $1 and e.deleted_at is null
          for share of d`,
        [groupId],
      )
    ).rows[0]
    if (!d || d.title.trim() === '' || d.summary.trim() === '') throw new Error(`legacy-signoff：${group.code} 的成果展示草稿要有題目與摘要`)
    const poster = d.poster_file_id && d.poster_checksum ? { fileId: d.poster_file_id, checksum: d.poster_checksum, name: d.poster_name ?? '海報' } : null
    const contentHash = sha256(
      canonical({ title: d.title, summaryChecksum: d.summary_checksum, videoUrl: d.video_url, poster: poster ? { fileId: poster.fileId, checksum: poster.checksum } : null }),
    )
    scope = {
      usages: ['public_showcase'],
      title: d.title,
      summary: d.summary,
      summaryChecksum: d.summary_checksum,
      assets: poster ? [{ fileId: poster.fileId, checksum: poster.checksum, kind: 'poster', name: poster.name }] : [],
      videoUrl: d.video_url,
      validUntil: null,
      scopeSource: { entryId: d.entry_id, draftRevision: d.revision, contentHash },
    }
    if (poster) await attach(poster.fileId, 'showcase_draft', d.entry_id)
  }

  // 附件：這一組正式送出的繳交檔（`submittedFileOf`），綁那一刻的 checksum。
  const attachments: unknown[] = []
  for (const fileId of input.attachmentFileIds ?? []) {
    const source = (
      await tx.query<{ submission_version_id: string; name: string; item_title: string; version_no: number }>(
        `select sf.submission_version_id, f.original_name as name, m.title as item_title, v.version_no
           from submission_files sf
           join submission_versions v on v.id = sf.submission_version_id
           join managed_items m on m.id = v.item_id
           join stored_files f on f.id = sf.file_id
          where sf.file_id = $1 and v.receiver_kind = 'group' and v.receiver_id = $2
          order by v.received_real_at desc
          limit 1`,
        [fileId, groupId],
      )
    ).rows[0]
    if (!source) throw new Error(`legacy-signoff：${fileId} 不是 ${group.code} 正式送出的繳交檔`)
    const checksum = await attach(fileId, 'submission_version', source.submission_version_id)
    attachments.push({ fileId, checksum, name: source.name, source: { itemTitle: source.item_title, versionNo: source.version_no } })
  }

  const versionNo = Number(
    (await tx.query<{ n: number }>('select coalesce(max(version_no), 0) + 1 as n from signoff_package_versions where package_id = $1', [pkg.id])).rows[0]!.n,
  )
  // `causeForNewVersion`：上一版因組員／主指導變更或重置而失效就沿用，其他是內容變更。
  const supersedeCause = !previous
    ? null
    : previous.state === 'superseded' && ['member_change', 'advisor_change', 'reset'].includes(previous.cause ?? '')
      ? previous.cause
      : 'content_change'

  await tx.query(
    `insert into signoff_package_versions
       (id, package_id, version_no, content_text, content_checksum, attachment_file_versions, participants, supersede_cause,
        authorization_scope, created_by_user_id, created_real_at, created_business_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10, now(), now())`,
    [versionId, pkg.id, versionNo, content, sha256(content), JSON.stringify(attachments), JSON.stringify(participants), supersedeCause, scope ? JSON.stringify(scope) : null, adminId],
  )
  await tx.query(
    `insert into signoff_version_status (version_id, state, created_at, updated_at, updated_by_user_id) values ($1, 'collecting', now(), now(), $2)`,
    [versionId, adminId],
  )

  let supersededVersionNo: number | null = null
  if (previous && previous.state !== 'superseded' && previous.state !== 'void') {
    await tx.query(
      `update signoff_version_status set state = 'superseded', cause = 'content_change', revision = revision + 1, updated_at = now(), updated_by_user_id = $2
        where version_id = $1`,
      [previous.version_id, adminId],
    )
    supersededVersionNo = previous.version_no
    await audit(tx, {
      adminId,
      action: 'signoff.version_supersede',
      targetId: previous.version_id,
      cohortId,
      payload: { groupId, purpose, itemId: null, versionNo: previous.version_no, from: previous.state, cause: 'content_change', replacedBy: versionId },
    })
    // 系辦自己建新版造成的失效：留事件、不通知。
    await publish(tx, {
      type: 'signoff.superseded',
      cohortId,
      sourceId: previous.version_id,
      sourceVersion: previous.version_no,
      adminId,
      recipients: [],
      recipientBasis: { basis: 'admin_own_action' },
      payload: { groupId, code: group.code, purpose, cause: 'content_change', replacedBy: versionId },
    })
  }
  await tx.query(`update signoff_packages set current_version_id = $2, revision = revision + 1, updated_at = now(), updated_by_user_id = $3 where id = $1`, [
    pkg.id,
    versionId,
    adminId,
  ])

  // 輪到本人同意：只發給參與學生。
  await publish(tx, {
    type: 'signoff.version_created',
    cohortId,
    sourceId: versionId,
    sourceVersion: versionNo,
    adminId,
    recipients: [...new Set(students.map((s) => s.userId.toLowerCase()))].sort(),
    recipientBasis: { basis: 'signoff_participants', versionId, groupId },
    payload: { title: `${group.code}「${PURPOSE_LABEL[purpose]}」第 ${versionNo} 版輪到你閱讀並同意`, groupId, code: group.code, purpose, versionNo },
  })
  await audit(tx, {
    adminId,
    action: 'signoff.version_create',
    targetId: versionId,
    cohortId,
    payload: {
      groupId,
      purpose,
      itemId: null,
      versionNo,
      contentChecksum: sha256(content),
      attachmentFileIds: [...(input.attachmentFileIds ?? [])],
      attachmentSource: 'submission',
      studentUserIds: students.map((s) => s.userId),
      advisorUserId: participants.advisor.userId,
      supersedeCause,
      supersededVersionId: supersededVersionNo !== null ? previous!.version_id : null,
      scopeSource: scope?.scopeSource ?? null,
      notify: 'version_created',
    },
  })
  return { versionId, versionNo, supersededVersionNo }
}

/** `PgEventPublisher.publish`：一筆 `domain_events`＋消費者 `notifications` 的投影列（兩種事件都只有這個消費者）。 */
async function publish(
  tx: PoolClient,
  e: {
    type: 'signoff.version_created' | 'signoff.superseded'
    cohortId: string
    sourceId: string
    sourceVersion: number
    adminId: string
    recipients: string[]
    recipientBasis: Record<string, unknown>
    payload: Record<string, unknown>
  },
) {
  const eventId = uuidv7()
  await tx.query(
    `insert into domain_events
       (id, type, scope, cohort_id, source_type, source_id, source_version, actor_kind, actor_user_id,
        occurred_real_at, occurred_business_at, recipients, recipient_basis, payload)
     values ($1, $2, 'cohort', $3, 'signoff_version', $4, $5, 'user', $6, now(), now(), $7::uuid[], $8::jsonb, $9::jsonb)`,
    [eventId, e.type, e.cohortId, e.sourceId, e.sourceVersion, e.adminId, e.recipients, JSON.stringify(e.recipientBasis), JSON.stringify(e.payload)],
  )
  await tx.query(`insert into event_projections (event_id, consumer, state) values ($1, 'notifications', 'pending')`, [eventId])
}

/** `PgAuditWriter.append`。 */
async function audit(tx: PoolClient, a: { adminId: string; action: string; targetId: string; cohortId: string; payload: Record<string, unknown> }) {
  await tx.query(
    `insert into audit_events (id, actor_kind, actor_user_id, role, action, target_type, target_id, scope, cohort_id, real_at, business_at, payload)
     values ($1, 'user', $2, 'admin', $3, 'signoff_version', $4, 'cohort', $5, now(), now(), $6::jsonb)`,
    [uuidv7(), a.adminId, a.action, a.targetId, a.cohortId, JSON.stringify(a.payload)],
  )
}

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { FileFacts, FileRef } from '@/application/ops'
import { createAttachmentPolicy } from '@/infrastructure/items/attachment-policy'
import { sha256 } from '@/infrastructure/ops/audit-writer'

/**
 * 專題事務附件下載政策（`DOWNLOAD_POLICIES.attachment`）接受「經簽核版本讀權驗證」的 `signoff_version` 引用
 * （C 階段規格① §3.3、C1-03；AC-21b 主指導下載整組附件、AC-23a 換檔後舊版仍可下載），其他附件不放寬。
 * 事實直接用 SQL 擺好、政策直接呼叫：只驗這一條規則，不經檔案能力。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
let policy: ReturnType<typeof createAttachmentPolicy>

type Role = 'admin' | 'teacher' | 'student'
function actor(userId: string, roles: Role[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}
const ANON: ResolvedActor = { kind: 'anonymous' }

let seq = 0
async function newUser(name: string, role: Role, cohortId?: string) {
  seq += 1
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `ap${seq}-${randomUUID().slice(0, 6)}@example.com`],
  )
  const id = String(row.rows[0]!.id)
  await owner.sql(`insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`, [id, role])
  const studentNo = role === 'student' ? `4140${String(seq).padStart(5, '0')}` : null
  await owner.sql(`insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email) values ($1, $2, $2, $3, $4, $5)`, [
    id,
    name,
    studentNo,
    cohortId ?? null,
    `c${seq}@example.com`,
  ])
  if (studentNo && cohortId) await owner.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return id
}

async function scenario() {
  seq += 1
  const cohortId = String(
    (
      await owner.sql(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind) values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
        [`AP-${seq}`],
      )
    ).rows[0]!.id,
  )
  const groupId = String(
    (
      await owner.sql(
        `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
         values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
        [cohortId],
      )
    ).rows[0]!.id,
  )
  const members = [await newUser('甲', 'student', cohortId), await newUser('乙', 'student', cohortId)]
  for (const m of members) {
    await owner.sql(`insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, now(), 'system')`, [groupId, cohortId, m])
  }
  const advisor = await newUser('主指導', 'teacher')
  await owner.sql(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason) values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '指派')`,
    [groupId, advisor, adminId],
  )
  // 整組收件、對象只有這一組的已發布同意書作業（附件政策對收件的附件只給組員，老師看不到）。
  const itemId = String(
    (
      await owner.sql(
        `insert into managed_items (id, cohort_id, placement, audience_kind, receiver_unit, status, title, body_html, consent_mode, consent_purpose, created_by_kind)
         values (gen_random_uuid(), $1, 'submission', 'groups', 'group', 'draft', '同意書', '<p>全文</p>', 'form', 'result_confirmation', 'system') returning id`,
        [cohortId],
      )
    ).rows[0]!.id,
  )
  await owner.sql(`insert into item_audience_groups (item_id, group_id) values ($1, $2)`, [itemId, groupId])
  // 發布＝有內容版本、欄位版本與實際開放時間（managed_items_published_check）。
  const contentVersionId = String(
    (
      await owner.sql(
        `insert into item_versions (id, item_id, version_no, title, summary, body_html, cover_file_id, category, created_by_user_id, created_at)
         values (gen_random_uuid(), $1, 1, '同意書', '', '<p>全文</p>', null, '', $2, now()) returning id`,
        [itemId, adminId],
      )
    ).rows[0]!.id,
  )
  const schemaVersionId = String(
    (
      await owner.sql(
        `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id, created_at) values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2, now()) returning id`,
        [itemId, adminId],
      )
    ).rows[0]!.id,
  )
  await owner.sql(
    `update managed_items set status = 'published', actual_opened_at = now(), current_content_version_id = $2, current_schema_version_id = $3 where id = $1`,
    [itemId, contentVersionId, schemaVersionId],
  )
  // 一包一版，參與者快照＝兩位組員＋主指導。
  const packageId = String(
    (
      await owner.sql(
        `insert into signoff_packages (id, group_id, cohort_id, purpose, item_id, created_by_user_id) values (gen_random_uuid(), $1, $2, 'result_confirmation', $3, $4) returning id`,
        [groupId, cohortId, itemId, adminId],
      )
    ).rows[0]!.id,
  )
  const participants = {
    students: members.map((id, i) => ({ userId: id, displayName: `學生${i}`, studentNo: null, membershipId: randomUUID() })),
    advisor: { userId: advisor, displayName: '主指導', assignmentId: randomUUID() },
  }
  const versionId = String(
    (
      await owner.sql(
        `insert into signoff_package_versions (id, package_id, version_no, content_text, content_checksum, attachment_file_versions, participants, created_by_user_id, created_real_at, created_business_at)
         values (gen_random_uuid(), $1, 1, '<p>全文</p>', $2, '[]'::jsonb, $3::jsonb, $4, now(), now()) returning id`,
        [packageId, sha256('<p>全文</p>'), JSON.stringify(participants), adminId],
      )
    ).rows[0]!.id,
  )
  await owner.sql(`insert into signoff_version_status (version_id, state, updated_by_user_id) values ($1, 'collecting', $2)`, [versionId, adminId])
  await owner.sql(`update signoff_packages set current_version_id = $2 where id = $1`, [packageId, versionId])
  return { cohortId, groupId, members, advisor, itemId, versionId }
}

async function storedFile(cohortId: string, refsList: FileRef[]): Promise<FileFacts> {
  const id = String(
    (
      await owner.sql(
        `insert into stored_files (id, owner_user_id, scope, cohort_id, purpose, original_name, size_bytes, mime_declared, mime_detected, extension, checksum, status, storage_key, uploaded_real_at, finalized_at)
         values (gen_random_uuid(), $1, 'cohort', $2, 'attachment', '附件.pdf', 10, 'application/pdf', 'application/pdf', 'pdf', $3, 'stored', $4, now(), now()) returning id`,
        [adminId, cohortId, sha256(randomUUID()), `files/${randomUUID()}`],
      )
    ).rows[0]!.id,
  )
  for (const r of refsList) await owner.sql(`insert into file_references (id, file_id, ref_type, ref_id) values (gen_random_uuid(), $1, $2, $3)`, [id, r.refType, r.refId])
  return { id, purpose: 'attachment', ownerUserId: adminId, scope: 'cohort', cohortId, references: refsList }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'attachment_policy', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  adminId = String(
    (await owner.sql(`insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), '系辦', 'ap-admin@example.com', true, now(), 'active') returning id`)).rows[0]!.id,
  )
  await owner.sql(`insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'admin', $1, now())`, [adminId])
  policy = createAttachmentPolicy(() => app)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('signoff_version 引用（C1-03）', () => {
  it('同時有 item_attachment 與 signoff_version 引用：組員照 item 規則可下載；主指導靠簽核版本讀權可下載；別的老師、訪客、無關學生不行', async () => {
    const s = await scenario()
    const file = await storedFile(s.cohortId, [
      { refType: 'item_attachment', refId: s.itemId },
      { refType: 'signoff_version', refId: s.versionId },
    ])
    expect(await policy(actor(s.members[0]!, ['student']), file)).toBe(true)
    expect(await policy(actor(s.advisor, ['teacher']), file)).toBe(true)
    expect(await policy(actor(adminId, ['admin']), file)).toBe(true)
    expect(await policy(actor(await newUser('外系老師', 'teacher'), ['teacher']), file)).toBe(false)
    expect(await policy(actor(await newUser('別組學生', 'student', s.cohortId), ['student']), file)).toBe(false)
    expect(await policy(ANON, file)).toBe(false)
    // 沒有 signoff_version 引用時主指導仍下載不到（整組收件的附件只給組員）：這條規則沒被放寬。
    const plain = await storedFile(s.cohortId, [{ refType: 'item_attachment', refId: s.itemId }])
    expect(await policy(actor(s.advisor, ['teacher']), plain)).toBe(false)
    expect(await policy(actor(s.members[1]!, ['student']), plain)).toBe(true)
  })

  it('只剩 signoff_version 引用（換檔後的舊附件）：系辦、快照裡的學生、此刻的組員與主指導可下載；換掉的舊主指導、外人不行', async () => {
    const s = await scenario()
    const file = await storedFile(s.cohortId, [{ refType: 'signoff_version', refId: s.versionId }])
    expect(await policy(actor(adminId, ['admin']), file)).toBe(true)
    expect(await policy(actor(s.members[0]!, ['student']), file)).toBe(true)
    expect(await policy(actor(s.advisor, ['teacher']), file)).toBe(true)
    expect(await policy(actor(await newUser('路人', 'student', s.cohortId), ['student']), file)).toBe(false)
    expect(await policy(ANON, file)).toBe(false)
    // 換老師：舊主指導失權含看不到。
    const next = await newUser('新老師', 'teacher')
    await owner.sql(`update advisor_assignments set valid_to = now(), ended_real_at = now(), ended_by_user_id = $2, end_reason = '改派' where group_id = $1`, [s.groupId, adminId])
    await owner.sql(
      `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason) values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '改派')`,
      [s.groupId, next, adminId],
    )
    expect(await policy(actor(s.advisor, ['teacher']), file)).toBe(false)
    expect(await policy(actor(next, ['teacher']), file)).toBe(true)
  })

  it('沒有任何引用：連管理員也拒絕；引用的簽核版本不存在：管理員照簽核讀權放行、其他人拒絕', async () => {
    const s = await scenario()
    expect(await policy(actor(adminId, ['admin']), await storedFile(s.cohortId, []))).toBe(false)
    expect(await policy(actor(adminId, ['admin']), await storedFile(s.cohortId, [{ refType: 'signoff_version', refId: randomUUID() }]))).toBe(true)
    expect(await policy(actor(s.members[0]!, ['student']), await storedFile(s.cohortId, [{ refType: 'signoff_version', refId: randomUUID() }]))).toBe(false)
  })
})

describe('同意書作業刪除後（CL-14：簽核紀錄的留存性質）', () => {
  it('簽核版本的附件照簽核版本讀權放行（參與者可、外人不行）；一般附件對所有人含系辦都拒絕', async () => {
    const s = await scenario()
    const both = await storedFile(s.cohortId, [
      { refType: 'item_attachment', refId: s.itemId },
      { refType: 'signoff_version', refId: s.versionId },
    ])
    const plain = await storedFile(s.cohortId, [{ refType: 'item_attachment', refId: s.itemId }])
    const outsiderStudent = await newUser('別組學生', 'student', s.cohortId)
    const outsiderTeacher = await newUser('外系老師', 'teacher')
    // 刪除前：組員兩個都能下載（對照組）。
    expect(await policy(actor(s.members[0]!, ['student']), plain)).toBe(true)

    // 系辦先下架、再刪除（刪除只准下架或草稿）。
    await owner.sql(`update managed_items set status = 'archived', deleted_at = now(), deleted_by_user_id = $2 where id = $1`, [s.itemId, adminId])

    for (const who of [actor(adminId, ['admin']), actor(s.members[0]!, ['student']), actor(s.members[1]!, ['student']), actor(s.advisor, ['teacher'])]) {
      expect(await policy(who, both)).toBe(true)
    }
    for (const who of [actor(outsiderStudent, ['student']), actor(outsiderTeacher, ['teacher']), ANON]) {
      expect(await policy(who, both)).toBe(false)
    }
    // 只綁在作業上的一般附件：項目刪了就沒有有效引用，連系辦都下載不到（第三波 W1，不因簽核這條放寬）。
    for (const who of [actor(adminId, ['admin']), actor(s.members[0]!, ['student']), actor(s.advisor, ['teacher']), ANON]) {
      expect(await policy(who, plain)).toBe(false)
    }
  })
})

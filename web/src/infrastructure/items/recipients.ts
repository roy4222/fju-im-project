import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type {
  AudienceKind,
  RecipientGroup,
  RecipientPerson,
  RecipientQueryInput,
  ReceiverUnit,
} from '@/application/items'

/**
 * 依對象展開「實際的人／組」（模組實作設計 04 §5 `ReceiverResolver`；產品模組 05「個人填報與收件名單」）。
 *
 * 發布前的名單預覽與發布時建名單用**同一段查詢**，所以預覽看到的就是會寫進名單的。
 *
 * 誰算「有效學生」：本屆已核准（`student_identities`）、帳號正常、未去識別化、學生角色未撤銷——
 * 與票 13 發起提案時找同屆同學的條件相同。誰算「已成立組」：本屆 `status='active'` 的組別。
 * 組員：`group_memberships.valid_to IS NULL` 且帳號正常。
 */

type Queryable = Pick<Pool, 'query'> | PoolClient

const ELIGIBLE_STUDENT = `
  u.status = 'active' and u.deidentified_at is null
  and exists (select 1 from role_assignments r
               where r.user_id = u.id and r.role = 'student' and r.revoked_real_at is null)`

export type ExpandedRecipients = {
  readonly receiverUnit: ReceiverUnit
  /** 個人收件的名單成員（組別收件時是空的）。 */
  readonly people: readonly RecipientPerson[]
  /** 組別收件的名單成員（個人收件時是空的）。 */
  readonly groups: readonly RecipientGroup[]
  /** 發通知時要寫給誰（user id，已去重）。 */
  readonly notifyUserIds: readonly string[]
}

type PersonRow = { user_id: string; name: string; student_no: string | null; group_code: string | null }
type GroupRow = { id: string; code: string }
type MemberRow = { group_id: string; user_id: string; name: string }

async function eligibleStudents(db: Queryable, cohortId: string, groupIds: readonly string[] | null): Promise<RecipientPerson[]> {
  const rows = await db.query<PersonRow>(
    `select si.user_id, coalesce(p.display_name, u.name) as name, si.student_no, g.code as group_code
       from student_identities si
       join users u on u.id = si.user_id
       left join user_profiles p on p.user_id = si.user_id
       left join group_memberships m on m.user_id = si.user_id and m.cohort_id = si.cohort_id and m.valid_to is null
       left join groups g on g.id = m.group_id and g.status = 'active'
      where si.cohort_id = $1 and ${ELIGIBLE_STUDENT}
        and ($2::uuid[] is null or (g.id is not null and g.id = any($2::uuid[])))
      order by g.code nulls last, si.student_no`,
    [cohortId, groupIds],
  )
  return rows.rows.map((r) => ({ userId: r.user_id, name: r.name, studentNo: r.student_no, groupCode: r.group_code }))
}

async function activeGroups(db: Queryable, cohortId: string, groupIds: readonly string[] | null): Promise<RecipientGroup[]> {
  const groups = await db.query<GroupRow>(
    `select g.id, g.code from groups g
      where g.cohort_id = $1 and g.status = 'active' and ($2::uuid[] is null or g.id = any($2::uuid[]))
      order by g.code`,
    [cohortId, groupIds],
  )
  const members = await groupMembers(
    db,
    groups.rows.map((g) => g.id),
  )
  return groups.rows.map((g) => ({
    groupId: g.id,
    code: g.code,
    members: members.filter((m) => m.group_id === g.id).map((m) => m.name),
  }))
}

/** 這幾組的有效成員（帳號正常）。 */
async function groupMembers(db: Queryable, groupIds: readonly string[]): Promise<MemberRow[]> {
  if (groupIds.length === 0) return []
  const rows = await db.query<MemberRow>(
    `select m.group_id, m.user_id, coalesce(p.display_name, u.name) as name
       from group_memberships m
       join users u on u.id = m.user_id
       left join user_profiles p on p.user_id = m.user_id
      where m.group_id = any($1::uuid[]) and m.valid_to is null
        and u.status = 'active' and u.deidentified_at is null
      order by m.group_id, name`,
    [groupIds],
  )
  return rows.rows
}

/** 全部老師（公告對象是「全部老師」時的通知收件人）。 */
async function activeTeachers(db: Queryable): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `select u.id from users u
      where u.status = 'active' and u.deidentified_at is null
        and exists (select 1 from role_assignments r
                     where r.user_id = u.id and r.role = 'teacher' and r.revoked_real_at is null)`,
  )
  return rows.rows.map((r) => r.id)
}

function uniqueSorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort()
}

/**
 * 展開收件者與通知對象。
 *
 * - 收件（`receiverUnit` 不是 none）：個人＝有效學生（本屆全部或指定組別裡的）；組別＝已成立組（本屆全部或指定的）。
 *   通知對象＝名單展開到人（組別收件＝該組有效成員）。
 * - 公告／資源：沒有名單；通知對象＝本屆學生、指定組別成員或全部老師。公開與所有登入者**不展開**
 *   （不會替全站每個帳號各寫一則通知），只留事件。
 */
export async function expandRecipients(db: Queryable, input: RecipientQueryInput): Promise<ExpandedRecipients> {
  const scopedGroups = input.audienceKind === 'groups' ? input.groupIds : null
  if (input.audienceKind === 'groups' && input.groupIds.length === 0) {
    return { receiverUnit: input.receiverUnit, people: [], groups: [], notifyUserIds: [] }
  }

  if (input.receiverUnit === 'individual') {
    const people = await eligibleStudents(db, input.cohortId, scopedGroups)
    return { receiverUnit: 'individual', people, groups: [], notifyUserIds: uniqueSorted(people.map((p) => p.userId)) }
  }
  if (input.receiverUnit === 'group') {
    const groups = await activeGroups(db, input.cohortId, scopedGroups)
    const members = await groupMembers(
      db,
      groups.map((g) => g.groupId),
    )
    return { receiverUnit: 'group', people: [], groups, notifyUserIds: uniqueSorted(members.map((m) => m.user_id)) }
  }

  return { receiverUnit: 'none', people: [], groups: [], notifyUserIds: await audienceUserIds(db, input.cohortId, input.audienceKind, input.groupIds) }
}

/** 公告、資源的通知對象（見 `expandRecipients`）。 */
export async function audienceUserIds(
  db: Queryable,
  cohortId: string,
  audienceKind: AudienceKind,
  groupIds: readonly string[],
): Promise<string[]> {
  switch (audienceKind) {
    case 'cohort_students':
      return uniqueSorted((await eligibleStudents(db, cohortId, null)).map((p) => p.userId))
    case 'groups': {
      const valid = await activeGroups(db, cohortId, groupIds)
      const members = await groupMembers(
        db,
        valid.map((g) => g.groupId),
      )
      return uniqueSorted(members.map((m) => m.user_id))
    }
    case 'teachers':
      return uniqueSorted(await activeTeachers(db))
    case 'public':
    case 'signed_in':
      return []
  }
}

/** 某幾組目前的有效成員 user id（組別收件新加入名單時，通知那幾組的人）。 */
export async function memberUserIds(db: Queryable, groupIds: readonly string[]): Promise<string[]> {
  return uniqueSorted((await groupMembers(db, groupIds)).map((m) => m.user_id))
}

import 'server-only'
import type { Pool } from 'pg'
import { isUuid, type UnassignedQuery, type UnassignedRoster, type UnassignedStudent } from '@/application/groups'
import { getPool } from '@/infrastructure/db/client'
import { personAvatar } from '@/infrastructure/db/person-avatar'
import { personName } from '@/infrastructure/db/person-name'

/**
 * 系辦「未分組學生」分頁的讀取（C3-15；設計方案③ §6.3）。
 *
 * 學生名單一句 SQL：頭像、系級、名片技能、本人公開找隊員，以及「正在哪個建立中的組別」（占用表
 * `proposal_occupancy` 左 join 進行中的 `group_proposals`，帶發起人名字與到期時間）。誰算未分組照既有
 * `overview().ungrouped` 的條件（同屆、有效學生、沒有有效組別）。另一句讀「加入組別」可選的本屆組別與人數。
 */
export class PgUnassignedQuery implements UnassignedQuery {
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(reader: () => Pick<Pool, 'query'> = getPool) {
    this.#reader = reader
  }

  async roster(cohortId: string): Promise<UnassignedRoster> {
    if (!isUuid(cohortId)) return { students: [], groups: [] }
    const db = this.#reader()
    const [students, groups] = await Promise.all([
      db.query<{
        user_id: string
        name: string
        avatar_preset: number | null
        avatar_file_id: string | null
        student_no: string
        department_class: string | null
        skills: unknown
        open_to_join: boolean
        proposal_id: string | null
        proposer_name: string | null
        expires_business_at: Date | null
      }>(
        `select u.id as user_id, ${personName('p', 'u')} as name, ${personAvatar('p')}, p.student_no, p.department_class,
                p.skills, p.open_to_join,
                gp.id as proposal_id, ${personName('pp', 'pu')} as proposer_name, gp.expires_business_at
           from user_profiles p
           join users u on u.id = p.user_id
           left join proposal_occupancy o on o.user_id = u.id
           left join group_proposals gp on gp.id = o.proposal_id and gp.state = 'open'
           left join users pu on pu.id = gp.proposer_user_id
           left join user_profiles pp on pp.user_id = gp.proposer_user_id
          where p.cohort_id = $1 and p.student_no is not null
            and u.status = 'active' and u.deidentified_at is null
            and exists (select 1 from role_assignments r
                         where r.user_id = u.id and r.role = 'student' and r.revoked_real_at is null)
            and not exists (select 1 from group_memberships m
                             where m.user_id = u.id and m.cohort_id = $1 and m.valid_to is null)
          order by p.student_no`,
        [cohortId],
      ),
      db.query<{ id: string; code: string; revision: number; member_count: number }>(
        `select g.id, g.code, g.revision,
                (select count(*) from group_memberships m where m.group_id = g.id and m.valid_to is null)::int as member_count
           from groups g
          where g.cohort_id = $1 and g.status = 'active'
          order by g.code`,
        [cohortId],
      ),
    ])
    return {
      // 白名單欄位：SQL 多選了什麼也不會流到畫面。
      students: students.rows.map(
        (r): UnassignedStudent => ({
          userId: r.user_id,
          name: r.name,
          studentNo: r.student_no,
          departmentClass: r.department_class || null,
          avatarPreset: r.avatar_preset,
          avatarFileId: r.avatar_file_id,
          skills: Array.isArray(r.skills) ? r.skills.filter((v): v is string => typeof v === 'string') : [],
          openToJoin: r.open_to_join,
          proposal:
            r.proposal_id && r.expires_business_at
              ? { id: r.proposal_id, proposerName: r.proposer_name ?? '', expiresBusinessAt: r.expires_business_at }
              : null,
        }),
      ),
      groups: groups.rows.map((r) => ({ id: r.id, code: r.code, revision: r.revision, memberCount: r.member_count })),
    }
  }
}

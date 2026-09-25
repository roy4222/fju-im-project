import 'server-only'
import type { Pool } from 'pg'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import type {
  PublicShowcaseCard,
  PublicShowcasePage,
  PublicShowcaseQuery,
  ShowcaseArchive,
  ShowcaseAward,
  ShowcaseListFilter,
  ShowcasePeople,
  SignedInShowcaseCard,
} from '@/application/showcase'
import { getPool } from '@/infrastructure/db/client'
import { personName } from '@/infrastructure/db/person-name'

/**
 * 前台的優秀專題、歷屆一覽與專題詳情（模組實作設計 09 §5 `PublicContentQuery.featured／entry`、
 * `SignedInContentQuery.archive`；產品模組 09 §9.1）。
 *
 * **只讀已發布條目的目前版本**：`showcase_entries.status = 'published'` 而且從 `current_version_id` 接
 * `showcase_versions`。草稿（`showcase_drafts`）一個欄位都不碰——草稿可以隨時改，沒有經過發布閘門。
 * 撤稿（`withdrawn`）的條目列表不出現、詳情告訴他已下架。
 *
 * 白名單：題目、摘要、海報、影片連結、屆別、組別代碼、版本時間、獎項。授權參照、個資檢查結果、草稿內容都不出現。
 *
 * **優秀專題與歷屆一覽的界線（0011，票 39）**：公開的只有 `showcase_entries.award_level` 有值（優秀、佳作）的
 * 已發布作品；沒有等級的只給能正常使用平台的登入者（列表、詳情、上一件／下一件、屆別 pill 都照這條）。
 * 等級預設 NULL，所以 S12 的歷屆補登、一般發布不標等級就不會出現在公開頁。
 * 組員與主指導只給**能正常使用平台**的登入者（`statusGate` 通過：待審、必須改密、停用都當訪客），
 * 而且只給「目前有效」的那幾列（`valid_to IS NULL`），換組、重派之後的舊人不會掛在作品上。
 *
 * 發布本身（閘門、核閱、外部授權）在 S12；目前只有測試站示範資料會寫出已發布的列。
 */

const MAX_ROWS = 200

type Row = {
  id: string
  cohort_code: string
  group_id: string | null
  group_code: string | null
  title: string
  summary: string
  video_url: string | null
  poster_file_id: string | null
  created_real_at: Date
  award_level: ShowcaseAward | null
  award_label: string | null
}

const FROM = `
  from showcase_entries e
  join showcase_versions v on v.id = e.current_version_id and v.entry_id = e.id
  join cohorts c on c.id = e.cohort_id
  left join groups g on g.id = e.group_id
  left join stored_files f on f.id = v.poster_file_id and f.status = 'stored'
 where e.status = 'published'`

const COLUMNS = `e.id, c.code as cohort_code, e.group_id, g.code as group_code, v.title, v.summary, v.video_url,
       f.id as poster_file_id, v.created_real_at, e.award_level, e.award_label`

/** 公開（訪客也看得到）的那一批：有獎項等級的。 */
const FEATURED = `e.award_level is not null`

/** 得獎排序：優秀 → 佳作 → 沒得獎（原型 `awardRank`）；「佳作優先」把前兩個對調。 */
const EXCELLENT_FIRST = `case e.award_level when 'excellent' then 0 when 'merit' then 1 else 2 end`
const MERIT_FIRST = `case e.award_level when 'merit' then 0 when 'excellent' then 1 else 2 end`

const ORDER: Record<NonNullable<ShowcaseListFilter['sort']>, string> = {
  cohort: `c.code desc, ${EXCELLENT_FIRST}, g.code asc nulls last, v.title asc, e.id asc`,
  'cohort-asc': `c.code asc, ${EXCELLENT_FIRST}, g.code asc nulls last, v.title asc, e.id asc`,
  title: `v.title asc, c.code desc, e.id asc`,
  award: `${EXCELLENT_FIRST}, c.code desc, g.code asc nulls last, v.title asc, e.id asc`,
  excellent: `${EXCELLENT_FIRST}, c.code desc, g.code asc nulls last, v.title asc, e.id asc`,
  merit: `${MERIT_FIRST}, c.code desc, g.code asc nulls last, v.title asc, e.id asc`,
}

/** `ilike` 的萬用字元跳脫：搜尋字串裡的 `%`、`_` 當一般字。 */
function likePattern(q: string): string {
  return `%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
}

function toCard(r: Row): PublicShowcaseCard {
  return {
    id: r.id,
    cohortCode: r.cohort_code,
    groupCode: r.group_code,
    title: r.title,
    summary: r.summary,
    videoUrl: r.video_url,
    posterFileId: r.poster_file_id,
    publishedAt: r.created_real_at,
    award: r.award_level,
    awardLabel: r.award_label,
  }
}

/** 能正常使用平台的登入者（待審、必須改密、停用都不算）。 */
function isMember(actor: ResolvedActor): boolean {
  return actor.kind === 'authenticated' && statusGate(actor, 'business') === null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class PgPublicShowcaseQuery implements PublicShowcaseQuery {
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(reader: () => Pick<Pool, 'query'> = getPool) {
    this.#reader = reader
  }

  async featured(filter: ShowcaseListFilter = {}): Promise<PublicShowcaseCard[]> {
    const rows = await this.#rows({ ...filter, awardOnly: true }, false)
    return rows.map(toCard)
  }

  async archive(actor: ResolvedActor, filter: ShowcaseListFilter = {}): Promise<ShowcaseArchive> {
    if (!isMember(actor)) return { access: 'need_login' }
    const rows = await this.#rows(filter, true)
    const people = await this.#people(rows.map((r) => r.group_id).filter((id): id is string => id !== null))
    const cards: SignedInShowcaseCard[] = rows.map((r) => ({
      ...toCard(r),
      ...((r.group_id ? people.get(r.group_id) : undefined) ?? NO_PEOPLE),
    }))
    return { access: 'visible', cards }
  }

  async cohorts(options: { readonly featuredOnly?: boolean } = {}): Promise<string[]> {
    const rows = await this.#reader().query<{ code: string }>(
      `select distinct c.code ${FROM} ${options.featuredOnly ? `and ${FEATURED}` : ''} order by c.code desc`,
    )
    return rows.rows.map((r) => r.code)
  }

  async entry(actor: ResolvedActor, entryId: string): Promise<PublicShowcasePage> {
    if (!UUID.test(entryId)) return { access: 'not_found' }
    const db = this.#reader()
    const head = await db.query<{ status: 'draft' | 'published' | 'withdrawn' }>(
      `select status from showcase_entries where id = $1`,
      [entryId],
    )
    const status = head.rows[0]?.status
    if (status === 'withdrawn') return { access: 'withdrawn' }
    if (status !== 'published') return { access: 'not_found' }

    const found = await db.query<Row>(`select ${COLUMNS} ${FROM} and e.id = $1`, [entryId])
    const row = found.rows[0]
    if (!row) return { access: 'not_found' }
    const member = isMember(actor)
    // 沒得獎的只在登入後的歷屆一覽：訪客（含待審、必須改密）不給內容，連題目都不給。
    if (row.award_level === null && !member) return { access: 'need_login' }

    // 上一件／下一件：照列表的預設順序（屆別新到舊）；訪客只在優秀專題之間跳，登入者走整個歷屆一覽。
    const order = await db.query<{ id: string; title: string }>(
      `select e.id, v.title ${FROM} ${member ? '' : `and ${FEATURED}`} order by ${ORDER.cohort} limit ${MAX_ROWS}`,
    )
    const index = order.rows.findIndex((r) => r.id === entryId)
    const prev = index > 0 ? order.rows[index - 1]! : null
    const next = index >= 0 && index < order.rows.length - 1 ? order.rows[index + 1]! : null

    const people = member
      ? ((row.group_id ? (await this.#people([row.group_id])).get(row.group_id) : undefined) ?? NO_PEOPLE)
      : null
    return { access: 'visible', item: toCard(row), people, prev, next }
  }

  async #rows(filter: ShowcaseListFilter, signedIn: boolean): Promise<Row[]> {
    const values: unknown[] = []
    // 訪客那一邊（`signedIn=false`）一律只有得獎的；不靠呼叫的人記得傳 `awardOnly`。
    const where: string[] = filter.awardOnly || !signedIn ? [FEATURED] : []
    const cohort = filter.cohort?.trim()
    if (cohort) {
      values.push(cohort)
      where.push(`c.code = $${values.length}`)
    }
    const q = filter.q?.trim().slice(0, 100)
    if (q) {
      values.push(likePattern(q))
      const n = values.length
      const matches = [`v.title ilike $${n}`, `v.summary ilike $${n}`, `g.code ilike $${n}`]
      // 指導老師只有登入後看得到，所以也只有登入後能拿來搜（訪客不能用搜尋結果反推是誰指導）。
      if (signedIn) {
        matches.push(`exists (select 1 from advisor_assignments a
                                join users u on u.id = a.teacher_user_id
                                left join user_profiles p on p.user_id = u.id
                               where a.group_id = e.group_id and a.valid_to is null
                                 and ${personName('p', 'u')} ilike $${n})`)
      }
      where.push(`(${matches.join(' or ')})`)
    }
    const rows = await this.#reader().query<Row>(
      `select ${COLUMNS} ${FROM} ${where.map((w) => `and ${w}`).join(' ')}
        order by ${ORDER[filter.sort ?? 'cohort']} limit ${MAX_ROWS}`,
      values,
    )
    return rows.rows
  }

  /** 每組目前有效的組員（加入順序）與主指導。 */
  async #people(groupIds: readonly string[]): Promise<Map<string, ShowcasePeople>> {
    const result = new Map<string, { advisorName: string | null; memberNames: string[] }>()
    if (groupIds.length === 0) return result
    const db = this.#reader()
    const [members, advisors] = await Promise.all([
      db.query<{ group_id: string; name: string }>(
        `select m.group_id, ${personName('p', 'u')} as name
           from group_memberships m
           join users u on u.id = m.user_id
           left join user_profiles p on p.user_id = u.id
          where m.group_id = any($1::uuid[]) and m.valid_to is null
          order by m.group_id, m.valid_from, m.id`,
        [groupIds],
      ),
      db.query<{ group_id: string; name: string }>(
        `select a.group_id, ${personName('p', 'u')} as name
           from advisor_assignments a
           join users u on u.id = a.teacher_user_id
           left join user_profiles p on p.user_id = u.id
          where a.group_id = any($1::uuid[]) and a.valid_to is null`,
        [groupIds],
      ),
    ])
    const slot = (groupId: string) => {
      let s = result.get(groupId)
      if (!s) {
        s = { advisorName: null, memberNames: [] }
        result.set(groupId, s)
      }
      return s
    }
    for (const m of members.rows) slot(m.group_id).memberNames.push(m.name)
    for (const a of advisors.rows) slot(a.group_id).advisorName = a.name
    return result
  }
}

const NO_PEOPLE: ShowcasePeople = { advisorName: null, memberNames: [] }

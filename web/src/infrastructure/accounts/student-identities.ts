import 'server-only'
import type { Pool, PoolClient } from 'pg'

/**
 * 有效學號占用表 `student_identities` 的寫入（工程模組 01 附錄 A；核准〔票 7〕與恢復〔票 9〕共用）。
 *
 * **大小寫**：主鍵 `(cohort_id, student_no)` 是大小寫敏感的，但全站比對學號一律用 `upper()`
 * （名單比對、待審清單的重複學號、批次停用）。不改 schema 的前提下，統一在**寫入時存大寫**，
 * 同一屆 `a123` 與 `A123` 就會撞同一個主鍵；寫入前再用 `upper()` 查一次，擋住正規化以前
 * 已經寫進去的小寫舊列（那種列主鍵擋不到）。顯示用的學號（`user_profiles`、
 * `registration_applications`）照本人填的原樣保存，不動。
 */

type Queryable = Pick<Pool, 'query'> | PoolClient

/**
 * 這一屆裡，是不是已經有別人占用這個學號（忽略大小寫）？有的話回那個人的名字。
 * 核准（票 7）與恢復（票 9）共用：主鍵本身大小寫敏感，擋不住正規化以前寫進去的小寫舊列。
 */
export async function studentNoHolder(
  db: Queryable,
  cohortId: string,
  studentNo: string,
  exceptUserId: string,
): Promise<string | null> {
  const rows = await db.query<{ name: string }>(
    `select coalesce(up.display_name, u.name) as name
       from student_identities si
       join users u on u.id = si.user_id
       left join user_profiles up on up.user_id = si.user_id
      where si.cohort_id = $1 and upper(si.student_no) = upper($2) and si.user_id <> $3
      limit 1`,
    [cohortId, studentNo, exceptUserId],
  )
  return rows.rows[0]?.name ?? null
}

/** 占用有效學號：一律存大寫（見檔頭說明）。唯一違反由呼叫端處理。 */
export async function occupyStudentNo(
  tx: PoolClient,
  cohortId: string,
  studentNo: string,
  userId: string,
  now: Date,
): Promise<void> {
  await tx.query(
    `insert into student_identities (cohort_id, student_no, user_id, created_at) values ($1, $2, $3, $4)`,
    [cohortId, studentNo.toUpperCase(), userId, now],
  )
}


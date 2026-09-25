import 'server-only'
import type { Pool } from 'pg'
import type { FileListRow, FilePurpose } from '@/application/ops'

/**
 * 檔案管理頁的唯讀清單（票 35；產品模組 10「系辦在檔案管理看全部檔案、被誰引用」）。
 *
 * 只讀既有的 `stored_files`、`file_references` 與引用它們的表，不新增欄位或表。
 * 只列 `stored`（上傳完成、還沒被回收）的檔；上傳中、軟刪除、已清除的不列。
 * 引用位置只挑一個代表（附件 → 項目、封面 → 項目、繳交 → 那份收件的項目），引用數另外算有效引用的總數。
 * 授權在 composition（只有系辦）；這裡不判人。
 */

type Row = {
  id: string
  original_name: string
  size_bytes: string | number | null
  purpose: FilePurpose
  uploaded_real_at: Date
  uploader_name: string
  cohort_code: string | null
  active_refs: number
  where_kind: 'item_attachment' | 'item_cover' | 'submission' | null
  item_id: string | null
  item_title: string | null
  item_placement: string | null
}

/** 一次最多列幾筆（新的在前）。 */
export const FILE_LIST_LIMIT = 500

export async function listStoredFiles(db: Pick<Pool, 'query'>): Promise<FileListRow[]> {
  const result = await db.query<Row>(
    `select f.id, f.original_name, f.size_bytes, f.purpose, f.uploaded_real_at,
            u.name as uploader_name, c.code as cohort_code,
            (select count(*)::int from file_references r where r.file_id = f.id and r.released_at is null) as active_refs,
            case when att.item_id is not null then 'item_attachment'
                 when cov.item_id is not null then 'item_cover'
                 when sub.item_id is not null then 'submission' end as where_kind,
            coalesce(att.item_id, cov.item_id, sub.item_id) as item_id,
            m.title as item_title, m.placement as item_placement
       from stored_files f
       join users u on u.id = f.owner_user_id
       left join cohorts c on c.id = f.cohort_id
       left join lateral (
         select ia.item_id from item_attachments ia where ia.file_id = f.id order by ia.created_at limit 1
       ) att on true
       left join lateral (
         select mi.id as item_id from managed_items mi where mi.cover_file_id = f.id limit 1
       ) cov on true
       left join lateral (
         select sv.item_id from submission_files sf
           join submission_versions sv on sv.id = sf.submission_version_id
          where sf.file_id = f.id limit 1
       ) sub on true
       left join managed_items m on m.id = coalesce(att.item_id, cov.item_id, sub.item_id)
      where f.status = 'stored'
      order by f.uploaded_real_at desc, f.id
      limit $1`,
    [FILE_LIST_LIMIT],
  )
  return result.rows.map((r) => ({
    id: r.id,
    name: r.original_name,
    sizeBytes: Number(r.size_bytes ?? 0),
    purpose: r.purpose,
    uploadedAt: r.uploaded_real_at,
    uploaderName: r.uploader_name,
    cohortCode: r.cohort_code,
    activeRefs: r.active_refs,
    where:
      r.where_kind && r.item_id && r.item_title !== null && r.item_placement !== null
        ? { kind: r.where_kind, itemId: r.item_id, title: r.item_title, placement: r.item_placement }
        : null,
  }))
}

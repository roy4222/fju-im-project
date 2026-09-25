import 'server-only'
import type { Pool } from 'pg'
import type { DownloadPolicy } from '@/application/ops'
import { canReadSignoffVersions } from '@/infrastructure/signoff/version-read-access'

/**
 * 精選海報的下載政策（`DOWNLOAD_POLICIES.poster`；票 25，前台補頁加上「已發布版本的海報公開」）。
 *
 * 誰能下載：
 * - 任何人（含訪客）：這張是某個**發布中**條目**目前版本**的海報（前台優秀專題、專題詳情要用）。
 * - 管理員：草稿上、或被簽核版本凍結的海報都可以（編輯與核對要用）。
 * - 綁在精選草稿上（`showcase_draft`）：那一組**此刻**的有效組員與主指導（草稿是這一組的作品介紹）。
 * - 綁在簽核版本上（`signoff_version`，建版時凍結的授權範圍素材）：讀得到那一版的人（`canReadSignoffVersions`，
 *   跟版本頁、簽核附件同一個判斷）——授權範圍列在全文之後讓參與者讀完再同意，他們要看得到自己同意公開的那張海報。
 *   快照學生含之後被移出的人；老師只有此刻仍是這一組的主指導才可以，**換掉的舊主指導看不到**
 *   （產品 07 §8「換老師後舊老師失權」；2026-09-25 Roy 定：失權含看不到，收回票 25 對快照主指導較寬的做法）。
 * - 其他人、沒被任何草稿或版本引用的檔（剛上傳還沒存、換圖後被放掉的）一律拒絕。
 *
 * 只看目前有效的引用（`released_at IS NULL`，共用檔案能力先篩好）；每次下載都重查（契約 03 §4）。
 */
export function createPosterPolicy(reader: () => Pick<Pool, 'query'>): DownloadPolicy {
  return async (actor, file) => {
    // 前台（優秀專題、專題詳情）：**已發布**條目的**目前版本**用的那張海報，任何人都可以看（訪客也是）。
    // 只認 `showcase_versions.poster_file_id`（發布時凍結、不可變），草稿上的、舊版本的、撤稿後的一律不算。
    // 發布閘門（授權涵蓋、素材核閱）在 S12 的發布用例裡；能走到「發布中」就已經過了閘門。
    const published = await reader().query(
      `select 1
         from showcase_entries e
         join showcase_versions v on v.id = e.current_version_id and v.entry_id = e.id
        where e.status = 'published' and v.poster_file_id = $1
        limit 1`,
      [file.id],
    )
    if ((published.rowCount ?? 0) > 0) return true

    if (actor.kind !== 'authenticated') return false
    const draftEntryIds = file.references.filter((r) => r.refType === 'showcase_draft').map((r) => r.refId)
    const versionIds = file.references.filter((r) => r.refType === 'signoff_version').map((r) => r.refId)
    if (draftEntryIds.length === 0 && versionIds.length === 0) return false
    if (actor.roles.includes('admin')) return true

    const db = reader()
    if (draftEntryIds.length > 0) {
      const member = await db.query(
        `select 1
           from showcase_entries e
          where e.id = any($1::uuid[]) and e.group_id is not null
            and (exists (select 1 from group_memberships m
                          where m.group_id = e.group_id and m.user_id = $2 and m.valid_to is null)
                 or exists (select 1 from advisor_assignments a
                             where a.group_id = e.group_id and a.teacher_user_id = $2 and a.valid_to is null))
          limit 1`,
        [draftEntryIds, actor.userId],
      )
      if ((member.rowCount ?? 0) > 0) return true
    }
    if (versionIds.length > 0 && (await canReadSignoffVersions(db, actor, versionIds))) return true
    return false
  }
}

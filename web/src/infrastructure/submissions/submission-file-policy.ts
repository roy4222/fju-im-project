import 'server-only'
import type { Pool } from 'pg'
import type { DownloadPolicy } from '@/application/ops'
import { canReadSubmission, type SubmissionHolder } from '@/application/submissions'
import { holderOf, VERSION_ACCESS_COLUMNS, viewerOf, type VersionAccessRow } from '@/infrastructure/submissions/version-access'

/**
 * 繳交附件的下載政策（`DOWNLOAD_POLICIES.submission`；契約 03 §1「組別共用草稿」「組別正式版本」「個人回答」；票 21）。
 *
 * 一個繳交檔被誰引用著（共用草稿、某一個正式版本），就照那一份繳交「誰能讀」來判斷——規則在 application 的
 * `canReadSubmission`，這裡只負責每次下載**當下**重查事實：
 *
 * - 此刻的有效組別（`group_memberships.valid_to IS NULL`、組別沒解散）：被移出的人立刻拿不到共用草稿。
 * - 目前主指導（`advisor_assignments.valid_to IS NULL`）：換老師後舊老師立刻拿不到。
 * - 這份收件最新的主指導閱覽設定（個人回答才用得到）。
 * - 那一版送出當下的組員（`membership_snapshot`，票 22）：被移出的人只拿得到自己還在組裡時那幾版的檔。
 *
 * 只看目前有效的引用（共用檔案能力先篩好 `released_at IS NULL`）：從草稿拿掉、也沒進任何正式版本的檔，誰都下載不到
 * （管理員也一樣——沒有引用的檔不屬於任何一份繳交）。剛傳完還沒存進草稿的檔同理。
 */

export function createSubmissionFilePolicy(reader: () => Pick<Pool, 'query'>): DownloadPolicy {
  return async (actor, file) => {
    if (actor.kind !== 'authenticated') return false
    const draftIds = file.references.filter((r) => r.refType === 'draft').map((r) => r.refId)
    const versionIds = file.references.filter((r) => r.refType === 'submission_version').map((r) => r.refId)
    if (draftIds.length === 0 && versionIds.length === 0) return false
    if (actor.roles.includes('admin')) return true

    const db = reader()
    const [drafts, versions, viewer] = await Promise.all([
      draftIds.length > 0
        ? db.query<{ receiver_kind: 'user' | 'group'; receiver_id: string }>(
            'select receiver_kind, receiver_id from submission_drafts where id = any($1::uuid[])',
            [draftIds],
          )
        : Promise.resolve({ rows: [] as { receiver_kind: 'user' | 'group'; receiver_id: string }[] }),
      versionIds.length > 0
        ? db.query<VersionAccessRow>(
            `select ${VERSION_ACCESS_COLUMNS}
               from submission_versions v
               join managed_items m on m.id = v.item_id
               join form_schema_versions sv on sv.id = v.schema_version_id
              where v.id = any($1::uuid[])`,
            [versionIds],
          )
        : Promise.resolve({ rows: [] as VersionAccessRow[] }),
      viewerOf(db, actor),
    ])
    if (!viewer) return false

    const holders: SubmissionHolder[] = [
      ...drafts.rows.map((d): SubmissionHolder => ({ kind: 'draft', receiverKind: d.receiver_kind, receiverId: d.receiver_id })),
      ...versions.rows.map(holderOf),
    ]
    return holders.some((holder) => canReadSubmission(viewer, holder))
  }
}

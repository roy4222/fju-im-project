import type { FileListRow } from '@/application/ops'
import { formatBytes } from '@/shared/format-bytes'
import { taipeiDateOf } from '@/shared/time'

/**
 * 檔案分頁一列要顯示的樣子（C1-16 從 `page.tsx` 搬出來；票 35 原本的對照不變）。
 *
 * 「用在哪裡」是連結（附件、封面進編輯器，繳交檔案進收件名單）；還有地方在用的檔不能刪，
 * 刪除鈕直接寫原因「還有 N 處在用（公告「X」附件）」（①設計方案 §1.6、§4.6）。
 */

export type FileKind = 'item' | 'submission' | 'other'

export type FileRowView = {
  id: string
  name: string
  kind: FileKind
  kindLabel: string
  whereText: string
  whereHref: string | null
  /** 附件、封面：解除引用要回編輯器改。 */
  releaseHref: string | null
  uploader: string
  size: string
  date: string
  refs: number
  /** 還有地方在用時，刪除鈕上寫的原因；沒人用（可以刪）是 null。 */
  inUseText: string | null
}

/** 附件依所在項目的位置叫不同名字（原型「公開資源／公告附件／組別繳交」）。 */
const ATTACHMENT_LABEL: Record<string, string> = {
  news: '公告附件',
  resource: '資源附件',
  rules: '規則附件',
  submission: '作業附件',
}

/** 刪除鈕原因裡的項目叫法：公告「X」附件、作業「X」封面。 */
const PLACEMENT_NOUN: Record<string, string> = {
  news: '公告',
  resource: '資源',
  rules: '規則',
  submission: '作業',
  requirement: '繳交規定',
  showcase: '成果展示',
  honor: '榮譽',
}

const OTHER_LABEL: Record<string, string> = {
  roster_csv: '名單匯入',
  advisor_csv: '名單匯入',
  poster: '成果展示素材',
  photo: '首頁大圖',
  signoff_attachment: '同意書附件',
  export: '匯出檔',
  attachment: '附件',
  submission: '繳交檔案',
}

/**
 * 被引用、但不是公告與作業的附件也不是繳交檔案時，「用在哪裡」寫實際用途（N-87），不寫「（系統紀錄）」。
 * 這類檔案沒有可以點進去的頁面，只說它是做什麼的。
 */
const IN_USE_LABEL: Record<string, string> = {
  roster_csv: '匯入學生名單的原檔',
  advisor_csv: '批次指派指導老師的原檔',
  poster: '成果展示素材',
  photo: '首頁大圖',
  signoff_attachment: '同意書附件',
  export: '匯出檔',
  attachment: '公告與作業附件',
}

function inUseText(refs: number, where: string): string | null {
  if (refs <= 0) return null
  return `還有 ${refs} 處在用（${where}${refs > 1 ? '等' : ''}）`
}

export function fileRowView(row: FileListRow): FileRowView {
  const where = row.where
  let kind: FileKind = 'other'
  let kindLabel = OTHER_LABEL[row.purpose] ?? '其他'
  let whereText = row.activeRefs > 0 ? (IN_USE_LABEL[row.purpose] ?? '其他用途') : '沒有用到'
  let reason = whereText
  let whereHref: string | null = null
  let releaseHref: string | null = null
  if (where?.kind === 'item_attachment' || where?.kind === 'item_cover') {
    kind = 'item'
    kindLabel = where.kind === 'item_cover' ? '封面' : (ATTACHMENT_LABEL[where.placement] ?? '附件')
    whereText = where.title
    reason = `${PLACEMENT_NOUN[where.placement] ?? '項目'}「${where.title}」${where.kind === 'item_cover' ? '封面' : '附件'}`
    whereHref = `/dashboard/admin/editor/${where.itemId}`
    releaseHref = whereHref
  } else if (where?.kind === 'submission') {
    kind = 'submission'
    kindLabel = '繳交檔案'
    whereText = where.title
    reason = `作業「${where.title}」繳交檔案`
    // 繳交檔案看收件名單頁（不能從這裡解除：正式送出的版本不可變）。
    whereHref = `/dashboard/admin/affairs/${where.itemId}`
  } else if (row.purpose === 'submission') {
    kind = 'submission'
    whereText = row.activeRefs > 0 ? '草稿中' : '沒有用到'
    reason = '繳交草稿'
  }
  return {
    id: row.id,
    name: row.name,
    kind,
    kindLabel,
    whereText,
    whereHref,
    releaseHref,
    uploader: row.uploaderName,
    size: formatBytes(row.sizeBytes),
    date: taipeiDateOf(row.uploadedAt),
    refs: row.activeRefs,
    inUseText: inUseText(row.activeRefs, reason),
  }
}

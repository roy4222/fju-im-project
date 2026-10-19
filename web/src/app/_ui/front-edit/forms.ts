import type { ComponentType } from 'react'

/**
 * 前台編輯的表單登錄表（C2-16 建檔並定型別；規格② 設計方案 §6.3.1 是定版）。
 *
 * 每種 kind 對應一個 `() => import('<表單模組>')`：只在按下「編輯／新增」那一刻才載入，
 * 不進 `/office-edit/*` 的首載（①③表單的硬規定，§12.1 第 4 點）。
 * 還沒有表單的 kind 先登錄成 `notProvided`，框架看到它就顯示「這個區塊還不能在前台改」：
 * - ②的 `hero`、`quick_card`、`footer_contact`、`privacy` 由 C2-17 換成 import；
 * - ①的由 C1-06／C1-07／C1-09 各自換掉自己 kind 那一行（10/18 主腦裁定）；
 * - ③的 `opportunity`、`activity` 由 C3-10、C3-08 各自換掉（總表 Y-3）。
 * 換的時候只改自己那一行，型別不動。
 */

export type FeKind =
  | 'news' | 'submission' | 'rules' | 'resource' | 'honor' | 'showcase' // ①（競賽併在 news）
  | 'resource_category' // ①（要補模組）
  | 'activity' | 'opportunity' // ③
  | 'hero' | 'quick_card' | 'footer_contact' | 'privacy' // ②

/** `data-fe-fields` 的 JSON：只放表單要預填的純值。 */
export type FeFields = Record<string, string | number | boolean | null>

export interface FeFormProps {
  mode: 'edit' | 'add'
  kind: FeKind
  id: string | null // edit 必填（data-fe-id）；add 為 null
  revision: number | null // data-fe-rev 預填；表單可以自己重讀最新 revision（①用 ItemDetail.revision）
  cohortId: string | null // 區塊的 data-fe-cohort；add 時建立用，沒有就由表單取預設工作屆別
  fields: FeFields
  /** 成功後呼叫一次。回傳值框架只拿來組 toast（「已儲存」／「已發布」）與記 log，不依賴它。 */
  onDone(result?: { id: string; status?: 'draft' | 'published' | 'saved' }): void
  onCancel(): void
}

export interface FeFormModule {
  default: ComponentType<FeFormProps>
  /** 有才能刪；框架先跳確認再呼叫。回 ok:false 時框架把 message 顯示在確認框、不關窗。 */
  remove?: (input: { id: string; revision: number | null; requestId: string }) => Promise<{ ok: true } | { ok: false; message: string }>
}

/** 「尚未提供」佔位：框架認得它，不載入任何東西，直接告訴系辦這個區塊還不能在前台改。 */
export const notProvided = (): Promise<FeFormModule> => Promise.reject(new Error('這個區塊還不能在前台改'))

export const FE_FORMS: Record<FeKind, () => Promise<FeFormModule>> = {
  // ①（C1-06／C1-07／C1-09 登錄）
  news: notProvided,
  submission: notProvided,
  rules: notProvided,
  resource: notProvided,
  honor: notProvided,
  showcase: notProvided,
  resource_category: notProvided,
  // ③（C3-08、C3-10 登錄）
  activity: notProvided,
  opportunity: notProvided,
  // ②（C2-17 登錄）
  hero: notProvided,
  quick_card: notProvided,
  footer_contact: notProvided,
  privacy: notProvided,
}

/** 視窗標題用的名稱：「編輯公告」「新增活動」。 */
export const FE_KIND_LABEL: Record<FeKind, string> = {
  news: '公告',
  submission: '作業',
  rules: '規則',
  resource: '檔案',
  honor: '榮譽',
  showcase: '優秀專題',
  resource_category: '分類名稱',
  activity: '活動',
  opportunity: '合作案',
  hero: '首頁橫幅',
  quick_card: '快速入口',
  footer_contact: '頁尾聯絡資料',
  privacy: '隱私權政策',
}

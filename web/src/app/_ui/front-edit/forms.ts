import type { ComponentType } from 'react'
import { requestHeroUploadAction, saveHeroAction, saveSiteTextAction } from './forms/actions'
import { provideFeActions } from './forms/registry'
import { ITEM_FORM_DEPS, provideItemFormDeps } from '@/app/dashboard/admin/affairs/_form/item-form-dialog'

/**
 * 前台編輯的表單登錄表（C2-16 建檔並定型別；規格② 設計方案 §6.3.1 是定版）。
 *
 * 每種 kind 對應一個 `() => import('<表單模組>')`：只在按下「編輯／新增」那一刻才載入，
 * 不進 `/office-edit/*` 的首載（①③表單的硬規定，§12.1 第 4 點）。
 * 還沒有表單的 kind 先登錄成 `notProvided`，框架看到它就顯示「這個區塊還不能在前台改」：
 * - ②的 `hero`、`quick_card`、`footer_contact`、`privacy` 已由 C2-17 換成 import（`forms/`）；
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

/**
 * ②的 Server Function（C2-17）由這裡（編輯層載入時就在的父層）登錄給延遲表單，表單經 `forms/registry.ts` 取用、
 * 不直接 import `./forms/actions`：延遲 chunk 一靜態碰到 Server Function 的客戶端接線，Turbopack 就把那段接線從
 * 「每頁都載」的共用 chunk 拆出來，所有路由的 gzip 都變大（AC-C2-44 步驟 7）。理由全文見 `forms/registry.ts`。
 */
provideFeActions({ saveSiteText: saveSiteTextAction, saveHero: saveHeroAction, requestHeroUpload: requestHeroUploadAction })
provideItemFormDeps(ITEM_FORM_DEPS) // ①（C1-06）：同理把 Server Function 與 SubmissionFields 登錄給①的延遲表單（item-form-model.ts 的 itemFormDeps）

/** 「尚未提供」佔位：框架認得它，不載入任何東西，直接告訴系辦這個區塊還不能在前台改。 */
export const notProvided = (): Promise<FeFormModule> => Promise.reject(new Error('這個區塊還不能在前台改'))

export const FE_FORMS: Record<FeKind, () => Promise<FeFormModule>> = {
  // ①（C1-06／C1-07／C1-09 登錄）
  news: () => import('@/app/dashboard/admin/affairs/front-edit/news'),
  submission: () => import('@/app/dashboard/admin/affairs/front-edit/submission'),
  rules: () => import('@/app/dashboard/admin/affairs/front-edit/rules'),
  resource: () => import('@/app/dashboard/admin/affairs/front-edit/resource'),
  honor: () => import('@/app/dashboard/admin/affairs/front-edit/honor'),
  showcase: notProvided,
  resource_category: notProvided,
  // ③（C3-08、C3-10 登錄）
  activity: notProvided,
  opportunity: notProvided,
  // ②（C2-17）
  hero: () => import('./forms/hero-form'),
  quick_card: () => import('./forms/site-text-form'),
  footer_contact: () => import('./forms/site-text-form'),
  privacy: () => import('./forms/site-text-form'),
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

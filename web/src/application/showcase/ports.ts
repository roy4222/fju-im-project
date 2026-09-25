import type { ResolvedActor } from '@/application/accounts'
import type { DeclaredUpload, UploadTicket } from '@/application/ops'
import type { Result } from '@/shared/result'

/**
 * 模組 09 精選的 port（模組實作設計 09 §5 `ShowcaseCommand`；票 25 只交付最小草稿能力：建立、編輯、海報上傳）。
 *
 * 發布、撤稿、素材核閱、外部授權登記、公開頁都在 S12。授權都在實作裡判：只有管理員（契約 03 §1「精選：admin」）；
 * 學生、老師呼叫任何一個都是 `FORBIDDEN`。
 */

// ── 回執 ────────────────────────────────────────────────────────────────────

export type CreateDraftReceipt = {
  readonly entryId: string
  readonly groupCode: string
  /** 草稿版本（樂觀鎖用；新建是 1）。 */
  readonly revision: number
}

export type UpdateDraftReceipt = {
  readonly entryId: string
  readonly groupCode: string
  readonly revision: number
  readonly posterChanged: boolean
}

// ── 輸入 ────────────────────────────────────────────────────────────────────

export type UpdateDraftInput = {
  readonly entryId: string
  /** 畫面看到的草稿版本；別人先存過就 `CONFLICT`。 */
  readonly revision: number
  readonly title: string
  readonly summary: string
  readonly videoUrl: string
  /** 海報檔（剛上傳的或原本那一張）；null＝拿掉海報。 */
  readonly posterFileId: string | null
}

export type PosterUploadInput = DeclaredUpload & { readonly entryId: string }

// ── 查詢結果 ────────────────────────────────────────────────────────────────

export type ShowcaseDraftView = {
  readonly entryId: string
  readonly groupId: string
  readonly groupCode: string
  readonly groupDissolved: boolean
  readonly status: 'draft' | 'published' | 'withdrawn'
  readonly title: string
  readonly summary: string
  readonly videoUrl: string | null
  readonly poster: { readonly fileId: string; readonly name: string; readonly checksum: string } | null
  readonly revision: number
  readonly updatedAt: Date
  readonly updatedByName: string | null
  /** 有幾個簽核版本的授權範圍是從這份草稿凍結的（只是提示：改草稿不會影響已凍結的版本）。 */
  readonly frozenInVersions: number
}

export type ShowcaseBoard = {
  readonly cohort: { readonly id: string; readonly code: string; readonly archived: boolean }
  /** 這一屆有效（沒解散）的組別，以及它有沒有草稿。 */
  readonly groups: readonly { readonly id: string; readonly code: string; readonly entryId: string | null }[]
  readonly drafts: readonly ShowcaseDraftView[]
}

// ── port ────────────────────────────────────────────────────────────────────

export interface ShowcaseCommand {
  /** 替一組建精選條目＋空草稿（同交易）。同屆同組已經有 → `CONFLICT`；組別解散 → `GROUP_DISSOLVED`。 */
  createDraft(actor: ResolvedActor, input: { groupId: string }, requestId: string): Promise<Result<CreateDraftReceipt>>
  /** 存草稿：題目、摘要、影片連結、海報。草稿版本不符 → `CONFLICT`；海報不是本人剛上傳的圖片 → `FILE_*`。 */
  updateDraft(actor: ResolvedActor, input: UpdateDraftInput, requestId: string): Promise<Result<UpdateDraftReceipt>>
  /** 替某份草稿要一張海報上傳憑證（只收 PNG／JPG）。 */
  requestPosterUpload(actor: ResolvedActor, input: PosterUploadInput): Promise<Result<UploadTicket>>
}

export interface ShowcaseQuery {
  /** 管理員的精選頁；不是管理員 → `FORBIDDEN`。 */
  adminBoard(actor: ResolvedActor, cohortId: string): Promise<Result<ShowcaseBoard>>
}

// ── 前台（公開優秀專題與登入後的歷屆一覽） ──────────────────────────────────

/**
 * 獎項等級（0011，票 39；原型 `ProjectAward`）：excellent＝優秀專題（王冠）、merit＝佳作（獎盃）。
 * 有等級的才是公開的「優秀專題」；沒有等級的已發布作品只在登入後的「歷屆一覽」（產品模組 09 §9.1）。
 */
export type ShowcaseAward = 'excellent' | 'merit'

/**
 * 前台卡片：**白名單欄位**（模組實作設計 09 §5 `PublicContentQuery`；產品模組 09「公開授權與素材來源」）。
 *
 * 只從**已發布**條目的**目前版本**（`showcase_entries.current_version_id`）讀：題目、摘要、海報、影片連結，
 * 加上屆別與組別代碼。草稿內容、授權參照、個資檢查結果、組員、老師都不在這裡。
 */
export type PublicShowcaseCard = {
  /** 條目 ID（詳情頁網址用）。 */
  readonly id: string
  readonly cohortCode: string
  /** 歷屆補登可以沒有組別。 */
  readonly groupCode: string | null
  readonly title: string
  readonly summary: string
  readonly videoUrl: string | null
  readonly posterFileId: string | null
  /** 這個版本凍結的時間。 */
  readonly publishedAt: Date
  /** 獎項等級；null＝沒有得獎（只在登入後的歷屆一覽）。 */
  readonly award: ShowcaseAward | null
  /** 獎項全名（例如「113 學年度校級優秀專題」）；沒填就是 null。 */
  readonly awardLabel: string | null
}

/** 登入後才給的欄位：目前有效組員與主指導（訪客永遠拿不到，型別上就分開）。 */
export type ShowcasePeople = {
  readonly advisorName: string | null
  readonly memberNames: readonly string[]
}

export type SignedInShowcaseCard = PublicShowcaseCard & ShowcasePeople

/**
 * 排序（原型）：優秀專題有「屆別」「優秀專題優先」「佳作優先」；歷屆一覽有「屆別」「得獎優先」「題目」。
 * 同一個型別給兩頁共用，各頁只開自己那幾個（`FEATURED_SORT_OPTIONS`、`ARCHIVE_SORT_OPTIONS`）。
 */
export type ShowcaseSort = 'cohort' | 'cohort-asc' | 'title' | 'award' | 'excellent' | 'merit'

export type ShowcaseListFilter = {
  /** 屆別代碼；空＝全部。 */
  readonly cohort?: string
  /** 只要有獎項等級的（歷屆一覽的「只看得獎」；優秀專題本來就只有得獎的）。 */
  readonly awardOnly?: boolean
  /** 關鍵字：題目、摘要、組別（登入後的歷屆一覽另外比對指導老師）。 */
  readonly q?: string
  readonly sort?: ShowcaseSort
}

export type ShowcaseArchive =
  | { readonly access: 'visible'; readonly cards: readonly SignedInShowcaseCard[] }
  | { readonly access: 'need_login' }

export type ShowcaseNeighbor ={ readonly id: string; readonly title: string }

export type PublicShowcasePage =
  | {
      readonly access: 'visible'
      readonly item: PublicShowcaseCard
      /** 訪客是 null（組員與老師「登入後顯示」）。 */
      readonly people: ShowcasePeople | null
      readonly prev: ShowcaseNeighbor | null
      readonly next: ShowcaseNeighbor | null
    }
  /**
   * 已發布但沒有獎項等級、看的人又不是能正常使用平台的登入者：只在登入後的歷屆一覽，不帶內容
   * （產品模組 09 §9.1；原型 `getProject` 的 `visible = award || isMember`）。
   */
  | { readonly access: 'need_login' }
  /** 曾經發布、現在撤下：告訴他已下架，不帶內容（SHW-06）。 */
  | { readonly access: 'withdrawn' }
  /** 沒有這筆、或從沒發布過（草稿）：和「沒有」一樣，不給人探測草稿存在。 */
  | { readonly access: 'not_found' }

export interface PublicShowcaseQuery {
  /** 優秀專題（公開）：任何人，只回**有獎項等級**的已發布作品、白名單欄位。 */
  featured(filter?: ShowcaseListFilter): Promise<PublicShowcaseCard[]>
  /** 歷屆專題一覽（登入後）：沒登入、或帳號還不能用（待審、必須改密） → `need_login`，一筆都不回。 */
  archive(actor: ResolvedActor, filter?: ShowcaseListFilter): Promise<ShowcaseArchive>
  /**
   * 有已發布作品的屆別代碼（新到舊），給屆別篩選 pill。`featuredOnly`：只算有獎項等級的
   * （優秀專題頁用，不讓訪客從 pill 看出哪一屆有沒得獎的作品）。
   */
  cohorts(options?: { readonly featuredOnly?: boolean }): Promise<string[]>
  /**
   * 專題詳情：有獎項等級的任何人都看得到、沒有的只給登入者（其他人 `need_login`）；組員與老師只給登入者。
   * 上一件／下一件照同一條界線：訪客只在優秀專題之間跳。
   */
  entry(actor: ResolvedActor, entryId: string): Promise<PublicShowcasePage>
}

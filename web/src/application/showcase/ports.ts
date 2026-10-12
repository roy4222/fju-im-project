import type { ResolvedActor } from '@/application/accounts'
import type { DeclaredUpload, UploadTicket } from '@/application/ops'
import type { Result } from '@/shared/result'

/**
 * 模組 09 精選的 port（模組實作設計 09 §5 `ShowcaseCommand`）。票 25 交付草稿（建立、編輯、海報上傳）；
 * 第三波 W2 補發布（系辦勾同意，Q31）、下架、重新發布、獎項、刪除（設計方案 §4）。
 *
 * 素材核閱、正式授權閘門仍在 S12。授權都在實作裡判：只有管理員（契約 03 §1「精選：admin」）；
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

/** 發布、下架、重新發布、設獎項、刪除共用：條目版本（樂觀鎖）與一句話要用的組別／題目。 */
export type ShowcaseLifecycleReceipt = {
  readonly entryId: string
  /** 歷屆補登沒有組別。 */
  readonly groupCode: string | null
  readonly title: string
  /** 條目版本（`showcase_entries.revision`；刪除後是刪除那一刻的版本）。 */
  readonly revision: number
}

export type PublishReceipt = ShowcaseLifecycleReceipt & { readonly versionNo: number }

export type SetAwardReceipt = ShowcaseLifecycleReceipt & {
  readonly award: ShowcaseAward | null
  readonly awardLabel: string | null
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

/** 下架、重新發布、刪除：只要條目與畫面看到的條目版本。 */
export type ShowcaseEntryRef = {
  readonly entryId: string
  /** 畫面看到的條目版本（`showcase_entries.revision`）；別人先動過就 `CONFLICT`。 */
  readonly revision: number
}

export type PublishInput = ShowcaseEntryRef & {
  /** 系辦勾了「已取得這組同學同意公開」（Q31）；不是 true 一律擋下。勾的人是伺服器端的登入者，不從表單拿。 */
  readonly consent: boolean
}

export type SetAwardInput = ShowcaseEntryRef & {
  /** '' 或 null＝拿掉獎項。 */
  readonly level: string | null
  readonly label: string | null
}

// ── 查詢結果 ────────────────────────────────────────────────────────────────

export type ShowcaseDraftView = {
  readonly entryId: string
  readonly cohortId: string
  readonly cohortCode: string
  readonly cohortArchived: boolean
  /** 歷屆補登沒有組別（`group_id` 為 null）。 */
  readonly groupId: string | null
  readonly groupCode: string | null
  readonly groupDissolved: boolean
  readonly status: 'draft' | 'published' | 'withdrawn'
  /** 條目版本（下架、發布等指令的樂觀鎖）；草稿內容的版本是 `revision`。 */
  readonly entryRevision: number
  readonly award: ShowcaseAward | null
  readonly awardLabel: string | null
  /** 首頁輪播順序（1–99；null＝排在有填的後面）。 */
  readonly homePosition: number | null
  /** 有沒有草稿列（歷屆補登可能只有發布版本）；沒有就不能在這頁改內容。 */
  readonly hasDraft: boolean
  /** 前台目前那一版的題目（沒發布過是 null）。 */
  readonly publishedTitle: string | null
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
  /** 建立草稿用的屆別（沒有可用的屆別是 null）。 */
  readonly cohort: { readonly id: string; readonly code: string; readonly archived: boolean } | null
  /** 建立草稿那一屆有效（沒解散）的組別，以及它有沒有條目（含已刪除的：一組一屆只能有一個條目）。 */
  readonly groups: readonly { readonly id: string; readonly code: string; readonly entryId: string | null }[]
  /** 看板上的作品（篩選的屆別，或全部含歷屆）；已刪除的不在這裡。新屆在前、同屆依組別。 */
  readonly drafts: readonly ShowcaseDraftView[]
}

export type ShowcaseBoardFilter = {
  /** 只看這一屆；null＝全部（含歷屆）。 */
  readonly cohortId: string | null
  /** 建立草稿的屆別（列出還沒有條目的組）；null＝不需要。 */
  readonly createCohortId: string | null
}

// ── port ────────────────────────────────────────────────────────────────────

export interface ShowcaseCommand {
  /** 替一組建精選條目＋空草稿（同交易）。同屆同組已經有 → `CONFLICT`；組別解散 → `GROUP_DISSOLVED`。 */
  createDraft(actor: ResolvedActor, input: { groupId: string }, requestId: string): Promise<Result<CreateDraftReceipt>>
  /** 存草稿：題目、摘要、影片連結、海報。草稿版本不符 → `CONFLICT`；海報不是本人剛上傳的圖片 → `FILE_*`。 */
  updateDraft(actor: ResolvedActor, input: UpdateDraftInput, requestId: string): Promise<Result<UpdateDraftReceipt>>
  /** 替某份草稿要一張海報上傳憑證（只收 PNG／JPG）。 */
  requestPosterUpload(actor: ResolvedActor, input: PosterUploadInput): Promise<Result<UploadTicket>>
  /**
   * 發布（草稿 → 公開中）：把目前草稿凍結成新一筆 `showcase_versions`（外部授權：`authorization_ref`＝這次的請求編號，
   * `pii_check` 記「系辦確認已取得同意」與勾的人），海報一起綁到版本上，條目指向它。沒勾同意、題目空白 → `VALIDATION_FAILED`。
   * 不受屆別封存限制（不改內容）。
   */
  publish(actor: ResolvedActor, input: PublishInput, requestId: string): Promise<Result<PublishReceipt>>
  /** 下架（公開中 → 已下架）：前台看不到、海報不再公開；後台還在。 */
  withdraw(actor: ResolvedActor, input: ShowcaseEntryRef, requestId: string): Promise<Result<ShowcaseLifecycleReceipt>>
  /** 重新發布（已下架 → 公開中）：沿用下架前那一版，不切新版本。 */
  republish(actor: ResolvedActor, input: ShowcaseEntryRef, requestId: string): Promise<Result<ShowcaseLifecycleReceipt>>
  /** 設獎項（任何狀態）：有等級的才上「優秀專題」與首頁輪播。 */
  setAward(actor: ResolvedActor, input: SetAwardInput, requestId: string): Promise<Result<SetAwardReceipt>>
  /** 刪除（草稿或已下架）：記刪除標記與稽核，後台與前台都當作不存在；不能恢復。 */
  delete(actor: ResolvedActor, input: ShowcaseEntryRef, requestId: string): Promise<Result<ShowcaseLifecycleReceipt>>
}

export interface ShowcaseQuery {
  /** 管理員的精選頁；不是管理員 → `FORBIDDEN`。 */
  adminBoard(actor: ResolvedActor, filter: ShowcaseBoardFilter): Promise<Result<ShowcaseBoard>>
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

export type SignedInShowcaseCard = PublicShowcaseCard &
  ShowcasePeople & {
    /** 屆別名稱（例如「第 43 屆」）；歷屆一覽標「名稱（代碼）」。公開卡維持白名單，不帶這欄。 */
    readonly cohortName: string
  }

/**
 * 排序（原型）：優秀專題有「屆別」「優秀專題優先」「佳作優先」；歷屆一覽有「屆別」「得獎優先」「題目」。
 * 同一個型別給兩頁共用，各頁只開自己那幾個（`FEATURED_SORT_OPTIONS`、`ARCHIVE_SORT_OPTIONS`）。
 */
export type ShowcaseSort = 'cohort' | 'cohort-asc' | 'title' | 'award' | 'excellent' | 'merit' | 'home'

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
  /**
   * 優秀專題（公開）：任何人，只回**有獎項等級**的已發布作品、白名單欄位。
   * 沒指定排序時是首頁輪播的順序（`home`：首頁順序小到大、沒填的排後面，再照屆別新到舊）。
   */
  featured(filter?: ShowcaseListFilter): Promise<PublicShowcaseCard[]>
  /** 歷屆專題一覽（登入後）：沒登入、或帳號還不能用（待審、必須改密） → `need_login`，一筆都不回。 */
  archive(actor: ResolvedActor, filter?: ShowcaseListFilter): Promise<ShowcaseArchive>
  /**
   * 有已發布作品的屆別代碼（新到舊），給屆別篩選 pill。`featuredOnly`：只算有獎項等級的
   * （優秀專題頁用，不讓訪客從 pill 看出哪一屆有沒得獎的作品）。
   */
  cohorts(options?: { readonly featuredOnly?: boolean }): Promise<string[]>
  /** 同 `cohorts()`，多帶屆別名稱（歷屆一覽的 pill 標「名稱（代碼）」）。 */
  cohortChoices(options?: { readonly featuredOnly?: boolean }): Promise<{ readonly code: string; readonly name: string }[]>
  /**
   * 專題詳情：有獎項等級的任何人都看得到、沒有的只給登入者（其他人 `need_login`）；組員與老師只給登入者。
   * 上一件／下一件照同一條界線：訪客只在優秀專題之間跳。
   */
  entry(actor: ResolvedActor, entryId: string): Promise<PublicShowcasePage>
}

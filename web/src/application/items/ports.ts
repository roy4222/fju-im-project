import type { ResolvedActor } from '@/application/accounts'
import type {
  AudienceKind,
  CompetitionStatus,
  ConsentMode,
  ConsentPurpose,
  FormField,
  ItemFileKind,
  ItemInput,
  ItemStatus,
  Placement,
  PublishCheck,
  ReceiverUnit,
} from '@/application/items/items'
import type { DeleteReceipt, LifecycleAction, LifecycleReceipt, PublicAccess } from '@/application/items/lifecycle'
import type { UploadTicket } from '@/application/ops'
import type { Result } from '@/shared/result'
import type { TaipeiDate } from '@/shared/time'

/**
 * 模組 04 對外的 port（模組實作設計 04 §5 的 `ItemCommand`／`ItemQuery`、`ReceiverResolver`，票 15 的部分）。
 *
 * 寫入的 port 自己做授權（只有管理員）；查詢的 port 不做授權——呼叫它的頁面自己守門。
 * 撤回、下架、重新發布在票 16（`changeStatus`）；改結構與受眾變更的影響預覽在後面的票（S08）。
 * 前台內容頁與站內日曆的查詢是 `PublicItemQuery`：它**自己**依看的人過濾（前台沒有頁面守門可以依靠）。
 */

export type SaveReceipt = { readonly itemId: string; readonly revision: number; readonly status: ItemStatus }

export type PublishReceipt = {
  readonly itemId: string
  readonly title: string
  readonly placement: Placement
  readonly receiverUnit: ReceiverUnit
  readonly revision: number
  /** 實際開放時間（業務時間）：第一次發布時寫一次，之後不重設。 */
  readonly actualOpenedAt: string
  readonly dueAt: string | null
  readonly contentVersionNo: number
  readonly schemaVersionNo: number
  /** 收件名單有幾位（個人）或幾組（組別）；公告、資源是 0。 */
  readonly rosterCount: number
  /** 這次的事件寫給幾個人（通知由背景工作投影）。 */
  readonly notifiedCount: number
  /**
   * 站內同意書（`consent_mode='form'`）才有：建了幾個簽核包、哪幾組沒建（沒有主指導或沒有組員，繳交狀況頁顯示「尚未建立」）。
   * 站內同意書不發「新作業」通知（`item.published`），通知由簽核包的「輪到你同意」發。其他作業是 null。
   */
  readonly consent: { readonly created: number; readonly skipped: readonly { readonly groupId: string; readonly reason: 'no_advisor' | 'no_members' }[] } | null
}

export type UpdateChange = 'content' | 'schema' | 'settings' | 'deadline'

export type UpdateReceipt = {
  readonly itemId: string
  readonly title: string
  readonly revision: number
  readonly changes: readonly UpdateChange[]
  readonly contentVersionNo: number
  readonly schemaVersionNo: number
  readonly dueAt: string | null
  readonly rosterAdded: number
  readonly rosterRemoved: number
  readonly notify: boolean
  readonly notifiedCount: number
}

/** 置頂／取消置頂的回執（第 1 批 V1）：`pinned` 是做完之後的狀態。 */
export type PinReceipt = { readonly itemId: string; readonly title: string; readonly pinned: boolean }

/** 規則章節上移／下移的回執（A-14）：`position` 是移完之後的位置（同屆規則從 1 起算）。 */
export type RuleOrderReceipt = { readonly itemId: string; readonly title: string; readonly position: number }

/** 規則章節整批排序的回執（C 階段規格① §3.1）：`count` 是這一屆排了幾章。 */
export type RulesReorderReceipt = { readonly cohortId: string; readonly count: number }

/** 資源分類改名的回執（C 階段規格① §11.3 `resource_category`）：`count` 是改到幾筆資源（跨屆）。 */
export type RenameCategoryReceipt = { readonly from: string; readonly to: string; readonly count: number }

export type StartItemUploadInput = {
  readonly cohortId: string
  readonly kind: ItemFileKind
  readonly fileName: string
  readonly declaredMime: string
  readonly declaredSize: number
}

export interface ItemCommand {
  /** 建一筆草稿（快速建立第 1 步、完整編輯器第一次儲存）。之後都操作同一個 ID。 */
  create(actor: ResolvedActor, input: ItemInput, requestId: string): Promise<Result<SaveReceipt>>
  /** 存草稿：只有草稿能用；已發布的改用 `updatePublished`（改了就是生效）。 */
  saveDraft(actor: ResolvedActor, itemId: string, revision: number, input: ItemInput, requestId: string): Promise<Result<SaveReceipt>>
  /**
   * 發布：發布前檢查 → 同一筆交易切內容版本與欄位版本、寫實際開放時間、發布紀錄、
   * 依對象展開收件名單、排截止到期工作、發事件（通知由背景工作投影）。任何一步失敗整筆回滾。
   */
  publish(
    actor: ResolvedActor,
    itemId: string,
    revision: number,
    options: { readonly notify: boolean },
    requestId: string,
  ): Promise<Result<PublishReceipt>>
  /**
   * 發布更新（已發布項目的修改）：內容變了切新內容版本、欄位變了切新欄位版本、
   * 對象或收件單位變了重算名單、截止變了換期限版本與到期工作。是否通知由管理員選。
   * 有人作答後：收件單位、對象、欄位結構都不能改（`ITEM_HAS_RESPONSES`）。
   */
  updatePublished(
    actor: ResolvedActor,
    itemId: string,
    revision: number,
    input: ItemInput,
    options: { readonly notify: boolean },
    requestId: string,
  ): Promise<Result<UpdateReceipt>>
  /** 附件或封面的上傳 ticket（共用檔案能力；只有管理員）。 */
  startUpload(actor: ResolvedActor, input: StartItemUploadInput): Promise<Result<UploadTicket>>
  /**
   * 發布前檢查與預覽（不寫任何東西）：用畫面上**還沒存**的內容跑同一份發布檢查、展開實際名單、
   * 清理正文給預覽用。`itemId` 給的話，已發布項目用第一次的實際開放時間判斷截止。只有管理員（名單有學生姓名）。
   */
  review(actor: ResolvedActor, input: ItemInput, itemId: string | null): Promise<Result<ItemReview>>
  /**
   * 撤回（發布中→草稿，只有還沒有任何回答時）、下架（發布中→已下架）、重新發布（已下架→發布中）。票 16。
   *
   * 三個動作都不動實際開放時間、不切新內容版本，只寫一列發布紀錄（`item_publications`）、稽核與事件（不發通知）。
   * 撤回另外結束目前的收件名單（再發布時照當下對象重建）並取消還沒到的截止工作；下架保留名單、回答與截止工作。
   *
   * 例外：重新發布公告／資源時勾了「重要」（`options.notify`），同一筆交易另發 `item.announced`，
   * 依當下對象逐人通知（Roy 2026-09-25 定）。收件項目、撤回、下架都不理會這個選項。
   */
  changeStatus(
    actor: ResolvedActor,
    itemId: string,
    revision: number,
    action: LifecycleAction,
    requestId: string,
    options?: { readonly notify?: boolean },
  ): Promise<Result<LifecycleReceipt>>
  /**
   * 刪除（第三波 W1）：只限草稿與已下架、收件項目沒有任何回答（Q28）。不實體刪列，寫刪除標記
   * （`deleted_at`／`deleted_by_user_id`）與稽核 `item.deleted`（payload 留刪除前的狀態、標題、屆別、位置）；
   * 之後後台查詢、前台、附件下載都當作不存在。不能恢復；已寄的通知不收回；附件檔案與引用照留。
   */
  delete(actor: ResolvedActor, itemId: string, revision: number, requestId: string): Promise<Result<DeleteReceipt>>
  /**
   * 置頂／取消置頂（第 1 批 V1；Q48-a）：只限發布中的公告（`pinDenial`）。置頂是列表上的展示動作——
   * 只寫 `pinned_at`、稽核 `item.pin`／`item.unpin`，**不動 `revision`**（編輯器開著的草稿存檔不會衝突）、
   * 不切版本、不寫發布紀錄、不發事件。已經是目標狀態再按一次回 ok、不改任何東西（原本的置頂時間不變）。
   */
  setPinned(actor: ResolvedActor, itemId: string, pinned: boolean, requestId: string): Promise<Result<PinReceipt>>
  /**
   * 規則章節上移／下移（A-14；Q198）：跟同一屆、placement rules、未刪除（含草稿、已下架）的項目中位置緊鄰的那一筆
   * 交換 `rules_position`。前台 `/rules` 只顯示其中發布中的子序列，所以前台的相對順序跟著動或不變（鄰居沒發布時）。
   * 已經在最上／最下 → `VALIDATION_FAILED`「已經在最上面了。」／「已經在最下面了。」。稽核 `item.rule_moved`；
   * 跟置頂一樣是展示動作，不動 `revision`、`updated_at`，不切版本、不發事件。
   */
  moveRule(actor: ResolvedActor, itemId: string, direction: 'up' | 'down', requestId: string): Promise<Result<RuleOrderReceipt>>
  /**
   * 專題規則整批排序（C 階段規格① §3.1，拖曳排序用；`moveRule` 保留給上下移）。`orderedIds` 必須正好等於這一屆
   * 全部未刪除規則（含草稿、已下架）的集合、不重複，否則 `VALIDATION_FAILED`；照順序寫成 1..n。
   * 跟 `moveRule` 一樣是展示動作：鎖序同 `lockRuleSet`、不動 `revision`、不切版本、不發事件，稽核沿用 `item.rule_moved`（payload `kind:'reorder'`）。
   * 順序跟現在一樣也回 ok（不寫稽核）。
   */
  reorderRules(actor: ResolvedActor, cohortId: string, orderedIds: readonly string[], requestId: string): Promise<Result<RulesReorderReceipt>>
  /**
   * 資源分類改名（C 階段規格① §11.3 `resource_category`；前台 `/files` 依名稱合併跨屆資源，所以範圍是**所有屆別**）：
   * `placement='resource'`、未刪除、`category=from` 的每一列改成 `to`、`revision+1`；一筆交易。
   * 新名稱已經是別的資源分類 → `VALIDATION_FAILED`「已有這個分類」；沒有任何資源用 `from` → `VALIDATION_FAILED`。
   * 跟置頂一樣不產生內容版本、不寫發布紀錄、不發事件；稽核 `item.category_renamed`（`{from,to,count}`）。`requestId` 冪等。
   * 封存屆別的資源也一起改（分類名是跨屆共用的標籤，不是那一屆的內容）。
   */
  renameResourceCategory(
    actor: ResolvedActor,
    input: { readonly from: string; readonly to: string; readonly requestId: string },
  ): Promise<Result<RenameCategoryReceipt>>
}

export type ItemReview = {
  readonly checks: readonly PublishCheck[]
  readonly recipients: RecipientPreview
  /** 清理後的正文（預覽直接顯示這一段）。 */
  readonly bodyHtml: string
  /** 「截止：…（含此分鐘，臺灣時間）」；沒有截止是 null。 */
  readonly deadlineText: string | null
  /** 開放時間的說明：設定的時間，或「發布即開放」。 */
  readonly openText: string
  readonly hasResponses: boolean
}

/**
 * 「這份收件有沒有人作答」（模組實作設計 05 §5 `SubmissionQuery.hasAnyResponse`）。
 *
 * 實作在模組 05（`infrastructure/submissions/pg-response-presence.ts`，票 17）：有任何草稿或正式版本就算。
 * 吃呼叫端的 `tx`，在發布更新的交易裡判斷。
 */
export interface ResponsePresence<Tx = unknown> {
  hasAnyResponse(tx: Tx, itemId: string): Promise<boolean>
}

// ── 查詢 ──────────────────────────────────────────────────────────────────────

export type ItemFileSummary = { readonly fileId: string; readonly name: string; readonly sizeBytes: number }

export type ItemListRow = {
  readonly id: string
  readonly placement: Placement
  readonly title: string
  readonly status: ItemStatus
  readonly audienceKind: AudienceKind
  readonly audienceGroupCodes: readonly string[]
  readonly receiverUnit: ReceiverUnit
  /** 同意書模式（C 階段規格① §1.1）；不是同意書是 null。 */
  readonly consentMode: ConsentMode | null
  readonly dueAt: Date | null
  readonly actualOpenedAt: Date | null
  /** 置頂時間（第 1 批 V1）；沒置頂是 null。 */
  readonly pinnedAt: Date | null
  /** 規則章節的位置（A-14）：只有規則有，同屆從 1 起算；其他位置與舊資料是 null。 */
  readonly rulesPosition: number | null
  readonly updatedAt: Date
  /**
   * 應交數（個人＝人、組別＝組）：目前名單、不含免填與已移出，跟收件名單頁完成率的分母同一個口徑
   * （`application/submissions/roster.ts`）；不是收件就是 0。
   */
  readonly rosterCount: number
}

export type ItemDetail = {
  readonly id: string
  readonly cohortId: string
  readonly placement: Placement
  readonly status: ItemStatus
  readonly title: string
  readonly summary: string
  readonly bodyHtml: string
  readonly category: string | null
  readonly cover: ItemFileSummary | null
  readonly attachments: readonly ItemFileSummary[]
  readonly audienceKind: AudienceKind
  readonly groupIds: readonly string[]
  readonly receiverUnit: ReceiverUnit
  readonly stageId: string | null
  /** 同意書模式與用途（存草稿就落盤；發布後鎖定，`updatePublished` 改它們回 `VALIDATION_FAILED`）。 */
  readonly consentMode: ConsentMode | null
  readonly consentPurpose: ConsentPurpose | null
  readonly opensAt: Date | null
  readonly actualOpenedAt: Date | null
  readonly dueAt: Date | null
  /** 競賽資訊的報名截止日與活動日（臺灣日曆日；0011）。 */
  readonly registrationDeadline: string | null
  readonly eventDate: string | null
  /** 榮譽榜的得獎日期（臺灣日曆日；0011）；沒填或不是榮譽是 null。 */
  readonly awardedOn: string | null
  readonly deadlineVersion: number
  readonly fields: readonly FormField[]
  readonly revision: number
  readonly contentVersionNo: number | null
  readonly schemaVersionNo: number | null
  /** 應交數：同 `ItemListRow.rosterCount`（不含免填與已移出）。 */
  readonly rosterCount: number
  readonly updatedAt: Date
  /** 已有人存過草稿或正式送出（見 `ResponsePresence`）：收件單位、對象、欄位結構鎖定。 */
  readonly hasResponses: boolean
  /** 發布、發布更新的紀錄，新的在前。 */
  readonly publications: readonly {
    readonly action: string
    readonly notify: boolean
    readonly actorUserId: string
    readonly actorName: string
    /** 操作者頭像兩欄（`user_profiles`；沒有 profile 是 null，畫面依帳號 hash 固定一張預設圖）。 */
    readonly actorAvatarPreset: number | null
    readonly actorAvatarFileId: string | null
    readonly realAt: Date
  }[]
}

export type EditorOptions = {
  readonly stages: readonly { readonly id: string; readonly seq: number; readonly name: string; readonly startDate: string }[]
  readonly groups: readonly { readonly id: string; readonly code: string; readonly memberCount: number }[]
}

export type RecipientPerson = {
  readonly userId: string
  readonly name: string
  readonly studentNo: string | null
  readonly groupCode: string | null
}

export type RecipientGroup = {
  readonly groupId: string
  readonly code: string
  readonly members: readonly string[]
}

/**
 * 發布前的名單預覽（產品模組 04：要能展開看到實際的人／組，不只總數）。
 * 收件：`people`（個人收件）或 `groups`（組別收件）就是會進名單的對象；
 * 公告／資源：只算勾「重要」時通知會寫給幾個人（`public`／`signed_in`＝全站有效帳號）。
 */
export type RecipientPreview = {
  readonly receiverUnit: ReceiverUnit
  readonly people: readonly RecipientPerson[]
  readonly groups: readonly RecipientGroup[]
  /** 發通知時會寫給幾個人。 */
  readonly notifyCount: number
}

export type RecipientQueryInput = {
  readonly cohortId: string
  readonly audienceKind: AudienceKind
  readonly groupIds: readonly string[]
  readonly receiverUnit: ReceiverUnit
}

export interface ItemQuery {
  /** 專題事務工作台：一屆的全部項目（不含已刪除），新的在前（呼叫端守門）。 */
  list(cohortId: string): Promise<ItemListRow[]>
  /** 編輯器要的一筆（呼叫端守門）。找不到或已刪除回 null。 */
  get(itemId: string): Promise<ItemDetail | null>
  /** 編輯器的選項：這一屆的階段與有效組別。 */
  editorOptions(cohortId: string): Promise<EditorOptions>
  /** 依對象展開實際的收件者（發布前預覽；與發布時建名單用同一段查詢）。 */
  previewRecipients(input: RecipientQueryInput): Promise<RecipientPreview>
}

// ── 前台與日曆（票 16） ────────────────────────────────────────────────────────

/** 前台列表的一張卡：只有公開欄位（標題、摘要、分類、封面、附件、發布日），沒有對象細節、名單或欄位。 */
export type PublicItemCard = {
  readonly id: string
  readonly placement: Placement
  readonly title: string
  readonly summary: string
  readonly category: string | null
  /** 對象不是「公開訪客」時，卡片標「登入可見」。 */
  readonly audienceKind: AudienceKind
  readonly cover: ItemFileSummary | null
  readonly attachments: readonly ItemFileSummary[]
  /** 第一次發布的時間（實際開放時間；重新發布不改）。 */
  readonly publishedAt: Date
  /** 競賽資訊的報名截止日與活動日（臺灣日曆日；0011，票 39）；不是競賽資訊就是 null。 */
  readonly registrationDeadline: string | null
  readonly eventDate: string | null
  /** 榮譽榜的得獎日期（臺灣日曆日；0011）；沒填是 null（畫面退回發布日）。 */
  readonly awardedOn: string | null
  /** 置頂時間（第 1 批 V1）：有值時卡片標「置頂」。只有公告會有。 */
  readonly pinnedAt: Date | null
}

/**
 * 打開一個前台內容頁的結果（`publicAccessOf` 的四種狀態）。只有 `visible` 帶內容；
 * 已下架、已撤回、要登入、找不到都**不帶標題與內容**，只帶位置讓頁面給對的下一步。
 */
export type PublicItemPage =
  | {
      readonly access: 'visible'
      readonly item: PublicItemCard & {
        /** 正文：**已經過 `renderBodyHtml` 清理**（伺服器端），畫面直接輸出這一段。 */
        readonly bodyHtml: string
      }
    }
  | { readonly access: Exclude<PublicAccess, 'visible'>; readonly placement: Placement | null }

export type PublicListFilter = {
  readonly category?: string
  /** 標題或摘要包含這段字（不分大小寫）。 */
  readonly q?: string
  readonly limit?: number
  /**
   * 預設新的在前，**置頂的公告排最前**（多則置頂時後置頂的在前；第 1 批 V1，D3、D9）；規則頁用 `oldest`（先發布的章節在前）。
   * 榮譽用 `awarded`／`awarded-asc`：依得獎日期（沒填退回發布日的臺灣日期）排，**排好才取 `limit` 筆**。
   */
  readonly order?: 'newest' | 'oldest' | 'awarded' | 'awarded-asc'
  /**
   * 競賽狀態篩選：在 SQL 裡依 `today` 推狀態（與 `competitionStatus` 同一套規則），**篩完才取 `limit` 筆**，
   * 較早發布但還在報名中的競賽不會被截掉。
   */
  readonly competition?: { readonly today: TaipeiDate; readonly statuses: readonly CompetitionStatus[] }
  /**
   * 只列這幾種對象（老師首頁「給老師的公告」，第三波 W4）：在 SQL 裡**篩完才取 `limit` 筆**，較舊的老師公告
   * 不會被較新的公開公告擠掉。只是縮小範圍，看不看得到照舊依看的人判斷；給空陣列就是什麼都不列。
   */
  readonly audiences?: readonly AudienceKind[]
}

/** 學生行事曆上的一個收件截止（來源就是收件項目的截止，不另外存）。 */
export type MyDeadline = {
  readonly itemId: string
  readonly cohortId: string
  readonly title: string
  readonly dueAt: Date
  readonly receiverUnit: ReceiverUnit
}

/**
 * 前台內容頁與站內日曆的查詢（產品模組 09 §9.1、08「站內日曆」）。
 *
 * 跟 `ItemQuery` 不同，這個 port **自己依看的人過濾**：沒登入、待審、停用、必須改密的人都當訪客；
 * 登入者依角色、學生屆別與目前所在組別套 `canViewItem`。前台只列發布中的項目，跨屆別、新的在前。
 */
export interface PublicItemQuery {
  /** 某個前台位置（公告、資源、規則）看得到的項目。 */
  list(actor: ResolvedActor, placement: Placement, filter?: PublicListFilter): Promise<PublicItemCard[]>
  /**
   * 整頁全文（規則頁）：這個位置看得到的項目**連同正文**，先發布的在前。
   * 正文同樣已經過 `renderBodyHtml` 清理。
   */
  fullText(actor: ResolvedActor, placement: Placement): Promise<(PublicItemCard & { readonly bodyHtml: string })[]>
  /** 這個位置看得到的項目用了哪些分類（篩選用）。 */
  categories(actor: ResolvedActor, placement: Placement): Promise<string[]>
  /** 打開某一個項目（只認這個位置的；別的位置的 ID 一律 `not_found`）。 */
  open(actor: ResolvedActor, itemId: string, placement: Placement): Promise<PublicItemPage>
  /**
   * 這位學生目前要交的收件截止：本人或本人所在組別在**目前的**收件名單上、項目發布中、有截止。
   * 可見範圍跟收件名單一致（產品 08：可見範圍跟來源一致，不把別組的截止給他看）。
   */
  myDeadlines(actor: ResolvedActor): Promise<MyDeadline[]>
  /**
   * 這位老師目前指導的組所在的屆別（`advisor_assignments` 有效那一列、組別沒解散；第三波 W4，Q13）。
   * 跟可見性判斷用同一份資料：老師首頁「本屆活動」列這些屆別的活動。不是老師、訪客回空陣列。
   */
  advisedCohortIds(actor: ResolvedActor): Promise<string[]>
}

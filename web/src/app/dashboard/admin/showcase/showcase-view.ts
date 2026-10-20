/**
 * 公告與作業 › 成果展示的畫面資料（C 階段規格① §4.5、§11.3；C1-09）：純函式，伺服器頁與用戶端視窗共用。
 *
 * - `defaultShowcaseDraft`：「新增 › 作品／補登歷屆作品」視窗的空白初值。
 * - `showcaseCohorts`：屆別選單（作品清單、榮譽榜各一條）、建草稿的屆別、補登可選的屆別。
 * - `homeOrderPatch`：拖曳或輸入數字後，哪幾件的首頁順序要改成多少（存一次）。
 */

export type ShowcaseStatus = 'draft' | 'published' | 'withdrawn'
export type ShowcaseAwardLevel = 'excellent' | 'merit'

/** 視窗編輯的欄位（題目、摘要、影片、海報屬於草稿；獎項、首頁順序屬於條目）。 */
export type ShowcaseDraftFields = {
  readonly title: string
  readonly summary: string
  readonly videoUrl: string
  readonly poster: { readonly fileId: string; readonly name: string } | null
  readonly award: ShowcaseAwardLevel | null
  readonly awardLabel: string
  /** 1–99；null＝不排。 */
  readonly homePosition: number | null
}

/** 清單一列＋編輯視窗要的事實（伺服器算好）。 */
export type ShowcaseEntryView = ShowcaseDraftFields & {
  readonly entryId: string
  /** 條目版本（獎項、首頁順序、公開狀態的樂觀鎖）。 */
  readonly entryRevision: number
  /** 草稿版本（題目、摘要、影片、海報的樂觀鎖）。 */
  readonly draftRevision: number
  readonly cohortLabel: string
  /** 組別代號；歷屆補登是「（歷屆補登）」。 */
  readonly groupLabel: string
  readonly status: ShowcaseStatus
  readonly hasDraft: boolean
  readonly hasUnpublishedChanges: boolean
  readonly publishedTitle: string | null
  /** 不能改內容的原因（例如組已解散）；可以改是 null。 */
  readonly locked: string | null
  /** 不能刪的原因（公開中要先下架）；可以刪是 null。 */
  readonly deleteBlocked: string | null
  /** 最後儲存「時間・誰」與凍結說明。 */
  readonly savedNote: string
}

export function defaultShowcaseDraft(): ShowcaseDraftFields {
  return { title: '', summary: '', videoUrl: '', poster: null, award: null, awardLabel: '', homePosition: null }
}

type CohortLike = { readonly id: string; readonly status: string; readonly isDefaultWorking: boolean }

export type ShowcaseCohorts<C extends CohortLike> = {
  /** 作品清單篩選的屆別；null＝全部（含歷屆）。 */
  readonly picked: C | null
  /** 「新增 › 作品」用的屆別：篩選的屆別沒封存就用它，否則用預設工作屆別；都沒有是 null。 */
  readonly createCohort: C | null
  /** 榮譽榜區看哪一屆（含已封存）：`?honor=` → 篩選的屆別 → 預設工作屆別 → 第一屆。 */
  readonly honorCohort: C | null
  /** 補登歷屆作品可選的屆別（含已封存）；篩選中的排第一個當預設。 */
  readonly backfillCohorts: readonly C[]
}

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function showcaseCohorts<C extends CohortLike>(
  all: readonly C[],
  params: { readonly cohort?: string | string[]; readonly honor?: string | string[] },
): ShowcaseCohorts<C> {
  const picked = all.find((c) => c.id === one(params.cohort)) ?? null
  const open = all.filter((c) => c.status !== 'archived')
  const fallback = open.find((c) => c.isDefaultWorking) ?? open[0] ?? null
  const createCohort = picked && picked.status !== 'archived' ? picked : fallback
  const honorCohort = all.find((c) => c.id === one(params.honor)) ?? picked ?? fallback ?? all[0] ?? null
  const backfillCohorts = [...(picked ? [picked] : []), ...all.filter((c) => c.id !== picked?.id)]
  return { picked, createCohort, honorCohort, backfillCohorts }
}

/** 首頁順序上限（同用例）。 */
export const HOME_POSITION_MAX = 99

/**
 * 首頁輪播順序：照畫面上的先後給 1、2、3…，只回傳跟原本不一樣的那幾件（存一次）。
 * 超過上限的排不進去（留原值），由畫面提示。
 */
export function homeOrderPatch(
  ordered: readonly { readonly entryId: string; readonly homePosition: number | null }[],
): { entryId: string; position: number }[] {
  return ordered
    .slice(0, HOME_POSITION_MAX)
    .map((e, i) => ({ entryId: e.entryId, position: i + 1, before: e.homePosition }))
    .filter((e) => e.before !== e.position)
    .map(({ entryId, position }) => ({ entryId, position }))
}

// ── 編輯視窗一次存齊（`actions.ts` 的 `saveEntryAction`；actions 檔只能匯出 async 函式，型別放這裡） ──

/** 每一步各自的請求編號（重送同一組編號時，已做過的步驟由用例的冪等處理回同一個結果）。 */
export type SaveEntryRequestIds = { create: string; draft: string; award: string; home: string; lifecycle: string }

export type SaveEntryInput = {
  /** create＝本屆某組新作品；backfill＝補登歷屆作品（沒有組別）；edit＝改既有作品。 */
  mode: 'create' | 'backfill' | 'edit'
  entryId: string | null
  groupId: string | null
  cohortId: string | null
  entryRevision: number
  draftRevision: number
  /** 草稿欄位；沒改是 null。 */
  draft: { title: string; summary: string; videoUrl: string; posterFileId: string | null } | null
  /** 獎項；沒改是 null。 */
  award: { level: string; label: string } | null
  /** 首頁順序（'' ＝不排）；沒改是 null。 */
  home: { position: string } | null
  /** 存完要不要順便發布、發布更新或重新發布。 */
  lifecycle: 'publish' | 'publish_update' | 'republish' | null
  /** 「已取得這組同學同意公開」（發布與發布更新要勾，Q31）。 */
  consent: boolean
  requestIds: SaveEntryRequestIds
}

export type SaveEntryResult =
  | { ok: true; message: string; entryId: string }
  | { ok: false; message: string; field?: string }

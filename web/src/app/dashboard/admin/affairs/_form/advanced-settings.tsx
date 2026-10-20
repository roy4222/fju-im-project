'use client'
import { ChevronIcon, CoverPicker, cx, HistoryIcon, IMPORTANT_LABEL, INPUT, LABEL, pillClass } from '@/app/dashboard/admin/affairs/item-form-parts'
import { HONOR, type EditorState, type EditorVocabulary, type PublicationLog } from '@/app/dashboard/admin/affairs/item-form-model'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 進階設定（C 階段規格① §2.3；折疊，預設收）：照位置露出不常改的欄位。
 * - 公告：摘要、分類（競賽資訊多報名截止日與活動日）、封面、重要公告通知。
 * - 資源：摘要、分類、重要公告通知。
 * - 作業：摘要、對應的評分項目（唯讀，連到成績 › 評分規則）；站內同意書多「用途」（發布後鎖定）。
 * - 榮譽：得獎日期、封面。
 * 最下方是「發布紀錄」（舊編輯頁的 Panel 搬進來，操作者有頭像：總表 Y-4）。
 */

const ACTION_LABEL: Record<string, string> = {
  publish: '發布',
  content_change: '改內容',
  schema_change: '改欄位',
  settings_change: '改「誰看得到」或繳交設定',
  deadline_change: '改截止',
  withdraw: '撤回',
  archive: '下架',
  republish: '重新發布',
}

export function AdvancedSettings({
  state,
  onChange,
  vocabulary,
  published,
  open,
  onToggle,
  important,
  onImportant,
  notifyCount,
  linkedStages,
  publications,
  consentPurposeError,
}: {
  state: EditorState
  onChange: (patch: Partial<EditorState>) => void
  vocabulary: EditorVocabulary
  /** 發布過（發布中或已下架）：同意書用途鎖定。 */
  published: boolean
  open: boolean
  onToggle: (open: boolean) => void
  /** 公告／資源這次發布要不要逐人通知；`null`＝這個位置沒有這個選項（作業、規則、榮譽、已發布）。 */
  important: boolean | null
  onImportant: (next: boolean) => void
  notifyCount: number | null
  /** 有幾個評分項目把這份作業設成對應作業（只有作業、而且算得到時才有）。 */
  linkedStages: number | null
  publications: readonly PublicationLog[]
  consentPurposeError?: string
}) {
  const placement = state.placement
  const consentForm = placement === 'submission' && state.consentMode === 'form'
  const competition = placement === 'news' && state.category.trim() === vocabulary.competitionCategory
  const showSummary = placement !== HONOR && placement !== 'rules'
  const showCategory = placement === 'news' || placement === 'resource'
  const showCover = placement === 'news' || placement === HONOR

  return (
    <details
      open={open}
      onToggle={(e) => onToggle(e.currentTarget.open)}
      className="group rounded-xl border border-border"
      data-testid="advanced-settings"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <ChevronIcon aria-hidden className="size-4 transition-transform group-open:rotate-90" />
        進階設定
        <span className="text-xs font-normal text-muted-foreground">
          {placement === 'submission' ? '摘要、評分項目' : placement === HONOR ? '得獎日期、封面' : placement === 'rules' ? '發布紀錄' : '摘要、分類、通知'}
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-border px-4 pt-3 pb-4">
        {showSummary ? (
          <div>
            <label htmlFor="ed-summary" className={LABEL}>
              摘要 <span className="text-xs font-normal text-muted-foreground">一句話，列表與首頁用</span>
            </label>
            <input
              id="ed-summary"
              className={INPUT}
              value={state.summary}
              placeholder="例：分組名單確認表已開放填寫。"
              onChange={(e) => onChange({ summary: e.target.value })}
            />
          </div>
        ) : null}

        {showCategory ? (
          <div>
            <label htmlFor="ed-category" className={LABEL}>
              分類 <span className="text-xs font-normal text-muted-foreground">選填</span>
            </label>
            {placement === 'news' ? (
              // 競賽頁只認一字不差的「競賽資訊」（設計方案 §14-4）：給一顆快速鍵與一句說明。
              <>
                <div className="flex items-center gap-2">
                  <input
                    id="ed-category"
                    className={cx(INPUT, 'min-w-0 flex-1')}
                    value={state.category}
                    aria-describedby="ed-category-hint"
                    onChange={(e) => onChange({ category: e.target.value })}
                  />
                  <button
                    type="button"
                    data-testid="category-competition"
                    className={cx(pillClass(state.category.trim() === vocabulary.competitionCategory), 'shrink-0')}
                    onClick={() => onChange({ category: vocabulary.competitionCategory })}
                  >
                    {vocabulary.competitionCategory}
                  </button>
                </div>
                <p id="ed-category-hint" className="mt-1.5 text-xs text-muted-foreground">
                  要出現在前台「{vocabulary.competitionCategory}」頁，分類要填「{vocabulary.competitionCategory}」，填了會多出報名截止日與活動日。
                </p>
              </>
            ) : (
              <input id="ed-category" className={INPUT} value={state.category} onChange={(e) => onChange({ category: e.target.value })} />
            )}
          </div>
        ) : null}

        {competition ? (
          <div className="grid gap-4 sm:grid-cols-2" data-testid="competition-dates">
            <div>
              <label htmlFor="ed-registration-deadline" className={LABEL}>
                報名截止日 <span className="text-xs font-normal text-muted-foreground">當天以前顯示「報名中」</span>
              </label>
              <input
                id="ed-registration-deadline"
                type="date"
                className={INPUT}
                value={state.registrationDeadline}
                onChange={(e) => onChange({ registrationDeadline: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="ed-event-date" className={LABEL}>
                活動日 <span className="text-xs font-normal text-muted-foreground">決賽、展出；截止後到這天顯示「決賽／結果」</span>
              </label>
              <input
                id="ed-event-date"
                type="date"
                className={INPUT}
                value={state.eventDate}
                min={state.registrationDeadline || undefined}
                onChange={(e) => onChange({ eventDate: e.target.value })}
              />
            </div>
          </div>
        ) : null}

        {placement === HONOR ? (
          <div>
            <label htmlFor="ed-awarded-on" className={LABEL}>
              得獎日期 <span className="text-xs font-normal text-muted-foreground">選填</span>
            </label>
            <input id="ed-awarded-on" type="date" className={INPUT} value={state.awardedOn} onChange={(e) => onChange({ awardedOn: e.target.value })} />
            <p className="mt-1.5 text-xs text-muted-foreground">沒填就用發布那天；前台榮譽榜依這天分年份、由新到舊排。</p>
          </div>
        ) : null}

        {showCover ? (
          <div className="flex flex-col gap-2">
            <p className={LABEL}>
              封面 <span className="text-xs font-normal text-muted-foreground">選填</span>
            </p>
            <CoverPicker
              cohortId={state.cohortId}
              placement={state.placement}
              cover={state.cover}
              onChange={(cover) => onChange({ cover })}
              accept={vocabulary.uploads.cover.accept}
              maxMiB={vocabulary.uploads.cover.maxMiB}
            />
          </div>
        ) : null}

        {important !== null ? (
          <label className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
            <input type="checkbox" checked={important} className="size-4 accent-primary" onChange={(e) => onImportant(e.target.checked)} />
            {IMPORTANT_LABEL}
            {notifyCount !== null ? <span className="font-normal whitespace-nowrap text-muted-foreground">・勾選後將通知 {notifyCount} 人</span> : null}
          </label>
        ) : null}

        {consentForm ? (
          <div>
            <label htmlFor="ed-consent-purpose" className={LABEL}>
              同意書用途
            </label>
            <select
              id="ed-consent-purpose"
              className={INPUT}
              value={state.consentPurpose}
              disabled={published}
              aria-invalid={consentPurposeError ? true : undefined}
              aria-describedby={consentPurposeError ? 'err-consentPurpose' : 'ed-consent-purpose-hint'}
              onChange={(e) => onChange({ consentPurpose: e.target.value })}
            >
              <option value="">請選擇</option>
              {vocabulary.consentPurposes.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            {consentPurposeError ? (
              <p id="err-consentPurpose" className="mt-1.5 text-sm font-semibold text-destructive" data-error="consentPurpose">
                {consentPurposeError}
              </p>
            ) : null}
            <p id="ed-consent-purpose-hint" className="mt-1.5 text-xs text-muted-foreground">
              {published
                ? '發布後用途不能改。'
                : state.consentPurpose === 'final_document'
                  ? '發布時每個對象組都要有成果展示草稿，否則擋發布。'
                  : '發布後就不能改。'}
            </p>
          </div>
        ) : null}

        {placement === 'submission' && !consentForm ? (
          <p className="text-sm" data-testid="linked-stages">
            {linkedStages && linkedStages > 0 ? `有 ${linkedStages} 個評分項目會看這份作業；` : '目前沒有評分項目對應這份作業；'}
            <a href={`/dashboard/admin/grading/rules?cohort=${state.cohortId}`} className="font-semibold text-primary-on-subtle underline-offset-2 hover:underline">
              到成績 › 評分規則設定
            </a>
            。
          </p>
        ) : null}

        {publications.length > 0 ? (
          <details className="rounded-lg border border-border">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-semibold">
              <HistoryIcon aria-hidden className="size-4" /> 發布紀錄
              <span className="text-xs font-normal text-muted-foreground">{publications.length} 筆</span>
            </summary>
            <ul aria-label="發布紀錄" className="divide-y divide-border border-t border-border text-sm">
              {publications.map((p, index) => (
                <li key={index} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 tabular-nums">
                  {/* 頭像網址由伺服器算好帶進來（`toInitial` 的 `avatarUrls`）；樣式同 `AvatarImg`，姓名就在旁邊所以 alt 留空。 */}
                  {p.actorAvatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.actorAvatarUrl}
                      alt=""
                      width={24}
                      height={24}
                      loading="lazy"
                      decoding="async"
                      className="size-6 shrink-0 rounded-full bg-muted object-cover"
                    />
                  ) : (
                    <span aria-hidden className="size-6 shrink-0 rounded-full bg-muted" />
                  )}
                  <span className="font-semibold">{ACTION_LABEL[p.action] ?? p.action}</span>
                  <span className="text-muted-foreground">
                    {formatTaipeiMinute(new Date(p.realAt))}・{p.actorName}
                    {p.notify ? '・有勾通知' : '・沒勾通知'}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </details>
  )
}

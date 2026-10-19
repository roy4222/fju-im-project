'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconSend, IconTrash } from '@tabler/icons-react'
import { BackLink, Pill } from '@/app/_ui/dashboard-kit'
import { AdvancedSettings } from '@/app/dashboard/admin/affairs/_form/advanced-settings'
import { AttachmentDrop } from '@/app/dashboard/admin/affairs/_form/attachment-drop'
import { FieldBuilder } from '@/app/dashboard/admin/affairs/_form/field-builder'
import { LivePreview, useLiveReview } from '@/app/dashboard/admin/affairs/_form/live-preview'
import {
  changeItemStatusAction,
  createItemAction,
  deleteItemAction,
  publishItemAction,
  saveDraftAction,
  updatePublishedAction,
} from '@/app/dashboard/admin/affairs/actions'
import { DIALOG, Feedback, IMPORTANT_LABEL, INPUT, LABEL, PRIMARY, SECONDARY } from '@/app/dashboard/admin/affairs/item-form-parts'
import {
  blurError,
  broadAudience,
  defaultItemDraft,
  ERROR_ORDER,
  errorKeyOfCheck,
  errorKeyOfField,
  HONOR,
  HONOR_AUDIENCE,
  ITEM_FLASH_KEY,
  newRequestId,
  stateFromInitial,
  switchPlacement,
  toPayload,
  validateItemForm,
  type EditorState,
  type EditorVocabulary,
  type FieldDraft,
  type FormErrorKey,
  type FormErrors,
  type ItemFormInitial,
  type ItemFormPlacement,
  type ItemStatusValue,
} from '@/app/dashboard/admin/affairs/item-form-model'
import { RichEditor } from '@/app/dashboard/admin/editor/rich-editor'
import type { ItemTemplate } from '@/application/items'
import { cn } from '@/shared/cn'

/**
 * 共用一頁式新增／編輯表單（C 階段規格① §2；A11、A3、A4、A5、A13、R2、G2）。
 * 取代舊的「新增項目」三步驟視窗與「完整編輯器」四區段：左邊由上到下「對象、開放時間、截止時間、標題、內容、附件、繳交欄位、▸ 進階設定」，
 * 右邊「即時預覽：學生看到的樣子」，底部兩顆鈕。所有類型共用，由 `placement` 決定露出哪些欄位。
 *
 * - 必填當下就擋：標題、截止在 blur 時驗；按「發布」整張驗一次，頂部寫「還缺 N 項」並捲到第一個紅字，不跳視窗、不離開表單。
 *   規則的權威仍在伺服器（`publishChecks`）；伺服器擋下的項目也標回對應欄位。
 * - 按鈕：新增／草稿「儲存（先不發布）」「發布」；發布中「儲存更新」「下架」；已下架「重新發布」。「撤回」不在畫面上（API 保留）。
 * - 草稿共用 id：第一次儲存或發布才建列；之後都存回同一筆（`requestId` 冪等）。
 * - 表單**不** `router.push`／`refresh`、不發 toast：成功只呼叫 `onDone`，刷新與提示由呼叫端（全頁、分頁、前台編輯框架）處理。
 *   例外是全頁的「儲存（先不發布）」：留在原頁、網址換成 `/editor/<id>`（同一筆繼續編輯）。
 */

export type { ItemFormPlacement } from '@/app/dashboard/admin/affairs/item-form-model'

export type ItemFormProps = {
  /** 由分頁或前台區塊決定；表單裡不能改（`/editor/new` 例外：`placementSelectable`）。 */
  placement: ItemFormPlacement
  cohortId: string
  /** 有＝編輯；無＝新增。 */
  itemId?: string
  /** 編輯時由 server 端 `ItemQuery.get` 轉成（`toInitial`，§2.7）。 */
  initial?: ItemFormInitial
  /** 組別清單、檔案規則、詞彙（`editorVocabulary(cohortId)`）。 */
  options: EditorVocabulary
  /** 前台「指定組別」區塊預填。 */
  presetGroupIds?: readonly string[]
  /** 只有作業用；由「新增」選單決定。 */
  consentMode?: 'form' | 'upload'
  /** 全頁（/editor/*）、對話框（分頁內、前台 A8）、就地展開（專題規則章節卡：沒有右欄預覽、沒有對象／開放／截止欄）。 */
  layout: 'page' | 'dialog' | 'inline'
  onDone: (result: { itemId: string; status: 'draft' | 'published'; message?: string }) => void
  onCancel: () => void
  /** 收件範本（第三波 W12）：按一下插入整組欄位。 */
  templates?: readonly ItemTemplate[]
  /** `/editor/new`：沒有分頁脈絡，可以在表單上方選「顯示在哪一區」（換位置時已填的內容保留）。 */
  placementSelectable?: boolean
  /** 全頁的頁首。 */
  heading?: string
  meta?: string
  /** 有幾個評分項目把這份作業設成對應作業（進階設定唯讀顯示）；算不到是 null。 */
  linkedStages?: number | null
  /** 全頁刪除成功（刪除鈕只在全頁；清單列的刪除歸 C1-07）。 */
  onDeleted?: (cohortId: string) => void
}

const STATUS_LABEL: Record<ItemStatusValue, string> = { draft: '草稿', published: '發布中', archived: '已下架' }

/** 刪除鈕與確認鈕上的名詞（確認鈕寫動作，不寫「確定」；§9 規則 1）。 */
const DELETE_LABEL: Record<string, string> = {
  news: '刪除這則公告',
  resource: '刪除這份資源',
  submission: '刪除這個作業',
  rules: '刪除這節規則',
  honor: '刪除這則榮譽',
}

/** 每個會標紅的欄位捲到哪個元素（`ERROR_ORDER` 的順序＝畫面由上到下）。 */
const ERROR_TARGET: Record<FormErrorKey, string> = {
  audience: 'ed-audience',
  opensAt: 'ed-opens',
  dueAt: 'ed-due',
  title: 'ed-title',
  fields: 'sec-fields',
  consentPurpose: 'ed-consent-purpose',
}

const ERROR_LABEL: Record<FormErrorKey, string> = {
  audience: '對象',
  opensAt: '開放時間',
  dueAt: '截止時間',
  title: '標題',
  fields: '繳交欄位',
  consentPurpose: '同意書用途',
}

function subscribeNothing() {
  return () => {}
}

type Busy = null | 'save' | 'publish' | 'update' | 'archive' | 'republish' | 'delete'
const BUSY_TEXT: Record<Exclude<Busy, null>, string> = {
  save: '儲存中…',
  publish: '發布中…',
  update: '更新中…',
  archive: '下架中…',
  republish: '重新發布中…',
  delete: '刪除中…',
}

export function ItemForm(props: ItemFormProps) {
  const { cohortId, options: vocabulary, layout, onDone, onCancel, templates = [] } = props
  const [initial] = useState<ItemFormInitial>(
    () => props.initial ?? defaultItemDraft(props.placement, cohortId, { consentMode: props.consentMode, presetGroupIds: props.presetGroupIds }),
  )
  const [state, setState] = useState<EditorState>(() => stateFromInitial(initial))
  const [itemId, setItemId] = useState<string | null>(props.itemId ?? null)
  const [revision, setRevision] = useState(initial.revision)
  const [status, setStatus] = useState<ItemStatusValue>(initial.status)
  const [errors, setErrors] = useState<FormErrors>({})
  const [summary, setSummary] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [importantChoice, setImportantChoice] = useState<boolean | null>(null)
  const [notifyUpdate, setNotifyUpdate] = useState(() => !broadAudience(initial.audienceKind))
  const [republishNotify, setRepublishNotify] = useState(false)
  const [confirming, setConfirming] = useState<null | 'archive' | 'republish' | 'delete'>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const confirmDialog = useRef<HTMLDialogElement>(null)
  const requestIds = useRef({ save: newRequestId(), publish: newRequestId(), lifecycle: newRequestId(), remove: newRequestId() })
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false)

  const collects = state.placement === 'submission'
  const consentForm = collects && state.consentMode === 'form'
  const honor = state.placement === HONOR
  const fixedPublic = honor || state.placement === 'rules'
  const published = status !== 'draft'
  const archived = status === 'archived'
  const hasResponses = initial.hasResponses
  const publishedBefore = initial.publications.length > 0
  const inline = layout === 'inline'
  const live = useLiveReview(state, itemId, !inline)
  const notifyCount = live.review ? live.review.recipients.notifyCount : null
  // 公告／資源第一次發布：「重要公告」預設依對象（公開、所有登入者不勾），發布過再發布不勾；沒有人可以通知也不勾（§14-3）。
  const importantDefault = !broadAudience(state.audienceKind) && !publishedBefore && (notifyCount ?? 0) > 0
  const important = importantChoice ?? importantDefault
  const offersImportant = !published && !collects && !honor

  useEffect(() => {
    const dialog = confirmDialog.current
    if (!dialog) return
    if (confirming && !dialog.open) dialog.showModal()
    if (!confirming && dialog.open) dialog.close()
  }, [confirming])

  function patch(next: Partial<EditorState>) {
    setState((s) => ({ ...s, ...next }))
    // 改了哪一欄就把那一欄的紅字收掉（其他欄留著，直到下一次驗）。
    setErrors((e) => {
      const cleared = { ...e }
      if ('title' in next) delete cleared.title
      if ('dueAt' in next || 'opensAt' in next) {
        delete cleared.dueAt
        delete cleared.opensAt
      }
      if ('audienceKind' in next || 'groupIds' in next) delete cleared.audience
      if ('fields' in next) delete cleared.fields
      if ('consentPurpose' in next) delete cleared.consentPurpose
      return cleared
    })
  }

  function onBlur(key: 'title' | 'dueAt') {
    const error = blurError(state, key)
    setErrors((e) => {
      const next = { ...e }
      if (error) next[key] = error
      else delete next[key]
      return next
    })
  }

  /** 標紅、頂部寫「還缺 N 項」、捲到第一個紅字（不跳視窗）。 */
  function showErrors(found: FormErrors, fallback?: string) {
    setErrors(found)
    const keys = ERROR_ORDER.filter((k) => found[k])
    if (keys.length === 0) {
      setSummary(fallback ?? null)
      return
    }
    setSummary(`還缺 ${keys.length} 項：${keys.map((k) => ERROR_LABEL[k]).join('、')}`)
    if (keys.includes('consentPurpose')) setAdvancedOpen(true)
    const first = keys[0]!
    requestAnimationFrame(() => {
      const el = document.getElementById(ERROR_TARGET[first])
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.focus({ preventScroll: true })
    })
  }

  /** 伺服器擋下時：檢查代碼與欄位標回畫面；對不上欄位的整句放頂部。 */
  function showServerError(result: { message: string; field?: string; checks?: string[] }) {
    const found: FormErrors = {}
    for (const check of result.checks ?? []) {
      const key = errorKeyOfCheck(check)
      if (key) found[key] = result.message
    }
    const fieldKey = errorKeyOfField(result.field)
    if (fieldKey) found[fieldKey] = result.message
    if (Object.keys(found).length > 0) showErrors(found)
    else {
      setErrors({})
      setSummary(result.message)
    }
  }

  function startOver() {
    setSummary(null)
    setMessage(null)
  }

  /** 草稿存檔；回傳存好之後的 id 與 revision（失敗回 null，訊息已經顯示）。 */
  async function persist(): Promise<{ itemId: string; revision: number } | null> {
    const payload = toPayload(state)
    const result = itemId
      ? await saveDraftAction(itemId, revision, payload, requestIds.current.save)
      : await createItemAction(payload, requestIds.current.save)
    requestIds.current.save = newRequestId()
    if (!result.ok) {
      showServerError(result)
      return null
    }
    const saved = { itemId: result.data.itemId, revision: result.data.revision }
    setItemId(saved.itemId)
    setRevision(saved.revision)
    if (!itemId && layout === 'page') {
      // 全頁第一次存：網址換成這一筆的編輯頁（不重新載入，畫面上的內容保留）。
      window.history.replaceState(null, '', `/dashboard/admin/editor/${saved.itemId}`)
    }
    return saved
  }

  async function onSaveDraft() {
    startOver()
    const found = validateItemForm(state, 'draft', vocabulary.inputFieldTypes, vocabulary.emptyCollectionMessage)
    if (Object.keys(found).length > 0) return showErrors(found)
    setBusy('save')
    try {
      const saved = await persist()
      if (!saved) return
      if (layout === 'page') setMessage({ tone: 'ok', text: '已存成草稿；還沒有人看得到。' })
      else onDone({ itemId: saved.itemId, status: 'draft', message: '已儲存' })
    } catch {
      setSummary('連線中斷，請再按一次。')
    } finally {
      setBusy(null)
    }
  }

  async function onPublish() {
    startOver()
    const found = validateItemForm(state, 'publish', vocabulary.inputFieldTypes, vocabulary.emptyCollectionMessage)
    if (Object.keys(found).length > 0) return showErrors(found)
    setBusy('publish')
    try {
      const saved = await persist()
      if (!saved) return
      // 作業一定通知名單上要交的人；榮譽不發；公告／資源看「重要公告」。
      const notify = collects ? true : honor ? false : important
      const result = await publishItemAction(saved.itemId, saved.revision, notify, requestIds.current.publish)
      if (!result.ok) return showServerError(result)
      requestIds.current.publish = newRequestId()
      setRevision(result.data.revision)
      setStatus('published')
      onDone({ itemId: saved.itemId, status: 'published', message: '已發布' })
    } catch {
      setSummary('連線中斷；結果尚未確認，請回清單看這一筆的狀態。')
    } finally {
      setBusy(null)
    }
  }

  async function onUpdate() {
    if (!itemId) return
    startOver()
    const found = validateItemForm(state, 'publish', vocabulary.inputFieldTypes, vocabulary.emptyCollectionMessage)
    if (Object.keys(found).length > 0) return showErrors(found)
    setBusy('update')
    try {
      const result = await updatePublishedAction(itemId, revision, toPayload(state), notifyUpdate && !honor, requestIds.current.publish)
      if (!result.ok) return showServerError(result)
      requestIds.current.publish = newRequestId()
      setRevision(result.data.revision)
      onDone({ itemId, status: 'published', message: '已更新' })
    } catch {
      setSummary('連線中斷；結果尚未確認，請重新整理看狀態再決定要不要再按一次。')
    } finally {
      setBusy(null)
    }
  }

  function openConfirm(kind: 'archive' | 'republish' | 'delete') {
    startOver()
    setConfirmError(null)
    setRepublishNotify(false)
    requestIds.current.lifecycle = newRequestId()
    requestIds.current.remove = newRequestId()
    setConfirming(kind)
  }

  async function confirmLifecycle(action: 'archive' | 'republish') {
    if (!itemId) return
    setBusy(action)
    setConfirmError(null)
    try {
      const notify = action === 'republish' && !collects && !honor && republishNotify
      const result = await changeItemStatusAction(itemId, revision, action, requestIds.current.lifecycle, notify)
      if (!result.ok) {
        setConfirmError(result.message)
        return
      }
      requestIds.current.lifecycle = newRequestId()
      setRevision(result.data.revision)
      setStatus(result.data.status)
      setConfirming(null)
      if (layout === 'page') setMessage({ tone: 'ok', text: result.message ?? '已完成。' })
      else onDone({ itemId, status: result.data.status === 'published' ? 'published' : 'draft', message: action === 'archive' ? '已下架' : '已重新發布' })
    } catch {
      setConfirmError('連線中斷；結果尚未確認，請重新整理頁面看狀態再決定要不要再按一次。')
    } finally {
      setBusy(null)
    }
  }

  async function confirmDelete() {
    if (!itemId) return
    setBusy('delete')
    setConfirmError(null)
    try {
      const result = await deleteItemAction(itemId, revision, requestIds.current.remove)
      if (!result.ok) {
        setConfirmError(result.message)
        return
      }
      setConfirming(null)
      props.onDeleted?.(result.data.cohortId)
    } catch {
      setConfirmError('連線中斷；結果尚未確認，請重新整理頁面看狀態再決定要不要再按一次。')
    } finally {
      setBusy(null)
    }
  }

  function applyTemplate(template: ItemTemplate, added: FieldDraft[]): string {
    patch({ fields: [...state.fields, ...added], receiverUnit: template.receiverUnit })
    const unit = vocabulary.units.find((u) => u.value === template.receiverUnit)?.label ?? template.receiverUnit
    return added.length > 0
      ? `已加入 ${added.length} 個欄位，繳交方式改為「${unit}」（可在上方「繳交方式」改）。`
      : `這些欄位都已經在了，沒有重複加入；繳交方式維持「${unit}」。`
  }

  // ── 欄位 ──
  const audiences = fixedPublic
    ? vocabulary.audiences.filter((a) => a.value === HONOR_AUDIENCE || a.value === state.audienceKind)
    : collects
      ? vocabulary.audiences.filter((a) => vocabulary.collectionAudiences.includes(a.value))
      : vocabulary.audiences
  const errorText = (key: FormErrorKey) =>
    errors[key] ? (
      <p id={`err-${key}`} className="mt-1.5 text-sm font-semibold text-destructive" data-error={key}>
        {errors[key]}
      </p>
    ) : null
  const invalid = (key: FormErrorKey) => (errors[key] ? { 'aria-invalid': true, 'aria-describedby': `err-${key}` } : {})
  const deleteLabel = DELETE_LABEL[state.placement] ?? '刪除這個項目'
  const deleteBlocked =
    status === 'published'
      ? '發布中，先下架才能刪'
      : hasResponses
        ? initial.responseCount
          ? `已有 ${initial.responseCount} ${state.receiverUnit === 'individual' ? '人' : '組'}交件，不能刪`
          : '已經有人交件，不能刪'
        : null
  const busyText = busy ? BUSY_TEXT[busy] : null

  const audienceBlock = inline ? null : (
    <div className="flex flex-col gap-3" data-testid="audience-block">
      <div>
        <label htmlFor="ed-audience" className={LABEL}>
          對象（誰看得到）
        </label>
        <select
          id="ed-audience"
          className={INPUT}
          value={honor ? HONOR_AUDIENCE : state.audienceKind}
          disabled={hasResponses || fixedPublic || archived}
          onChange={(e) => patch({ audienceKind: e.target.value })}
          {...invalid('audience')}
        >
          {audiences.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        {honor ? (
          <p className="mt-1.5 text-xs text-muted-foreground" data-testid="honor-where">
            榮譽榜是公開頁：對象固定「公開訪客」、不發通知。發布後會出現在前台
            <a href="/honors" target="_blank" rel="noopener" className="mx-0.5 font-semibold text-foreground underline underline-offset-2">
              「榮譽榜」
            </a>
            與首頁「榮譽與競賽」；年份與排序依得獎日期。
          </p>
        ) : state.placement === 'rules' ? (
          <p className="mt-1.5 text-xs text-muted-foreground">專題規則是公開頁：對象固定「公開訪客」。</p>
        ) : collects ? (
          <p className="mt-1.5 text-xs text-muted-foreground">作業只能發給本屆學生、指定組別或全部老師。</p>
        ) : null}
      </div>
      {state.audienceKind === 'groups' && !fixedPublic ? (
        <fieldset>
          <legend className={cn(LABEL, 'mb-1.5')}>
            指定組別 <span className="font-normal text-muted-foreground">・已選 {state.groupIds.length} 組</span>
          </legend>
          {vocabulary.groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">這一屆還沒有成立的組別。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {vocabulary.groups.map((g) => {
                const on = state.groupIds.includes(g.id)
                return (
                  <label
                    key={g.id}
                    className={cn(
                      'inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-semibold tabular-nums transition-colors',
                      on ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border hover:border-ink/40',
                      (hasResponses || archived) && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={hasResponses || archived}
                      className="size-4 accent-primary"
                      onChange={() => patch({ groupIds: on ? state.groupIds.filter((x) => x !== g.id) : [...state.groupIds, g.id] })}
                    />
                    {g.code}（{g.memberCount} 人）
                  </label>
                )
              })}
            </div>
          )}
        </fieldset>
      ) : null}
      {errorText('audience')}
      {collects && state.consentMode === null ? (
        <fieldset>
          <legend className={cn(LABEL, 'mb-1.5')}>繳交方式</legend>
          <div className="flex flex-wrap gap-2">
            {vocabulary.units
              .filter((u) => u.value !== 'none')
              .map((u) => {
                const on = state.receiverUnit === u.value
                return (
                  <label
                    key={u.value}
                    className={cn(
                      'inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors',
                      on ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border hover:border-ink/40',
                      hasResponses && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <input
                      type="radio"
                      name="ed-unit"
                      value={u.value}
                      checked={on}
                      disabled={hasResponses || archived}
                      className="size-4 accent-primary"
                      onChange={() => patch({ receiverUnit: u.value })}
                    />
                    {u.label}
                  </label>
                )
              })}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {hasResponses
              ? '已經有人作答，繳交方式鎖定、不能再切換。'
              : '個人一份：每位學生各交一份。整組一份：組員共用一份，任一人送出代表整組。有人作答後就不能切換。'}
          </p>
        </fieldset>
      ) : null}
    </div>
  )

  const timeBlock =
    inline || !collects ? null : (
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="ed-opens" className={LABEL}>
            開放時間（選填）
          </label>
          <input
            id="ed-opens"
            type="datetime-local"
            className={INPUT}
            value={state.opensAt}
            disabled={published}
            onChange={(e) => patch({ opensAt: e.target.value })}
            {...invalid('opensAt')}
          />
          {errorText('opensAt')}
          <p className="mt-1.5 text-xs text-muted-foreground">留空＝發布即開放；發布時會記下實際開放時間，之後不會重設。</p>
        </div>
        <div>
          <label htmlFor="ed-due" className={LABEL}>
            截止時間（臺灣時間，含這一分鐘）
          </label>
          <input
            id="ed-due"
            type="datetime-local"
            className={INPUT}
            value={state.dueAt}
            disabled={archived}
            min={state.opensAt || undefined}
            onChange={(e) => patch({ dueAt: e.target.value })}
            onBlur={() => onBlur('dueAt')}
            {...invalid('dueAt')}
          />
          {errorText('dueAt')}
          <p className="mt-1.5 text-xs text-muted-foreground">
            {consentForm ? '站內同意書的截止選填。' : '例如 23:59：23:59:59 前送出都算準時，00:00 起就算遲交。'}
          </p>
        </div>
      </div>
    )

  const leftColumn = (
    <fieldset disabled={archived} className="flex min-w-0 flex-col gap-5">
      {props.placementSelectable && !itemId ? (
        <div>
          <label htmlFor="ed-placement" className={LABEL}>
            顯示在哪一區
          </label>
          <select
            id="ed-placement"
            className={INPUT}
            value={state.placement}
            onChange={(e) => setState((s) => switchPlacement(s, e.target.value as ItemFormPlacement, vocabulary.collectionAudiences))}
          >
            {vocabulary.placements.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {vocabulary.placements.find((p) => p.value === state.placement)?.hint ? (
            <p className="mt-1.5 text-xs text-muted-foreground">{vocabulary.placements.find((p) => p.value === state.placement)?.hint}</p>
          ) : null}
        </div>
      ) : null}
      {audienceBlock}
      {timeBlock}
      <div>
        <label htmlFor="ed-title" className={LABEL}>
          標題
        </label>
        <input
          id="ed-title"
          className={INPUT}
          value={state.title}
          placeholder={state.placement === 'rules' ? '例：第一章 專題分組' : '例：114 學年度專題說明會'}
          onChange={(e) => patch({ title: e.target.value })}
          onBlur={() => onBlur('title')}
          {...invalid('title')}
        />
        {errorText('title')}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className={LABEL}>內容</p>
        <RichEditor
          value={state.body}
          onChange={(body) => patch({ body })}
          placeholder={collects ? '要交什麼、格式、上限。學生在作業說明看到的就是這段。' : '寫內容。可以打 # 標題、- 清單、**粗體**。'}
        />
        <p className="text-xs text-muted-foreground">
          直接打字，用上方工具列排版（標題、粗斜體、清單、表格、引用、連結）；也可切「原始 HTML」直接改。圖片請用封面或附件，其他標籤與程式碼存檔時會被清掉。
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className={LABEL}>
          附件 <span className="text-xs font-normal text-muted-foreground">{state.attachments.length ? `${state.attachments.length} 個` : '無'}</span>
        </p>
        <AttachmentDrop
          cohortId={state.cohortId}
          attachments={state.attachments}
          onChange={(attachments) => patch({ attachments })}
          accept={vocabulary.uploads.attachment.accept}
          maxMiB={vocabulary.uploads.attachment.maxMiB}
          disabled={archived}
        />
      </div>
      {collects && !consentForm ? (
        <FieldBuilder
          fields={state.fields}
          onChange={(fields) => patch({ fields })}
          vocabulary={vocabulary}
          hasResponses={hasResponses}
          responseCount={initial.responseCount}
          receiverUnit={state.receiverUnit}
          consentMode={state.consentMode}
          templates={state.consentMode === null ? templates : []}
          onTemplate={applyTemplate}
          error={errors.fields}
        />
      ) : null}
      <AdvancedSettings
        state={state}
        onChange={patch}
        vocabulary={vocabulary}
        published={published}
        open={advancedOpen}
        onToggle={setAdvancedOpen}
        important={offersImportant ? important : null}
        onImportant={setImportantChoice}
        notifyCount={notifyCount}
        linkedStages={props.linkedStages ?? null}
        publications={initial.publications}
        consentPurposeError={errors.consentPurpose}
      />
    </fieldset>
  )

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2" data-testid="item-form-actions">
      {busyText ? <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">{busyText}</span> : null}
      {status === 'published' && !honor ? (
        <label className="mr-auto flex min-h-10 flex-wrap items-center gap-x-2 text-sm font-semibold">
          <input type="checkbox" className="size-4 accent-primary" checked={notifyUpdate} onChange={(e) => setNotifyUpdate(e.target.checked)} />
          通知對象這次的修改
          {notifyCount !== null ? <span className="font-normal whitespace-nowrap text-muted-foreground">・勾選後將通知 {notifyCount} 人</span> : null}
        </label>
      ) : null}
      {status === 'draft' && offersImportant ? (
        <span className="mr-auto text-xs text-muted-foreground" data-testid="notify-hint">
          {important ? `發布時通知 ${notifyCount ?? 0} 人（進階設定可改）` : '發布時不逐人通知（進階設定可勾「重要公告」）'}
        </span>
      ) : null}
      {layout !== 'page' ? (
        <button type="button" className={SECONDARY} onClick={onCancel} disabled={busy !== null}>
          取消
        </button>
      ) : null}
      {status === 'draft' ? (
        <>
          <button type="button" className={SECONDARY} onClick={onSaveDraft} disabled={busy !== null}>
            儲存（先不發布）
          </button>
          <button type="button" className={cn(PRIMARY, 'h-10 px-5')} onClick={onPublish} disabled={busy !== null}>
            <IconSend aria-hidden /> 發布
          </button>
        </>
      ) : status === 'published' ? (
        <>
          <button type="button" className={SECONDARY} onClick={() => openConfirm('archive')} disabled={busy !== null}>
            下架
          </button>
          <button type="button" className={cn(PRIMARY, 'h-10 px-5')} onClick={onUpdate} disabled={busy !== null}>
            儲存更新
          </button>
        </>
      ) : (
        <button type="button" className={cn(PRIMARY, 'h-10 px-5')} onClick={() => openConfirm('republish')} disabled={busy !== null}>
          重新發布
        </button>
      )}
    </div>
  )

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="item-form" data-hydrated={hydrated ? '' : undefined} data-layout={layout}>
      {layout === 'page' ? (
        <div className="flex flex-col gap-2">
          <BackLink href={`/dashboard/admin/affairs?cohort=${state.cohortId}&placement=all`} label="公告與作業" />
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-extrabold tracking-tight">{props.heading ?? (itemId ? '編輯公告或作業' : '新增公告或作業')}</h1>
            <Pill tone={status === 'published' ? 'success' : 'default'} data-testid="item-status">
              {STATUS_LABEL[status]}
            </Pill>
          </div>
          {props.meta ? <p className="text-xs text-muted-foreground tabular-nums">{props.meta}</p> : null}
        </div>
      ) : null}

      {summary ? (
        <p role="alert" className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle" data-testid="form-error-summary">
          {summary}
        </p>
      ) : null}
      {message ? <Feedback tone={message.tone}>{message.text}</Feedback> : null}
      {archived ? (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm">已下架：前台看不到，內容不能在這裡改；要修改請先重新發布。</p>
      ) : null}

      <div className={cn('grid gap-6', !inline && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]')}>
        {leftColumn}
        {inline ? null : (
          <LivePreview
            state={state}
            vocabulary={vocabulary}
            live={live}
            notifyWhen={honor ? 'never' : published ? 'update' : 'important'}
            className="lg:sticky lg:top-20 lg:self-start"
          />
        )}
      </div>

      {layout === 'page' && itemId ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4" data-testid="item-delete">
          <button
            type="button"
            className={cn(SECONDARY, 'border-destructive/50 text-destructive hover:bg-destructive-subtle hover:text-destructive-on-subtle')}
            onClick={() => openConfirm('delete')}
            disabled={busy !== null || deleteBlocked !== null}
            aria-describedby={deleteBlocked ? 'delete-blocked' : undefined}
          >
            <IconTrash aria-hidden /> {deleteLabel}
          </button>
          {deleteBlocked ? (
            <p id="delete-blocked" className="text-xs font-semibold text-muted-foreground" data-testid="delete-blocked">
              {deleteBlocked}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">刪除後後台清單也看不到、不能恢復；已寄出的通知不會收回。</p>
          )}
        </div>
      ) : null}

      <div
        className={cn(
          'border-t border-border pt-4',
          layout === 'page' && 'sticky bottom-0 z-10 -mx-1 bg-background/95 px-1 pb-3 backdrop-blur',
          layout === 'dialog' && 'sticky bottom-0 bg-popover pb-1',
        )}
      >
        {footer}
      </div>

      <dialog
        ref={confirmDialog}
        aria-label={confirming === 'archive' ? '下架這個項目？' : confirming === 'republish' ? '重新發布？' : `${deleteLabel}？`}
        className={cn(DIALOG, 'w-[min(30rem,calc(100vw-2rem))]')}
        onClose={() => setConfirming(null)}
      >
        {confirming ? (
          <div className="flex flex-col gap-4 p-6">
            <h2 className="text-lg font-extrabold">
              {confirming === 'archive' ? '下架這個項目？' : confirming === 'republish' ? '重新發布？' : `${deleteLabel}？`}
            </h2>
            {confirming === 'archive' ? (
              <p className="text-sm leading-relaxed">下架後前台看不到，後台保留內容、回答與紀錄；之後可以重新發布，實際開放時間不會重設。</p>
            ) : confirming === 'republish' ? (
              <>
                <p className="text-sm leading-relaxed">恢復成下架前的那一版，對象又看得到；實際開放時間維持第一次發布的時間。已經截止的作業不能直接重新發布。</p>
                {!collects && !honor ? (
                  <label className="flex min-h-10 items-center gap-2 text-sm font-semibold">
                    <input type="checkbox" checked={republishNotify} className="size-4 accent-primary" onChange={(e) => setRepublishNotify(e.target.checked)} />
                    {IMPORTANT_LABEL}
                  </label>
                ) : null}
              </>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">對象</dt>
                <dd className="font-semibold break-words">「{state.title || '（未命名）'}」</dd>
                <dt className="text-muted-foreground">後果</dt>
                <dd>刪除後後台清單也看不到、不能恢復；已寄的通知不會收回。</dd>
              </dl>
            )}
            {confirmError ? <Feedback tone="error">{confirmError}</Feedback> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={() => setConfirming(null)} disabled={busy !== null}>
                取消
              </button>
              <button
                type="button"
                className={cn(PRIMARY, confirming === 'delete' && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}
                onClick={() => (confirming === 'delete' ? confirmDelete() : confirmLifecycle(confirming))}
                disabled={busy !== null}
              >
                {confirming === 'archive' ? '確認下架' : confirming === 'republish' ? '確認重新發布' : deleteLabel}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
  )
}

/** 全頁（`/editor/new`、`/editor/<id>`）：發布、儲存更新後回清單；刪除後也回清單。提示字放 sessionStorage，清單頁的「新增」鈕讀出來顯示。 */
export function ItemFormPage(props: Omit<ItemFormProps, 'layout' | 'onDone' | 'onCancel' | 'onDeleted'>) {
  const router = useRouter()
  const back = (cohortId: string, flash?: string) => {
    if (flash) window.sessionStorage.setItem(ITEM_FLASH_KEY, flash)
    router.push(`/dashboard/admin/affairs?cohort=${cohortId}&placement=all`)
  }
  return (
    <ItemForm
      {...props}
      layout="page"
      onDone={(result) => back(props.cohortId, result.message)}
      onCancel={() => back(props.cohortId)}
      onDeleted={(cohortId) => back(cohortId, '已刪除')}
    />
  )
}

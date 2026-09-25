'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconAlertCircle, IconCheck, IconEye, IconSend } from '@tabler/icons-react'
import { BackLink, Pill } from '@/app/_ui/dashboard-kit'
import {
  changeItemStatusAction,
  createItemAction,
  publishItemAction,
  reviewItemAction,
  saveDraftAction,
  updatePublishedAction,
} from '@/app/dashboard/admin/affairs/actions'
import {
  AttachmentPicker,
  CheckList,
  CoverPicker,
  DIALOG,
  Feedback,
  INPUT,
  LABEL,
  newRequestId,
  PRIMARY,
  RecipientList,
  SECONDARY,
  StudentView,
  toPayload,
  type EditorState,
  type EditorVocabulary,
} from '@/app/dashboard/admin/affairs/item-form-parts'
import { FieldsEditor, SettingsFields } from '@/app/dashboard/admin/affairs/item-settings'
import { sectionOfField } from '@/app/dashboard/admin/editor/field-section'
import type { ItemReview } from '@/application/items'
import { cn } from '@/shared/cn'

/**
 * 完整編輯器（票 15；原型 `/dashboard/admin/editor/[id]`）：一頁由上往下——
 * 1 內容（標題、摘要、正文、封面、附件）→ 2 收件欄位 → 3 發布設定 → 4 預覽確認。
 *
 * 外觀照原型（票 35）：整個編輯器是一張卡，頂列固定（標題、儲存狀態、存草稿／預覽／發布），
 * 四段用數字圓與 1px 線分隔；手機（<1024px）四段變分頁（只切換顯示，內容都還在頁面上）。
 * 原型的 Markdown 工具列沒做：正文是伺服器清理過的簡單 HTML，插 Markdown 記號會原樣顯示。
 *
 * 草稿：按「存草稿」才存（第一次存就建立項目，網址換成 `/editor/<id>`，之後都是同一個 ID）。
 * 已發布：沒有「未發布的修改」這種狀態——改完按「發布更新」，看過發布前檢查、選要不要通知，整筆套用。
 * 檢查、名單、學生看到的樣子都是伺服器算的（`reviewItemAction`），這裡不自己判規則。
 */

type Status = 'draft' | 'published' | 'archived'

const STATUS_LABEL: Record<Status, string> = { draft: '草稿', published: '發布中', archived: '已下架' }

type LifecycleAction = 'withdraw' | 'archive' | 'republish'

const SECTIONS = [
  { key: 'content', label: '內容' },
  { key: 'fields', label: '欄位' },
  { key: 'publish', label: '發布' },
  { key: 'preview', label: '預覽' },
] as const
type SectionKey = (typeof SECTIONS)[number]['key']

/** 伺服器擋下的欄位（`field`）在檢查表上叫什麼。 */
const FIELD_CHECK_LABEL: Record<string, string> = {
  title: '標題',
  summary: '摘要',
  body: '正文',
  category: '分類',
  fields: '欄位',
  placement: '發布位置',
  audienceKind: '對象',
  receiverUnit: '收件單位',
  opensAt: '開放時間',
  dueAt: '截止',
  stageId: '所屬階段',
  groupIds: '指定組別',
  attachments: '附件',
  cover: '封面',
  registrationDeadline: '報名截止日',
  eventDate: '活動日',
}

/** 段落標題：數字圓＋名詞＋一句灰字（原型 `sectionHead`）。 */
function SectionHead({ n, id, title, hint, right }: { n: number; id: string; title: string; hint?: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 pt-5 pb-3 lg:px-6">
      <span aria-hidden className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold tabular-nums">
        {n}
      </span>
      <h2 id={id} className="text-[15px] font-bold">
        <span className="sr-only">{n}. </span>
        {title}
      </h2>
      {hint ? <span className="hidden truncate text-xs text-muted-foreground sm:inline">・{hint}</span> : null}
      {right ? <div className="ml-auto">{right}</div> : null}
    </div>
  )
}

/** 撤回、下架、重新發布的確認文案（票 16；產品模組 04 §4.5）。規則由伺服器判，這裡只說清楚會發生什麼。 */
const LIFECYCLE: Record<LifecycleAction, { label: string; title: string; explain: string; confirm: string }> = {
  withdraw: {
    label: '撤回',
    title: '撤回成草稿？',
    explain:
      '撤回後受眾看不到這個項目（前台網址會顯示「已撤回」），收件名單會結束。改好後按「發布」恢復同一個項目，實際開放時間不會重設。只有還沒有任何人作答時可以撤回。',
    confirm: '確認撤回',
  },
  archive: {
    label: '下架',
    title: '下架這個項目？',
    explain: '下架後前台網址會顯示「已下架」與下一步；既有回答、收件名單與紀錄都保留。之後可以「重新發布」，實際開放時間不會重設。',
    confirm: '確認下架',
  },
  republish: {
    label: '重新發布',
    title: '重新發布？',
    explain:
      '恢復成下架前的那一版，對象又看得到；實際開放時間維持第一次發布的時間，這次不發通知。發布前檢查會再跑一次：已經截止的收件不能直接重新發布。',
    confirm: '確認重新發布',
  },
}

export function ItemEditor({
  initial,
  itemId: initialItemId,
  revision: initialRevision,
  status: initialStatus,
  hasResponses,
  vocabulary,
  heading,
  meta,
}: {
  initial: EditorState
  itemId: string | null
  revision: number
  status: Status
  hasResponses: boolean
  vocabulary: EditorVocabulary
  /** 這一頁的 h1（畫面上看不到：頂列的標題輸入框就是視覺上的標題，原型同）。 */
  heading: string
  /** 頂列小字：屆別、狀態、版本（伺服器排好）。 */
  meta: string
}) {
  const router = useRouter()
  const [state, setState] = useState<EditorState>(initial)
  const [itemId, setItemId] = useState(initialItemId)
  const [revision, setRevision] = useState(initialRevision)
  const [status, setStatus] = useState<Status>(initialStatus)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [review, setReview] = useState<ItemReview | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  // 檢查沒跑完是因為哪一欄（伺服器回的 `field`）：新建頁還沒填標題時，檢查表先列這一項，照原型給「回去補」。
  const [reviewErrorField, setReviewErrorField] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [notify, setNotify] = useState(true)
  const [done, setDone] = useState<string | null>(null)
  // 對話框打開那一刻是「發布」還是「發布更新」；發布成功後狀態變了，對話框標題不跟著換。
  const [dialogTitle, setDialogTitle] = useState('發布前檢查')
  const dialog = useRef<HTMLDialogElement>(null)
  const requestIds = useRef<{ save: string; publish: string; lifecycle: string }>({
    save: newRequestId(),
    publish: newRequestId(),
    lifecycle: newRequestId(),
  })
  const lifecycleDialog = useRef<HTMLDialogElement>(null)
  const [lifecycle, setLifecycle] = useState<LifecycleAction | null>(null)
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  // 手機的四個分頁（桌面四段全部攤開）。
  const [tab, setTab] = useState<SectionKey>('content')

  function openLifecycle(action: LifecycleAction) {
    setLifecycle(action)
    setLifecycleError(null)
    setMessage(null)
    requestIds.current.lifecycle = newRequestId()
    lifecycleDialog.current?.showModal()
  }

  async function confirmLifecycle() {
    if (!lifecycle || !itemId) return
    setBusy(`${LIFECYCLE[lifecycle].label}中…`)
    setLifecycleError(null)
    try {
      const result = await changeItemStatusAction(itemId, revision, lifecycle, requestIds.current.lifecycle)
      if (!result.ok) {
        setLifecycleError(result.message)
        return
      }
      setRevision(result.data.revision)
      setStatus(result.data.status)
      setMessage({ tone: 'ok', text: result.message ?? '已完成。' })
      requestIds.current.lifecycle = newRequestId()
      lifecycleDialog.current?.close()
      router.refresh()
    } catch {
      setLifecycleError('連線中斷；結果尚未確認，請重新整理頁面看狀態再決定要不要再按一次。')
    } finally {
      setBusy(null)
    }
  }

  const collects = state.placement === 'submission'
  const published = status !== 'draft'

  function patch(next: Partial<EditorState>) {
    setState((s) => ({ ...s, ...next }))
    setDirty(true)
    setReview(null)
  }

  /** 草稿存檔；回傳存好之後的 id 與 revision（失敗回 null，訊息已經顯示）。 */
  async function saveDraft(): Promise<{ itemId: string; revision: number } | null> {
    const payload = toPayload(state)
    const result = itemId
      ? await saveDraftAction(itemId, revision, payload, requestIds.current.save)
      : await createItemAction(payload, requestIds.current.save)
    requestIds.current.save = newRequestId()
    if (!result.ok) {
      setMessage({ tone: 'error', text: result.message })
      return null
    }
    setItemId(result.data.itemId)
    setRevision(result.data.revision)
    setDirty(false)
    if (!itemId) {
      // 第一次存：網址換成這一筆的編輯頁（不重新載入，畫面上的內容保留）。
      window.history.replaceState(null, '', `/dashboard/admin/editor/${result.data.itemId}`)
    }
    return { itemId: result.data.itemId, revision: result.data.revision }
  }

  async function onSave() {
    setBusy('儲存中…')
    setMessage(null)
    try {
      const saved = await saveDraft()
      if (saved) setMessage({ tone: 'ok', text: '已存成草稿；還沒有人看得到。' })
    } catch {
      setMessage({ tone: 'error', text: '連線中斷，請再按一次存草稿。' })
    } finally {
      setBusy(null)
    }
  }

  async function runReview(): Promise<ItemReview | null> {
    setReviewError(null)
    setReviewErrorField(null)
    const result = await reviewItemAction(toPayload(state), itemId)
    if (!result.ok) {
      setReview(null)
      setReviewError(result.message)
      setReviewErrorField(result.field ?? null)
      return null
    }
    setReview(result.data)
    return result.data
  }

  async function onPreview() {
    setBusy('檢查中…')
    try {
      await runReview()
    } catch {
      setReviewError('連線中斷，請再按一次。')
    } finally {
      setBusy(null)
    }
  }

  async function openPublish() {
    setBusy('檢查中…')
    setDone(null)
    setDialogTitle(published ? '發布更新前檢查' : '發布前檢查')
    setMessage(null)
    setDialogError(null)
    try {
      const checked = await runReview()
      if (!checked) setDialogError('內容還有問題，請看下面的說明修正後再發布。')
      requestIds.current.publish = newRequestId()
      dialog.current?.showModal()
    } catch {
      setMessage({ tone: 'error', text: '連線中斷，請再試一次。' })
    } finally {
      setBusy(null)
    }
  }

  async function confirmPublish() {
    setBusy(published ? '更新中…' : '發布中…')
    setDialogError(null)
    try {
      if (!published) {
        const saved = dirty || !itemId ? await saveDraft() : { itemId: itemId!, revision }
        if (!saved) {
          dialog.current?.close()
          return
        }
        const result = await publishItemAction(saved.itemId, saved.revision, notify || collects, requestIds.current.publish)
        if (!result.ok) {
          setDialogError(result.message)
          return
        }
        setRevision(result.data.revision)
        setStatus('published')
        setDone(result.message ?? '已發布。')
      } else {
        const result = await updatePublishedAction(itemId!, revision, toPayload(state), notify, requestIds.current.publish)
        if (!result.ok) {
          setDialogError(result.message)
          return
        }
        setRevision(result.data.revision)
        setDirty(false)
        setDone(result.message ?? '已更新。')
      }
      requestIds.current.publish = newRequestId()
    } catch {
      setDialogError('連線中斷；結果尚未確認，請重新整理頁面看狀態再決定要不要再按一次。')
    } finally {
      setBusy(null)
    }
  }

  const failing = review ? review.checks.filter((c) => !c.ok).length : 0

  // 原型第 4 段是頁內常駐的檢查表：內容一停手就重跑一次伺服器的發布前檢查（唯讀，`reviewItemAction`）。
  // 規則仍然只在伺服器；這裡只是不用每次都按「檢查與預覽」。舊的回應晚到就丟掉。
  const reviewSeq = useRef(0)
  useEffect(() => {
    const seq = ++reviewSeq.current
    const timer = setTimeout(() => {
      reviewItemAction(toPayload(state), itemId)
        .then((result) => {
          if (seq !== reviewSeq.current) return
          if (result.ok) {
            setReview(result.data)
            setReviewError(null)
            setReviewErrorField(null)
          } else {
            setReview(null)
            setReviewError(result.message)
            setReviewErrorField(result.field ?? null)
          }
        })
        .catch(() => {
          // 傳輸失敗（斷線、伺服器沒回）：說清楚，不要一直停在「檢查中…」。
          if (seq !== reviewSeq.current) return
          setReview(null)
          setReviewError('自動檢查連線中斷；請按「檢查與預覽」再試一次。')
          setReviewErrorField(null)
        })
    }, seq === 1 ? 0 : 700) // 打開頁面時馬上檢查一次；之後停手 0.7 秒才重跑
    return () => clearTimeout(timer)
  }, [state, itemId])

  /** 檢查表「回去補」：跳到該補的那一段（手機切到那一個分頁）。 */
  function goFix(key: string) {
    const target: SectionKey = sectionOfField(key)
    setTab(target)
    requestAnimationFrame(() => document.getElementById(`sec-${target}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }
  const [perspective, setPerspective] = useState<'guest' | 'student' | 'teacher'>('student')
  // 手機分頁：不是這一頁的段落只在窄螢幕藏起來（不卸載，打到一半的內容與上傳狀態都還在）。
  const section = (key: SectionKey) => cn('border-t border-border first:border-t-0', tab !== key && 'max-lg:hidden')
  const failingIn = (key: SectionKey) =>
    review ? review.checks.some((c) => !c.ok && (key === 'publish' ? c.key !== 'fields' && c.key !== 'title' : key === 'fields' ? c.key === 'fields' : key === 'content' && c.key === 'title')) : false

  async function previewFromTopBar() {
    setTab('preview')
    await onPreview()
    document.getElementById('sec-preview')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">{heading}</h1>
      <BackLink href="/dashboard/admin/affairs" label="專題事務" />

      <div className="dash-card overflow-clip">
        {/* 頂列：標題｜儲存狀態｜存草稿｜預覽｜發布 */}
        <div className="sticky top-14 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card px-5 py-3 lg:px-6">
          <label className="sr-only" htmlFor="ed-title">
            標題
          </label>
          <input
            id="ed-title"
            value={state.title}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="標題"
            className="min-w-0 flex-1 basis-64 bg-transparent text-xl font-extrabold tracking-tight outline-none placeholder:text-muted-foreground/60"
          />
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
            <span aria-hidden className={cn('inline-block size-2 rounded-full', dirty ? 'border-[1.5px] border-foreground/70' : 'bg-foreground')} />
            {busy ?? (dirty ? (published ? '有修改，按「發布更新」才會生效' : '有未儲存的修改') : '已儲存')}
          </span>
          <Pill tone={status === 'published' ? 'success' : 'default'} data-testid="item-status">
            {STATUS_LABEL[status]}
          </Pill>
          <div className="flex flex-wrap items-center gap-2">
            {!published ? (
              <button type="button" className={SECONDARY} onClick={onSave} disabled={busy !== null}>
                存草稿
              </button>
            ) : null}
            <button type="button" className={SECONDARY} onClick={() => void previewFromTopBar()} disabled={busy !== null}>
              <IconEye aria-hidden /> 預覽
            </button>
            {status === 'published' && !hasResponses ? (
              <button type="button" className={SECONDARY} onClick={() => openLifecycle('withdraw')} disabled={busy !== null}>
                撤回
              </button>
            ) : null}
            {status === 'published' ? (
              <button type="button" className={SECONDARY} onClick={() => openLifecycle('archive')} disabled={busy !== null}>
                下架
              </button>
            ) : null}
            {status === 'archived' ? (
              <button type="button" className={PRIMARY} onClick={() => openLifecycle('republish')} disabled={busy !== null}>
                重新發布
              </button>
            ) : (
              <button type="button" className={PRIMARY} onClick={openPublish} disabled={busy !== null}>
                <IconSend aria-hidden /> {published ? '發布更新' : '發布'}
              </button>
            )}
          </div>
          <p className="basis-full text-xs text-muted-foreground tabular-nums">{meta}</p>
          {/* 手機：四個分頁 */}
          <nav className="-mb-3 basis-full border-t border-border lg:hidden" aria-label="編輯區段">
            <ul className="grid grid-cols-4">
              {SECTIONS.map((sec) => (
                <li key={sec.key}>
                  <button
                    type="button"
                    onClick={() => setTab(sec.key)}
                    aria-current={tab === sec.key ? 'page' : undefined}
                    className={cn(
                      'relative h-11 w-full text-sm font-semibold',
                      tab === sec.key
                        ? 'text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-primary'
                        : 'text-muted-foreground',
                    )}
                  >
                    {sec.label}
                    {failingIn(sec.key) ? <span aria-hidden className="ml-1 inline-block size-1.5 rounded-full bg-destructive align-middle" /> : null}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        {status === 'archived' || message ? (
          <div className="flex flex-col gap-2 px-5 pt-4 lg:px-6">
            {status === 'archived' ? (
              <p className="rounded-lg bg-muted px-3 py-2 text-sm">
                已下架：前台網址顯示「已下架」，內容不能在這裡改；要修改請先重新發布。
              </p>
            ) : null}
            {message ? <Feedback tone={message.tone}>{message.text}</Feedback> : null}
          </div>
        ) : null}

        {/* 1 內容 */}
        <section aria-labelledby="sec-content" className={section('content')}>
          <SectionHead n={1} id="sec-content" title="內容" hint="公告與資源的主體；學生打開先看到這段" />
          <div className="flex flex-col gap-4 px-5 pb-6 lg:px-6">
            <div className="rounded-lg border border-input focus-within:border-primary focus-within:ring-3 focus-within:ring-primary/25">
              <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                <label htmlFor="ed-body" className="text-xs font-semibold">
                  正文
                </label>
                <span className="ml-auto text-[11px] text-muted-foreground">可用簡單 HTML</span>
              </div>
              <textarea
                id="ed-body"
                rows={10}
                className="w-full resize-y bg-transparent px-4 py-3 text-[15px] leading-relaxed outline-none"
                value={state.body}
                onChange={(e) => patch({ body: e.target.value })}
                placeholder={collects ? '要交什麼、格式、上限。學生在作業說明看到的就是這段。' : '寫公告內容。段落之間空一行。'}
              />
            </div>
            <p className="-mt-2 text-xs text-muted-foreground">
              直接打字即可（空一行分段）；要排版可用簡單的 HTML：段落、粗體、清單、標題、連結。其他標籤與程式碼存檔時會被清掉。
            </p>
            <div>
              <label htmlFor="ed-summary" className={LABEL}>
                摘要 <span className="text-xs font-normal text-muted-foreground">一句話，列表與首頁用</span>
              </label>
              <input
                id="ed-summary"
                className={INPUT}
                value={state.summary}
                placeholder="例：分組名單確認表已開放填寫。"
                onChange={(e) => patch({ summary: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="ed-category" className={LABEL}>
                分類 <span className="text-xs font-normal text-muted-foreground">選填</span>
              </label>
              <input id="ed-category" className={INPUT} value={state.category} onChange={(e) => patch({ category: e.target.value })} />
            </div>
            {state.placement === 'news' && state.category.trim() === vocabulary.competitionCategory ? (
              // 競賽資訊（0011，票 39）：前台 /competitions 依這兩天自動顯示報名中／決賽／已結束，不用手動切換。
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
                    onChange={(e) => patch({ registrationDeadline: e.target.value })}
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
                    onChange={(e) => patch({ eventDate: e.target.value })}
                  />
                </div>
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              <p className={LABEL}>
                封面 <span className="text-xs font-normal text-muted-foreground">選填</span>
              </p>
              <CoverPicker
                cohortId={state.cohortId}
                cover={state.cover}
                onChange={(cover) => patch({ cover })}
                accept={vocabulary.uploads.cover.accept}
                maxMiB={vocabulary.uploads.cover.maxMiB}
              />
            </div>
            <div className="flex flex-col gap-2">
              <p className={LABEL}>
                附件 <span className="text-xs font-normal text-muted-foreground">{state.attachments.length ? `${state.attachments.length} 個` : '無'}</span>
              </p>
              <AttachmentPicker
                cohortId={state.cohortId}
                attachments={state.attachments}
                onChange={(attachments) => patch({ attachments })}
                accept={vocabulary.uploads.attachment.accept}
                maxMiB={vocabulary.uploads.attachment.maxMiB}
              />
            </div>
          </div>
        </section>

        {/* 2 收件欄位 */}
        <section aria-labelledby="sec-fields" className={section('fields')}>
          <SectionHead
            n={2}
            id="sec-fields"
            title="收件欄位"
            hint={collects ? `學生會看到的樣子；點一欄原地改設定・${state.fields.filter((f) => vocabulary.inputFieldTypes.includes(f.type)).length} 個` : undefined}
          />
          <div className="px-5 pb-6 lg:px-6">
            {collects ? (
              <>
                {hasResponses ? (
                  <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold">
                    <IconAlertCircle aria-hidden className="size-3.5 text-primary" />
                    已經有人作答：欄位結構不能在這裡改。
                  </p>
                ) : null}
                <FieldsEditor fields={state.fields} onChange={(fields) => patch({ fields })} vocabulary={vocabulary} />
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-muted-foreground">這個項目不收資料。</p>
                {!published ? (
                  <button
                    type="button"
                    className={SECONDARY}
                    onClick={() =>
                      patch({
                        placement: 'submission',
                        receiverUnit: 'group',
                        audienceKind: vocabulary.collectionAudiences.includes(state.audienceKind) ? state.audienceKind : 'cohort_students',
                      })
                    }
                  >
                    啟用收件（改為文件繳交）
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </section>

        {/* 3 發布設定 */}
        <section aria-labelledby="sec-publish" className={section('publish')}>
          <SectionHead n={3} id="sec-publish" title="發布設定" hint="位置、對象、收件單位、階段、開放與截止" />
          <div className="px-5 pb-6 lg:px-6">
            <SettingsFields
              state={state}
              onChange={patch}
              vocabulary={vocabulary}
              published={published}
              unitLocked={hasResponses}
              idPrefix="ed"
            placementAs="select"
            />
          </div>
        </section>

        {/* 4 預覽確認 */}
        <section aria-labelledby="sec-preview" id="sec-preview-wrap" className={section('preview')}>
          <SectionHead
            n={4}
            id="sec-preview"
            title="預覽確認"
            hint="發布前檢查、實際名單與學生看到的樣子"
            right={
              <button type="button" className={SECONDARY} onClick={onPreview} disabled={busy !== null}>
                <IconEye aria-hidden /> 檢查與預覽
              </button>
            }
          />
          <div className="flex flex-col gap-3 px-5 pb-6 lg:px-6">
            {reviewError && reviewErrorField ? (
              // 伺服器在跑檢查前就先擋下的那一欄（例如新建頁還沒填標題）：照原型的檢查表列出來，給「回去補」。
              <ul aria-label="發布前檢查" className="divide-y divide-border rounded-xl border border-border text-sm">
                <li className="flex min-h-11 items-center gap-3 bg-destructive-subtle/40 px-4 py-2">
                  <span
                    aria-hidden
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
                  >
                    <IconAlertCircle className="size-3.5" />
                  </span>
                  <span className="w-16 shrink-0 text-muted-foreground">{FIELD_CHECK_LABEL[reviewErrorField] ?? '內容'}</span>
                  <span className="min-w-0 flex-1 font-semibold text-destructive">{reviewError}</span>
                  <button
                    type="button"
                    onClick={() => goFix(reviewErrorField)}
                    className="shrink-0 text-xs font-semibold text-destructive underline-offset-2 hover:underline"
                  >
                    回去補<span className="sr-only">：{FIELD_CHECK_LABEL[reviewErrorField] ?? '內容'}</span>
                  </button>
                </li>
                <li className="flex min-h-11 items-center gap-3 px-4 py-2 text-muted-foreground">
                  <span aria-hidden className="inline-block size-5 shrink-0 rounded-full border-2 border-border" />
                  <span className="w-16 shrink-0">其他項目</span>
                  <span className="min-w-0 flex-1">這一項補好後會自動再檢查對象、截止、欄位等其他項目。</span>
                </li>
              </ul>
            ) : reviewError ? (
              <Feedback tone="error">{reviewError}</Feedback>
            ) : null}
            {review ? (
              <>
                <CheckList checks={review.checks} onFix={goFix} />
                <p className="text-sm text-muted-foreground">
                  {review.openText}
                  {review.deadlineText ? `・${review.deadlineText}` : ''}
                </p>
                <RecipientList recipients={review.recipients} />
                {/* 原型：訪客／學生／老師三個視角。 */}
                <div className="flex flex-wrap gap-2" role="group" aria-label="預覽視角">
                  {(
                    [
                      ['guest', '訪客視角'],
                      ['student', '學生視角'],
                      ['teacher', '老師視角'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={perspective === key}
                      onClick={() => setPerspective(key)}
                      className={cn(SECONDARY, perspective === key && 'border-ink bg-ink text-ink-foreground hover:bg-ink/85 hover:text-ink-foreground')}
                    >
                      <IconEye aria-hidden /> {label}
                    </button>
                  ))}
                </div>
                {perspective === 'guest' && state.audienceKind !== 'public' ? (
                  <div className="rounded-xl bg-muted/40 px-4 py-8 text-center">
                    <p className="text-sm font-bold">訪客看不到這一筆</p>
                    <p className="mt-1 text-xs text-muted-foreground">發布對象不是「公開訪客」；要讓訪客看到，在發布設定改對象。</p>
                  </div>
                ) : (
                  <StudentView state={state} review={review} vocabulary={vocabulary} />
                )}
                {perspective === 'teacher' && collects ? (
                  <p className="text-xs text-muted-foreground">老師視角唯讀：看各組繳交狀態，不填表。</p>
                ) : null}
              </>
            ) : reviewError ? null : (
              <p className="text-sm text-muted-foreground">檢查中…</p>
            )}
          </div>
        </section>
      </div>

      {/* 發布或更新成功、看完回執關掉對話框時，才刷新頁首的版本與發布紀錄。 */}
      <dialog
        ref={dialog}
        aria-label={dialogTitle}
        className={cn(DIALOG, 'w-[min(30rem,calc(100vw-2rem))]')}
        onClose={() => {
          if (done) router.refresh()
        }}
      >
        <div className="flex flex-col gap-3 p-6">
          {done ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="inline-flex size-14 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle">
                <IconCheck aria-hidden className="size-7" />
              </span>
              <h2 className="text-xl font-extrabold">{published && dialogTitle === '發布更新前檢查' ? '已更新' : '已發布'}</h2>
              <Feedback tone="ok">{done}</Feedback>
              <div className="mt-1 flex gap-2">
                <Link href="/dashboard/admin/affairs" className={SECONDARY}>
                  回列表
                </Link>
                <button type="button" className={PRIMARY} onClick={() => dialog.current?.close()}>
                  繼續編輯
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2 className="text-lg font-extrabold">{dialogTitle}</h2>
              {review ? (
                <>
                  <CheckList checks={review.checks} />
                  <p className="text-sm text-muted-foreground">
                    {review.openText}
                    {review.deadlineText ? `・${review.deadlineText}` : ''}
                  </p>
                  <RecipientList recipients={review.recipients} />
                </>
              ) : null}
              {collects && !published ? (
                <p className="text-xs text-muted-foreground">新收件一定會通知收件名單上的人（站內通知）。</p>
              ) : (
                <label className="flex min-h-10 items-center gap-2 text-sm font-semibold">
                  <input type="checkbox" checked={notify} className="size-4 accent-primary" onChange={(e) => setNotify(e.target.checked)} />
                  {published ? '通知對象這次的修改（小幅修改可以不通知）' : '發布時通知對象（站內通知）'}
                </label>
              )}
              {dialogError ? <Feedback tone="error">{dialogError}</Feedback> : null}
              {!review && reviewError ? <Feedback tone="error">{reviewError}</Feedback> : null}
              <div className="flex justify-end gap-2">
                <button type="button" className={SECONDARY} onClick={() => dialog.current?.close()}>
                  取消
                </button>
                <button type="button" className={PRIMARY} onClick={confirmPublish} disabled={busy !== null || !review || failing > 0}>
                  {failing > 0 ? `還缺 ${failing} 項` : published ? '確認更新' : '確認發布'}
                </button>
              </div>
            </>
          )}
        </div>
      </dialog>

      <dialog ref={lifecycleDialog} aria-label={lifecycle ? LIFECYCLE[lifecycle].title : '確認'} className={cn(DIALOG, 'w-[min(30rem,calc(100vw-2rem))]')}>
        {lifecycle ? (
          <div className="flex flex-col gap-4 p-6">
            <h2 className="text-lg font-extrabold">{LIFECYCLE[lifecycle].title}</h2>
            <p className="text-sm leading-relaxed">{LIFECYCLE[lifecycle].explain}</p>
            {lifecycleError ? <Feedback tone="error">{lifecycleError}</Feedback> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={() => lifecycleDialog.current?.close()}>
                取消
              </button>
              <button type="button" className={PRIMARY} onClick={confirmLifecycle} disabled={busy !== null}>
                {LIFECYCLE[lifecycle].confirm}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
  )
}

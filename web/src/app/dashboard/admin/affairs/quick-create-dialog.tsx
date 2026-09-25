'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { IconAlignLeft, IconArrowLeft, IconArrowRight, IconCalendar, IconCheck, IconCursorText, IconFileUpload, IconLink, IconPencilPlus, type Icon } from '@tabler/icons-react'
import { createItemAction, publishItemAction, reviewItemAction, saveDraftAction } from './actions'
import {
  AttachmentPicker,
  CheckList,
  DIALOG,
  Feedback,
  INPUT,
  LABEL,
  newField,
  newRequestId,
  PRIMARY,
  RecipientList,
  SECONDARY,
  StudentView,
  toPayload,
  type EditorState,
  type EditorVocabulary,
  type FieldDraft,
} from './item-form-parts'
import { SettingsFields } from './item-settings'
import { BTN_INK } from '@/app/_ui/dashboard-kit'
import type { ItemReview } from '@/application/items'
import { cn } from '@/shared/cn'

/**
 * 新增項目（快速建立三步驟；原型 `NewItemDialog`）：1 類型與對象 → 2 內容 → 3 發布前檢查。
 *
 * 第 1 步按「下一步」就建立草稿（之後每一步都存回同一筆）；第 3 步的檢查清單、實際名單與
 * 「學生看到的樣子」都是伺服器算的。發布後可以「回列表」或「細調欄位」（進完整編輯器，同一個 ID）。
 */

const QUICK_FIELDS: { type: string; label: string; icon: Icon }[] = [
  { type: 'file', label: '檔案上傳', icon: IconFileUpload },
  { type: 'text', label: '短文字', icon: IconCursorText },
  { type: 'textarea', label: '長文字', icon: IconAlignLeft },
  { type: 'url', label: '網址', icon: IconLink },
  { type: 'date', label: '日期', icon: IconCalendar },
]

const STEPS = ['類型', '內容', '發布'] as const

/** 原型「上一步」是 ghost 鈕。 */
const GHOST =
  'press inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition-colors hover:bg-muted disabled:opacity-40'

function emptyState(cohortId: string): EditorState {
  return {
    cohortId,
    placement: 'news',
    title: '',
    summary: '',
    body: '',
    category: '',
    cover: null,
    attachments: [],
    audienceKind: 'cohort_students',
    groupIds: [],
    receiverUnit: 'none',
    stageId: '',
    opensAt: '',
    dueAt: '',
    registrationDeadline: '',
    eventDate: '',
    fields: [],
  }
}

export function QuickCreateDialog({ cohortId, vocabulary }: { cohortId: string; vocabulary: EditorVocabulary }) {
  const router = useRouter()
  const dialog = useRef<HTMLDialogElement>(null)
  const [step, setStep] = useState(0)
  const [state, setState] = useState<EditorState>(() => emptyState(cohortId))
  const [saved, setSaved] = useState<{ itemId: string; revision: number } | null>(null)
  const [review, setReview] = useState<ItemReview | null>(null)
  const [notify, setNotify] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const requestId = useRef(newRequestId())

  const collects = state.placement === 'submission'
  const patch = (next: Partial<EditorState>) => setState((s) => ({ ...s, ...next }))

  function open() {
    setStep(0)
    setState(emptyState(cohortId))
    setSaved(null)
    setReview(null)
    setNotify(true)
    setError(null)
    setDone(null)
    requestId.current = newRequestId()
    dialog.current?.showModal()
  }

  /** 每一步按「下一步」：第一次建立，之後存回同一筆。 */
  async function persist(): Promise<{ itemId: string; revision: number } | null> {
    const payload = toPayload(state)
    const result = saved
      ? await saveDraftAction(saved.itemId, saved.revision, payload, requestId.current)
      : await createItemAction(payload, requestId.current)
    requestId.current = newRequestId()
    if (!result.ok) {
      setError(result.message)
      return null
    }
    const next = { itemId: result.data.itemId, revision: result.data.revision }
    setSaved(next)
    return next
  }

  async function next() {
    setBusy('儲存中…')
    setError(null)
    try {
      const ok = await persist()
      if (!ok) return
      if (step === 1) {
        const checked = await reviewItemAction(toPayload(state), ok.itemId)
        if (!checked.ok) {
          setError(checked.message)
          return
        }
        setReview(checked.data)
      }
      setStep((s) => s + 1)
    } catch {
      setError('連線中斷，請再按一次。')
    } finally {
      setBusy(null)
    }
  }

  async function publish() {
    if (!saved) return
    setBusy('發布中…')
    setError(null)
    try {
      const result = await publishItemAction(saved.itemId, saved.revision, notify || collects, requestId.current)
      if (!result.ok) {
        setError(result.message)
        return
      }
      requestId.current = newRequestId()
      setDone(result.message ?? '已發布。')
    } catch {
      setError('連線中斷；結果尚未確認，請回列表看這一筆的狀態。')
    } finally {
      setBusy(null)
    }
  }

  function toggleQuickField(type: string, label: string) {
    const has = state.fields.some((f) => f.type === type)
    const fields: FieldDraft[] = has ? state.fields.filter((f) => f.type !== type) : [...state.fields, newField(type, label)]
    patch({ fields })
  }

  const failing = review ? review.checks.filter((c) => !c.ok).length : 0
  const canNext = step === 0 ? state.title.trim() !== '' : true

  return (
    <>
      <button type="button" className={cn(PRIMARY, 'h-10')} onClick={open}>
        <IconPencilPlus aria-hidden /> 新增項目
      </button>
      {/* 關掉時刷新列表（建立、存草稿、發布都可能改了列表）。 */}
      <dialog ref={dialog} aria-label="新增項目" className={DIALOG} onClose={() => router.refresh()}>
        {done ? (
          <div className="flex flex-col items-center gap-3 px-8 py-10 text-center">
            <span className="inline-flex size-14 items-center justify-center rounded-full bg-success-subtle text-success-on-subtle">
              <IconCheck aria-hidden className="size-7" />
            </span>
            <h2 className="text-xl font-extrabold">已發布</h2>
            <Feedback tone="ok">{done}</Feedback>
            <div className="mt-1 flex justify-center gap-2">
              <button type="button" className={SECONDARY} onClick={() => dialog.current?.close()}>
                回列表
              </button>
              <Link href={`/dashboard/admin/editor/${saved?.itemId}`} className={BTN_INK}>
                細調欄位
              </Link>
            </div>
          </div>
        ) : (
          <div className="flex max-h-[85vh] flex-col">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
              <div>
                <h2 className="text-lg font-extrabold">新增項目</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">{['選類型、寫標題、定對象', '內容與附件', '發布前檢查'][step]}</p>
              </div>
              <ol className="flex shrink-0 items-center gap-2 whitespace-nowrap" aria-label="步驟">
                {STEPS.map((label, i) => (
                  <li key={label} aria-current={i === step ? 'step' : undefined} className="flex items-center gap-2 text-xs font-semibold">
                    <span
                      className={cn(
                        'inline-flex size-6 items-center justify-center rounded-full',
                        i < step ? 'bg-success text-success-foreground' : i === step ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {i < step ? <IconCheck aria-hidden className="size-3.5" strokeWidth={3} /> : i + 1}
                    </span>
                    <span className={i === step ? '' : 'text-muted-foreground'}>{label}</span>
                    {i < STEPS.length - 1 ? <span aria-hidden className="h-px w-5 bg-border" /> : null}
                  </li>
                ))}
              </ol>
            </div>

            <div className="flex min-h-[340px] flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
              {step === 0 ? (
                <SettingsFields
                  state={state}
                  onChange={patch}
                  vocabulary={vocabulary}
                  published={false}
                  unitLocked={false}
                  idPrefix="qc"
                  afterPlacement={
                    <>
                      <label htmlFor="qc-title" className={LABEL}>
                        標題
                      </label>
                      <input
                        id="qc-title"
                        className={INPUT}
                        value={state.title}
                        onChange={(e) => patch({ title: e.target.value })}
                        placeholder="例：114 學年度專題說明會"
                      />
                    </>
                  }
                />
              ) : null}

              {step === 1 ? (
                <>
                  <div>
                    <label htmlFor="qc-body" className={LABEL}>
                      說明
                    </label>
                    <textarea
                      id="qc-body"
                      rows={5}
                      className={INPUT}
                      value={state.body}
                      onChange={(e) => patch({ body: e.target.value })}
                      placeholder={collects ? '要交什麼、格式、上限。學生在作業說明看到的就是這段。' : '公告內容；要排版、加封面再進完整編輯器。'}
                    />
                  </div>
                  <div>
                    <p className={LABEL}>附件</p>
                    <AttachmentPicker
                      cohortId={state.cohortId}
                      attachments={state.attachments}
                      onChange={(attachments) => patch({ attachments })}
                      accept={vocabulary.uploads.attachment.accept}
                      maxMiB={vocabulary.uploads.attachment.maxMiB}
                    />
                  </div>
                  {collects ? (
                    <fieldset>
                      <legend className={LABEL}>
                        要學生交什麼 <span className="font-normal text-muted-foreground">・勾幾個就有幾個欄位；要細調再進完整編輯器</span>
                      </legend>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {QUICK_FIELDS.map((f) => {
                          const on = state.fields.some((x) => x.type === f.type)
                          const FieldIcon = f.icon
                          return (
                            <button
                              key={f.type}
                              type="button"
                              aria-pressed={on}
                              onClick={() => toggleQuickField(f.type, f.label)}
                              className={cn(
                                'press inline-flex h-10 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors',
                                on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:border-ink/40',
                              )}
                            >
                              <FieldIcon aria-hidden className="size-4" />
                              {f.label}
                            </button>
                          )
                        })}
                      </div>
                    </fieldset>
                  ) : (
                    <p className="text-xs text-muted-foreground">這是公告或資源，不收資料；要收件請回上一步改成「文件繳交」。</p>
                  )}
                </>
              ) : null}

              {step === 2 && review ? (
                <>
                  <CheckList checks={review.checks} />
                  <p className="text-sm text-muted-foreground">
                    {review.openText}
                    {review.deadlineText ? `・${review.deadlineText}` : ''}
                  </p>
                  <RecipientList recipients={review.recipients} />
                  <StudentView state={state} review={review} vocabulary={vocabulary} />
                  {collects ? (
                    <p className="text-sm">新收件一定會通知收件名單上的人（站內通知）。</p>
                  ) : (
                    <label className="flex min-h-10 items-center gap-2 text-sm font-semibold">
                      <input type="checkbox" checked={notify} className="size-4 accent-primary" onChange={(e) => setNotify(e.target.checked)} />
                      發布時通知對象（站內通知）
                    </label>
                  )}
                </>
              ) : null}

              {error ? <Feedback tone="error">{error}</Feedback> : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-6 py-4">
              <button
                type="button"
                className={GHOST}
                onClick={() => (step === 0 ? dialog.current?.close() : setStep((s) => s - 1))}
                disabled={busy !== null}
              >
                {step === 0 ? '取消' : (
                  <>
                    <IconArrowLeft aria-hidden className="size-4" /> 上一步
                  </>
                )}
              </button>
              <div className="flex items-center gap-2">
                {busy ? <span className="text-xs text-muted-foreground">{busy}</span> : null}
                {step === 2 ? (
                  <button type="button" className={SECONDARY} onClick={() => dialog.current?.close()} disabled={busy !== null}>
                    先存成草稿
                  </button>
                ) : null}
                {step < 2 ? (
                  <button type="button" className={cn(PRIMARY, 'h-10 px-5')} onClick={next} disabled={busy !== null || !canNext}>
                    下一步 <IconArrowRight aria-hidden className="size-4" />
                  </button>
                ) : (
                  <button type="button" className={cn(PRIMARY, 'h-10 px-5')} onClick={publish} disabled={busy !== null || failing > 0}>
                    {failing > 0 ? `還缺 ${failing} 項` : '發布'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </dialog>
    </>
  )
}

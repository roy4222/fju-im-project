'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
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
import type { ItemReview } from '@/application/items'
import { cn } from '@/shared/cn'

/**
 * 完整編輯器（票 15；原型 `/dashboard/admin/editor/[id]`）：一頁由上往下——
 * 1 內容（標題、摘要、正文、封面、附件）→ 2 收件欄位 → 3 發布設定 → 4 預覽確認。
 *
 * 草稿：按「存草稿」才存（第一次存就建立項目，網址換成 `/editor/<id>`，之後都是同一個 ID）。
 * 已發布：沒有「未發布的修改」這種狀態——改完按「發布更新」，看過發布前檢查、選要不要通知，整筆套用。
 * 檢查、名單、學生看到的樣子都是伺服器算的（`reviewItemAction`），這裡不自己判規則。
 */

type Status = 'draft' | 'published' | 'archived'

const STATUS_LABEL: Record<Status, string> = { draft: '草稿', published: '發布中', archived: '已下架' }

type LifecycleAction = 'withdraw' | 'archive' | 'republish'

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
    explain: '恢復成下架前的那一版，對象又看得到；實際開放時間維持第一次發布的時間，這次不發通知。',
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
}: {
  initial: EditorState
  itemId: string | null
  revision: number
  status: Status
  hasResponses: boolean
  vocabulary: EditorVocabulary
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
    const result = await reviewItemAction(toPayload(state), itemId)
    if (!result.ok) {
      setReview(null)
      setReviewError(result.message)
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

  return (
    <div className="space-y-4">
      <Link href="/dashboard/admin/affairs" className="inline-flex text-sm font-medium text-muted-foreground hover:text-ink">
        ← 專題事務
      </Link>

      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-card border border-border bg-background px-4 py-3">
        <span
          data-testid="item-status"
          className={cn(
            'rounded-full px-2.5 py-0.5 text-xs font-semibold',
            status === 'published' ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-muted text-muted-foreground',
          )}
        >
          {STATUS_LABEL[status]}
        </span>
        <span className="min-w-0 flex-1 truncate text-base font-semibold text-ink">{state.title || '（未命名）'}</span>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {busy ?? (dirty ? (published ? '有修改，按「發布更新」才會生效' : '有未儲存的修改') : '已儲存')}
        </span>
        {!published ? (
          <button type="button" className={SECONDARY} onClick={onSave} disabled={busy !== null}>
            存草稿
          </button>
        ) : null}
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
            {published ? '發布更新' : '發布'}
          </button>
        )}
      </div>
      {status === 'archived' ? (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-ink">
          已下架：前台網址顯示「已下架」，內容不能在這裡改；要修改請先重新發布。
        </p>
      ) : null}

      {message ? <Feedback tone={message.tone}>{message.text}</Feedback> : null}

      <section aria-labelledby="sec-content" className="rounded-card border border-border bg-background p-5">
        <h2 id="sec-content" className="text-base font-semibold text-ink">
          1. 內容
        </h2>
        <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="ed-title" className={LABEL}>
              標題
            </label>
            <input id="ed-title" className={INPUT} value={state.title} onChange={(e) => patch({ title: e.target.value })} />
          </div>
          <div>
            <label htmlFor="ed-summary" className={LABEL}>
              摘要 <span className="font-normal text-muted-foreground">・一句話，列表與首頁用</span>
            </label>
            <input id="ed-summary" className={INPUT} value={state.summary} onChange={(e) => patch({ summary: e.target.value })} />
          </div>
          <div>
            <label htmlFor="ed-body" className={LABEL}>
              正文
            </label>
            <textarea
              id="ed-body"
              rows={10}
              className={INPUT}
              value={state.body}
              onChange={(e) => patch({ body: e.target.value })}
              placeholder={collects ? '要交什麼、格式、上限。學生在作業說明看到的就是這段。' : '公告內容。空一行就是新段落。'}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              直接打字即可（空一行分段）；要排版可用簡單的 HTML：段落、粗體、清單、標題、連結。其他標籤與程式碼存檔時會被清掉。
            </p>
          </div>
          <div>
            <label htmlFor="ed-category" className={LABEL}>
              分類（選填）
            </label>
            <input id="ed-category" className={INPUT} value={state.category} onChange={(e) => patch({ category: e.target.value })} />
          </div>
          <div>
            <p className={LABEL}>封面（選填）</p>
            <CoverPicker
              cohortId={state.cohortId}
              cover={state.cover}
              onChange={(cover) => patch({ cover })}
              accept={vocabulary.uploads.cover.accept}
              maxMiB={vocabulary.uploads.cover.maxMiB}
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
        </div>
      </section>

      <section aria-labelledby="sec-fields" className="rounded-card border border-border bg-background p-5">
        <h2 id="sec-fields" className="text-base font-semibold text-ink">
          2. 收件欄位
        </h2>
        <div className="mt-4">
          {collects ? (
            <>
              {hasResponses ? (
                <p className="mb-3 rounded-md bg-muted px-3 py-2 text-sm text-ink">已經有人作答：欄位結構不能在這裡改。</p>
              ) : null}
              <FieldsEditor fields={state.fields} onChange={(fields) => patch({ fields })} vocabulary={vocabulary} />
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              這個項目不收資料。
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

      <section aria-labelledby="sec-publish" className="rounded-card border border-border bg-background p-5">
        <h2 id="sec-publish" className="text-base font-semibold text-ink">
          3. 發布設定
        </h2>
        <div className="mt-4">
          <SettingsFields
            state={state}
            onChange={patch}
            vocabulary={vocabulary}
            published={published}
            unitLocked={hasResponses}
            idPrefix="ed"
          />
        </div>
      </section>

      <section aria-labelledby="sec-preview" className="rounded-card border border-border bg-background p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="sec-preview" className="text-base font-semibold text-ink">
            4. 預覽確認
          </h2>
          <button type="button" className={SECONDARY} onClick={onPreview} disabled={busy !== null}>
            檢查與預覽
          </button>
        </div>
        <div className="mt-4 space-y-3">
          {reviewError ? <Feedback tone="error">{reviewError}</Feedback> : null}
          {review ? (
            <>
              <CheckList checks={review.checks} />
              <p className="text-sm text-muted-foreground">
                {review.openText}
                {review.deadlineText ? `・${review.deadlineText}` : ''}
              </p>
              <RecipientList recipients={review.recipients} />
              <StudentView state={state} review={review} vocabulary={vocabulary} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">按「檢查與預覽」看發布前檢查、實際名單與學生看到的樣子。</p>
          )}
        </div>
      </section>

      {/* 發布或更新成功、看完回執關掉對話框時，才刷新頁首的版本與發布紀錄。 */}
      <dialog
        ref={dialog}
        aria-label={dialogTitle}
        className={DIALOG}
        onClose={() => {
          if (done) router.refresh()
        }}
      >
        <div className="space-y-4 p-5">
          {done ? (
            <>
              <h2 className="text-base font-semibold text-ink">完成</h2>
              <Feedback tone="ok">{done}</Feedback>
              <div className="flex justify-end gap-2 border-t border-border pt-4">
                <Link href="/dashboard/admin/affairs" className={SECONDARY}>
                  回列表
                </Link>
                <button type="button" className={PRIMARY} onClick={() => dialog.current?.close()}>
                  繼續編輯
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-ink">{dialogTitle}</h2>
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
                <p className="text-sm text-ink">新收件一定會通知收件名單上的人（站內通知）。</p>
              ) : (
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                  {published ? '通知對象這次的修改（小幅修改可以不通知）' : '發布時通知對象（站內通知）'}
                </label>
              )}
              {dialogError ? <Feedback tone="error">{dialogError}</Feedback> : null}
              {!review && reviewError ? <Feedback tone="error">{reviewError}</Feedback> : null}
              <div className="flex justify-end gap-2 border-t border-border pt-4">
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

      <dialog ref={lifecycleDialog} aria-label={lifecycle ? LIFECYCLE[lifecycle].title : '確認'} className={DIALOG}>
        {lifecycle ? (
          <div className="space-y-4 p-5">
            <h2 className="text-base font-semibold text-ink">{LIFECYCLE[lifecycle].title}</h2>
            <p className="text-sm text-ink">{LIFECYCLE[lifecycle].explain}</p>
            {lifecycleError ? <Feedback tone="error">{lifecycleError}</Feedback> : null}
            <div className="flex justify-end gap-2 border-t border-border pt-4">
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

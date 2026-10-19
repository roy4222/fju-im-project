'use client'
import { IconPaperclip } from '@tabler/icons-react'
import { BodyPreview, cx, RecipientList } from '@/app/dashboard/admin/affairs/item-form-parts'
import type { LiveReview } from '@/app/dashboard/admin/affairs/_form/item-form'
import { HONOR, itemFormDeps, toFormField, type EditorState, type EditorVocabulary } from '@/app/dashboard/admin/affairs/item-form-model'

/**
 * 右欄「即時預覽：學生看到的樣子」（C 階段規格① §2.3、AC-3、AC-4）：標題、對象與截止、淨化後正文、附件、繳交欄位的樣子。
 *
 * **預覽走伺服器**：停手 500 ms 後呼叫 `reviewItemAction`，只渲染回傳的 `bodyHtml`（淨化在伺服器；CSP 沒有 unsafe-inline），
 * 不在 client 直接渲染原字（問伺服器的是 `item-form.tsx` 的 `useLiveReview`）。繳交欄位用學生「寫作業」同一套 `SubmissionFields`（唯讀）。
 */

export default function LivePreview({
  state,
  vocabulary,
  live,
  notifyWhen,
  className,
}: {
  state: EditorState
  vocabulary: EditorVocabulary
  live: LiveReview
  notifyWhen: 'important' | 'update' | 'never'
  className?: string
}) {
  const { review, error } = live
  const placement = vocabulary.placements.find((p) => p.value === state.placement)?.label ?? ''
  const audience =
    state.audienceKind === 'groups'
      ? `指定組別：${
          state.groupIds
            .map((id) => vocabulary.groups.find((g) => g.id === id)?.code)
            .filter(Boolean)
            .join('、') || '（還沒選）'
        }`
      : (vocabulary.audiences.find((a) => a.value === state.audienceKind)?.label ?? '')
  const collects = state.placement === 'submission' && state.consentMode !== 'form'
  const fields = collects ? state.fields.map(toFormField) : []
  const { SubmissionFields } = itemFormDeps()

  return (
    <section aria-labelledby="live-preview-title" className={cx('flex min-w-0 flex-col gap-3', className)}>
      <h3 id="live-preview-title" className="text-xs font-bold tracking-[0.06em] text-muted-foreground">
        即時預覽：學生看到的樣子
      </h3>
      <article aria-label="學生看到的樣子" data-testid="live-preview" className="rounded-xl bg-muted/40 p-4 text-sm">
        <p className="text-xs font-semibold text-muted-foreground" data-testid="preview-meta">
          {placement}・{audience}
          {review?.deadlineText ? `・${review.deadlineText}` : ''}
        </p>
        <h4 className="mt-1 text-[17px] font-extrabold break-words" data-testid="preview-title">
          {state.title || '（未命名）'}
        </h4>
        {state.summary ? <p className="mt-1 text-muted-foreground">{state.summary}</p> : null}
        <div className="mt-3" data-testid="body-preview">
          <BodyPreview html={review ? review.bodyHtml : null} error={error} />
        </div>
        {state.attachments.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1 text-xs" aria-label="學生會看到的檔案">
            {state.attachments.map((a) => (
              <li key={a.fileId} className="flex items-center gap-1.5 text-muted-foreground">
                <IconPaperclip aria-hidden className="size-3.5" />
                {a.name}
              </li>
            ))}
          </ul>
        ) : null}
        {fields.length > 0 ? (
          <div className="mt-4 flex flex-col gap-4 border-t border-border pt-3" data-testid="preview-fields">
            <SubmissionFields fields={fields} values={{}} preview />
          </div>
        ) : null}
        {state.placement === 'submission' && state.consentMode === 'form' ? (
          <p className="mt-3 text-xs text-muted-foreground">站內同意書：學生在「狀態」分頁按「我同意」或「不同意」，不用寫作業。</p>
        ) : null}
      </article>
      {review && state.placement !== HONOR ? <RecipientList recipients={review.recipients} notifyWhen={notifyWhen} /> : null}
    </section>
  )
}

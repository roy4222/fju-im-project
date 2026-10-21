'use client'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { IconArrowDown, IconArrowUp, IconGripVertical } from '@tabler/icons-react'
import { Pill } from '@/app/_ui/dashboard-kit'
// 表單本體按需載入；它要的 Server Function 由這個外殼在模組初始化時登錄（`ITEM_FORM_DEPS`），所以要先 import 它。
import '@/app/dashboard/admin/affairs/_form/item-form-dialog'
import { deleteItemAction } from '@/app/dashboard/admin/affairs/actions'
import { frontEditContextAction } from '@/app/dashboard/admin/affairs/front-edit-context-action'
import { toInitial, type EditorVocabulary, type ItemFormInitial } from '@/app/dashboard/admin/affairs/item-form-model'
import { DIALOG, SECONDARY } from '@/app/dashboard/admin/affairs/item-form-parts'
import { cn } from '@/shared/cn'

/**
 * 專題規則的一張章節卡（C 階段規格① §4.4、C1-08）：拖柄、序號、章名、正文摘要（前 2 行）、狀態、上移／下移、「編輯」「刪除」。
 * 「編輯」在卡片內就地展開 `ItemForm`（layout `inline`：沒有右欄預覽、沒有對象／開放／截止欄、按鈕在卡底）。
 * 拖放、展開哪一章、未存改動的確認由 `rules-actions.tsx` 的 `RulesBoard` 管；這裡只畫一張卡。
 */

export type RuleCardFacts = {
  readonly id: string
  readonly title: string
  /** 正文的純文字（畫面上只顯示前 2 行）。 */
  readonly summary: string
  readonly status: 'draft' | 'published' | 'archived'
  readonly statusLabel: string
  /** 不能刪時寫在按鈕上的原因；可以刪是 null。 */
  readonly deleteBlocked: string | null
}

export type InlineDone = { itemId: string; status: 'draft' | 'published'; message?: string }

const ItemForm = dynamic(() => import('@/app/dashboard/admin/affairs/_form/item-form').then((m) => m.ItemForm), {
  ssr: false,
  loading: () => <p className="px-1 py-8 text-center text-sm text-muted-foreground">表單載入中…</p>,
})

/** 列內小按鈕：桌面 h-8，觸控至少 44×44（同 `list-actions.tsx`）。 */
export const ROW_BTN =
  'press inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-border bg-background px-2.5 text-xs font-semibold whitespace-nowrap transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-60 pointer-coarse:min-h-11 pointer-coarse:min-w-11 [&_svg]:size-3.5'

type Loaded = { cohortId: string; options: EditorVocabulary; initial: ItemFormInitial | null }

/** 正文編輯區的內容指紋：去掉所有屬性（游標、placeholder 的 class 會變），只留標籤結構與文字。 */
function editorShape(el: Element): string {
  const copy = el.cloneNode(true) as Element
  for (const node of [copy, ...copy.querySelectorAll('*')]) for (const name of node.getAttributeNames()) node.removeAttribute(name)
  return copy.innerHTML
}

/**
 * 就地展開的表單：先經 `frontEditContextAction` 載完整的那一筆（附件、revision）再畫；`itemId` 是 null 時是新增一章。
 *
 * 有沒有未存改動（`onDirtyChange`；`ItemForm` 不回報改動，這裡從外面看）：
 * - 一般欄位：聽冒泡上來的 input 事件，有輸入就算改過。
 * - 正文（Tiptap 的 contenteditable）：粗體、清單、Enter 這類由編輯器自己處理的操作不一定發 input 事件，所以改看內容——
 *   編輯區第一次出現時記下內容指紋（`editorShape`），之後每次 DOM 變動跟它比；改回原樣就不算改過。
 */
export function InlineRuleForm({
  cohortId,
  itemId,
  onDirtyChange,
  onDone,
  onCancel,
}: {
  cohortId: string
  itemId: string | null
  onDirtyChange: (dirty: boolean) => void
  onDone: (result: InlineDone) => void
  onCancel: () => void
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const fieldsDirty = useRef(false)
  const editorDirty = useRef(false)
  const onDirtyRef = useRef(onDirtyChange)
  useEffect(() => {
    onDirtyRef.current = onDirtyChange
  }, [onDirtyChange])

  useEffect(() => {
    const root = host.current
    if (!root) return
    let baseline: string | null = null
    const check = () => {
      const editor = root.querySelector('[contenteditable="true"]')
      if (!editor) return
      const shape = editorShape(editor)
      if (baseline === null) baseline = shape
      const dirty = shape !== baseline
      if (dirty !== editorDirty.current) {
        editorDirty.current = dirty
        onDirtyRef.current(fieldsDirty.current || dirty)
      }
    }
    const observer = new MutationObserver(check)
    observer.observe(root, { subtree: true, childList: true, characterData: true })
    check()
    return () => observer.disconnect()
    // 表單載入（`loaded`）後 host 才掛上。
  }, [loaded])

  useEffect(() => {
    let alive = true
    frontEditContextAction({ cohortId: itemId ? null : cohortId, itemId })
      .then((context) => {
        if (!alive) return
        if (!context.ok) return setError(context.message)
        if (itemId && !context.detail) return setError('這一章已經不在了，請重新整理頁面。')
        setLoaded({
          cohortId: context.cohortId,
          options: context.options,
          initial: context.detail ? toInitial(context.detail, null, context.avatarUrls) : null,
        })
      })
      .catch(() => alive && setError('表單資料載入失敗，請收起再按一次「編輯」。'))
    return () => {
      alive = false
    }
  }, [cohortId, itemId])

  if (error) {
    return (
      <p role="alert" className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle">
        {error}
      </p>
    )
  }
  if (!loaded) return <p className="px-1 py-8 text-center text-sm text-muted-foreground">表單載入中…</p>
  return (
    <div
      ref={host}
      onInput={(e) => {
        // 正文編輯區的輸入由上面的內容比對決定。
        if (e.target instanceof Element && e.target.closest('[contenteditable="true"]')) return
        if (fieldsDirty.current) return
        fieldsDirty.current = true
        onDirtyRef.current(true)
      }}
      data-testid="rule-inline-form"
    >
      <ItemForm
        layout="inline"
        placement="rules"
        cohortId={loaded.cohortId}
        options={loaded.options}
        {...(itemId && loaded.initial ? { itemId, initial: loaded.initial } : {})}
        onDone={onDone}
        onCancel={onCancel}
      />
    </div>
  )
}

export function RuleCard({
  card,
  index,
  total,
  busy,
  expanded,
  dragging,
  dropTarget,
  onMove,
  onEdit,
  onDeleted,
  dragHandlers,
  children,
}: {
  card: RuleCardFacts
  index: number
  total: number
  /** 排序或刪除進行中：上下移、編輯都停用（避免連按把順序搞亂）。 */
  busy: boolean
  expanded: boolean
  dragging: boolean
  dropTarget: boolean
  onMove: (direction: 'up' | 'down') => void
  onEdit: () => void
  onDeleted: (text: string) => void
  dragHandlers: Pick<React.HTMLAttributes<HTMLLIElement>, 'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDragLeave' | 'onDrop'>
  /** 展開時的表單（`InlineRuleForm`）。 */
  children?: React.ReactNode
}) {
  return (
    <li
      data-testid="affair-row"
      data-rule-id={card.id}
      draggable={!expanded && !busy}
      {...dragHandlers}
      className={cn(
        'border-t border-border transition-colors first:border-t-0',
        dragging && 'opacity-50',
        dropTarget && 'bg-accent/60 ring-2 ring-primary/40 ring-inset',
        expanded && 'bg-muted/30',
      )}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <span
          className={cn('mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground [&_svg]:size-4', !expanded && 'cursor-grab active:cursor-grabbing')}
          aria-label={`拖曳排序「${card.title}」`}
          title="拖曳調整順序"
          data-testid="rule-drag-handle"
        >
          <IconGripVertical aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-semibold text-muted-foreground tabular-nums">{index + 1}.</span>
            <Link href={`/dashboard/admin/editor/${card.id}`} draggable={false} className="link-ink min-w-0 truncate text-[15px] font-bold">
              {card.title}
            </Link>
            <Pill tone={card.status === 'published' ? 'success' : 'default'}>{card.statusLabel}</Pill>
          </div>
          {card.summary ? (
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground" data-testid="rule-summary">
              {card.summary}
            </p>
          ) : null}
        </div>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            className={ROW_BTN}
            aria-label={`上移「${card.title}」`}
            disabled={busy || index === 0}
            onClick={() => onMove('up')}
          >
            <IconArrowUp aria-hidden />
          </button>
          <button
            type="button"
            className={ROW_BTN}
            aria-label={`下移「${card.title}」`}
            disabled={busy || index === total - 1}
            onClick={() => onMove('down')}
          >
            <IconArrowDown aria-hidden />
          </button>
          <button type="button" className={ROW_BTN} aria-label={`編輯：${card.title}`} aria-expanded={expanded} disabled={busy || expanded} onClick={onEdit}>
            編輯
          </button>
          <DeleteButton card={card} disabled={busy} onDeleted={onDeleted} />
        </span>
      </div>
      {expanded ? <div className="border-t border-border px-4 pt-4 pb-3">{children}</div> : null}
    </li>
  )
}

/** 「刪除」：不能刪時按鈕本身寫原因且停用；能刪時開一句話確認框（同 `list-actions.tsx` 的列刪除）。 */
function DeleteButton({ card, disabled, onDeleted }: { card: RuleCardFacts; disabled: boolean; onDeleted: (text: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState('')

  if (card.deleteBlocked) {
    return (
      <button type="button" className={ROW_BTN} disabled data-testid="delete-blocked">
        {card.deleteBlocked}
      </button>
    )
  }

  async function confirm() {
    setPending(true)
    setError(null)
    try {
      // 卡片沒有 revision：先讀一次這一章目前的版本（系辦已在確認框看過名稱、按了刪除）。
      const context = await frontEditContextAction({ cohortId: null, itemId: card.id })
      if (!context.ok || !context.detail) {
        setError(context.ok ? '這一章已經不在了，請重新整理頁面。' : context.message)
        return
      }
      const result = await deleteItemAction(card.id, context.detail.revision, requestId)
      if (!result.ok) {
        setError(result.message)
        return
      }
      dialog.current?.close()
      onDeleted(result.message ?? '已刪除。')
    } catch {
      setError('連線中斷；結果尚未確認，請重新整理頁面看狀態。')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className={cn(ROW_BTN, 'text-destructive hover:bg-destructive-subtle')}
        aria-label={`刪除：${card.title}`}
        disabled={disabled}
        onClick={() => {
          setError(null)
          setRequestId(crypto.randomUUID())
          dialog.current?.showModal()
        }}
      >
        刪除
      </button>
      <dialog ref={dialog} aria-label={`刪除「${card.title}」`} className={cn(DIALOG, 'w-[min(28rem,calc(100vw-2rem))]')}>
        <div className="flex flex-col gap-4 px-6 py-5">
          <p className="text-base font-bold break-words">確定刪除「{card.title}」？刪了就不能恢復。</p>
          {error ? (
            <p role="alert" className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button type="button" className={SECONDARY} onClick={() => dialog.current?.close()}>
              取消
            </button>
            <button
              type="button"
              className="press inline-flex h-9 items-center rounded-lg bg-destructive px-4 text-sm font-semibold text-white disabled:opacity-60"
              disabled={pending}
              onClick={confirm}
            >
              {pending ? '刪除中…' : '刪除'}
            </button>
          </div>
        </div>
      </dialog>
    </>
  )
}

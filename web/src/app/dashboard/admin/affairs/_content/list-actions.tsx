'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { IconChevronDown, IconDots, IconPencilPlus, IconPin, IconPinnedOff } from '@tabler/icons-react'
import { ItemFormDialog } from '@/app/dashboard/admin/affairs/_form/item-form-dialog'
import { deleteItemAction, setPinnedAction } from '@/app/dashboard/admin/affairs/actions'
import { frontEditContextAction } from '@/app/dashboard/admin/affairs/front-edit-context-action'
import {
  formPlacementOf,
  ITEM_FLASH_KEY,
  toInitial,
  type ConsentModeValue,
  type EditorVocabulary,
  type ItemFormInitial,
  type ItemFormPlacement,
} from '@/app/dashboard/admin/affairs/item-form-model'
import { DIALOG, PRIMARY, SECONDARY } from '@/app/dashboard/admin/affairs/item-form-parts'
import { cn } from '@/shared/cn'

/**
 * 公告與作業各分頁的互動部分（C 階段規格① §4、C1-07）：右上的「新增」、每一列的「編輯」「刪除」「⋯」。
 *
 * - 「新增」在哪個分頁就新增那一類（A1、A2、A10）：公告、資源、規則直接開表單，不先問類型；作業是一顆下拉（作業、兩種同意書）。
 * - 「編輯」開同一張 `ItemFormDialog`（對話框；表單本體按需載入），先經 `frontEditContextAction` 載完整的那一筆再開。
 * - 「刪除」開一句話確認框；不能刪時按鈕本身寫原因且停用（原因由伺服器頁面依 `deleteCheck` 的規則算好帶進來）。
 * - 「⋯」放置頂／取消置頂（發布中的公告才有）。
 * - 成功後在右下角提示一句、`router.refresh()`；全頁編輯器（`/editor/*`）送出回到清單時留下的提示也在這裡顯示一次。
 * - 觸控裝置上列內小按鈕的可點範圍至少 44×44（`pointer-coarse:min-h-11`；規格④ §8.4）。
 */

/** 列內小按鈕：桌面 h-8，觸控至少 44×44。 */
const ROW_BTN =
  'press inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-border bg-background px-2.5 text-xs font-semibold whitespace-nowrap transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-60 pointer-coarse:min-h-11 pointer-coarse:min-w-11 [&_svg]:size-3.5'
const MENU = 'absolute right-0 z-30 mt-1 min-w-44 rounded-lg border border-border bg-popover p-1 text-sm shadow-lg'
const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left font-semibold hover:bg-accent focus-visible:bg-accent focus-visible:outline-none pointer-coarse:min-h-11 [&_svg]:size-4'

/** 右下角一句話提示（4 秒後消失）。 */
function useToast(): [string | null, (text: string) => void] {
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(timer)
  }, [toast])
  return [toast, setToast]
}

function Toast({ text, testId = 'item-toast' }: { text: string | null; testId?: string }) {
  if (!text) return null
  return (
    <p
      role="status"
      className="fixed right-4 bottom-4 z-50 max-w-[calc(100vw-2rem)] rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-ink-foreground shadow-lg"
      data-testid={testId}
    >
      {text}
    </p>
  )
}

/** 點外面或按 Esc 關掉下拉選單。 */
function useDismiss(open: boolean, close: () => void) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])
  return box
}

type Creating = { placement: ItemFormPlacement; consentMode: ConsentModeValue | null; title: string }

/** 新增表單的對話框＋提示；全頁編輯器回到清單時留下的提示也顯示一次。 */
function CreateHost({
  creating,
  cohortId,
  vocabulary,
  onClose,
}: {
  creating: Creating | null
  cohortId: string
  vocabulary: EditorVocabulary
  onClose: () => void
}) {
  const router = useRouter()
  const [toast, setToast] = useToast()

  useEffect(() => {
    const flash = window.sessionStorage.getItem(ITEM_FLASH_KEY)
    if (!flash) return
    window.sessionStorage.removeItem(ITEM_FLASH_KEY)
    setToast(flash)
  }, [setToast])

  return (
    <>
      {creating ? (
        <ItemFormDialog
          open
          title={creating.title}
          placement={creating.placement}
          consentMode={creating.consentMode ?? undefined}
          cohortId={cohortId}
          options={vocabulary}
          onCancel={onClose}
          onDone={(result) => {
            onClose()
            setToast(result.message ?? (result.status === 'published' ? '已發布' : '已儲存'))
            router.refresh()
          }}
        />
      ) : null}
      <Toast text={toast} />
    </>
  )
}

/**
 * 公告、資源、規則分頁右上的「新增」：直接開那一類的表單（不問類型，AC-10）。
 * 畫面上寫「新增」，無障礙名稱帶類別（「新增公告」），對話框標題同名。
 */
export function NewItemButton({
  cohortId,
  vocabulary,
  placement,
  noun,
}: {
  cohortId: string
  vocabulary: EditorVocabulary
  placement: ItemFormPlacement
  /** 類別名（「公告」「資源」「規則」）。 */
  noun: string
}) {
  const [creating, setCreating] = useState<Creating | null>(null)
  return (
    <>
      <button
        type="button"
        className={cn(PRIMARY, 'h-10')}
        onClick={() => setCreating({ placement, consentMode: null, title: `新增${noun}` })}
      >
        <IconPencilPlus aria-hidden /> 新增<span className="sr-only">{noun}</span>
      </button>
      <CreateHost creating={creating} cohortId={cohortId} vocabulary={vocabulary} onClose={() => setCreating(null)} />
    </>
  )
}

/** 作業分頁「新增」的三個選項（AC-9）：一般作業、兩種同意書（§6.1）。 */
const ASSIGNMENT_KINDS: readonly { label: string; hint: string; consentMode: ConsentModeValue | null }[] = [
  { label: '作業', hint: '學生或各組上傳檔案、填欄位', consentMode: null },
  { label: '同意書（站內表單）', hint: '每組在站內按「我同意」，全員同意後輪到指導老師', consentMode: 'form' },
  { label: '同意書（下載 PDF 再上傳）', hint: '附空白同意書，學生簽好上傳', consentMode: 'upload' },
]

/** 作業分頁右上的「新增」下拉：作業、同意書（站內表單）、同意書（下載 PDF 再上傳）→ 開 `ItemFormDialog` 帶 `consentMode`。 */
export function AssignmentListActions({ cohortId, vocabulary }: { cohortId: string; vocabulary: EditorVocabulary }) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState<Creating | null>(null)
  const box = useDismiss(open, () => setOpen(false))
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        className={cn(PRIMARY, 'h-10')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <IconPencilPlus aria-hidden /> 新增<span className="sr-only">作業</span>
        <IconChevronDown aria-hidden className="size-4" />
      </button>
      {open ? (
        <div role="menu" aria-label="新增哪一種" className={cn(MENU, 'w-72')}>
          {ASSIGNMENT_KINDS.map((k) => (
            <button
              key={k.label}
              type="button"
              role="menuitem"
              className={cn(MENU_ITEM, 'flex-col items-start gap-0.5')}
              onClick={() => {
                setOpen(false)
                setCreating({ placement: 'submission', consentMode: k.consentMode, title: `新增${k.label}` })
              }}
            >
              <span>{k.label}</span>
              <span className="text-xs font-normal text-muted-foreground">{k.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
      <CreateHost creating={creating} cohortId={cohortId} vocabulary={vocabulary} onClose={() => setCreating(null)} />
    </div>
  )
}

/** 一列要的事實（伺服器算好）。 */
export type RowActionFacts = {
  readonly id: string
  readonly title: string
  /** 不能刪時寫在按鈕上的原因（「發布中，先下架才能刪」「已有 N 組交件，不能刪」）；可以刪是 null。 */
  readonly deleteBlocked: string | null
  /** 發布中的公告才有「⋯ › 置頂／取消置頂」。 */
  readonly canPin: boolean
  readonly pinned: boolean
}

type Editing = { placement: ItemFormPlacement; cohortId: string; initial: ItemFormInitial; options: EditorVocabulary }

/** 每一列的「編輯」「刪除」「⋯」。 */
export function RowActions({ row }: { row: RowActionFacts }) {
  const router = useRouter()
  const [busy, setBusy] = useState<'edit' | 'pin' | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [menu, setMenu] = useState(false)
  const [toast, setToast] = useToast()
  const [pinFeedback, setPinFeedback] = useState<string | null>(null)
  const box = useDismiss(menu, () => setMenu(false))

  async function edit() {
    setBusy('edit')
    try {
      const context = await frontEditContextAction({ cohortId: null, itemId: row.id })
      if (!context.ok || !context.detail) {
        setToast(context.ok ? '這一筆已經不在了，請重新整理頁面。' : context.message)
        return
      }
      const initial = toInitial(context.detail, null, context.avatarUrls)
      setEditing({ placement: formPlacementOf(context.detail.placement), cohortId: context.cohortId, initial, options: context.options })
    } catch {
      setToast('表單資料載入失敗，請再按一次。')
    } finally {
      setBusy(null)
    }
  }

  async function togglePin() {
    setMenu(false)
    setBusy('pin')
    setPinFeedback(null)
    try {
      // 置頂是「設成目標狀態」：再按一次也不會重複做，所以每按一次用新的請求編號。
      const result = await setPinnedAction(row.id, !row.pinned, crypto.randomUUID())
      setPinFeedback(result.ok ? (result.message ?? '已完成。') : result.message)
      if (result.ok) router.refresh()
    } catch {
      setPinFeedback('連線中斷；結果尚未確認，請重新整理頁面看狀態再決定要不要再按一次。')
    } finally {
      setBusy(null)
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-1.5 md:justify-end">
      <button type="button" className={ROW_BTN} aria-label={`編輯：${row.title}`} disabled={busy !== null} onClick={edit}>
        {busy === 'edit' ? '載入中…' : '編輯'}
      </button>
      <DeleteButton row={row} onDeleted={(text) => {
        setToast(text)
        router.refresh()
      }} />
      {row.canPin ? (
        <div ref={box} className="relative">
          <button
            type="button"
            className={ROW_BTN}
            aria-label={`更多動作：${row.title}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={busy !== null}
            onClick={() => setMenu((v) => !v)}
          >
            <IconDots aria-hidden />
          </button>
          {menu ? (
            <div role="menu" aria-label={`更多動作：${row.title}`} className={MENU}>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                aria-label={row.pinned ? `取消置頂「${row.title}」` : `置頂「${row.title}」`}
                onClick={togglePin}
              >
                {row.pinned ? <IconPinnedOff aria-hidden /> : <IconPin aria-hidden />}
                {row.pinned ? '取消置頂' : '置頂'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {editing ? (
        <ItemFormDialog
          open
          title={`編輯：${row.title}`}
          placement={editing.placement}
          cohortId={editing.cohortId}
          itemId={row.id}
          initial={editing.initial}
          options={editing.options}
          onCancel={() => setEditing(null)}
          onDone={(result) => {
            setEditing(null)
            setToast(result.message ?? (result.status === 'published' ? '已發布' : '已儲存'))
            router.refresh()
          }}
        />
      ) : null}
      <Toast text={toast} />
      <Toast text={pinFeedback} testId="pin-feedback" />
    </span>
  )
}

/** 「刪除」：不能刪時按鈕本身寫原因且停用；能刪時開一句話確認框。 */
function DeleteButton({ row, onDeleted }: { row: RowActionFacts; onDeleted: (text: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState('')

  if (row.deleteBlocked) {
    return (
      <button type="button" className={ROW_BTN} disabled data-testid="delete-blocked">
        {row.deleteBlocked}
      </button>
    )
  }

  async function confirm() {
    setPending(true)
    setError(null)
    try {
      // 清單列沒有 revision：先讀一次這一筆目前的版本（系辦已在確認框看過名稱、按了刪除）。
      const context = await frontEditContextAction({ cohortId: null, itemId: row.id })
      if (!context.ok || !context.detail) {
        setError(context.ok ? '這一筆已經不在了，請重新整理頁面。' : context.message)
        return
      }
      const result = await deleteItemAction(row.id, context.detail.revision, requestId)
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
        aria-label={`刪除：${row.title}`}
        onClick={() => {
          setError(null)
          setRequestId(crypto.randomUUID())
          dialog.current?.showModal()
        }}
      >
        刪除
      </button>
      <dialog ref={dialog} aria-label={`刪除「${row.title}」`} className={cn(DIALOG, 'w-[min(28rem,calc(100vw-2rem))]')}>
        <div className="flex flex-col gap-4 px-6 py-5">
          <p className="text-base font-bold break-words">確定刪除「{row.title}」？刪了就不能恢復。</p>
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

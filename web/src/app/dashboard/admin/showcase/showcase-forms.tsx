'use client'
import { useRouter } from 'next/navigation'
import { useActionState, useEffect, useRef, useState, type DragEvent } from 'react'
import { IconChevronDown, IconGripVertical, IconPencilPlus } from '@tabler/icons-react'
import { deleteEntryAction, saveHomeOrderAction } from './actions'
import { ShowcaseEditDialog, type ShowcaseDialogTarget } from './showcase-edit-dialog'
import { ItemFormDialog } from '@/app/dashboard/admin/affairs/_form/item-form-dialog'
import { frontEditContextAction } from '@/app/dashboard/admin/affairs/front-edit-context-action'
import type { EditorVocabulary } from '@/app/dashboard/admin/affairs/item-form-model'
import { DIALOG, Feedback, PRIMARY, SECONDARY } from '@/app/dashboard/admin/groups/admin-group-forms'
import { homeOrderPatch, type ShowcaseEntryView } from '@/app/dashboard/admin/showcase/showcase-view'
import { cn } from '@/shared/cn'

/**
 * 公告與作業 › 成果展示會動的部分（C 階段規格① §4.5；C1-09 把原本攤開的四塊表單重組成清單＋一個視窗）：
 *
 * - `ShowcaseNewMenu`：右上「新增」下拉——「作品（本屆某組）」「補登歷屆作品」開 `ShowcaseEditDialog`，「榮譽」開共用的
 *   `ItemFormDialog placement='honor'`（帶榮譽榜區選的屆別，封存屆別也可以）。
 * - `EntryRowActions`：作品列的「編輯」（開視窗）、「刪除」（公開中停用、按鈕寫原因；能刪時一句確認）。
 * - `HomeOrderPanel`：首頁輪播順序，原生拖曳或上移／下移，按一次「儲存首頁順序」。
 * - 成功後右下角一句提示（整頁共用一個，掛在「新增」旁；列被刪掉也還看得到）；資料由 Server Action 的 `refresh()` 重新整理。
 */

/** `field`：失敗時是哪一欄（目前只有存草稿的 `videoUrl` 會帶），訊息改顯示在那一欄下面。 */
export type ShowcaseActionState = { ok: boolean; message: string; field?: string } | undefined

const ROW_BTN =
  'press inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-border bg-background px-2.5 text-xs font-semibold whitespace-nowrap transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-60 pointer-coarse:min-h-11 pointer-coarse:min-w-11 [&_svg]:size-3.5'
const MENU = 'absolute right-0 z-30 mt-1 w-72 rounded-lg border border-border bg-popover p-1 text-sm shadow-lg'
const MENU_ITEM =
  'flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left font-semibold hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60 pointer-coarse:min-h-11'

/** 右下角一句話提示（6 秒後消失）。 */
function useToast(): [string | null, (text: string) => void] {
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 6000)
    return () => window.clearTimeout(timer)
  }, [toast])
  return [toast, setToast]
}

function Toast({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p
      role="status"
      data-testid="showcase-toast"
      className="fixed right-4 bottom-4 z-50 max-w-[min(36rem,calc(100vw-2rem))] rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-ink-foreground shadow-lg"
    >
      {text}
    </p>
  )
}

/** 整頁共用的提示：列上的動作呼叫 `showToast`，`ToastHost`（掛在「新增」旁，頁面只有一個）顯示。 */
const toastListeners = new Set<(text: string) => void>()

function showToast(text: string) {
  for (const listener of toastListeners) listener(text)
}

function ToastHost() {
  const [toast, setToast] = useToast()
  useEffect(() => {
    toastListeners.add(setToast)
    return () => {
      toastListeners.delete(setToast)
    }
  }, [setToast])
  return <Toast text={toast} />
}

/** 視窗共用的設定（伺服器帶進來的句子與上限）。 */
export type ShowcaseDialogConfig = { videoUrlMessage: string; awardLabelMax: number }

type Honor = { cohortId: string; options: EditorVocabulary }

export function ShowcaseNewMenu({
  config,
  create,
  backfillCohorts,
  honorCohort,
}: {
  config: ShowcaseDialogConfig
  /** 「作品」：建草稿的屆別與還沒有作品的組；沒有進行中的屆別是 null（選項停用並寫原因）。 */
  create: { cohortLabel: string; groups: readonly { readonly id: string; readonly code: string }[] } | null
  backfillCohorts: readonly { readonly id: string; readonly label: string }[]
  /** 榮譽榜區目前選的屆別。 */
  honorCohort: { id: string; label: string } | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<ShowcaseDialogTarget | null>(null)
  const [honor, setHonor] = useState<Honor | null>(null)
  const [loading, setLoading] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function openHonor() {
    if (!honorCohort) return
    setOpen(false)
    setLoading(true)
    try {
      const context = await frontEditContextAction({ cohortId: honorCohort.id })
      if (context.ok) setHonor({ cohortId: context.cohortId, options: context.options })
      else showToast(context.message)
    } catch {
      showToast('表單資料載入失敗，請再按一次。')
    } finally {
      setLoading(false)
    }
  }

  const createReason = !create
    ? '目前沒有進行中的屆別，只能補登歷屆作品。'
    : create.groups.length === 0
      ? `${create.cohortLabel}還沒有組別，或每一組都已經有作品了。`
      : null

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        className={cn(PRIMARY, 'inline-flex items-center gap-1.5')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={loading}
        onClick={() => setOpen((v) => !v)}
      >
        <IconPencilPlus aria-hidden className="size-4" /> {loading ? '載入中…' : '新增'}
        <IconChevronDown aria-hidden className="size-4" />
      </button>
      {open ? (
        <div role="menu" aria-label="新增哪一種" className={MENU}>
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            disabled={createReason !== null}
            onClick={() => {
              setOpen(false)
              if (create) setTarget({ mode: 'create', cohortLabel: create.cohortLabel, groups: create.groups })
            }}
          >
            <span>作品</span>
            <span className="text-xs font-normal text-muted-foreground">{createReason ?? `替${create?.cohortLabel ?? ''}的某一組建成果展示`}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => {
              setOpen(false)
              setTarget({ mode: 'backfill', cohorts: backfillCohorts })
            }}
          >
            <span>補登歷屆作品</span>
            <span className="text-xs font-normal text-muted-foreground">選屆別（含已封存）＋題目，沒有組別</span>
          </button>
          <button type="button" role="menuitem" className={MENU_ITEM} disabled={!honorCohort} onClick={openHonor}>
            <span>榮譽</span>
            <span className="text-xs font-normal text-muted-foreground">
              {honorCohort ? `記在${honorCohort.label}；發布後出現在前台「榮譽榜」` : '還沒有屆別'}
            </span>
          </button>
        </div>
      ) : null}
      {target ? (
        <ShowcaseEditDialog
          target={target}
          {...config}
          onCancel={() => setTarget(null)}
          onSaved={(message) => {
            setTarget(null)
            showToast(message)
          }}
        />
      ) : null}
      {honor ? (
        <ItemFormDialog
          open
          title="新增榮譽"
          placement="honor"
          cohortId={honor.cohortId}
          options={honor.options}
          onCancel={() => setHonor(null)}
          onDone={(result) => {
            setHonor(null)
            showToast(result.message ?? (result.status === 'published' ? '已發布' : '已儲存'))
            router.refresh()
          }}
        />
      ) : null}
      <ToastHost />
    </div>
  )
}

/** 作品列的「編輯」「刪除」。 */
export function EntryRowActions({ entry, config }: { entry: ShowcaseEntryView; config: ShowcaseDialogConfig }) {
  const [editing, setEditing] = useState(false)
  const name = entry.title || '（未填題目）'
  return (
    <span className="flex flex-wrap items-center gap-1.5 md:justify-end">
      <button type="button" className={ROW_BTN} aria-label={`編輯：${name}`} onClick={() => setEditing(true)}>
        編輯
      </button>
      <DeleteEntryButton entry={entry} onDeleted={showToast} />
      {editing ? (
        <ShowcaseEditDialog
          target={{ mode: 'edit', entry }}
          {...config}
          onCancel={() => setEditing(false)}
          onSaved={(message) => {
            setEditing(false)
            showToast(message)
          }}
        />
      ) : null}
    </span>
  )
}

/** 刪除：公開中停用、按鈕本身寫原因；能刪時一句確認（不能恢復）。 */
function DeleteEntryButton({ entry, onDeleted }: { entry: ShowcaseEntryView; onDeleted: (text: string) => void }) {
  const [state, action, pending] = useActionState(deleteEntryAction, undefined)
  const dialog = useRef<HTMLDialogElement>(null)
  const [requestId, setRequestId] = useState('')
  const name = entry.title || '（未填題目）'

  useEffect(() => {
    if (!state?.ok) return
    dialog.current?.close()
    onDeleted(state.message)
  }, [state, onDeleted])

  if (entry.deleteBlocked) {
    return (
      <button type="button" className={ROW_BTN} disabled data-testid="delete-blocked">
        {entry.deleteBlocked}
      </button>
    )
  }
  return (
    <>
      <button
        type="button"
        className={cn(ROW_BTN, 'text-destructive hover:bg-destructive-subtle')}
        aria-label={`刪除：${name}`}
        onClick={() => {
          setRequestId(crypto.randomUUID())
          dialog.current?.showModal()
        }}
      >
        刪除
      </button>
      <dialog ref={dialog} aria-label="刪除作品" className={cn(DIALOG, 'w-[min(28rem,calc(100vw-2rem))]')}>
        <form action={action} className="flex flex-col gap-4 px-6 py-5">
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="entryId" value={entry.entryId} />
          <input type="hidden" name="revision" value={entry.entryRevision} />
          <p className="text-base font-bold break-words">
            確定刪除 {entry.groupLabel}「{name}」？草稿與發布過的版本一起刪掉，前台與作品網址都不再出現，不能恢復。
          </p>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2">
            <button type="button" className={SECONDARY} onClick={() => dialog.current?.close()}>
              取消
            </button>
            <button
              type="submit"
              className="press inline-flex h-10 items-center rounded-lg bg-destructive px-4 text-sm font-semibold text-white disabled:opacity-60"
              disabled={pending}
            >
              {pending ? '刪除中…' : '刪除這件作品'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}

type HomeEntry = { entryId: string; title: string; groupLabel: string; homePosition: number | null; entryRevision: number }

/** 首頁輪播順序：原生拖曳或上移／下移排好，按一次「儲存首頁順序」照先後存成 1、2、3…。 */
export function HomeOrderPanel({ entries }: { entries: readonly HomeEntry[] }) {
  const [order, setOrder] = useState(entries)
  const [dragging, setDragging] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [state, setState] = useState<ShowcaseActionState>(undefined)
  // 伺服器重新整理後（別處改了順序），以新的資料為準。
  const signature = entries.map((e) => `${e.entryId}:${e.homePosition}:${e.entryRevision}`).join(',')
  const [seen, setSeen] = useState(signature)
  if (seen !== signature) {
    setSeen(signature)
    setOrder(entries)
  }
  const patch = homeOrderPatch(order)

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return
    const next = [...order]
    const [picked] = next.splice(from, 1)
    next.splice(to, 0, picked!)
    setOrder(next)
    setState(undefined)
  }

  async function save() {
    setPending(true)
    try {
      const revisionOf = new Map(order.map((e) => [e.entryId, e.entryRevision]))
      const result = await saveHomeOrderAction(
        patch.map((p) => ({ ...p, revision: revisionOf.get(p.entryId) ?? 0, requestId: crypto.randomUUID() })),
      )
      setState(result)
    } catch {
      setState({ ok: false, message: '連線中斷；結果尚未確認，請重新整理頁面看順序。' })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-2">
      <ol aria-label="首頁輪播順序" className="divide-y divide-border rounded-lg border border-border">
        {order.map((e, i) => (
          <li
            key={e.entryId}
            draggable
            data-testid="home-order-item"
            onDragStart={(ev: DragEvent<HTMLLIElement>) => {
              ev.dataTransfer.effectAllowed = 'move'
              ev.dataTransfer.setData('text/plain', e.entryId)
              setDragging(e.entryId)
            }}
            onDragOver={(ev) => ev.preventDefault()}
            onDrop={(ev) => {
              ev.preventDefault()
              const from = order.findIndex((x) => x.entryId === (dragging ?? ev.dataTransfer.getData('text/plain')))
              if (from >= 0) move(from, i)
              setDragging(null)
            }}
            onDragEnd={() => setDragging(null)}
            className={cn('flex items-center gap-2 px-3 py-2 text-sm', dragging === e.entryId && 'opacity-50')}
          >
            <IconGripVertical aria-hidden className="size-4 shrink-0 cursor-grab text-muted-foreground" />
            <span className="w-6 shrink-0 font-semibold tabular-nums">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">
              {e.title || '（未填題目）'}
              <span className="ml-1 text-xs text-muted-foreground">{e.groupLabel}</span>
            </span>
            <button type="button" className={ROW_BTN} aria-label={`上移：${e.title}`} disabled={i === 0} onClick={() => move(i, i - 1)}>
              上移
            </button>
            <button type="button" className={ROW_BTN} aria-label={`下移：${e.title}`} disabled={i === order.length - 1} onClick={() => move(i, i + 1)}>
              下移
            </button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={SECONDARY} disabled={pending || patch.length === 0} onClick={save}>
          {pending ? '儲存中…' : '儲存首頁順序'}
        </button>
        <span className="text-xs text-muted-foreground">拖曳或按上移、下移排好後存一次；也可以在作品的「編輯」直接填數字。</span>
      </div>
      <Feedback state={state} />
    </div>
  )
}

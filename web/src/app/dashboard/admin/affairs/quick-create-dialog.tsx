'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  IconArrowRight,
  IconBell,
  IconBook,
  IconClipboardText,
  IconSignature,
  IconFolders,
  IconPencilPlus,
  IconTrophy,
  type Icon,
} from '@tabler/icons-react'
import { ItemFormDialog } from './_form/item-form-dialog'
import { DIALOG, PRIMARY, SECONDARY } from './item-form-parts'
import { ITEM_FLASH_KEY, type ConsentModeValue, type EditorVocabulary, type ItemFormPlacement } from './item-form-model'
import { cn } from '@/shared/cn'

/**
 * 「新增」鈕的相容包裝（C 階段規格① C1-06）：同名 export、同 props，給②四個公告與作業分頁殼繼續掛；C1-07 換掉掛載後就刪。
 *
 * 按鈕與類型選單保留（第 1 步選類型；作業另有兩種同意書）；按「下一步」起開共用表單 `ItemFormDialog`（一頁式、按需載入）。
 * 表單送出後關窗、刷新清單、在右下角提示一句；全頁編輯器（`/editor/*`）送出回到清單時留下的提示也在這裡顯示一次。
 */

const PLACEMENT_ICON: Record<string, Icon> = {
  news: IconBell,
  resource: IconFolders,
  submission: IconClipboardText,
  rules: IconBook,
  honor: IconTrophy,
}

type Kind = { placement: ItemFormPlacement; consentMode: ConsentModeValue | null; label: string; hint?: string; icon: Icon }
const keyOf = (k: Pick<Kind, 'placement' | 'consentMode'>) => `${k.placement}:${k.consentMode ?? ''}`

/** 作業的兩種同意書（§6.1）：站內表單（整組、我同意／不同意）、下載 PDF 再上傳（一般個人作業）。 */
const CONSENT_KINDS: readonly Kind[] = [
  { placement: 'submission', consentMode: 'form', label: '同意書（站內表單）', hint: '每組在站內按「我同意」，全員同意後輪到指導老師', icon: IconSignature },
  { placement: 'submission', consentMode: 'upload', label: '同意書（下載 PDF 再上傳）', hint: '附空白同意書，學生簽好上傳', icon: IconSignature },
]

/** `label`：按鈕、對話框名稱與標題（各分頁用「新增公告／作業／資源／規則」）；`placement`：開窗時預選的類型。 */
export function QuickCreateDialog({
  cohortId,
  vocabulary,
  label = '新增項目',
  placement = 'news',
}: {
  cohortId: string
  vocabulary: EditorVocabulary
  label?: string
  placement?: string
}) {
  const router = useRouter()
  const picker = useRef<HTMLDialogElement>(null)
  const kinds: Kind[] = [
    ...vocabulary.placements.map((p) => ({
      placement: p.value as ItemFormPlacement,
      consentMode: null,
      label: p.label,
      hint: p.hint,
      icon: PLACEMENT_ICON[p.value] ?? IconClipboardText,
    })),
    ...CONSENT_KINDS,
  ]
  const preset = keyOf(kinds.find((k) => k.placement === placement && k.consentMode === null) ?? kinds[0]!)
  const [choice, setChoice] = useState(preset)
  const [form, setForm] = useState<Kind | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // 全頁編輯器送出後回到清單：把它留下的那一句顯示一次。
  useEffect(() => {
    const flash = window.sessionStorage.getItem(ITEM_FLASH_KEY)
    if (!flash) return
    window.sessionStorage.removeItem(ITEM_FLASH_KEY)
    setToast(flash)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(timer)
  }, [toast])

  function open() {
    setChoice(preset)
    picker.current?.showModal()
  }

  function next() {
    picker.current?.close()
    setForm(kinds.find((k) => keyOf(k) === choice) ?? null)
  }

  return (
    <>
      <button type="button" className={cn(PRIMARY, 'h-10')} onClick={open}>
        <IconPencilPlus aria-hidden /> {label}
      </button>
      <dialog ref={picker} aria-label={label} className={cn(DIALOG, 'w-[min(44rem,calc(100vw-2rem))]')}>
        <div className="flex flex-col gap-4 px-6 py-5">
          <div>
            <h2 className="text-lg font-extrabold">{label}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">選要新增哪一種，下一步就是完整的表單（左邊填、右邊即時預覽）。</p>
          </div>
          <fieldset>
            <legend className="sr-only">類型</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {kinds.map((k) => {
                const on = choice === keyOf(k)
                const KindIcon = k.icon
                return (
                  <label
                    key={keyOf(k)}
                    className={cn(
                      'press flex cursor-pointer items-start gap-3 rounded-xl border-2 p-4 text-left transition-colors',
                      on ? 'border-primary bg-primary-subtle/40' : 'border-border hover:border-ink/40',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn('inline-flex size-10 shrink-0 items-center justify-center rounded-lg', on ? 'bg-primary text-primary-foreground' : 'bg-muted')}
                    >
                      <KindIcon className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-bold">
                        <input type="radio" name="qc-kind" checked={on} className="size-4 accent-primary" onChange={() => setChoice(keyOf(k))} />
                        {k.label}
                      </span>
                      {k.hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{k.hint}</span> : null}
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={() => picker.current?.close()}>
              取消
            </button>
            <button type="button" className={cn(PRIMARY, 'h-10 px-5')} onClick={next}>
              下一步 <IconArrowRight aria-hidden className="size-4" />
            </button>
          </div>
        </div>
      </dialog>
      {form ? (
        <ItemFormDialog
          open
          title={label}
          placement={form.placement}
          consentMode={form.consentMode ?? undefined}
          cohortId={cohortId}
          options={vocabulary}
          onCancel={() => setForm(null)}
          onDone={(result) => {
            setForm(null)
            setToast(result.message ?? (result.status === 'published' ? '已發布' : '已儲存'))
            router.refresh()
          }}
        />
      ) : null}
      {toast ? (
        <p role="status" className="fixed right-4 bottom-4 z-50 rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-ink-foreground shadow-lg" data-testid="item-toast">
          {toast}
        </p>
      ) : null}
    </>
  )
}

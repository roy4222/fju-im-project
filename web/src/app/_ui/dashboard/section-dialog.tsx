'use client'
import { useEffect, useRef, type ReactNode } from 'react'
import { IconX } from '@tabler/icons-react'
import { DIALOG, DIALOG_DESC, DIALOG_TITLE } from '@/app/_ui/dashboard/look'
import { cn } from '@/shared/cn'

/**
 * 把一整個工作區塊收進對話框（原型把這類設定放在對話框裡，主畫面只留看的東西）。
 *
 * 用原生 `<dialog>`：焦點鎖、Esc 關閉都是瀏覽器的。裡面的表單照舊是 Server Action，
 * 送出後頁面重整不會把對話框關掉（元素沒有被換掉）。
 * `openParam`：網址上 `?dialog=<值>` 時一進頁就打開——對話框裡的分頁連結（例如換階段）是換網址，
 * 帶著這個參數回來才不會把人丟回主畫面。關掉時把參數從網址拿掉，重新整理就不會再自己打開。
 */
export function SectionDialog({
  label,
  title,
  description,
  icon,
  openParam,
  defaultOpen = false,
  size = '2xl',
  triggerClassName,
  children,
}: {
  label: ReactNode
  title: string
  description?: ReactNode
  icon?: ReactNode
  openParam: string
  defaultOpen?: boolean
  size?: keyof typeof DIALOG | 'wide'
  triggerClassName: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (defaultOpen && ref.current && !ref.current.open) ref.current.showModal()
  }, [defaultOpen])

  function onClose() {
    const url = new URL(window.location.href)
    if (url.searchParams.get('dialog') === openParam) {
      url.searchParams.delete('dialog')
      window.history.replaceState(window.history.state, '', url)
    }
  }

  const width = size === 'wide' ? cn(DIALOG['2xl'], 'w-[min(64rem,calc(100vw-2rem))]') : DIALOG[size]
  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => ref.current?.showModal()}>
        {icon}
        {label}
      </button>
      <dialog ref={ref} aria-label={title} className={width} onClose={onClose}>
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className={DIALOG_TITLE}>{title}</h2>
            {description ? <p className={DIALOG_DESC}>{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="關閉"
          >
            <IconX className="size-4" aria-hidden />
          </button>
        </div>
        {children}
      </dialog>
    </>
  )
}

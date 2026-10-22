'use client'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { IconCopy } from '@tabler/icons-react'
import { BTN_ROW_GHOST as GHOST_SM, BTN_ROW } from '@/app/_ui/dashboard/look'
import { cn } from '@/shared/cn'

/** 把字串放進剪貼簿。`navigator.clipboard` 不能用時（非安全來源、權限被擋）退回選取文字＋複製指令。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 往下走後備做法。
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  return copied
}

export function CopyEmailsButton({ code, emails }: { code: string; emails: readonly string[] }) {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  if (emails.length === 0) return <span className="text-xs text-muted-foreground">沒有信箱</span>
  const joined = emails.join(', ')
  return (
    <div className="relative">
      <button
        type="button"
        className={cn(GHOST_SM, 'px-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11')}
        title="複製本組信箱"
        aria-label={`複製本組信箱：${code}`}
        onClick={async () => {
          const ok = await copyText(joined)
          setMessage(
            ok
              ? { ok: true, text: `已複製 ${emails.length} 個信箱，可以直接貼到收件人欄。` }
              : { ok: false, text: '瀏覽器不允許複製，請手動選取旁邊的信箱。' },
          )
          // 提示浮在表格上，成功的過幾秒自己收起來；失敗的留著，讓人照著做。
          if (ok) setTimeout(() => setMessage(null), 5000)
        }}
      >
        <IconCopy className="size-3.5" aria-hidden />
        複製本組信箱
      </button>
      {message ? (
        <p role="status" className={cn('absolute top-full right-0 z-10 mt-1 w-56 rounded-lg bg-popover p-2 text-xs shadow-md ring-1 ring-foreground/10', message.ok ? 'text-brand-on-subtle' : 'text-destructive')}>
          {message.text}
        </p>
      ) : null}
    </div>
  )
}


const Selection = createContext<{ ids: readonly string[]; selected: readonly string[]; toggle: (id: string, on: boolean) => void } | null>(null)

export function RosterSelection({ ids, children }: { ids: readonly string[]; children: ReactNode }) {
  const [selected, setSelected] = useState<readonly string[]>([])
  return <Selection.Provider value={{ ids, selected: selected.filter((id) => ids.includes(id)), toggle: (id, on) => setSelected((old) => on ? [...new Set([...old, id])] : old.filter((x) => x !== id)) }}>{children}</Selection.Provider>
}

export function SelectGroup({ id, code }: { id: string; code: string }) {
  const selection = useContext(Selection)
  if (!selection) return null
  return <label className="inline-flex min-h-11 min-w-11 items-center justify-center">
    <input type="checkbox" className="size-4 accent-primary" checked={selection.selected.includes(id)} onChange={(e) => selection.toggle(id, e.target.checked)} aria-label={`勾選 ${code}`} />
  </label>
}

export function RosterCount({ total }: { total: number }) {
  const selection = useContext(Selection)
  return <p className="text-xs tabular-nums text-muted-foreground" data-testid="roster-count">
    顯示 {selection?.ids.length ?? 0}／{total} 組・已勾選 {selection?.selected.length ?? 0} 組
  </p>
}

export function RosterExportMenu({ cohortId, filter }: { cohortId: string; filter: Record<string, string> }) {
  const selection = useContext(Selection)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  async function download(format: 'csv' | 'xlsx', selected: boolean) {
    setBusy(true)
    setMessage(null)
    try {
      const body = selected ? { cohortId, format, kind: 'ids', groupIds: selection?.selected ?? [] } : { cohortId, format, kind: 'filter', filter }
      const response = await fetch('/api/admin/groups/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) {
        const problem = await response.json().catch(() => null) as { message?: string } | null
        setMessage({ ok: false, text: problem?.message ?? '匯出失敗，請重新整理頁面再試。' })
        return
      }
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') ?? '')?.[1]
      const fileName = encoded ? decodeURIComponent(encoded) : `組別名單.${format}`
      const url = URL.createObjectURL(await response.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      setMessage({ ok: true, text: `已匯出 ${response.headers.get('x-export-count') ?? ''} 組、${response.headers.get('x-export-rows') ?? ''} 位組員（${fileName}）。` })
    } catch {
      setMessage({ ok: false, text: '匯出失敗，請檢查網路後再試。' })
    } finally { setBusy(false) }
  }
  return <details className="relative">
    <summary className={`${BTN_ROW} cursor-pointer pointer-coarse:min-h-11`}>匯出</summary>
    <div className="absolute right-0 z-20 mt-2 w-64 space-y-2 rounded-lg border border-border bg-popover p-3 shadow-lg">
      <p className="text-sm">已選 {selection?.selected.length ?? 0} 組</p>
      {(['csv', 'xlsx'] as const).map((format) => <div key={format} className="flex flex-wrap gap-2">
        <button type="button" className={BTN_ROW} disabled={busy || !selection?.ids.length} onClick={() => void download(format, false)}>匯出篩選結果（{format.toUpperCase()}）</button>
        <button type="button" className={BTN_ROW} disabled={busy || !selection?.selected.length} onClick={() => void download(format, true)}>匯出勾選（{format.toUpperCase()}）</button>
      </div>)}
      {message ? <p role={message.ok ? 'status' : 'alert'} className="text-sm">{message.text}</p> : null}
    </div>
  </details>
}

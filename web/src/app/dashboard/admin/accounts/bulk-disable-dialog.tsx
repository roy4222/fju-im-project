'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { BulkDisableReceipt, BulkPreview } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { bulkDisableAction, previewBulkDisableAction } from './actions'

/**
 * 批次停用（產品模組 01 §2.6；票 9；原型的 BulkDisableDialog）。
 *
 * 三步：選 TXT 或直接貼上（一行一個學號）→ 伺服器預覽「將停用／已停用／找不到／重複」
 * 與要人工處理的列 → 寫理由確認。確認時伺服器用同一份文字再算一次，跟預覽不同就請你重新預覽。
 * 預設只停用，不刪除任何東西。
 */

const BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50'
const PRIMARY = 'bg-primary text-primary-foreground hover:bg-primary/90'
const SECONDARY = 'bg-muted text-foreground hover:bg-border'
const DANGER = 'bg-danger text-white hover:bg-danger/90'

type Phase =
  | { kind: 'input' }
  | { kind: 'preview'; preview: BulkPreview }
  | { kind: 'done'; receipt: BulkDisableReceipt }

export function BulkDisableDialog({ maxChars }: { maxChars: number }) {
  const router = useRouter()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'input' })
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [requestId, setRequestId] = useState('')

  function open() {
    setPhase({ kind: 'input' })
    setText('')
    setReason('')
    setError(null)
    setRequestId(crypto.randomUUID())
    setIsOpen(true)
    dialogRef.current?.showModal()
  }

  function onClosed() {
    setIsOpen(false)
    if (phase.kind === 'done') router.refresh()
  }

  async function pickFile(file: File | undefined) {
    setError(null)
    if (!file) return
    if (file.size > maxChars * 4) {
      setError('檔案太大了，請分批處理。')
      return
    }
    try {
      // 只收 UTF-8：解不開就直接說，不猜編碼。
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      setText(decoded)
    } catch {
      setError('這個檔案不是 UTF-8 文字檔。請用記事本另存成 UTF-8 再試一次。')
    }
  }

  async function preview() {
    if (!text.trim()) {
      setError('請選擇 TXT 檔，或在框裡貼上學號（一行一個）。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await previewBulkDisableAction({ text })
      if (result.ok) setPhase({ kind: 'preview', preview: result.data })
      else setError(result.message)
    } catch {
      setError('預覽失敗，請再試一次。')
    } finally {
      setBusy(false)
    }
  }

  async function confirm(p: BulkPreview) {
    if (!reason.trim()) {
      setError('請寫停用的理由。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await bulkDisableAction({
        text,
        expectedUserIds: p.hits.map((h) => h.userId),
        reason,
        requestId,
      })
      if (result.ok) setPhase({ kind: 'done', receipt: result.data })
      else if (result.code === 'CONFLICT') {
        setError(result.message)
        setPhase({ kind: 'input' })
        setRequestId(crypto.randomUUID())
      } else setError(result.message)
    } catch {
      setError('結果未知：可能已經停用。請再按一次確認（不會重複停用），或關閉後重新整理。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" onClick={open} className={cn(BUTTON, SECONDARY, 'px-3 py-1.5')}>
        批次停用（TXT）
      </button>
      <dialog
        ref={dialogRef}
        onClose={onClosed}
        aria-label="批次停用"
        className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40"
      >
        <div className="max-h-[85vh] overflow-y-auto p-5">
          {!isOpen ? null : phase.kind === 'done' ? (
            <div className="space-y-3 text-center" role="status">
              <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">
                已停用
              </p>
              <h2 className="text-lg font-semibold text-ink">{phase.receipt.disabled} 個帳號</h2>
              <p className="text-sm text-muted-foreground">
                他們在任何分頁做下一個動作就會被登出；資料與紀錄都保留，可以逐一恢復。理由、操作者與時間已寫入紀錄。
              </p>
              {phase.receipt.revocationFailed > 0 ? (
                <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  有 {phase.receipt.revocationFailed} 個帳號的封鎖同步沒有完成（已留紀錄）；停用已經生效，他們已經進不來。
                </p>
              ) : null}
              <button type="button" onClick={() => dialogRef.current?.close()} className={cn(BUTTON, SECONDARY)}>
                關閉
              </button>
            </div>
          ) : phase.kind === 'preview' ? (
            <PreviewStep
              preview={phase.preview}
              reason={reason}
              setReason={(v) => {
                setReason(v)
                setError(null)
              }}
              error={error}
              busy={busy}
              onBack={() => {
                setPhase({ kind: 'input' })
                setError(null)
              }}
              onConfirm={() => confirm(phase.preview)}
            />
          ) : (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-ink">批次停用</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  UTF-8 的 TXT，<strong className="font-medium text-ink">一行一個學號</strong>，可以有空白行，不要加逗號或姓名。
                  下一步會先預覽，不會馬上停用。
                </p>
              </div>
              <label className="block text-sm font-medium text-ink">
                選擇 TXT 檔
                <input
                  type="file"
                  accept=".txt,text/plain"
                  onChange={(e) => pickFile(e.target.files?.[0])}
                  className="mt-1 block w-full text-sm font-normal"
                />
              </label>
              <label className="block text-sm font-medium text-ink">
                或直接貼上學號
                <textarea
                  rows={6}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value)
                    setError(null)
                  }}
                  placeholder={'411400001\n411400002'}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm font-normal"
                />
              </label>
              {error ? (
                <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => dialogRef.current?.close()} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                  取消
                </button>
                <button type="button" onClick={preview} className={cn(BUTTON, PRIMARY)} disabled={busy}>
                  {busy ? '預覽中…' : '預覽'}
                </button>
              </div>
            </div>
          )}
        </div>
      </dialog>
    </>
  )
}

function Count({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="rounded-md bg-muted px-3 py-3 text-center" data-testid={testId}>
      <p className="text-2xl font-semibold tabular-nums text-ink">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function PreviewStep({
  preview: p,
  reason,
  setReason,
  error,
  busy,
  onBack,
  onConfirm,
}: {
  preview: BulkPreview
  reason: string
  setReason: (v: string) => void
  error: string | null
  busy: boolean
  onBack: () => void
  onConfirm: () => void
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">批次停用預覽</h2>
        <p className="mt-1 text-sm text-muted-foreground">只會停用「將停用」那幾位；其他的不動。預設停用，不是刪除。</p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Count label="將停用" value={p.hits.length} testId="bulk-hits" />
        <Count label="已停用" value={p.alreadyDisabled.length} testId="bulk-already" />
        <Count label="找不到" value={p.notFound.length} testId="bulk-not-found" />
        <Count label="重複" value={p.duplicates.length} testId="bulk-duplicates" />
      </div>

      {p.hits.length > 0 ? (
        <section aria-label="將停用">
          <h3 className="mb-1 text-sm font-medium text-ink">將停用</h3>
          <ul className="max-h-40 overflow-y-auto rounded-md border border-border text-sm">
            {p.hits.map((h) => (
              <li key={h.userId} className="flex justify-between gap-3 border-b border-border px-3 py-1.5 last:border-0">
                <span className="text-ink">{h.name}</span>
                <span className="tabular-nums text-muted-foreground">
                  {h.studentNo}
                  {h.cohortCode ? `・${h.cohortCode}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {p.notFound.length + p.duplicates.length + p.alreadyDisabled.length + p.skipped.length > 0 ? (
        <section aria-label="不會停用的列">
          <h3 className="mb-1 text-sm font-medium text-ink">不會停用的列</h3>
          <ul className="max-h-40 overflow-y-auto rounded-md border border-border text-xs">
            {p.skipped.map((s) => (
              <li key={`s-${s.line}`} className="flex justify-between gap-3 border-b border-border px-3 py-1.5 last:border-0">
                <span className="tabular-nums">第 {s.line} 行 {s.studentNo}</span>
                <span className="text-primary-on-subtle">{s.reason}</span>
              </li>
            ))}
            {p.alreadyDisabled.map((a) => (
              <li key={`a-${a.line}`} className="flex justify-between gap-3 border-b border-border px-3 py-1.5 last:border-0">
                <span className="tabular-nums">第 {a.line} 行 {a.studentNo}（{a.name}）</span>
                <span className="text-muted-foreground">已經是停用</span>
              </li>
            ))}
            {p.notFound.map((n) => (
              <li key={`n-${n.line}`} className="flex justify-between gap-3 border-b border-border px-3 py-1.5 last:border-0">
                <span className="tabular-nums">第 {n.line} 行 {n.studentNo}</span>
                <span className="text-muted-foreground">找不到已核准的帳號</span>
              </li>
            ))}
            {p.duplicates.map((d) => (
              <li key={`d-${d.line}`} className="flex justify-between gap-3 border-b border-border px-3 py-1.5 last:border-0">
                <span className="tabular-nums">第 {d.line} 行 {d.studentNo}</span>
                <span className="text-muted-foreground">與第 {d.firstLine} 行重複</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {p.hits.length > 0 ? (
        <label className="block text-sm font-medium text-ink">
          理由 <span className="font-normal text-muted-foreground">・必填，會寫入每一位的紀錄</span>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="例：113 學年度畢業"
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-normal"
          />
        </label>
      ) : (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">沒有需要停用的帳號。</p>
      )}

      {error ? (
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onBack} className={cn(BUTTON, SECONDARY)} disabled={busy}>
          上一步
        </button>
        {p.hits.length > 0 ? (
          <button type="button" onClick={onConfirm} className={cn(BUTTON, DANGER)} disabled={busy}>
            {busy ? '處理中…' : `確認停用 ${p.hits.length} 個帳號`}
          </button>
        ) : null}
      </div>
    </div>
  )
}

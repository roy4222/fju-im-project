'use client'
import { useEffect, useRef, useState } from 'react'
import type {
  GroupImportKind,
  GroupImportOutcome,
  GroupImportPreview,
  GroupImportReceipt,
} from '@/application/groups'
import { formatBytes } from '@/shared/format-bytes'
import type { groupImportAction } from './import-actions'

/** 匯入分組 Server Action 的回傳（型別放這裡：`import-actions.ts` 只能匯出 async 函式）。 */
export type ImportActionOutcome<T> = { ok: true; data: T } | { ok: false; message: string }

type Step =
  | { kind: 'choose' }
  | { kind: 'preview'; preview: GroupImportPreview; requestId: string }
  | { kind: 'done'; receipt: GroupImportReceipt; message: string; csv: string }

/** 不用 `cn`（tailwind-merge 會跟著進延後載入的 chunk、把全站共用 chunk 切開）；這裡的 class 不會互相衝突。 */
function join(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

const SKIP_KINDS: readonly GroupImportKind[] = ['skip_same', 'conflict_other_group', 'conflict_proposal', 'invalid']

/**
 * 對話框用到的 Server Action（`groupImportAction`，由 `toolbar-actions.tsx` 傳進來；理由同 `GroupImportLook`）。
 */
export type GroupImportActions = typeof groupImportAction

/**
 * 對話框與按鈕的樣式字串（由 `toolbar-actions.tsx` 從 `admin-group-forms` 傳進來）。這個模組不 import `admin-group-forms`：
 * 那個檔帶著 Server Action 與元件庫的按鈕，延後載入的 chunk 一引用它們，全站共用的 chunk 就會被重新切開。
 */
export type GroupImportLook = { dialog: string; primary: string; secondary: string }

/** 對話框要的文字與上限（開啟時由 `groupImportSettingsAction` 拿；app 對 application 只能帶型別）。 */
export type GroupImportSettings = {
  kindLabels: Record<GroupImportKind, string>
  outcomeLabels: Record<GroupImportOutcome, string>
  maxBytes: number
}

/**
 * 「匯入」分組（C3-16；設計方案③ §6.4）：下載範本 → 選 CSV → 六類預覽 → 執行（逐列，只做建新組與加人）→ 結果表可下載。
 * 屆別就是頁面上方選的那一屆。檔案位元組直接 POST 到 `/api/files/upload`（同批次指派）；預覽與執行都由伺服器重新讀那份原檔。
 *
 * 這個模組只在按「匯入」時才載入（`toolbar-actions.tsx` 用 `import()`），不進頁面首載；
 * 掛上就開啟，關閉時呼叫 `onClose` 讓外層卸載（下次再開是全新狀態）。
 */
export function GroupImportDialog({
  cohortId,
  cohortLabel,
  actions,
  look,
  onClose,
}: {
  cohortId: string
  cohortLabel: string
  actions: GroupImportActions
  look: GroupImportLook
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  
  const [settings, setSettings] = useState<GroupImportSettings | null>(null)
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const inFlight = useRef(false)

  useEffect(() => {
    dialogRef.current?.showModal()
    let alive = true
    actions({ op: 'settings' })
      .then((loaded) => {
        if (alive) setSettings(loaded)
      })
      .catch(() => {
        if (alive) setError('連線中斷，請關閉後再開一次。')
      })
    return () => {
      alive = false
    }
  }, [actions])

  async function onFile(file: File | undefined) {
    if (!file) return
    setError(null)
    setBusy('上傳中…')
    try {
      const ticket = await actions({ op: 'upload', fileName: file.name, declaredMime: file.type, declaredSize: file.size })
      if (!ticket.ok) {
        setError(ticket.message)
        return
      }
      const response = await fetch(`/api/files/upload?ticket=${encodeURIComponent(ticket.data.ticket)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      const uploaded = (await response.json().catch(() => null)) as { ok: true; fileId: string } | { ok: false; message: string } | null
      if (!uploaded || !uploaded.ok) {
        setError(uploaded?.message ?? '上傳失敗，請重新選擇檔案。')
        return
      }
      setBusy('分析中…')
      const preview = await actions({ op: 'preview', fileId: uploaded.fileId, cohortId })
      if (!preview.ok) {
        setError(preview.message)
        return
      }
      setStep({ kind: 'preview', preview: preview.data, requestId: crypto.randomUUID() })
    } catch {
      setError('連線中斷，請重新選擇檔案。')
    } finally {
      setBusy(null)
    }
  }

  async function execute(current: Extract<Step, { kind: 'preview' }>) {
    if (inFlight.current) return
    inFlight.current = true
    setError(null)
    setBusy('逐列執行中…')
    try {
      // 同一個 requestId 重送只會做一次，連點或斷線重試都安全。
      const result = await actions({ op: 'execute', fileId: current.preview.fileId, cohortId, requestId: current.requestId })
      if (!result.ok) setError(result.message)
      else setStep({ kind: 'done', ...result.data })
    } catch {
      setError('結果未知：可能已經執行。請再按一次「執行」（不會重複建組或通知），或關閉後看組別列表。')
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  function downloadResult(csv: string, fileName: string) {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `匯入結果_${fileName.replace(/\.csv$/i, '')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <dialog ref={dialogRef} aria-label="匯入分組" onClose={onClose} className={`${look.dialog} min-w-[min(52rem,calc(100vw-2rem))]`}>
        <div className="max-h-[85vh] space-y-4 overflow-y-auto p-5">
          <div>
            <h2 className="text-lg font-extrabold text-foreground">匯入分組・{cohortLabel}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              存檔時文字編碼選 UTF-8 的 CSV；第一行欄名是 <code className="rounded bg-muted px-1">學號,組別代碼,類型</code>。
              同一個組別代碼多列＝多個組員，第一個學號是組長；代碼要像 G01，還沒有的代碼會建新組，已經有的就加人；類型填「一般」或「產學」，省略＝一般。
              要換屆別請先在頁面上方切換。
              <a href="/samples/分組匯入範例.csv" download className="ml-1 font-semibold text-primary hover:underline">
                下載範本
              </a>
            </p>
          </div>

          {step.kind === 'choose' ? (
            <label
              className={join(
                'flex cursor-pointer flex-col items-center gap-2 rounded-card border border-dashed border-border px-4 py-8 text-sm transition-colors hover:border-primary hover:bg-primary-subtle/40',
                busy && 'pointer-events-none opacity-60',
              )}
            >
              <span className="font-medium text-foreground">{busy ?? '選擇 CSV 檔'}</span>
              <span className="text-xs text-muted-foreground">
                {settings ? `上限 ${formatBytes(settings.maxBytes)}；` : ''}先看預覽，確認後才逐列執行
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-label="選擇分組匯入 CSV 檔"
                disabled={Boolean(busy) || !settings}
                onChange={(event) => {
                  onFile(event.currentTarget.files?.[0])
                  event.currentTarget.value = ''
                }}
              />
            </label>
          ) : step.kind === 'preview' && settings ? (
            <ImportPreview
              preview={step.preview}
              kindLabels={settings.kindLabels}
              look={look}
              busy={busy}
              onRestart={() => {
                setError(null)
                setStep({ kind: 'choose' })
              }}
              onExecute={() => execute(step)}
            />
          ) : step.kind === 'done' && settings ? (
            <div className="space-y-3">
              <p role="status" className="rounded-lg bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
                {step.message}
              </p>
              <ResultTable receipt={step.receipt} outcomeLabels={settings.outcomeLabels} />
              <div className="flex justify-end">
                <button type="button" className={look.secondary} onClick={() => downloadResult(step.csv, step.receipt.fileName)}>
                  下載結果表
                </button>
              </div>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end border-t border-border p-4">
          <button type="button" className={look.secondary} onClick={() => dialogRef.current?.close()}>
            關閉
          </button>
        </div>
    </dialog>
  )
}

function ImportPreview({
  preview,
  kindLabels,
  look,
  busy,
  onRestart,
  onExecute,
}: {
  preview: GroupImportPreview
  kindLabels: Record<GroupImportKind, string>
  look: GroupImportLook
  busy: string | null
  onRestart: () => void
  onExecute: () => void
}) {
  const { counts } = preview
  const doable = counts.create + counts.add
  const kinds = Object.keys(kindLabels) as GroupImportKind[]
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground">預覽・{preview.fileName}</h3>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {kinds.map((kind) => (
          <div key={kind} className={join('rounded-lg border px-3 py-2', kind === 'invalid' && counts[kind] > 0 ? 'border-danger bg-danger-subtle' : 'border-border')}>
            <dt className="text-xs text-muted-foreground">{kindLabels[kind]}</dt>
            <dd data-testid={`group-import-count-${kind}`} className="text-lg font-extrabold text-foreground tabular-nums">
              {counts[kind]}
            </dd>
          </div>
        ))}
      </dl>

      <div className="overflow-x-auto rounded-card border border-border">
        <table className="w-full text-left text-sm" aria-label="預覽結果">
          <thead className="bg-muted text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">行</th>
              <th className="px-3 py-2 font-medium">學號</th>
              <th className="px-3 py-2 font-medium">姓名</th>
              <th className="px-3 py-2 font-medium">組別</th>
              <th className="px-3 py-2 font-medium">分類</th>
              <th className="px-3 py-2 font-medium">說明</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <tr key={row.line} data-testid={`group-import-row-${row.line}`} data-kind={row.kind} className="border-t border-border">
                <td className="px-3 py-2 tabular-nums">{row.line}</td>
                <td className="px-3 py-2 tabular-nums">{row.studentNo || '—'}</td>
                <td className="px-3 py-2">{row.studentName ?? '—'}</td>
                <td className="px-3 py-2 tabular-nums">{row.groupCode || '—'}</td>
                <td className={join('px-3 py-2 whitespace-nowrap', SKIP_KINDS.includes(row.kind) && 'font-semibold text-danger')}>
                  {kindLabels[row.kind]}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{row.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-sm text-muted-foreground">
        執行時只做「{kindLabels.create}」「{kindLabels.add}」的 {doable} 列，其他列跳過、原因寫在結果表；每列各自處理，一列失敗不影響別列。
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={look.secondary} onClick={onRestart} disabled={Boolean(busy)}>
          重新選檔
        </button>
        <button type="button" className={look.primary} onClick={onExecute} disabled={Boolean(busy)}>
          {busy ?? '執行'}
        </button>
      </div>
    </div>
  )
}

function ResultTable({ receipt, outcomeLabels }: { receipt: GroupImportReceipt; outcomeLabels: Record<GroupImportOutcome, string> }) {
  return (
    <ul aria-label="逐列結果" className="divide-y divide-border rounded-card border border-border text-sm">
      {receipt.results.map((r) => (
        <li key={r.line} data-testid={`group-import-result-${r.line}`} className="flex flex-wrap gap-x-3 px-3 py-2">
          <span className="tabular-nums text-muted-foreground">第 {r.line} 行</span>
          <span className="tabular-nums text-foreground">{r.studentNo}</span>
          <span className="font-semibold tabular-nums text-foreground">{r.groupCode}</span>
          <span className={join(r.outcome === 'failed' || r.outcome === 'skipped' ? 'text-danger' : 'text-foreground')}>{outcomeLabels[r.outcome]}</span>
          <span className="text-muted-foreground">{r.message}</span>
        </li>
      ))}
    </ul>
  )
}

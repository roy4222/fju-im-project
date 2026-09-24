'use client'
import { useRef, useState, useTransition } from 'react'
import type { RosterImportReceipt, RosterPreview } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { importRosterAction, previewRosterAction, startRosterUploadAction } from './actions'

/**
 * 「匯入名單 CSV」三步：選檔 → 預覽 → 已匯入（原型 `/dashboard/admin/accounts` 的 ImportRosterDialog）。
 *
 * 檔案位元組直接 POST 到 `/api/files/upload`（串流、不經 Server Action）；
 * 預覽與匯入都由伺服器重新讀那份已存的原檔，這裡只顯示伺服器回來的結果、不自己判任何規則。
 */

type Step =
  | { kind: 'choose' }
  | { kind: 'preview'; preview: RosterPreview; requestId: string }
  | { kind: 'done'; receipt: RosterImportReceipt }

const BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50'
const PRIMARY = 'bg-primary text-primary-foreground hover:bg-primary/90'
const SECONDARY = 'bg-muted text-foreground hover:bg-border'

function newRequestId(): string {
  return crypto.randomUUID()
}

export function ImportRosterDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  function open() {
    setStep({ kind: 'choose' })
    setError(null)
    setBusy(null)
    dialogRef.current?.showModal()
  }

  function close() {
    dialogRef.current?.close()
  }

  async function onFile(file: File | undefined) {
    if (!file) return
    setError(null)
    setBusy('上傳中…')
    try {
      const ticket = await startRosterUploadAction({
        fileName: file.name,
        declaredMime: file.type,
        declaredSize: file.size,
      })
      if (!ticket.ok) {
        setError(ticket.message)
        return
      }

      const response = await fetch(`/api/files/upload?ticket=${encodeURIComponent(ticket.data.ticket)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      const uploaded = (await response.json().catch(() => null)) as
        | { ok: true; fileId: string }
        | { ok: false; message: string }
        | null
      if (!uploaded || !uploaded.ok) {
        setError(uploaded?.message ?? '上傳失敗，請重新選擇檔案。')
        return
      }

      setBusy('分析名單中…')
      const preview = await previewRosterAction({ fileId: uploaded.fileId, cohortId: null })
      if (!preview.ok) {
        setError(preview.message)
        return
      }
      setStep({ kind: 'preview', preview: preview.data, requestId: newRequestId() })
    } catch {
      setError('連線中斷，請重新選擇檔案。')
    } finally {
      setBusy(null)
    }
  }

  async function changeCohort(current: Extract<Step, { kind: 'preview' }>, cohortId: string) {
    setError(null)
    setBusy('重新比對屆別中…')
    // 選單先顯示剛選的屆別，數字等伺服器重新比對回來再更新（比對期間「匯入」按鈕是停用的）。
    setStep({ ...current, preview: { ...current.preview, selectedCohortId: cohortId } })
    try {
      const preview = await previewRosterAction({ fileId: current.preview.fileId, cohortId })
      if (!preview.ok) setError(preview.message)
      // 換了屆別就是另一個匯入請求，換一個 requestId。
      else setStep({ kind: 'preview', preview: preview.data, requestId: newRequestId() })
    } catch {
      setError('連線中斷，請再選一次屆別。')
    } finally {
      setBusy(null)
    }
  }

  async function confirm(current: Extract<Step, { kind: 'preview' }>) {
    const cohortId = current.preview.selectedCohortId
    if (!cohortId) {
      setError('請先選擇要匯入到哪一屆。')
      return
    }
    setError(null)
    setBusy('匯入中…')
    try {
      // 同一個 requestId 重送只會匯入一次（帳本），所以連點或斷線重試都安全。
      const result = await importRosterAction({ fileId: current.preview.fileId, cohortId, requestId: current.requestId })
      if (!result.ok) setError(result.message)
      else startTransition(() => setStep({ kind: 'done', receipt: result.data }))
    } catch {
      setError('結果未知：可能已經匯入。請再按一次「匯入」確認（不會重複匯入），或關閉後看名單版本列表。')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <button type="button" onClick={open} className={cn(BUTTON, SECONDARY)}>
        匯入名單 CSV
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="import-roster-title"
        className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40"
      >
        <div className="max-h-[85vh] overflow-y-auto p-5">
          {step.kind === 'choose' ? (
            <ChooseStep busy={busy} onFile={onFile} />
          ) : step.kind === 'preview' ? (
            <PreviewStep
              step={step}
              busy={busy}
              onCohort={(cohortId) => changeCohort(step, cohortId)}
              onRestart={() => {
                setError(null)
                setStep({ kind: 'choose' })
              }}
              onConfirm={() => confirm(step)}
            />
          ) : (
            <DoneStep receipt={step.receipt} />
          )}

          {error ? (
            <p role="alert" className="mt-4 rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end border-t border-border p-4">
          <button type="button" onClick={close} className={cn(BUTTON, SECONDARY)}>
            關閉
          </button>
        </div>
      </dialog>
    </>
  )
}

function ChooseStep({ busy, onFile }: { busy: string | null; onFile: (file: File | undefined) => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 id="import-roster-title" className="text-base font-semibold text-ink">
          匯入本屆名單
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          UTF-8 CSV，欄位固定 <code className="rounded bg-muted px-1">student_no,name,cohort,email</code>
          ，可多一欄 <code className="rounded bg-muted px-1">department_class</code>（系級）。
        </p>
      </div>
      <label
        className={cn(
          'flex cursor-pointer flex-col items-center gap-2 rounded-card border border-dashed border-border px-4 py-8 text-sm transition-colors hover:border-primary hover:bg-primary-subtle/40',
          busy && 'pointer-events-none opacity-60',
        )}
      >
        <span className="font-medium text-ink">{busy ?? '選擇 CSV 檔'}</span>
        <span className="text-xs text-muted-foreground">上限 2 MiB；先看預覽，確認後才匯入</span>
        <input
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          aria-label="選擇名單 CSV 檔"
          disabled={Boolean(busy)}
          onChange={(event) => {
            onFile(event.currentTarget.files?.[0])
            event.currentTarget.value = ''
          }}
        />
      </label>
    </div>
  )
}

function PreviewStep({
  step,
  busy,
  onCohort,
  onRestart,
  onConfirm,
}: {
  step: Extract<Step, { kind: 'preview' }>
  busy: string | null
  onCohort: (cohortId: string) => void
  onRestart: () => void
  onConfirm: () => void
}) {
  const { preview } = step
  const { counts } = preview
  // 屆別欄裡跟所選屆別不同的值（對不到既有屆別的，或是另一屆的），按值彙總。
  const differing = preview.cohortValues.filter(
    (v) => v.cohortId === null || (preview.selectedCohortId !== null && v.cohortId !== preview.selectedCohortId),
  )
  const tiles: [string, number, string][] = [
    ['總筆數', counts.total, 'text-ink'],
    ['有效', counts.valid, 'text-ink'],
    ['重複', counts.duplicate, counts.duplicate ? 'text-primary-on-subtle' : 'text-ink'],
    ['缺欄', counts.missing, counts.missing ? 'text-danger-on-subtle' : 'text-ink'],
    ['衝突', counts.conflict, counts.conflict ? 'text-danger-on-subtle' : 'text-ink'],
  ]

  return (
    <div className="space-y-4">
      <div>
        <h2 id="import-roster-title" className="text-base font-semibold text-ink">
          預覽・{preview.fileName}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">確認後才匯入。名單只協助審核比對，不會自動核准任何人。</p>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-center sm:grid-cols-5" aria-label="預覽摘要">
        {tiles.map(([label, value, tone]) => (
          <div key={label} className="rounded-card bg-muted px-2 py-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className={cn('text-2xl font-semibold tabular-nums', tone)} data-testid={`roster-count-${label}`}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <div>
        <label htmlFor="roster-cohort" className="block text-sm font-medium text-ink">
          匯入到哪一屆
        </label>
        {preview.cohorts.length === 0 ? (
          <p className="mt-1 text-sm text-danger-on-subtle">
            還沒有任何屆別。請先到
            <a href="/dashboard/admin/cohorts" className="mx-1 underline">
              屆別
            </a>
            建立，再回來匯入。
          </p>
        ) : (
          <select
            id="roster-cohort"
            value={preview.selectedCohortId ?? ''}
            disabled={Boolean(busy)}
            onChange={(event) => event.currentTarget.value && onCohort(event.currentTarget.value)}
            className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
          >
            <option value="" disabled>
              請選擇屆別
            </option>
            {preview.cohorts.map((cohort) => (
              <option key={cohort.id} value={cohort.id}>
                {cohort.name}（{cohort.code}）{cohort.isRegistrationOpen ? '・開放註冊中' : ''}
              </option>
            ))}
          </select>
        )}
        {differing.length > 0 ? (
          <p className="mt-1 text-xs text-primary-on-subtle" role="status">
            CSV 屆別欄：
            {differing
              .map((v) => `「${v.value}」${v.rows} 列${v.cohortId === null ? '對不到既有屆別' : '是另一屆'}`)
              .join('；')}
            。都會匯入到{preview.selectedCohortId ? '你選的屆別' : '下面選的屆別'}。
          </p>
        ) : null}
        {!preview.columns.cohort ? (
          <p className="mt-1 text-xs text-muted-foreground">CSV 沒有屆別欄，請選要匯入的屆別。</p>
        ) : null}
      </div>

      {preview.issues.length > 0 ? (
        <div>
          <h3 className="text-sm font-medium text-ink">需要注意的列</h3>
          <ul className="mt-1 max-h-48 overflow-y-auto rounded-card border border-border text-xs" aria-label="需要注意的列">
            {preview.issues.map((issue, index) => (
              <li key={`${issue.line}-${issue.kind}-${index}`} className="flex justify-between gap-3 border-b border-border px-3 py-1.5 last:border-b-0">
                <span>
                  第 {issue.line} 行{issue.studentNo ? ` ${issue.studentNo}` : ''}：{issue.message}
                </span>
                <span className={issue.action === 'skipped' ? 'shrink-0 text-danger-on-subtle' : 'shrink-0 text-primary-on-subtle'}>
                  {issue.action === 'skipped' ? '略過' : '提醒'}
                </span>
              </li>
            ))}
          </ul>
          {preview.issuesTruncated ? <p className="mt-1 text-xs text-muted-foreground">只列前 200 筆。</p> : null}
        </div>
      ) : null}

      {preview.sample.length > 0 ? (
        <div className="overflow-x-auto rounded-card border border-border">
          <table className="w-full min-w-[28rem] text-xs">
            <caption className="sr-only">前幾筆有效名單</caption>
            <thead className="bg-muted text-left text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-medium">學號</th>
                <th scope="col" className="px-3 py-1.5 font-medium">姓名</th>
                <th scope="col" className="px-3 py-1.5 font-medium">系級</th>
                <th scope="col" className="px-3 py-1.5 font-medium">Email</th>
              </tr>
            </thead>
            <tbody>
              {preview.sample.slice(0, 5).map((row) => (
                <tr key={row.line} className="border-t border-border">
                  <td className="px-3 py-1.5 tabular-nums">{row.studentNo}</td>
                  <td className="px-3 py-1.5">{row.nameRaw}</td>
                  <td className="px-3 py-1.5">{row.departmentClass ?? '—'}</td>
                  <td className="px-3 py-1.5">{row.email ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onRestart} disabled={Boolean(busy)} className={cn(BUTTON, SECONDARY)}>
          重新選檔
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={Boolean(busy) || counts.valid === 0 || !preview.selectedCohortId}
          className={cn(BUTTON, PRIMARY)}
        >
          {busy ?? `匯入 ${counts.valid} 筆`}
        </button>
      </div>
    </div>
  )
}

function DoneStep({ receipt }: { receipt: RosterImportReceipt }) {
  return (
    <div className="flex flex-col items-center gap-3 py-3 text-center" role="status">
      <span className="inline-flex -rotate-2 items-center rounded-md border-2 border-primary px-3 py-1 text-sm font-bold tracking-widest text-primary-on-subtle">
        已匯入
      </span>
      <h2 id="import-roster-title" className="text-base font-semibold text-ink">
        {receipt.cohortName}・{receipt.counts.valid} 筆名單
      </h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        已建立一個名單版本，原檔可以在版本列表下載。之後的註冊申請會拿這份名單比對，仍要系辦核實本人才核准。
      </p>
    </div>
  )
}

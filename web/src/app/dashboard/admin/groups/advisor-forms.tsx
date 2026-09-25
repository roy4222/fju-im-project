'use client'
import { startTransition, useActionState, useRef, useState, type FormEvent } from 'react'
import type {
  AdvisorBatchKind,
  AdvisorBatchOutcome as BatchRowOutcome,
  AdvisorBatchPreview,
  AdvisorBatchReceipt,
  GradingAssignmentSummary,
  TeacherOption,
} from '@/application/groups'
import { cn } from '@/shared/cn'
import {
  assignAdvisorAction,
  executeAdvisorBatchAction,
  previewAdvisorBatchAction,
  startAdvisorUploadAction,
  unassignAdvisorAction,
} from './actions'
import { DIALOG, Feedback, INPUT, LABEL, PRIMARY, SECONDARY, useCloseOnSuccess, useDialog } from './admin-group-forms'
import { IconUserPlus } from '@tabler/icons-react'
import { BTN_ROW as ROW, BTN_ROW_GHOST as ROW_GHOST } from '@/app/_ui/dashboard/look'

/**
 * 票 19：管理員指派、重派、解除指導老師（原型 `AssignDialog`），以及批次指派 CSV（原型沒有，模組實作設計 03 §7.2 缺口）。
 *
 * 規則都在用例裡判；這裡只顯示伺服器回來的預覽與回饋。重派對話框先列原老師在本組的評分指派
 * （票 23 接上真的查詢：階段與未填／暫存／已正式送出）——只列、不移轉：原型寫的「評分與簽核指派會一併移轉」
 * 是舊文案，正式版新主指導不自動取得評分權限；要移除或改派評分老師（保留／替換／新增三選一）在票 24。
 */

/** 批次指派 Server Action 的回傳（型別放這裡：`actions.ts` 只能匯出 async 函式）。 */
export type BatchActionOutcome<T> = { ok: true; data: T } | { ok: false; message: string }

export type AdvisorGroup = {
  id: string
  code: string
  revision: number
  typeLabel: string
  advisor: { userId: string; name: string } | null
}

function TeacherSelect({ id, teachers, exclude }: { id: string; teachers: TeacherOption[]; exclude: string | null }) {
  const [value, setValue] = useState('')
  const options = teachers.filter((t) => t.userId !== exclude)
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        指導老師
      </label>
      <select id={id} name="teacherUserId" value={value} onChange={(e) => setValue(e.target.value)} className={INPUT}>
        <option value="" disabled>
          請選一位老師
        </option>
        {options.map((t) => (
          <option key={t.userId} value={t.userId}>
            {t.name}（{t.loginEmail}）
          </option>
        ))}
      </select>
    </div>
  )
}

/** 理由欄：受控（伺服器拒絕時已經打好的字不能不見，同票 14）。 */
function Reason({ id, maxLength, placeholder }: { id: string; maxLength: number; placeholder: string }) {
  const [value, setValue] = useState('')
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        理由（必填）
      </label>
      <textarea
        id={id}
        name="reason"
        rows={3}
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={INPUT}
      />
    </div>
  )
}

/**
 * 送出但不讓 React 在 action 回來後重設表單：被伺服器拒絕（例如忘了填理由）時，已經選好的老師不能被洗掉
 * （React 19 的表單重設會把受控的 `<select>` 也還原成第一個選項）。
 */
function submitWithoutReset(action: (formData: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    startTransition(() => action(formData))
  }
}

const GRADING_STATE_LABEL: Record<GradingAssignmentSummary['state'], string> = {
  empty: '未填',
  draft: '暫存',
  submitted: '已正式送出',
}

/**
 * 分組總覽每一組的「指導老師」格：老師名字（或尚未指派）＋「指派老師」或「重派」「解除」。
 * 回饋放在格子裡（對話框關掉後還看得到），和作廢提案同一個做法。
 */
export function AdvisorCell({
  group,
  teachers,
  grading,
  requestIds,
  reasonMaxLength,
}: {
  group: AdvisorGroup
  teachers: TeacherOption[]
  /** 目前主指導在本組的評分指派（重派對話框要先列）。 */
  grading: readonly GradingAssignmentSummary[]
  requestIds: { assign: string; unassign: string }
  reasonMaxLength: number
}) {
  const [assignState, assignAction, assigning] = useActionState(assignAdvisorAction, undefined)
  const [unassignState, unassignAction, unassigning] = useActionState(unassignAdvisorAction, undefined)
  const assignDialog = useDialog()
  const unassignDialog = useDialog()
  useCloseOnSuccess(assignState, assignDialog.close)
  useCloseOnSuccess(unassignState, unassignDialog.close)
  const current = group.advisor
  const verb = current ? '重派' : '指派'
  const done = assignState?.ok ? assignState : unassignState?.ok ? unassignState : undefined

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {current ? (
          <span className="text-sm text-foreground">{current.name}</span>
        ) : (
          <span className="text-sm font-semibold text-destructive">尚未指派</span>
        )}
        <button type="button" className={current ? ROW_GHOST : ROW} aria-label={`${verb}指導老師：${group.code}`} onClick={assignDialog.open}>
          <IconUserPlus aria-hidden />
          {current ? '重派' : '指派老師'}
        </button>
        {current ? (
          <button type="button" className={ROW_GHOST} aria-label={`解除指導老師：${group.code}`} onClick={unassignDialog.open}>
            解除
          </button>
        ) : null}
      </div>
      <Feedback state={done} />

      <dialog ref={assignDialog.ref} aria-label={`${verb} ${group.code} 的指導老師`} className={DIALOG}>
        <form key={group.revision} onSubmit={submitWithoutReset(assignAction)} className="space-y-4 p-5">
          <div>
            <p className="text-xs font-semibold text-primary">{group.typeLabel}</p>
            <h2 className="text-lg font-extrabold text-foreground">
              {verb} {group.code} 的指導老師
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {current
                ? `目前：${current.name}。重派後全組、新老師與原老師都會收到通知；歷史保留。`
                : '一般組依抽籤或行政結果指派；產學組老師也可以自己認領。指派後全組與老師會收到通知。'}
            </p>
          </div>
          <input type="hidden" name="groupId" value={group.id} />
          <input type="hidden" name="revision" value={group.revision} />
          <input type="hidden" name="requestId" value={requestIds.assign} />
          {current ? (
            <section aria-label="原老師在本組的評分指派" className="space-y-1 rounded-lg border border-border px-3 py-2">
              <h3 className="text-sm font-semibold text-foreground">{current.name} 在本組的評分指派</h3>
              {grading.length > 0 ? (
                <ul data-testid="grading-assignments" className="space-y-1 text-sm">
                  {grading.map((g) => (
                    <li key={g.id} className="flex items-center justify-between gap-2">
                      <span className="text-foreground">{g.stageName}</span>
                      <span className="text-muted-foreground">{GRADING_STATE_LABEL[g.state]}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p data-testid="grading-assignments-empty" className="text-sm text-muted-foreground">
                  目前沒有評分指派。
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                重派只換指導老師：評分指派維持原老師，新老師不會自動取得評分權限。要調整評分老師請到「評分」頁。
              </p>
            </section>
          ) : null}
          <TeacherSelect id={`advisor-teacher-${group.id}`} teachers={teachers} exclude={current?.userId ?? null} />
          <Reason
            id={`advisor-reason-${group.id}`}
            maxLength={reasonMaxLength}
            placeholder={current ? '例：原指導老師休假，改由其他老師指導' : '例：115 學年抽籤結果'}
          />
          <Feedback state={assignState?.ok ? undefined : assignState} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={assignDialog.close}>
              先不要
            </button>
            <button type="submit" disabled={assigning} className={PRIMARY}>
              {assigning ? '處理中…' : `確認${verb}`}
            </button>
          </div>
        </form>
      </dialog>

      {current ? (
        <dialog ref={unassignDialog.ref} aria-label={`解除 ${group.code} 的指導老師？`} className={DIALOG}>
          <form key={group.revision} onSubmit={submitWithoutReset(unassignAction)} className="space-y-4 p-5">
            <h2 className="text-lg font-extrabold text-foreground">解除 {group.code} 的指導老師？</h2>
            <p className="text-sm text-muted-foreground">
              解除 {current.name} 之後，這組會變成「尚未指派」；全組與 {current.name} 會收到通知，理由只留在系辦紀錄。
            </p>
            <input type="hidden" name="groupId" value={group.id} />
            <input type="hidden" name="revision" value={group.revision} />
            <input type="hidden" name="requestId" value={requestIds.unassign} />
            <Reason id={`advisor-unassign-reason-${group.id}`} maxLength={reasonMaxLength} placeholder="例：抽籤結果更正" />
            <Feedback state={unassignState?.ok ? undefined : unassignState} />
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <button type="button" className={SECONDARY} onClick={unassignDialog.close}>
                先不要
              </button>
              <button type="submit" disabled={unassigning} className={PRIMARY}>
                {unassigning ? '處理中…' : '確定解除'}
              </button>
            </div>
          </form>
        </dialog>
      ) : null}
    </div>
  )
}

// ── 批次指派 CSV ─────────────────────────────────────────────────────────────

type Step =
  | { kind: 'choose' }
  | { kind: 'preview'; preview: AdvisorBatchPreview; requestId: string }
  | { kind: 'done'; receipt: AdvisorBatchReceipt; message: string }

const ERROR_KINDS: readonly AdvisorBatchKind[] = ['group_missing', 'teacher_missing', 'duplicate']

/**
 * 「批次指派（CSV）」：選檔 → 六類預覽 → 逐列執行的結果。屆別就是頁面上方選的那一屆。
 * 檔案位元組直接 POST 到 `/api/files/upload`（和名單匯入同一條路）；預覽與執行都由伺服器重新讀那份原檔。
 */
export function BatchAssignDialog({
  cohortId,
  cohortCode,
  kindLabels,
  outcomeLabels,
  maxBytes,
  reasonMaxLength,
}: {
  cohortId: string
  cohortCode: string
  kindLabels: Record<AdvisorBatchKind, string>
  outcomeLabels: Record<BatchRowOutcome, string>
  maxBytes: number
  reasonMaxLength: number
}) {
  const dialog = useDialog()
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [confirmReassign, setConfirmReassign] = useState(false)
  const inFlight = useRef(false)

  function open() {
    setStep({ kind: 'choose' })
    setError(null)
    setBusy(null)
    setReason('')
    setConfirmReassign(false)
    dialog.open()
  }

  async function onFile(file: File | undefined) {
    if (!file) return
    setError(null)
    setBusy('上傳中…')
    try {
      const ticket = await startAdvisorUploadAction({ fileName: file.name, declaredMime: file.type, declaredSize: file.size })
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
      const preview = await previewAdvisorBatchAction({ fileId: uploaded.fileId, cohortId })
      if (!preview.ok) {
        setError(preview.message)
        return
      }
      setConfirmReassign(false)
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
      const revisions: Record<string, number> = {}
      for (const row of current.preview.rows) {
        if (row.groupId && row.groupRevision !== null) revisions[row.groupId] = row.groupRevision
      }
      // 同一個 requestId 重送只會做一次（每一列由它推出自己的請求編號），連點或斷線重試都安全。
      const result = await executeAdvisorBatchAction({
        fileId: current.preview.fileId,
        cohortId,
        reason,
        confirmReassign,
        revisions,
        requestId: current.requestId,
      })
      if (!result.ok) setError(result.message)
      else setStep({ kind: 'done', receipt: result.data.receipt, message: result.data.message })
    } catch {
      setError('結果未知：可能已經執行。請再按一次「確認執行」（不會重複指派或通知），或關閉後看組別列表。')
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  return (
    <>
      <button type="button" className={SECONDARY} onClick={open}>
        批次指派（CSV）
      </button>
      <dialog ref={dialog.ref} aria-label="批次指派指導老師" className={cn(DIALOG, 'w-[min(48rem,calc(100vw-2rem))]')}>
        <div className="max-h-[85vh] space-y-4 overflow-y-auto p-5">
          <div>
            <h2 className="text-lg font-extrabold text-foreground">批次指派指導老師・{cohortCode}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              UTF-8 CSV，欄位固定 <code className="rounded bg-muted px-1">group_code,teacher_login_email</code>
              ；老師用<strong>登入 Email</strong>，不能用聯絡 Email。要換屆別請先在頁面上方切換。
            </p>
          </div>

          {step.kind === 'choose' ? (
            <label
              className={cn(
                'flex cursor-pointer flex-col items-center gap-2 rounded-card border border-dashed border-border px-4 py-8 text-sm transition-colors hover:border-primary hover:bg-primary-subtle/40',
                busy && 'pointer-events-none opacity-60',
              )}
            >
              <span className="font-medium text-foreground">{busy ?? '選擇 CSV 檔'}</span>
              <span className="text-xs text-muted-foreground">
                上限 {Math.round(maxBytes / 1024)} KiB；先看預覽，確認後才逐列執行
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-label="選擇批次指派 CSV 檔"
                disabled={Boolean(busy)}
                onChange={(event) => {
                  onFile(event.currentTarget.files?.[0])
                  event.currentTarget.value = ''
                }}
              />
            </label>
          ) : step.kind === 'preview' ? (
            <BatchPreview
              step={step}
              kindLabels={kindLabels}
              reason={reason}
              onReason={setReason}
              reasonMaxLength={reasonMaxLength}
              confirmReassign={confirmReassign}
              onConfirmReassign={setConfirmReassign}
              busy={busy}
              onRestart={() => {
                setError(null)
                setStep({ kind: 'choose' })
              }}
              onExecute={() => execute(step)}
            />
          ) : (
            <BatchDone receipt={step.receipt} message={step.message} outcomeLabels={outcomeLabels} />
          )}

          {error ? (
            <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end border-t border-border p-4">
          <button type="button" className={SECONDARY} onClick={dialog.close}>
            關閉
          </button>
        </div>
      </dialog>
    </>
  )
}

function BatchPreview({
  step,
  kindLabels,
  reason,
  onReason,
  reasonMaxLength,
  confirmReassign,
  onConfirmReassign,
  busy,
  onRestart,
  onExecute,
}: {
  step: Extract<Step, { kind: 'preview' }>
  kindLabels: Record<AdvisorBatchKind, string>
  reason: string
  onReason: (value: string) => void
  reasonMaxLength: number
  confirmReassign: boolean
  onConfirmReassign: (value: boolean) => void
  busy: string | null
  onRestart: () => void
  onExecute: () => void
}) {
  const { preview } = step
  const { counts } = preview
  const errors = counts.group_missing + counts.teacher_missing + counts.duplicate
  const changes = counts.new + counts.reassign
  const blocked =
    errors > 0 || changes === 0 || (counts.reassign > 0 && !confirmReassign) || reason.trim() === '' || Boolean(busy)
  const kinds = Object.keys(kindLabels) as AdvisorBatchKind[]

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground">預覽・{preview.fileName}</h3>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {kinds.map((kind) => (
          <div
            key={kind}
            className={cn(
              'rounded-lg border px-3 py-2',
              ERROR_KINDS.includes(kind) && counts[kind] > 0 ? 'border-danger bg-danger-subtle' : 'border-border',
            )}
          >
            <dt className="text-xs text-muted-foreground">{kindLabels[kind]}</dt>
            <dd data-testid={`advisor-batch-count-${kind}`} className="text-lg font-extrabold text-foreground tabular-nums">
              {counts[kind]}
            </dd>
          </div>
        ))}
      </dl>

      <div className="overflow-x-auto rounded-card border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">行</th>
              <th className="px-3 py-2 font-medium">組別</th>
              <th className="px-3 py-2 font-medium">老師登入 Email</th>
              <th className="px-3 py-2 font-medium">分類</th>
              <th className="px-3 py-2 font-medium">說明</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <tr key={row.line} data-testid={`advisor-batch-row-${row.line}`} className="border-t border-border">
                <td className="px-3 py-2 tabular-nums">{row.line}</td>
                <td className="px-3 py-2 tabular-nums">{row.groupCode || '—'}</td>
                <td className="px-3 py-2">{row.teacherEmail || '—'}</td>
                <td className={cn('px-3 py-2 whitespace-nowrap', ERROR_KINDS.includes(row.kind) && 'font-semibold text-danger')}>
                  {kindLabels[row.kind]}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{row.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {errors > 0 ? (
        <p className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
          有 {errors} 列錯誤：請修正檔案後重新上傳，錯誤都修好才能執行。
        </p>
      ) : null}
      {counts.reassign > 0 ? (
        <label className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={confirmReassign}
            onChange={(e) => onConfirmReassign(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            確認重派 {counts.reassign} 組：原老師會收到通知；他們在本組的評分指派不會一併移轉，新老師不會自動取得評分權限。
          </span>
        </label>
      ) : null}
      <div>
        <label htmlFor="advisor-batch-reason" className={LABEL}>
          理由（必填，整批共用）
        </label>
        <textarea
          id="advisor-batch-reason"
          rows={2}
          maxLength={reasonMaxLength}
          placeholder="例：115 學年抽籤結果"
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          className={INPUT}
        />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={SECONDARY} onClick={onRestart} disabled={Boolean(busy)}>
          重新選檔
        </button>
        <button type="button" className={PRIMARY} onClick={onExecute} disabled={blocked}>
          {busy ?? `確認執行（${changes} 組）`}
        </button>
      </div>
    </div>
  )
}

function BatchDone({
  receipt,
  message,
  outcomeLabels,
}: {
  receipt: AdvisorBatchReceipt
  message: string
  outcomeLabels: Record<BatchRowOutcome, string>
}) {
  return (
    <div className="space-y-3">
      <p role="status" className="rounded-lg bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
        {message}
      </p>
      <ul aria-label="逐列結果" className="divide-y divide-border rounded-card border border-border text-sm">
        {receipt.results.map((r) => (
          <li key={r.line} data-testid={`advisor-batch-result-${r.line}`} className="flex flex-wrap gap-x-3 px-3 py-2">
            <span className="tabular-nums text-muted-foreground">第 {r.line} 行</span>
            <span className="font-semibold tabular-nums text-foreground">{r.groupCode}</span>
            <span className={cn(r.outcome === 'conflict' || r.outcome === 'failed' ? 'text-danger' : 'text-foreground')}>
              {outcomeLabels[r.outcome]}
            </span>
            <span className="text-muted-foreground">{r.message}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

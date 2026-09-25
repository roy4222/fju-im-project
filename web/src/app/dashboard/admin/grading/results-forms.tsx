'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useActionState, useState } from 'react'
import {
  applySchemeAction,
  overrideAction,
  removeAssignmentAction,
  resolveReviewAction,
  returnEvaluationAction,
} from './actions'
import { DIALOG, Feedback, INPUT, LABEL, PRIMARY, SECONDARY, useCloseOnSuccess, useDialog } from '@/app/dashboard/admin/groups/admin-group-forms'
import type { ReassignmentPreview, RemovalChoice } from '@/application/grading'
import { cn } from '@/shared/cn'

/**
 * 管理員「評分」票 24 的會動部分：退回、更正、復核、改派三選一、套用新方案版本、成績匯出。
 * 規則全在用例裡判（理由必填、最終未完成、預覽過期、重複指派…）；畫面只收表單、顯示伺服器回來的句子。
 * 預覽過期（`CONFLICT`）時提供「重新預覽」：重新整理頁面拿新的 basis_hash／token。
 */

/** 失敗時多帶錯誤碼：遇到 `CONFLICT`（預覽過期）才知道要請使用者重新預覽。 */
export type ResultsActionState = { ok: boolean; message: string; code?: string } | undefined

const TEXTAREA = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm'

function StaleHint({ state, label = '重新預覽' }: { state: ResultsActionState; label?: string }) {
  const router = useRouter()
  if (state?.ok !== false || state.code !== 'CONFLICT') return null
  return (
    <button type="button" className={SECONDARY} onClick={() => router.refresh()}>
      {label}
    </button>
  )
}

/** 退回某位老師的正式評分（理由必填，老師收到通知）。 */
export function ReturnForm({
  groupId,
  evaluationId,
  teacherName,
  stageName,
  requestId,
}: {
  groupId: string
  evaluationId: string
  teacherName: string
  stageName: string
  requestId: string
}) {
  const [state, action, pending] = useActionState(returnEvaluationAction, undefined)
  const dialog = useDialog()
  useCloseOnSuccess(state, dialog.close)
  return (
    <div className="space-y-1">
      <button type="button" className={SECONDARY} onClick={dialog.open} aria-label={`退回 ${teacherName} 老師的「${stageName}」評分`}>
        退回
      </button>
      <Feedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label="退回評分" className={DIALOG}>
        <form action={action} className="space-y-4 p-5">
          <div>
            <h2 className="text-base font-semibold text-ink">退回 {teacherName} 老師的「{stageName}」評分</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              只退回這一份。老師會收到通知與理由，修改後重新正式送出；重送前這一份不算完成，舊紀錄保留。
            </p>
          </div>
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="evaluationId" value={evaluationId} />
          <input type="hidden" name="requestId" value={requestId} />
          <label className={LABEL}>
            退回理由（老師看得到）
            <textarea name="reason" required maxLength={500} rows={3} className={TEXTAREA} />
          </label>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending ? '處理中…' : '確認退回'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}

/** 更正最終結果：原值保留、理由必填；老師原始輸入不動。 */
export function OverrideForm({
  groupId,
  groupCode,
  computed,
  basisHash,
  requestId,
  disabledReason,
}: {
  groupId: string
  groupCode: string
  computed: string | null
  basisHash: string
  requestId: string
  disabledReason: string | null
}) {
  const [state, action, pending] = useActionState(overrideAction, undefined)
  const dialog = useDialog()
  useCloseOnSuccess(state, dialog.close)
  return (
    <div className="space-y-1">
      <button type="button" className={SECONDARY} onClick={dialog.open} disabled={disabledReason !== null} title={disabledReason ?? undefined}>
        更正最終成績
      </button>
      {disabledReason ? <p className="text-xs text-muted-foreground">{disabledReason}</p> : null}
      <Feedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label="更正最終成績" className={DIALOG}>
        <form action={action} className="space-y-4 p-5">
          <div>
            <h2 className="text-base font-semibold text-ink">更正 {groupCode} 的最終成績</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              算出來的最終成績是 <b className="tabular-nums text-ink">{computed ?? '—'}</b>。更正值另存一筆（原值、理由、操作者、時間、方案版本），
              老師的原始輸入不會被改；之後採計分數或方案改變，這筆更正會進「待復核」。
            </p>
          </div>
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="basisHash" value={basisHash} />
          <input type="hidden" name="requestId" value={requestId} />
          <label className={LABEL}>
            更正後的最終成績（0–100，最多兩位小數）
            <input name="newValue" required inputMode="decimal" className={INPUT} />
          </label>
          <label className={LABEL}>
            更正理由
            <textarea name="reason" required maxLength={500} rows={3} className={TEXTAREA} />
          </label>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <StaleHint state={state} label="重新整理看最新成績" />
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending ? '處理中…' : '確認更正'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}

/** 待復核的更正：沿用原更正值，或改成新的更正值（兩種都留一筆新版本）。 */
export function ResolveReviewForm({
  groupId,
  overrideId,
  previousValue,
  computed,
  basisHash,
  requestId,
  disabledReason,
}: {
  groupId: string
  overrideId: string
  previousValue: string
  computed: string | null
  basisHash: string
  requestId: string
  disabledReason: string | null
}) {
  const [state, action, pending] = useActionState(resolveReviewAction, undefined)
  const [decision, setDecision] = useState<'keep' | 'new'>('keep')
  return (
    <form action={action} className="space-y-3 rounded-md border border-border p-4" aria-label="復核更正">
      <p className="text-sm text-ink">
        計算基礎改變後，新的計算結果是 <b className="tabular-nums">{computed ?? '尚未完成'}</b>；原更正值 <b className="tabular-nums">{previousValue}</b>。
        確認之前，更正不套用在新的計算基礎上。
      </p>
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="overrideId" value={overrideId} />
      <input type="hidden" name="basisHash" value={basisHash} />
      <input type="hidden" name="requestId" value={requestId} />
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="sr-only">復核方式</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="decision" value="keep" checked={decision === 'keep'} onChange={() => setDecision('keep')} />
          沿用原更正值 {previousValue}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="decision" value="new" checked={decision === 'new'} onChange={() => setDecision('new')} />
          改成新的更正值
        </label>
      </fieldset>
      {decision === 'new' ? (
        <label className={LABEL}>
          新的更正值（0–100，最多兩位小數）
          <input name="newValue" required inputMode="decimal" className={INPUT} />
        </label>
      ) : null}
      <label className={LABEL}>
        復核說明
        <textarea name="reason" required maxLength={500} rows={2} className={TEXTAREA} />
      </label>
      <Feedback state={state} />
      <div className="flex flex-wrap gap-2">
        <StaleHint state={state} label="重新整理看最新成績" />
        <button type="submit" className={PRIMARY} disabled={pending || disabledReason !== null} title={disabledReason ?? undefined}>
          {pending ? '處理中…' : '確認復核'}
        </button>
      </div>
      {disabledReason ? <p className="text-xs text-muted-foreground">{disabledReason}</p> : null}
    </form>
  )
}

/** 移除／改派的三選一（預覽頁）。預覽過期回 CONFLICT：按「重新預覽」重新整理頁面拿新的 basis_hash。 */
export function ReassignForm({ preview, requestId }: { preview: ReassignmentPreview; requestId: string }) {
  const [state, action, pending] = useActionState(removeAssignmentAction, undefined)
  const firstAllowed = preview.options.find((o) => o.blockedReason === null)?.choice ?? 'replace'
  const [choice, setChoice] = useState<RemovalChoice>(firstAllowed)
  const done = state?.ok === true
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="groupId" value={preview.groupId} />
      <input type="hidden" name="assignmentId" value={preview.assignmentId} />
      <input type="hidden" name="basisHash" value={preview.basisHash} />
      <input type="hidden" name="requestId" value={requestId} />
      <fieldset className="grid gap-3 md:grid-cols-3" disabled={done}>
        <legend className="mb-2 text-sm font-medium text-ink">舊分數怎麼算（選一個）</legend>
        {preview.options.map((o) => (
          <label
            key={o.choice}
            data-testid={`choice-${o.choice}`}
            className={cn(
              'block cursor-pointer space-y-1 rounded-md border p-3 text-sm',
              choice === o.choice ? 'border-primary ring-1 ring-primary' : 'border-border',
              o.blockedReason ? 'cursor-not-allowed opacity-60' : '',
            )}
          >
            <span className="flex items-center gap-2 font-semibold text-ink">
              <input
                type="radio"
                name="choice"
                value={o.choice}
                checked={choice === o.choice}
                disabled={o.blockedReason !== null}
                onChange={() => setChoice(o.choice)}
              />
              {CHOICE_TITLE[o.choice]}
            </span>
            <span className="block text-xs text-muted-foreground">{CHOICE_HINT[o.choice]}</span>
            {o.blockedReason ? (
              <span className="block text-xs text-danger">{o.blockedReason}</span>
            ) : (
              <span className="block tabular-nums text-ink">
                之後：{o.countedAfter.map((c) => `${c.teacherName} ${c.display}`).join('、') || '沒有採計'}
                <br />
                份數 {o.countedAfter.length}／{o.requiredAfter ?? '未設定'}・平均 {o.averageAfter ?? '—'}・{o.stageStatusAfter}
                <br />
                最終 {o.finalAfter ?? '尚未完成'}
              </span>
            )}
          </label>
        ))}
      </fieldset>
      {choice !== 'keep' ? (
        <label className={LABEL}>
          {choice === 'add' ? '新增的評分老師（必選）' : '接手的評分老師（不選＝只移除，之後再指派）'}
          <select name="newTeacherUserId" defaultValue="" className={INPUT} disabled={done} required={choice === 'add'}>
            <option value="">{choice === 'add' ? '選老師…' : '先不指派'}</option>
            {preview.teachers.map((t) => (
              <option key={t.userId} value={t.userId}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className={LABEL}>
        理由（必填，留在指派紀錄裡）
        <textarea name="reason" required maxLength={500} rows={2} className={TEXTAREA} disabled={done} />
      </label>
      {preview.hasEffectiveOverride && choice !== 'keep' ? (
        <p className="text-sm text-danger">這一組有生效中的最終成績更正；這個選擇會改變計算基礎，那筆更正會進「待復核」。</p>
      ) : null}
      <Feedback state={state} />
      <div className="flex flex-wrap gap-2">
        {done ? (
          <Link href={`/dashboard/admin/grading/${preview.groupId}`} className={PRIMARY}>
            回 {preview.groupCode} 計算明細
          </Link>
        ) : (
          <>
            <StaleHint state={state} />
            <button type="submit" className={PRIMARY} disabled={pending}>
              {pending ? '處理中…' : '確認執行'}
            </button>
            <Link href={`/dashboard/admin/grading/${preview.groupId}`} className={SECONDARY}>
              取消
            </Link>
          </>
        )}
      </div>
    </form>
  )
}

const CHOICE_TITLE: Record<RemovalChoice, string> = {
  keep: '保留已完成評分',
  replace: '替換評分老師、重新評分',
  add: '明確新增一位評分老師',
}

const CHOICE_HINT: Record<RemovalChoice, string> = {
  keep: '舊分繼續採計、算已完成；不另外產生補評要求。',
  replace: '舊分保留成歷史、不再採計；新老師送出前算缺評。',
  add: '舊分繼續採計；新老師也要評，要求份數＋1。',
}

/** 確認套用新方案版本（先看影響）。 */
export function ApplySchemeForm({
  cohortId,
  versionId,
  versionNo,
  token,
  requestId,
  blocked,
}: {
  cohortId: string
  versionId: string
  versionNo: number
  token: string
  requestId: string
  blocked: boolean
}) {
  const [state, action, pending] = useActionState(applySchemeAction, undefined)
  const done = state?.ok === true
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="cohortId" value={cohortId} />
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="requestId" value={requestId} />
      <Feedback state={state} />
      <div className="flex flex-wrap gap-2">
        {done ? (
          <Link href={`/dashboard/admin/grading?cohort=${cohortId}`} className={PRIMARY}>
            回評分
          </Link>
        ) : (
          <>
            <StaleHint state={state} label="重新看影響" />
            <button type="submit" className={PRIMARY} disabled={pending || blocked}>
              {pending ? '套用中…' : `確認套用 v${versionNo}`}
            </button>
            <Link href={`/dashboard/admin/grading?cohort=${cohortId}`} className={SECONDARY}>
              取消（不重算）
            </Link>
          </>
        )}
      </div>
    </form>
  )
}

/** 成績匯出：用畫面目前的篩選（伺服器重新算，不收瀏覽器的列）。 */
export function GradeExportButtons({
  cohortId,
  filter,
  disabled,
}: {
  cohortId: string
  filter: { stage: string; group: string; status: string }
  disabled: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null)

  async function download(format: 'csv' | 'xlsx') {
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch('/api/admin/grading/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cohortId, format, filter }),
      })
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { message?: string } | null
        setMessage({ tone: 'error', text: problem?.message ?? '匯出失敗，請重新整理頁面再試。' })
        return
      }
      const disposition = response.headers.get('content-disposition') ?? ''
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
      const fileName = encoded ? decodeURIComponent(encoded) : `成績.${format}`
      const url = URL.createObjectURL(await response.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setMessage({
        tone: 'ok',
        text: `已匯出 ${response.headers.get('x-export-count') ?? ''} 組、${response.headers.get('x-export-rows') ?? ''} 列（${fileName}）。`,
      })
    } catch {
      setMessage({ tone: 'error', text: '匯出失敗，請檢查網路後再試。' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={SECONDARY} disabled={busy || disabled} onClick={() => download('xlsx')}>
          匯出 Excel（XLSX）
        </button>
        <button type="button" className={SECONDARY} disabled={busy || disabled} onClick={() => download('csv')}>
          匯出 CSV
        </button>
      </div>
      {message ? (
        <p
          role={message.tone === 'ok' ? 'status' : 'alert'}
          className={cn(
            'rounded-md px-3 py-2 text-sm',
            message.tone === 'ok' ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-danger-subtle text-danger-on-subtle',
          )}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  )
}

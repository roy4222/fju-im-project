'use client'
import Link from 'next/link'
import { useActionState, useEffect, useState } from 'react'
import { createVersionAction } from './actions'
import { Feedback, INPUT, LABEL, PRIMARY } from '@/app/dashboard/admin/groups/admin-group-forms'
import type { SignoffPurpose } from '@/application/signoff'
import { cn } from '@/shared/cn'

/**
 * 管理員「建立簽核版本」表單（票 25／S11-04；原型「新增簽核」與「選取示範檔後顯示影響人數」）。
 *
 * 選組別 → 用途 → 貼全文 → 從這組正式送出的繳交檔案選附件；最終文件授權另外要有這一組的精選草稿（授權範圍從它凍結）。
 * 影響人數預覽＝這一組**此刻**的有效組員＋主指導（建版時伺服器會再拍一次快照，以那一刻為準）。
 * 規則都在用例裡判；畫面只做預覽與顯示伺服器回來的句子。
 */

export type SignoffActionState = { ok: boolean; message: string; versionId?: string } | undefined

export type GroupOption = {
  readonly groupId: string
  readonly groupCode: string
  readonly members: readonly { readonly name: string; readonly studentNo: string | null }[]
  readonly advisorName: string | null
  readonly showcase: { readonly entryId: string; readonly title: string; readonly revision: number; readonly ready: boolean } | null
  readonly submissionFiles: readonly { readonly fileId: string; readonly name: string; readonly itemTitle: string; readonly versionNo: number }[]
  /** 這一組兩個用途目前那一版的版本號（建新版會讓它失效）。 */
  readonly currentVersionNo: Readonly<Record<SignoffPurpose, number | null>>
}

const PURPOSES: { value: SignoffPurpose; label: string; hint: string }[] = [
  { value: 'result_confirmation', label: '期中結果確認', hint: '確認期中結果或系統驗收；不帶公開授權範圍。' },
  { value: 'final_document', label: '最終文件授權', hint: '同意最終文件與公開展示範圍；要先有這一組的精選草稿。' },
]

export function CreateVersionForm({ groups, requestId }: { groups: readonly GroupOption[]; requestId: string }) {
  const [state, action, pending] = useActionState(createVersionAction, undefined)
  const [groupId, setGroupId] = useState(groups[0]?.groupId ?? '')
  const [purpose, setPurpose] = useState<SignoffPurpose>('result_confirmation')
  // 受控：送出被拒時全文還在（React 表單動作結束後會重設非受控欄位）。
  const [content, setContent] = useState('')
  useEffect(() => {
    // 建好了就清掉全文，免得按第二次又建一版。
    if (state?.ok) setContent('')
  }, [state])
  const group = groups.find((g) => g.groupId === groupId) ?? null
  const previous = group?.currentVersionNo[purpose] ?? null

  return (
    <form action={action} className="space-y-4" aria-label="建立簽核版本">
      <input type="hidden" name="requestId" value={requestId} />
      {/* 組別與用途以畫面狀態為準送出：表單動作結束後 React 會重設表單，重設會把單選與下拉的 DOM 值拉回初始值。 */}
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="purpose" value={purpose} />
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={LABEL}>
          組別
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className={INPUT} required>
            {groups.map((g) => (
              <option key={g.groupId} value={g.groupId}>
                {g.groupCode}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className={LABEL}>用途</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {PURPOSES.map((p) => (
              <label
                key={p.value}
                className={cn(
                  'cursor-pointer rounded-md border px-3 py-2 text-sm',
                  purpose === p.value ? 'border-primary bg-primary-subtle text-primary-on-subtle' : 'border-border',
                )}
              >
                <input
                  type="radio"
                  name="purpose-choice"
                  value={p.value}
                  checked={purpose === p.value}
                  onChange={() => setPurpose(p.value)}
                  className="sr-only"
                />
                {p.label}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{PURPOSES.find((p) => p.value === purpose)!.hint}</p>
        </fieldset>
      </div>

      {group ? (
        <div data-testid="impact-preview" className="rounded-md bg-surface px-4 py-3 text-sm">
          <p className="font-medium text-ink">
            參與者：{group.members.length} 位學生＋主指導 {group.advisorName ?? '（尚未指派）'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {group.members.map((m) => m.name).join('、') || '這一組目前沒有有效組員'}
          </p>
          {group.advisorName === null ? (
            <p className="mt-1 text-xs text-danger">這一組還沒有主指導，建版會被拒；請先到「分組」指派。</p>
          ) : null}
          {previous !== null ? (
            <p className="mt-1 text-xs text-danger">建立後，{group.groupCode} 目前的 v{previous} 會失效，所有人要對新版重新同意。</p>
          ) : null}
        </div>
      ) : null}

      <label className={LABEL}>
        全文
        <textarea
          name="content"
          rows={8}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className={INPUT}
          placeholder="貼上要大家閱讀並同意的全文。可以是純文字（空一行＝新段落）或段落、清單這類簡單排版。"
        />
        <span className="mt-1 block text-xs text-muted-foreground">建立後不能改字；要改就再建一版，所有人重新同意。</span>
      </label>

      <fieldset>
        <legend className={LABEL}>附件（從這一組正式送出的繳交檔案選）</legend>
        {group && group.submissionFiles.length > 0 ? (
          <ul className="mt-1 space-y-1" key={groupId}>
            {group.submissionFiles.map((f) => (
              <li key={f.fileId}>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="attachmentFileIds" value={f.fileId} />
                  <span className="font-medium text-ink">{f.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {f.itemTitle} 第 {f.versionNo} 次正式送出
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">這一組還沒有正式送出過附件；不選也可以建版。</p>
        )}
      </fieldset>

      {purpose === 'final_document' && group ? (
        <div className="rounded-md border border-border px-4 py-3 text-sm" data-testid="showcase-pick">
          {group.showcase ? (
            <label className="flex items-start gap-2">
              <input type="checkbox" name="showcaseEntryId" value={group.showcase.entryId} defaultChecked key={group.showcase.entryId} />
              <span>
                用 {group.groupCode} 的精選草稿「{group.showcase.title || '（還沒有題目）'}」（第 {group.showcase.revision} 版）凍結授權範圍
                {group.showcase.ready ? null : <span className="block text-xs text-danger">草稿還沒有題目或摘要，建版會被拒。</span>}
              </span>
            </label>
          ) : (
            <p>
              {group.groupCode} 還沒有精選草稿；最終文件授權要先到{' '}
              <Link href="/dashboard/admin/showcase" className="font-medium text-primary underline-offset-2 hover:underline">
                精選
              </Link>{' '}
              建立草稿。
            </p>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={PRIMARY} disabled={pending || !group}>
          {pending ? '建立中…' : '建立簽核版本'}
        </button>
        <span className="text-xs text-muted-foreground">建立後每位參與學生會收到「輪到你同意」。</span>
      </div>
      <Feedback state={state} />
      {state?.ok && state.versionId ? (
        <Link href={`/dashboard/admin/signoff/${state.versionId}`} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
          看剛建立的版本
        </Link>
      ) : null}
    </form>
  )
}

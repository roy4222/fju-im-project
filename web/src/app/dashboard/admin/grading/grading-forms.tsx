'use client'
import { useActionState, useState } from 'react'
import {
  assignEvaluatorAction,
  createSchemeVersionAction,
  publishSchemeAction,
  setRequirementAction,
} from './actions'
import {
  DIALOG,
  Feedback,
  INPUT,
  LABEL,
  PRIMARY,
  SECONDARY,
  useCloseOnSuccess,
  useDialog,
} from '@/app/dashboard/admin/groups/admin-group-forms'
import type { SchemeItemType, SchemeStage } from '@/application/grading'
import { cn } from '@/shared/cn'
import { LETTER_GRADES, type LetterMap } from '@/shared/score'

/**
 * 管理員「評分」頁會動的部分（票 23）：建立方案版本（階段、項目、滿分、權重，即時合計）、發布、
 * 每組每階段的要求份數、指派評分老師。規則都在用例裡判；畫面只做即時合計提示與顯示伺服器回來的句子。
 */

export type GradingActionState = { ok: boolean; message: string } | undefined

const ITEM_TYPES: { value: SchemeItemType; label: string }[] = [
  { value: 'number', label: '分數' },
  { value: 'letter', label: '等第 A–F' },
  { value: 'passfail', label: '通過／不通過' },
]

type ItemDraft = { key?: string; name: string; type: SchemeItemType; max: string; weight: string }
type StageDraft = { key?: string; name: string; weight: string; letterMap: Record<string, string>; items: ItemDraft[] }

const DEFAULT_LETTERS: Record<string, string> = { A: '95', B: '85', C: '75', D: '65', F: '50' }

function toDraft(stages: readonly SchemeStage[]): StageDraft[] {
  if (stages.length === 0) {
    return [
      { name: '系統驗收', weight: '60', letterMap: { ...DEFAULT_LETTERS }, items: [{ name: '功能完整度', type: 'number', max: '100', weight: '100' }] },
      { name: '專題發表', weight: '40', letterMap: { ...DEFAULT_LETTERS }, items: [{ name: '發表內容', type: 'number', max: '100', weight: '100' }] },
    ]
  }
  return stages.map((s) => ({
    key: s.key,
    name: s.name,
    weight: String(s.weight),
    letterMap: s.letterMap ? Object.fromEntries(LETTER_GRADES.map((g) => [g, String((s.letterMap as LetterMap)[g])])) : { ...DEFAULT_LETTERS },
    items: s.items.map((i) => ({ key: i.key, name: i.name, type: i.type, max: i.max === null ? '100' : String(i.max), weight: String(i.weight) })),
  }))
}

const num = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : 0)

function toPayload(stages: StageDraft[]) {
  return stages.map((s) => ({
    ...(s.key ? { key: s.key } : {}),
    name: s.name,
    weight: s.weight,
    ...(s.items.some((i) => i.type === 'letter') ? { letterMap: s.letterMap } : {}),
    items: s.items.map((i) => ({
      ...(i.key ? { key: i.key } : {}),
      name: i.name,
      type: i.type,
      max: i.type === 'number' ? i.max : null,
      weight: i.type === 'passfail' ? '0' : i.weight,
    })),
  }))
}

function SumBadge({ label, sum }: { label: string; sum: number }) {
  const ok = sum === 100
  return (
    <span
      data-testid="weight-sum"
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
        ok ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-danger-subtle text-danger-on-subtle',
      )}
    >
      {label} {sum}%{ok ? '' : '（要 100%）'}
    </span>
  )
}

/** 建立新方案版本：從目前（或最新）版本複製起草；權重即時合計，不合 100 伺服器也會擋。 */
export function SchemeEditor({
  cohortId,
  base,
  baseLabel,
  requestId,
  disabledReason,
}: {
  cohortId: string
  base: readonly SchemeStage[]
  baseLabel: string | null
  requestId: string
  disabledReason: string | null
}) {
  const [state, action, pending] = useActionState(createSchemeVersionAction, undefined)
  const dialog = useDialog()
  const [stages, setStages] = useState<StageDraft[]>(() => toDraft(base))
  useCloseOnSuccess(state, dialog.close)

  const stageSum = stages.reduce((sum, s) => sum + num(s.weight), 0)
  const update = (index: number, patch: Partial<StageDraft>) =>
    setStages((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  const updateItem = (stageIndex: number, itemIndex: number, patch: Partial<ItemDraft>) =>
    setStages((list) =>
      list.map((s, i) => (i === stageIndex ? { ...s, items: s.items.map((it, j) => (j === itemIndex ? { ...it, ...patch } : it)) } : s)),
    )

  return (
    <div className="space-y-2">
      <button
        type="button"
        className={PRIMARY}
        onClick={() => {
          setStages(toDraft(base))
          dialog.open()
        }}
        disabled={disabledReason !== null}
        title={disabledReason ?? undefined}
      >
        建立新方案版本
      </button>
      <Feedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label="建立評分方案版本" className={cn(DIALOG, 'w-[min(48rem,calc(100vw-2rem))]')}>
        <form action={action} className="space-y-4 p-5">
          <div>
            <h2 className="text-lg font-extrabold text-foreground">建立評分方案版本</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {baseLabel ? `從 ${baseLabel} 複製起草。` : '第一版從範本起草。'}
              階段占總成績合計要 100%、每個階段的項目權重合計也要 100%；建好是草稿，按「發布」後老師才會用。
            </p>
          </div>
          <input type="hidden" name="cohortId" value={cohortId} />
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="stages" value={JSON.stringify(toPayload(stages))} />

          <div className="flex flex-wrap items-center gap-2">
            <SumBadge label="階段合計" sum={stageSum} />
            <span className="text-xs text-muted-foreground">
              最終成績 = {stages.map((s) => `${s.name || '（未命名）'} × ${num(s.weight)}%`).join(' ＋ ')}
            </span>
          </div>

          <ol className="space-y-4">
            {stages.map((stage, si) => {
              const itemSum = stage.items.filter((i) => i.type !== 'passfail').reduce((sum, i) => sum + num(i.weight), 0)
              const hasLetter = stage.items.some((i) => i.type === 'letter')
              return (
                <li key={si} aria-label={`第 ${si + 1} 個階段`} className="space-y-3 rounded-lg border border-border p-3">
                  <div className="grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
                    <div>
                      <label htmlFor={`stage-${si}-name`} className={LABEL}>
                        階段名稱
                      </label>
                      <input id={`stage-${si}-name`} value={stage.name} onChange={(e) => update(si, { name: e.target.value })} className={INPUT} />
                    </div>
                    <div>
                      <label htmlFor={`stage-${si}-weight`} className={LABEL}>
                        占總成績 %
                      </label>
                      <input
                        id={`stage-${si}-weight`}
                        inputMode="numeric"
                        value={stage.weight}
                        onChange={(e) => update(si, { weight: e.target.value })}
                        className={INPUT}
                      />
                    </div>
                    <button
                      type="button"
                      className={SECONDARY}
                      disabled={stages.length <= 1}
                      onClick={() => setStages((list) => list.filter((_, i) => i !== si))}
                    >
                      刪除階段
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <SumBadge label={`「${stage.name || '未命名'}」項目合計`} sum={itemSum} />
                  </div>
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="py-1 font-medium">項目</th>
                        <th className="py-1 font-medium">型態</th>
                        <th className="py-1 font-medium">滿分</th>
                        <th className="py-1 font-medium">權重 %</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {stage.items.map((item, ii) => (
                        <tr key={ii}>
                          <td className="py-1 pr-2">
                            <input
                              aria-label={`第 ${si + 1} 階段第 ${ii + 1} 項名稱`}
                              value={item.name}
                              onChange={(e) => updateItem(si, ii, { name: e.target.value })}
                              className="w-full rounded-lg border border-border bg-background px-2 py-1.5"
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <select
                              aria-label={`第 ${si + 1} 階段第 ${ii + 1} 項型態`}
                              value={item.type}
                              onChange={(e) => updateItem(si, ii, { type: e.target.value as SchemeItemType })}
                              className="rounded-lg border border-border bg-background px-2 py-1.5"
                            >
                              {ITEM_TYPES.map((t) => (
                                <option key={t.value} value={t.value}>
                                  {t.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="w-20 py-1 pr-2">
                            {item.type === 'number' ? (
                              <input
                                aria-label={`第 ${si + 1} 階段第 ${ii + 1} 項滿分`}
                                inputMode="numeric"
                                value={item.max}
                                onChange={(e) => updateItem(si, ii, { max: e.target.value })}
                                className="w-full rounded-lg border border-border bg-background px-2 py-1.5"
                              />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="w-20 py-1 pr-2">
                            {item.type === 'passfail' ? (
                              <span className="text-xs text-muted-foreground">不計分</span>
                            ) : (
                              <input
                                aria-label={`第 ${si + 1} 階段第 ${ii + 1} 項權重`}
                                inputMode="numeric"
                                value={item.weight}
                                onChange={(e) => updateItem(si, ii, { weight: e.target.value })}
                                className="w-full rounded-lg border border-border bg-background px-2 py-1.5"
                              />
                            )}
                          </td>
                          <td className="py-1 text-right">
                            <button
                              type="button"
                              className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-40"
                              disabled={stage.items.length <= 1}
                              onClick={() => update(si, { items: stage.items.filter((_, j) => j !== ii) })}
                            >
                              刪除
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button
                    type="button"
                    className="text-sm font-medium text-primary underline-offset-2 hover:underline"
                    onClick={() => update(si, { items: [...stage.items, { name: '', type: 'number', max: '100', weight: '0' }] })}
                  >
                    ＋ 新增項目
                  </button>
                  {hasLetter ? (
                    <fieldset className="flex flex-wrap items-center gap-2 text-sm">
                      <legend className="mb-1 text-xs text-muted-foreground">等第對照（隨版本保存）</legend>
                      {LETTER_GRADES.map((g) => (
                        <label key={g} className="flex items-center gap-1">
                          {g}
                          <input
                            inputMode="numeric"
                            value={stage.letterMap[g] ?? ''}
                            onChange={(e) => update(si, { letterMap: { ...stage.letterMap, [g]: e.target.value } })}
                            className="w-14 rounded-lg border border-border bg-background px-2 py-1"
                          />
                        </label>
                      ))}
                    </fieldset>
                  ) : null}
                </li>
              )
            })}
          </ol>
          <button
            type="button"
            className={SECONDARY}
            onClick={() =>
              setStages((list) => [
                ...list,
                { name: '', weight: '0', letterMap: { ...DEFAULT_LETTERS }, items: [{ name: '', type: 'number', max: '100', weight: '100' }] },
              ])
            }
          >
            ＋ 新增階段
          </button>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending ? '處理中…' : '建立草稿'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}

/** 發布草稿版本。目前版本已鎖定時伺服器回 SCHEME_LOCKED；畫面先把按鈕停用並說明。 */
export function PublishButton({
  versionId,
  versionNo,
  requestId,
  disabledReason,
}: {
  versionId: string
  versionNo: number
  requestId: string
  disabledReason: string | null
}) {
  const [state, action, pending] = useActionState(publishSchemeAction, undefined)
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="requestId" value={requestId} />
      <button type="submit" className={SECONDARY} disabled={pending || disabledReason !== null} aria-label={`發布 v${versionNo}`}>
        {pending ? '發布中…' : '發布'}
      </button>
      {disabledReason ? <p className="text-xs text-muted-foreground">{disabledReason}</p> : null}
      <Feedback state={state} />
    </form>
  )
}

/** 每組每階段要幾份評分（版本號帶著：別人先改過就要求重新整理）。 */
export function RequirementForm({
  groupId,
  groupCode,
  stageKey,
  stageName,
  count,
  revision,
  requestId,
  max,
}: {
  groupId: string
  groupCode: string
  stageKey: string
  stageName: string
  count: number | null
  revision: number
  requestId: string
  max: number
}) {
  const [state, action, pending] = useActionState(setRequirementAction, undefined)
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="stageKey" value={stageKey} />
      <input type="hidden" name="revision" value={revision} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="flex items-center gap-2">
        <input
          key={`${revision}`}
          name="requiredCount"
          type="number"
          min={0}
          max={max}
          defaultValue={count ?? ''}
          placeholder="未設定"
          aria-label={`${groupCode}「${stageName}」要求份數`}
          className="w-20 rounded-lg border border-border bg-background px-2 py-1.5 text-sm tabular-nums"
        />
        <button type="submit" className={SECONDARY} disabled={pending}>
          {pending ? '…' : '儲存'}
        </button>
      </div>
      <Feedback state={state?.ok ? undefined : state} />
    </form>
  )
}

/** 指派一位評分老師（下拉只列有效的老師；已指派的排除）。 */
export function AssignEvaluatorForm({
  groupId,
  groupCode,
  stageKey,
  stageName,
  teachers,
  requestId,
}: {
  groupId: string
  groupCode: string
  stageKey: string
  stageName: string
  teachers: readonly { userId: string; name: string }[]
  requestId: string
}) {
  const [state, action, pending] = useActionState(assignEvaluatorAction, undefined)
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="stageKey" value={stageKey} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="flex items-center gap-2">
        <select
          name="teacherUserId"
          required
          defaultValue=""
          aria-label={`${groupCode}「${stageName}」評分老師`}
          className="min-w-32 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="" disabled>
            選老師…
          </option>
          {teachers.map((t) => (
            <option key={t.userId} value={t.userId}>
              {t.name}
            </option>
          ))}
        </select>
        <button type="submit" className={SECONDARY} disabled={pending || teachers.length === 0}>
          {pending ? '…' : '指派'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  )
}

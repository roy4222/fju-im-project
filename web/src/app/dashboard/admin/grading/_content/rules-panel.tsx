import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { HBar } from '@/app/_ui/dashboard/charts'
import { Panel, Pill, QuietState } from '@/app/_ui/dashboard/primitives'
import { PublishButton, SchemeEditor } from '@/app/dashboard/admin/grading/grading-forms'
import { StageSettingsForm } from '@/app/dashboard/admin/grading/stage-settings-form'
import type { SchemeVersionView, StageSetting } from '@/application/grading'
import { cohortLabel } from '@/composition/cohorts'
import { getItemQuery } from '@/composition/items'
import { describeFormula, getGradingQuery, getGradingStageSettingQuery, ITEM_TYPE_LABEL, SCHEME_STATUS_LABEL } from '@/composition/grading'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

const GRADING = '/dashboard/admin/grading'
const BASE = `${GRADING}/rules`

function versionLabel(v: SchemeVersionView, current: SchemeVersionView | null): string {
  if (v.isCurrent) return `${SCHEME_STATUS_LABEL[v.status]}・目前使用`
  if (v.status === 'draft') return '草稿'
  return current && v.versionNo < current.versionNo ? '已被新版本取代' : SCHEME_STATUS_LABEL[v.status]
}

/** 這一項目前跟哪一個評分項目同一組評審：同一個 `panelKey`、而且對方也在目前版本裡（只有自己用的代號＝各自指派）。 */
function panelPartner(settings: readonly StageSetting[], stageKey: string): string | null {
  const mine = settings.find((s) => s.stageKey === stageKey)?.panelKey ?? null
  if (mine === null) return null
  return settings.find((s) => s.stageKey !== stageKey && s.panelKey === mine)?.stageKey ?? null
}

/**
 * 「成績」的「評分規則」分頁內容（C 階段規格① §7.4、§11.2；原本 `grading/rules/page.tsx` 的上半）。兩個區塊：
 *
 * 1. 目前版本：`scheme-status`、「修改評分規則」（建新版草稿；成功訊息在區塊內）、每個評分項目一張卡——比例、細項與配分（版本內容），
 *    以及對應作業、說明、評審組（側表 `StageSettingsForm`：不建新版、不受鎖定影響）；公式。
 * 2. 版本紀錄：每版一張卡；草稿卡有「發布第 N 版」，評分規則鎖定後的草稿卡改成「查看第 N 版重算影響（尚不套用）」→ `apply/<版本>`。
 *
 * 每組要幾位老師評與指派搬到「評分老師」分頁（`EvaluatorsPanel`）。
 * 讀取三次：`adminBoard`（版本）、`stageSettings`（側表）、`items.list`（對應作業的選項：這一屆已發布、整組繳交、不是同意書）。
 */
export async function GradingRulesPanel({ cohortId }: { cohortId: string }) {
  const actor = await requireRole(BASE, 'admin')
  const [board, settings, items] = await Promise.all([
    getGradingQuery().adminBoard(actor, cohortId),
    getGradingStageSettingQuery().stageSettings(actor, cohortId),
    getItemQuery().list(cohortId),
  ])
  if (!board.ok) return <QuietState title="讀不到評分資料" hint={board.message} />
  const { current, versions } = board.receipt
  const stageSettings = settings.ok ? settings.receipt : []
  // 伺服器端的屆別狀態為準（寫入的用例本身也會以 COHORT_ARCHIVED 拒絕）。
  const archived = board.receipt.cohort.archived
  const archivedReason = archived ? `${cohortLabel(board.receipt.cohort)}已封存，只能查看與匯出；要修改請先解封。` : null
  const latest = versions[0] ?? null
  const locked = current?.status === 'locked'
  // 對應作業的選項跟伺服器驗證同一套條件（`setStageSetting`）：這一屆、作業、整組一份、已發布、不是同意書。
  const linkable = items
    .filter((i) => (i.placement === 'submission' || i.placement === 'requirement') && i.receiverUnit === 'group' && i.status !== 'draft' && i.consentMode === null)
    .map((i) => ({ id: i.id, title: i.title }))
  const teachersHref = `${GRADING}/teachers?cohort=${cohortId}`

  return (
    <>
      {archivedReason ? (
        <p role="status" data-testid="cohort-archived" className="rounded-lg bg-muted px-4 py-2.5 text-sm text-muted-foreground">
          {archivedReason}
        </p>
      ) : null}

      <Panel
        title={
          <>
            目前版本{' '}
            <span data-testid="scheme-status" className="ml-1 font-semibold text-muted-foreground">
              {current ? `第 ${current.versionNo} 版・${SCHEME_STATUS_LABEL[current.status]}` : '還沒有發布的評分規則'}
            </span>
          </>
        }
        aria-label="目前版本"
      >
        <div className="flex flex-col gap-1 border-t border-border/70 px-5 py-4">
          <p data-testid="rules-intro" className="mb-2 text-sm text-muted-foreground">
            評分項目的名稱、比例、細項是評分規則的內容，改了要建新版；對應作業、說明、評審組隨時可改，不用建新版。
          </p>
          <SchemeEditor
            cohortId={cohortId}
            base={current?.stages ?? latest?.stages ?? []}
            baseLabel={current ? `第 ${current.versionNo} 版` : latest ? `第 ${latest.versionNo} 版` : null}
            requestId={randomUUID()}
            disabledReason={archivedReason}
            locked={locked}
          />
        </div>
        {current ? (
          <>
            <ul className="grid gap-x-8 border-t border-border/70 md:grid-cols-2">
              {current.stages.map((s) => {
                const sum = s.items.filter((i) => i.type !== 'passfail').reduce((a, i) => a + i.weight, 0)
                const setting = stageSettings.find((x) => x.stageKey === s.key) ?? null
                // 目前連著、但已不符合條件的作業（例如之後改成個人繳交）也列進選項，才不會一按儲存就被清掉。
                const options =
                  setting?.itemId && !linkable.some((i) => i.id === setting.itemId)
                    ? [...linkable, { id: setting.itemId, title: setting.itemTitle ?? '（已不能對應的作業）' }]
                    : linkable
                return (
                  <li key={s.key} aria-label={`評分項目「${s.name}」`} data-testid={`rules-stage-${s.key}`} className="flex flex-col gap-3 px-5 py-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-bold">
                        {s.name} <span className="ml-1 text-xs font-normal text-muted-foreground">占總成績 {s.weight}%</span>
                      </p>
                      <Pill tone={sum === 100 ? 'success' : 'danger'}>細項 {sum}%</Pill>
                    </div>
                    <ul className="flex flex-col gap-2">
                      {s.items.map((i) => (
                        <li key={i.key}>
                          <HBar
                            label={i.name}
                            value={i.type === 'passfail' ? 0 : i.weight}
                            total={100}
                            suffix={i.type === 'number' ? `${i.weight}%・滿分 ${i.max}` : i.type === 'passfail' ? `${ITEM_TYPE_LABEL[i.type]}・不計分` : `${i.weight}%・${ITEM_TYPE_LABEL[i.type]}`}
                          />
                        </li>
                      ))}
                    </ul>
                    {s.letterMap ? (
                      <p className="text-xs text-muted-foreground">
                        等第對照：{Object.entries(s.letterMap).map(([g, v]) => `${g}=${v}`).join('、')}
                      </p>
                    ) : null}
                    <div className="rounded-lg bg-muted/50 p-3">
                      <StageSettingsForm
                        cohortId={cohortId}
                        stageKey={s.key}
                        stageName={s.name}
                        items={options}
                        others={current.stages.filter((o) => o.key !== s.key).map((o) => ({ key: o.key, name: o.name }))}
                        itemId={setting?.itemId ?? null}
                        description={setting?.description ?? null}
                        panelWith={panelPartner(stageSettings, s.key)}
                        teachersHref={teachersHref}
                        requestId={randomUUID()}
                        disabledReason={archivedReason}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
            <p data-testid="scheme-formula" className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
              {describeFormula(current.stages)}
            </p>
          </>
        ) : null}
      </Panel>

      <section aria-label="版本紀錄" className="flex flex-col gap-3">
        <h2 className="text-[15px] font-bold text-foreground">版本紀錄（{versions.length}）</h2>
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">還沒有任何版本。</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {versions.map((v) => (
              <article
                key={v.id}
                id={`version-${v.versionNo}`}
                aria-label={`第 ${v.versionNo} 版`}
                className={cn('dash-card flex flex-col gap-2 px-4 py-3', v.isCurrent && 'border-primary/50')}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="tabular font-bold text-foreground">第 {v.versionNo} 版</p>
                  <Pill tone={v.isCurrent ? 'brand' : 'default'}>{versionLabel(v, current)}</Pill>
                </div>
                <p className="tabular text-xs text-muted-foreground">建立於 {formatTaipeiMinute(v.createdAt)}</p>
                {v.status === 'draft' && archived ? null : v.status === 'draft' && locked ? (
                  <Link href={`${GRADING}/apply/${v.id}`} className={LINK_BUTTON}>
                    查看第 {v.versionNo} 版重算影響（尚不套用）
                  </Link>
                ) : v.status === 'draft' ? (
                  <PublishButton versionId={v.id} versionNo={v.versionNo} requestId={randomUUID()} disabledReason={null} />
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

const LINK_BUTTON =
  'inline-flex min-h-9 items-center justify-center self-start rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium text-foreground hover:bg-muted'

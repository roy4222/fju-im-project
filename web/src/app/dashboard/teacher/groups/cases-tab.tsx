import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconBriefcase } from '@tabler/icons-react'
import type { ManagedOpportunity, OpportunityCard, OpportunityQuery, OpportunityStatus } from '@/application/groups'
import { currentActor } from '@/app/_ui/guard'
import { LinkGroupDialog, type LinkTargetOption } from '@/app/dashboard/teacher/industry/link-dialog'
import { Panel, PanelEmpty, Pill, type PillTone } from '@/app/dashboard/teacher/_ui/dash'
import { LinkedGroupsCell, OpportunityFormDialog, OpportunityStatusButton } from '@/app/dashboard/teacher/industry/opportunity-forms'
import {
  CHANGE_REASON_MAX_LENGTH,
  getOpportunityQuery,
  OPPORTUNITY_FIELD_LABEL,
  OPPORTUNITY_LIMITS,
  OPPORTUNITY_STATUS_LABEL,
} from '@/composition/groups'
import { cohortLabel } from '@/composition/cohorts'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

export const CASES_HREF = '/dashboard/teacher/groups?tab=cases'

export const CASES_DESCRIPTION = '建立、編輯、下架自己的合作案；地址、聯絡人、電話、Email 只有你與系辦看得到。'

const STATUS_TONE: Record<OpportunityStatus, PillTone> = { published: 'success', draft: 'info', withdrawn: 'default' }

const LABELS = { fields: OPPORTUNITY_FIELD_LABEL, limits: OPPORTUNITY_LIMITS }

/** 頁首右邊的「新增合作案」（只在合作案分頁出現）。 */
export function NewOpportunityButton() {
  return <OpportunityFormDialog labels={LABELS} requestId={randomUUID()} />
}

/**
 * 分組總覽的「合作案」分頁（TE-05；原 `/dashboard/teacher/industry` 整頁搬進來，舊網址先過角色檢查再轉到這裡）。
 *
 * 建立、編輯、發布、下架、重新發布自己的合作案；聯絡資料只有自己與系辦看得到。
 * 每一案列出連結的組別（標「由誰連結」），可以解除（理由必填，通知該組與自己）；
 * 已發布的案有「連結組別」（TE-B3）：案主直接把還沒連案的產學組連上來，不必是該組指導老師。
 * 「我的／全部」切換：「全部」用前台 `/industry` 同一段已發布合作案查詢（只有公開欄位），別人的案子只能看。
 * 表單元件仍在 `teacher/industry/opportunity-forms.tsx`（檔案不搬）。
 */
export async function CasesTab({
  scope,
  items,
  cards,
  me,
}: {
  scope: 'mine' | 'all'
  items: readonly ManagedOpportunity[]
  cards: readonly OpportunityCard[]
  me: string
}) {
  const published = items.filter((o) => o.status === 'published').length
  const linked = items.reduce((sum, o) => sum + o.links.length, 0)
  const open = cards.filter((c) => c.linkedGroupCount === 0).length
  const tab = (key: 'mine' | 'all', label: string) => (
    <Link
      href={key === 'all' ? `${CASES_HREF}&scope=all` : CASES_HREF}
      aria-current={scope === key ? 'page' : undefined}
      className={cn(
        'tabular inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold transition-colors',
        scope === key ? 'bg-ink text-ink-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {label}
    </Link>
  )

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label="合作案範圍" className="inline-flex gap-1 rounded-xl border border-border bg-card p-1">
          {tab('mine', `我的 ${items.length} 件`)}
          {tab('all', `全部 ${cards.length} 件`)}
        </nav>
        <p className="tabular text-sm text-muted-foreground" data-testid="industry-summary">
          {scope === 'mine' ? (
            <>
              發布中 <b className="text-foreground">{published}</b> 件・連結 <b className="text-foreground">{linked}</b> 組
            </>
          ) : (
            <>
              全體尚未連結組別 <b className="text-foreground">{open}</b> 件
            </>
          )}
        </p>
      </div>
      {scope === 'all' ? <AllOpportunities cards={cards} me={me} /> : <MyOpportunities items={items} targets={await linkTargets(items)} />}
    </>
  )
}

type LinkTarget = Awaited<ReturnType<OpportunityQuery['teacherLinkTargets']>>[number]

/** 「連結組別」的選項：一頁只查一次；沒有已發布的案就不查。 */
async function linkTargets(items: readonly ManagedOpportunity[]): Promise<readonly LinkTargetOption[]> {
  if (!items.some((o) => o.status === 'published')) return []
  const targets = await getOpportunityQuery().teacherLinkTargets(await currentActor())
  return targets.map((t: LinkTarget) => ({
    groupId: t.groupId,
    label: `${cohortLabel({ name: t.cohortName, code: t.cohortCode })}・${t.groupCode}`,
    leaderName: t.leaderName,
    revision: t.revision,
  }))
}

function MyOpportunities({ items, targets }: { items: readonly ManagedOpportunity[]; targets: readonly LinkTargetOption[] }) {
  return (
    <Panel title="我的合作案" icon={<IconBriefcase />} description={`${items.length} 件`}>
      {items.length === 0 ? (
        <PanelEmpty
          icon={<IconBriefcase />}
          title="尚無合作案"
          hint="按「新增合作案」填公司、部門與內容；可以先存草稿，確認後再發布給學生看。"
        />
      ) : (
        <ul aria-label="合作案清單" className="divide-y divide-border">
          {items.map((o) => {
            const name = `${o.fields.companyName}・${o.fields.department}`
            return (
              <li
                key={o.id}
                data-testid="managed-opportunity"
                className="grid items-center gap-3 px-5 py-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={STATUS_TONE[o.status]}>{OPPORTUNITY_STATUS_LABEL[o.status]}</Pill>
                    {o.links.length > 0 ? <Pill>已連結 {o.links.length} 組</Pill> : <Pill tone="brand">尚未連結組別</Pill>}
                    {o.publishedAt ? (
                      <span className="tabular text-xs text-muted-foreground">{formatTaipeiDate(taipeiDateOf(o.publishedAt))} 發布</span>
                    ) : null}
                  </div>
                  <Link href={`/industry/${o.id}`} className="link-ink mt-1 block truncate text-[15px] font-bold text-foreground hover:text-primary">
                    {o.fields.companyName}
                  </Link>
                  <p className="truncate text-sm text-muted-foreground">
                    {o.fields.department}・{o.fields.content.split('\n')[0]}
                  </p>
                </div>
                <LinkedGroupsCell
                  links={o.links.map((l) => ({
                    linkId: l.linkId,
                    groupCode: l.groupCode,
                    cohortLabel: cohortLabel({ name: l.cohortName, code: l.cohortCode }),
                    linkedByName: l.linkedByName,
                  }))}
                  opportunityName={name}
                  requestId={randomUUID()}
                  reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
                />
                <div className="flex flex-wrap items-center gap-2 md:justify-self-end">
                  {o.status === 'published' ? (
                    <LinkGroupDialog opportunityId={o.id} opportunityName={name} options={targets} requestId={randomUUID()} />
                  ) : null}
                  {o.status !== 'withdrawn' ? (
                    <OpportunityFormDialog
                      labels={LABELS}
                      requestId={randomUUID()}
                      initial={{ opportunityId: o.id, revision: o.revision, values: o.fields, name }}
                    />
                  ) : null}
                  <OpportunityStatusButton
                    opportunityId={o.id}
                    revision={o.revision}
                    name={name}
                    kind={o.status === 'published' ? 'withdraw' : o.status === 'withdrawn' ? 'republish' : 'publish'}
                    requestId={randomUUID()}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

/**
 * 「全部」：全系已發布的合作案。資料是前台 `/industry` 那一段同樣的查詢（只有公開欄位、已發布的），
 * 老師本來就看得到；這裡只換成後台列表的樣子，不能編輯別人的案子。
 */
function AllOpportunities({ cards, me }: { cards: readonly OpportunityCard[]; me: string }) {
  return (
    <Panel title="全部合作案" icon={<IconBriefcase />} description={`${cards.length} 件已發布`}>
      {cards.length === 0 ? (
        <PanelEmpty icon={<IconBriefcase />} title="目前沒有已發布的合作案" hint="老師發布合作案之後，登入的學生與老師都看得到。" />
      ) : (
        <ul aria-label="全部合作案" className="divide-y divide-border">
          {cards.map((c) => {
            const mine = c.ownerUserId === me
            return (
              <li key={c.id} className="grid items-center gap-3 px-5 py-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone="success">{OPPORTUNITY_STATUS_LABEL[c.status]}</Pill>
                    {c.linkedGroupCount > 0 ? <Pill>已連結 {c.linkedGroupCount} 組</Pill> : <Pill tone="brand">尚未連結組別</Pill>}
                    {c.publishedAt ? <span className="tabular text-xs text-muted-foreground">{formatTaipeiDate(taipeiDateOf(c.publishedAt))} 發布</span> : null}
                  </div>
                  <Link href={`/industry/${c.id}`} className="link-ink mt-1 block truncate text-[15px] font-bold text-foreground hover:text-primary">
                    {c.companyName}
                  </Link>
                  <p className="truncate text-sm text-muted-foreground">
                    {c.department}・{c.summary}
                  </p>
                </div>
                <p className="text-xs font-semibold text-foreground">
                  {c.ownerName} 老師{mine ? '（我）' : ''}
                </p>
                <div className="md:justify-self-end">
                  {mine ? (
                    <Link href={CASES_HREF} className="text-xs font-semibold text-muted-foreground hover:text-foreground">
                      在「我的」管理
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">只有負責老師能編輯</span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

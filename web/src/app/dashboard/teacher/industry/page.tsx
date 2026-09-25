import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconBriefcase } from '@tabler/icons-react'
import type { OpportunityCard, OpportunityStatus } from '@/application/groups'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { PageTitle, Panel, PanelEmpty, Pill, type PillTone } from '@/app/dashboard/teacher/_ui/dash'
import { LinkedGroupsCell, OpportunityFormDialog, OpportunityStatusButton } from '@/app/dashboard/teacher/industry/opportunity-forms'
import {
  CHANGE_REASON_MAX_LENGTH,
  getOpportunityQuery,
  OPPORTUNITY_FIELD_LABEL,
  OPPORTUNITY_LIMITS,
  OPPORTUNITY_STATUS_LABEL,
} from '@/composition/groups'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

export const metadata = { title: '我的合作案｜資管系專題平台' }

const STATUS_TONE: Record<OpportunityStatus, PillTone> = { published: 'success', draft: 'info', withdrawn: 'default' }

/**
 * 老師「我的合作案」（票 20；票 37 照原型 `/dashboard/teacher/industry`）。
 *
 * 建立、編輯、發布、下架、重新發布自己的合作案；聯絡資料只有自己與系辦看得到。
 * 每一案列出連結的組別，可以解除（理由必填，通知該組與自己）。
 * 原型的「我的／全部」切換：「全部」用前台 `/industry` 同一段已發布合作案查詢（只有公開欄位），別人的案子只能看。
 */
export default async function TeacherIndustryPage({ searchParams }: { searchParams: Promise<{ scope?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/teacher/industry', 'teacher')
  const me = actor.kind === 'authenticated' ? actor.userId : ''
  const scope = (await searchParams).scope === 'all' ? 'all' : 'mine'
  const query = getOpportunityQuery()
  const [items, cards] = await Promise.all([query.manageList(actor), query.list(actor)])
  const labels = { fields: OPPORTUNITY_FIELD_LABEL, limits: OPPORTUNITY_LIMITS }
  const published = items.filter((o) => o.status === 'published').length
  const linked = items.reduce((sum, o) => sum + o.links.length, 0)
  const open = cards.filter((c) => c.linkedGroupCount === 0).length
  const base = '/dashboard/teacher/industry'
  const tab = (key: 'mine' | 'all', label: string) => (
    <Link
      href={key === 'all' ? `${base}?scope=all` : base}
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
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current={base}>
      <div className="flex flex-col gap-5">
        <PageTitle
          title="合作案"
          description="建立、編輯、下架自己的合作案；地址、聯絡人、電話、Email 只有你與系辦看得到。"
          actions={<OpportunityFormDialog labels={labels} requestId={randomUUID()} />}
        />
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
        {scope === 'all' ? (
          <AllOpportunities cards={cards} me={me} />
        ) : (
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
                      <Link href={`/industry/${o.id}`} className="link-ink mt-1 block truncate text-[15px] font-bold text-foreground">
                        {o.fields.companyName}
                      </Link>
                      <p className="truncate text-sm text-muted-foreground">
                        {o.fields.department}・{o.fields.content.split('\n')[0]}
                      </p>
                    </div>
                    <LinkedGroupsCell
                      links={o.links.map((l) => ({ linkId: l.linkId, groupCode: l.groupCode, cohortCode: l.cohortCode }))}
                      opportunityName={name}
                      requestId={randomUUID()}
                      reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
                    />
                    <div className="flex flex-wrap items-center gap-2 md:justify-self-end">
                      {o.status !== 'withdrawn' ? (
                        <OpportunityFormDialog
                          labels={labels}
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
        )}
      </div>
    </DashboardShell>
  )
}

/**
 * 「全部」分頁：全系已發布的合作案（原型的「全部 N 件」）。資料是前台 `/industry` 那一段同樣的查詢（只有公開欄位、
 * 已發布的），老師本來就看得到；這裡只換成後台列表的樣子，不能編輯別人的案子。
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
                  <Link href={`/industry/${c.id}`} className="link-ink mt-1 block truncate text-[15px] font-bold text-foreground">
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
                    <Link href="/dashboard/teacher/industry" className="text-xs font-semibold text-muted-foreground hover:text-foreground">
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

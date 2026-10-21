import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconBriefcase } from '@tabler/icons-react'
import type { OpportunityQuery, OpportunityStatus } from '@/application/groups'
import { Panel, PanelEmpty, Pill, type PillTone } from '@/app/dashboard/teacher/_ui/dash'
import { MemberAvatars, PendingGroups, type PendingGroupCard } from '@/app/dashboard/teacher/groups/claim-button'
import { LinkGroupDialog, type LinkTargetOption } from '@/app/dashboard/teacher/industry/link-dialog'
import { LinkedGroupsCell, OpportunityFormDialog, OpportunityStatusButton } from '@/app/dashboard/teacher/industry/opportunity-forms'
import { cohortLabel } from '@/composition/cohorts'
import { CHANGE_REASON_MAX_LENGTH, OPPORTUNITY_FIELD_LABEL, OPPORTUNITY_LIMITS, OPPORTUNITY_STATUS_LABEL } from '@/composition/groups'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

export const INDUSTRY_HREF = '/dashboard/teacher/groups?tab=industry'

export const INDUSTRY_DESCRIPTION =
  '建立、編輯、下架自己的合作案；學生選了你的案成組後，在這裡「確認指導」或「婉拒」。地址、聯絡人、電話、Email 只有你與系辦看得到。'

/** C3-09 的型別從介面取（`application/groups` 的入口不在本票可改範圍）。 */
type Board = Awaited<ReturnType<OpportunityQuery['teacherIndustryBoard']>>
type IndustryCase = Board['cases'][number]
type Card = IndustryCase['pending'][number]
type LinkTarget = Awaited<ReturnType<OpportunityQuery['teacherLinkTargets']>>[number]

const STATUS_TONE: Record<OpportunityStatus, PillTone> = { published: 'success', draft: 'info', withdrawn: 'default' }

const LABELS = { fields: OPPORTUNITY_FIELD_LABEL, limits: OPPORTUNITY_LIMITS }

/** 頁首右邊的「新增合作案」（只在產學組分頁出現；整頁只有這一顆）。 */
export function NewOpportunityButton() {
  return <OpportunityFormDialog labels={LABELS} requestId={randomUUID()} />
}

/**
 * 分組總覽的「產學組」分頁（C3-09；規格③ §7.1 模擬圖 09、§7.2）。原「合作案」分頁（TE-05）搬過來改：
 *
 * 上面是「我的合作案」（建立、編輯、發布、下架、重新發布自己的案；聯絡資料只有自己與系辦看得到；每一案列出連結的組別，
 * 可解除；已發布的案有 TE-B3「連結組別」）。每一案底下兩段：「待確認要帶的組」（學生選了這一案、或被直接連上來、
 * 還沒有指導老師的組：組員頭像一列、組長、「確認指導」「婉拒」）與「已帶的組」（指導老師＝我）。
 * 原本的「全部合作案」清單拿掉：別人的案看前台 `/industry`。刪除合作案只有系辦（用例會擋），這裡沒有刪除鈕。
 * 表單元件仍在 `teacher/industry/opportunity-forms.tsx`（檔案不搬）。
 */
export function IndustryTab({ board, targets, requestId }: { board: Board; targets: readonly LinkTarget[]; requestId: string }) {
  if (board.cases.length === 0) {
    return (
      <Panel title="我的合作案" icon={<IconBriefcase />}>
        <PanelEmpty
          icon={<IconBriefcase />}
          title="你還沒有合作案。學生選了你的合作案成組後，會出現在這裡等你確認。"
          hint="按右上角「新增合作案」填公司、部門與內容；可以先存草稿，確認後再發布給學生看。"
        />
      </Panel>
    )
  }
  const options: readonly LinkTargetOption[] = targets.map((t) => ({
    groupId: t.groupId,
    label: `${cohortLabel({ name: t.cohortName, code: t.cohortCode })}・${t.groupCode}`,
    leaderName: t.leaderName,
    revision: t.revision,
  }))
  const published = board.cases.filter((c) => c.opportunity.status === 'published').length
  const pending = board.cases.reduce((sum, c) => sum + c.pending.length, 0)

  return (
    <Panel
      title="我的合作案"
      icon={<IconBriefcase />}
      description={
        <span data-testid="industry-summary">
          {board.cases.length} 件・發布中 {published} 件・待確認 {pending} 組
        </span>
      }
    >
      <ul aria-label="合作案清單" className="divide-y divide-border">
        {board.cases.map((c) => (
          <CaseRow key={c.opportunity.id} item={c} options={options} requestId={requestId} />
        ))}
      </ul>
    </Panel>
  )
}

function CaseRow({ item, options, requestId }: { item: IndustryCase; options: readonly LinkTargetOption[]; requestId: string }) {
  const o = item.opportunity
  const name = `${o.fields.companyName}・${o.fields.department}`
  return (
    <li data-testid="managed-opportunity" className="flex flex-col gap-4 px-5 py-4">
      <div className="grid items-center gap-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={STATUS_TONE[o.status]}>{OPPORTUNITY_STATUS_LABEL[o.status]}</Pill>
            {o.links.length > 0 ? <Pill>已連結 {o.links.length} 組</Pill> : <Pill tone="brand">尚未連結組別</Pill>}
            {o.publishedAt ? <span className="tabular text-xs text-muted-foreground">{formatTaipeiDate(taipeiDateOf(o.publishedAt))} 發布</span> : null}
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
          {o.status === 'published' ? <LinkGroupDialog opportunityId={o.id} opportunityName={name} options={options} requestId={randomUUID()} /> : null}
          {o.status !== 'withdrawn' ? (
            <OpportunityFormDialog labels={LABELS} requestId={randomUUID()} initial={{ opportunityId: o.id, revision: o.revision, values: o.fields, name }} />
          ) : null}
          <OpportunityStatusButton
            opportunityId={o.id}
            revision={o.revision}
            name={name}
            kind={o.status === 'published' ? 'withdraw' : o.status === 'withdrawn' ? 'republish' : 'publish'}
            requestId={randomUUID()}
          />
        </div>
      </div>
      {/* 待確認：卡片與兩個對話框都在 client 元件裡，對話框放在卡片清單外面——確認或婉拒後頁面重新整理、那張卡移走或消失，回饋還看得到。 */}
      <PendingGroups cards={item.pending.map(toCard)} opportunityName={name} requestId={requestId} reasonMaxLength={CHANGE_REASON_MAX_LENGTH} />
      <section aria-label="已帶的組" className="rounded-lg border border-border/70 bg-muted/30 p-3">
        <h3 className="text-xs font-bold text-muted-foreground">
          已帶的組{item.advised.length > 0 ? `・${item.advised.length} 組` : ''}
        </h3>
        {item.advised.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">還沒有你指導的組。</p>
        ) : (
          <ul className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {item.advised.map((g) => {
              const card = toCard(g)
              return (
                <li key={g.groupId} data-testid={`industry-group-${g.groupCode}`} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-[15px] font-bold text-foreground">
                      <span className="tabular">{g.groupCode}</span>
                      <span className="text-xs font-normal text-muted-foreground">・{card.cohortLabel}</span>
                    </p>
                    <Pill tone="success">你指導中</Pill>
                  </div>
                  <MemberAvatars code={g.groupCode} members={card.members} size={32} />
                  <p className="text-sm text-muted-foreground">
                    {card.members.length} 人{card.leaderName ? `・組長 ${card.leaderName}` : ''}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </li>
  )
}

function toCard(g: Card): PendingGroupCard {
  return {
    groupId: g.groupId,
    groupCode: g.groupCode,
    cohortLabel: cohortLabel({ name: g.cohortName, code: g.cohortCode }),
    linkState: g.linkState,
    leaderName: g.members.find((m) => m.isLeader)?.name ?? null,
    members: g.members.map((m) => ({ userId: m.userId, name: m.name, isLeader: m.isLeader, avatarPreset: m.avatarPreset, avatarFileId: m.avatarFileId })),
    advisorName: g.advisor?.teacherName ?? null,
  }
}

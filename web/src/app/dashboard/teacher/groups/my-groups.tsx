import Link from 'next/link'
import { IconChevronRight, IconSchool } from '@tabler/icons-react'
import type { GroupSummary } from '@/application/groups'
import { Panel, PanelEmpty, Pill } from '@/app/dashboard/teacher/_ui/dash'
import { GROUP_TYPE_LABEL } from '@/composition/groups'

const AFFAIRS_HREF = '/dashboard/teacher/affairs'

/**
 * 分組總覽「我的組別」分頁上半：「我指導的組」，一組一張卡（TE-05，Q77）。
 *
 * 卡上：組號・組長姓名、組別類型、組員；整張卡連到作業區（作業區的「各組繳交」就是這幾組一組一張卡）。
 * 只用頁面已經讀到的 `cohortGroups`，不另外查。
 */
export function MyGroups({ groups }: { groups: readonly GroupSummary[] }) {
  return (
    <Panel title="我指導的組" icon={<IconSchool />} description={groups.length > 0 ? `${groups.length} 組` : undefined}>
      {groups.length === 0 ? (
        <PanelEmpty icon={<IconSchool />} title="你目前沒有指導中的組別。" hint="產學組可以在下面「擔任產學組指導老師」自己擔任。" />
      ) : (
        <ul aria-label="我指導的組" className="grid gap-3 px-5 pb-5 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => {
            const leader = g.members.find((m) => m.isLeader)?.name ?? null
            const others = g.members.filter((m) => !m.isLeader).map((m) => m.name)
            return (
              <li key={g.id} data-testid={`my-group-${g.code}`}>
                <Link
                  href={AFFAIRS_HREF}
                  aria-label={`${g.code}${leader ? `・組長 ${leader}` : ''}：到作業區看這一組的作業`}
                  className="group flex h-full min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/30"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-[15px] font-bold text-foreground">
                      <span className="tabular">{g.code}</span>
                      {leader ? `・${leader}` : ''}
                    </p>
                    <Pill tone={g.groupType === 'industry' ? 'brand' : 'default'}>{GROUP_TYPE_LABEL[g.groupType]}</Pill>
                  </div>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {g.members.length} 人{others.length > 0 ? `・${others.join('、')}` : ''}
                  </p>
                  <span className="mt-auto inline-flex items-center gap-0.5 text-xs font-semibold text-muted-foreground group-hover:text-foreground">
                    看作業 <IconChevronRight className="size-3.5" />
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

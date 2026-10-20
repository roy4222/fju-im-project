import Link from 'next/link'
import { IconChevronRight, IconSchool } from '@tabler/icons-react'
import type { GroupSummary } from '@/application/groups'
import { Panel, PanelEmpty, Pill } from '@/app/dashboard/teacher/_ui/dash'
import { MemberAvatars } from '@/app/dashboard/teacher/groups/claim-button'
import { GROUP_TYPE_LABEL } from '@/composition/groups'

/** 作業區預設是「我的作業」（C1-10）；從指導的組點進去要落在「指導組別的繳交」分頁。 */
const AFFAIRS_HREF = '/dashboard/teacher/affairs?tab=submissions'

/**
 * 分組總覽「我指導的組」分頁：一組一張卡（TE-05，Q77；C3-09 規格③ §7.1 加組員頭像一列與合作案名稱）。
 *
 * 卡上：組號・組長姓名、組別類型、組員頭像（32px）與人數、產學組的合作案名稱；整張卡連到作業區「指導組別的繳交」。
 * 只用頁面已經讀到的 `cohortGroups`，不另外查。
 */
export function MyGroups({ groups }: { groups: readonly GroupSummary[] }) {
  return (
    <Panel title="我指導的組" icon={<IconSchool />} description={groups.length > 0 ? `${groups.length} 組` : undefined}>
      {groups.length === 0 ? (
        <PanelEmpty icon={<IconSchool />} title="你還沒有指導的組" hint="學生選了你的合作案成組後，到「產學組」分頁按「確認指導」就會出現在這裡。" />
      ) : (
        <ul aria-label="我指導的組" className="grid gap-3 px-5 pb-5 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => {
            const leader = g.members.find((m) => m.isLeader)?.name ?? null
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
                  <MemberAvatars
                    code={g.code}
                    members={g.members.map((m) => ({ userId: m.userId, name: m.name, isLeader: m.isLeader, avatarPreset: m.avatarPreset, avatarFileId: m.avatarFileId }))}
                    size={32}
                  />
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {g.members.length} 人{g.groupType === 'industry' ? `・${g.opportunity ? `合作案：${g.opportunity.name}` : '還沒有合作案'}` : ''}
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

import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { UserAvatar } from '@/app/_ui/avatar/user-avatar'
import { PANEL_TABLE_HEAD, PANEL_TABLE_ROW, Panel, PanelEmpty, Pill } from '@/app/_ui/dashboard/primitives'
import { JoinGroupButton, UnassignedForms, VoidProposalButton } from '@/app/dashboard/admin/groups/unassigned/forms'
import { CHANGE_REASON_MAX_LENGTH } from '@/composition/groups'
import { describeUnassignedStatus, getUnassignedQuery, skillChips, summarizeUnassigned, unassignedStatus } from '@/composition/unassigned'

/**
 * 「未分組學生」名單（C3-15；設計方案③ §6.3、AC-C3-19）。Server Component：一屆的未分組學生一次讀完，
 * 每列頭像 32px、姓名（連到「帳號」那一列，A16）、學號、系級、狀態、技能膠囊（最多 3 個＋「+N」）、動作。
 *
 * 狀態與動作：可加入、公開找隊員（綠點）→「加入組別」；在建立中的組別裡 →「終止建立」（不能直接加入）。
 * 對話框在 `forms.tsx`（client）。
 */
export async function UnassignedStudents({ cohortId, size }: { cohortId: string; size: { min: number; max: number } }) {
  const roster = await getUnassignedQuery().roster(cohortId)

  return (
    <Panel title="未分組學生" aria-label="未分組學生">
      <UnassignedForms
        groups={roster.groups.map((g) => ({ ...g }))}
        size={size}
        requestIds={{ join: randomUUID(), void: randomUUID() }}
        reasonMaxLength={CHANGE_REASON_MAX_LENGTH}
      >
        <p className="tabular px-5 pb-3 text-sm text-muted-foreground" data-testid="unassigned-summary">
          {summarizeUnassigned(roster.students)}
        </p>
        {roster.students.length === 0 ? (
          <PanelEmpty title="本屆沒有未分組的學生" hint="還沒加入組別的學生會列在這裡；學生名單在「帳號」匯入。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className={PANEL_TABLE_HEAD}>
                  <th scope="col" className="px-5 py-2.5 font-semibold">姓名</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">學號</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">系級</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">狀態</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">技能</th>
                  <th scope="col" className="px-5 py-2.5">
                    <span className="sr-only">動作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {roster.students.map((s) => {
                  const status = unassignedStatus(s)
                  const chips = skillChips(s.skills)
                  return (
                    <tr key={s.userId} className={PANEL_TABLE_ROW} data-testid="unassigned-row">
                      <td className="px-5 py-2.5">
                        <span className="flex items-center gap-2.5">
                          <UserAvatar
                            size={32}
                            decorative
                            user={{ id: s.userId, name: s.name, avatarPreset: s.avatarPreset, avatarFileId: s.avatarFileId }}
                          />
                          <Link
                            href={`/dashboard/admin/accounts?q=${encodeURIComponent(s.studentNo)}`}
                            className="font-semibold text-foreground hover:text-primary hover:underline"
                          >
                            {s.name}
                          </Link>
                        </span>
                      </td>
                      <td className="tabular px-4 py-2.5">{s.studentNo}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{s.departmentClass ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-1.5 text-sm">
                          {status === 'open_to_join' ? <span className="size-2 shrink-0 rounded-full bg-success" data-testid="open-dot" aria-hidden /> : null}
                          <span className={status === 'in_proposal' ? 'text-muted-foreground' : undefined}>{describeUnassignedStatus(s)}</span>
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        {chips.shown.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <ul className="flex flex-wrap gap-1" aria-label={`${s.name}的技能`}>
                            {chips.shown.map((skill) => (
                              <li key={skill}>
                                <Pill>{skill}</Pill>
                              </li>
                            ))}
                            {chips.more > 0 ? (
                              <li>
                                <Pill title={s.skills.slice(chips.shown.length).join('、')}>+{chips.more}</Pill>
                              </li>
                            ) : null}
                          </ul>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        {s.proposal ? (
                          <VoidProposalButton proposalId={s.proposal.id} proposerName={s.proposal.proposerName} />
                        ) : (
                          <JoinGroupButton name={s.name} studentNo={s.studentNo} openToJoin={s.openToJoin} />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </UnassignedForms>
    </Panel>
  )
}

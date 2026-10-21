'use client'
import { useActionState, useState } from 'react'
import { IconAlertTriangle, IconCheck, IconUsersGroup, IconX } from '@tabler/icons-react'
import { claimGroupAction, declineGroupAction } from './actions'
import { AvatarImg } from '@/app/_ui/avatar/avatar-img'
import { Badge } from '@/app/_ui/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/app/_ui/ui/tooltip'
import { DataTable, type Column } from '@/app/dashboard/teacher/_ui/data-table'
import { DIALOG, GHOST_BUTTON, OUTLINE_BUTTON_SM, Panel, Pill, PRIMARY_BUTTON, StampMark, TEXTAREA } from '@/app/dashboard/teacher/_ui/dash'
import { cn } from '@/shared/cn'

/**
 * 老師「分組總覽」會動的部分（票 19、37；C3-09 規格③ §7.1、§7.2 改成「確認指導／婉拒」）。
 *
 * - `PendingGroups`：產學組分頁每一案底下「待確認要帶的組」——卡片（組員頭像一列、組長）＋「確認指導」「婉拒」，
 *   兩個對話框放在卡片清單外面：確認成功或撞到系辦剛指派別人，頁面都會重新整理、那張卡移走或消失，
 *   對話框與回饋不會跟著一起不見。衝突訊息是伺服器回的句子（點名是誰）。
 * - `TeacherGroupsBoard`：全部組別分頁的可搜尋、篩選、排序資料表，每列組員頭像一列、指導老師（自己標「你」）。
 *   這裡沒有任何「擔任／認領」入口：產學組由負責老師在產學組分頁確認，一般組由系辦指派。
 */

export type ClaimActionState = { ok: boolean; conflict: boolean; message: string } | undefined
export type DeclineActionState = { ok: boolean; message: string } | undefined

export type CardMember = { userId: string; name: string; isLeader: boolean; avatarPreset: number | null; avatarFileId: string | null }

/** 「待確認要帶的組」一張卡要的資料（伺服器端算好 `cohortLabel`）。 */
export type PendingGroupCard = {
  groupId: string
  groupCode: string
  cohortLabel: string
  /** `pending`＝學生選了這一案等確認；`active`＝TE-B3／系辦直接連上來、還沒有指導老師。 */
  linkState: 'pending' | 'active'
  leaderName: string | null
  members: readonly CardMember[]
  /**
   * 系辦已指派的指導老師（CL-3，Roy 10/21）：連結還在等確認、系辦先指派了別的老師時才有；
   * 這時「確認」只確認合作案（指導老師不變），「婉拒」只結束連結。沒有指導老師是 null。
   */
  advisorName: string | null
}

export type GroupRow = {
  groupId: string
  code: string
  industry: boolean
  typeLabel: string
  members: readonly CardMember[]
  /** 搜尋與 tooltip 用的文字：「甲（組長）、乙、丙」。 */
  memberText: string
  advisorName: string | null
  advisorUserId: string | null
  mine: boolean
  opportunityName: string | null
}

/** 組員頭像一列（C3 §2.2）：`alt` 是姓名（名字沒有另外寫出來，報讀器要唸）。不含登入信箱。 */
export function MemberAvatars({ code, members, size }: { code: string; members: readonly CardMember[]; size: 24 | 32 }) {
  return (
    <ul aria-label={`${code} 的組員`} className={cn('flex flex-wrap items-center', size === 32 ? '-space-x-2' : '-space-x-1.5')}>
      {members.map((m) => (
        <li key={m.userId} className="shrink-0">
          <AvatarImg
            user={{ id: m.userId, name: m.name, avatarPreset: m.avatarPreset, avatarFileId: m.avatarFileId }}
            size={size}
            className={cn('ring-2 ring-card', m.isLeader && 'ring-primary/60')}
          />
        </li>
      ))}
    </ul>
  )
}

// ── 待確認要帶的組：卡片＋確認指導／婉拒 ────────────────────────────────────────

export function PendingGroups({
  cards,
  opportunityName,
  requestId,
  reasonMaxLength,
}: {
  cards: readonly PendingGroupCard[]
  opportunityName: string
  requestId: string
  reasonMaxLength: number
}) {
  const [claimState, claimAction, claimPending] = useActionState(claimGroupAction, undefined)
  const [declineState, declineAction, declinePending] = useActionState(declineGroupAction, undefined)
  const [picked, setPicked] = useState<{ kind: 'claim' | 'decline'; card: PendingGroupCard } | null>(null)
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null)

  const open = (kind: 'claim' | 'decline', card: PendingGroupCard) => {
    setPicked({ kind, card })
    dialog?.showModal()
  }

  return (
    <section aria-label="待確認要帶的組" className="rounded-lg border border-border/70 bg-muted/30 p-3">
      <h3 className="text-xs font-bold text-muted-foreground">待確認要帶的組{cards.length > 0 ? `・${cards.length} 組` : ''}</h3>
      {cards.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">目前沒有等你確認的組。學生選了這一案成組後會出現在這裡。</p>
      ) : (
        <ul className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((c) => (
            <li key={c.groupId} data-testid={`industry-group-${c.groupCode}`} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 truncate text-[15px] font-bold text-foreground">
                  <span className="tabular">{c.groupCode}</span>
                  <span className="text-xs font-normal text-muted-foreground">・{c.cohortLabel}</span>
                </p>
                <Pill tone="brand">{c.linkState === 'pending' ? '學生已選案' : '已連結'}</Pill>
              </div>
              <MemberAvatars code={c.groupCode} members={c.members} size={32} />
              <p className="text-sm text-muted-foreground">
                {c.members.length} 人{c.leaderName ? `・組長 ${c.leaderName}` : ''}
              </p>
              {c.advisorName ? <p className="text-sm text-muted-foreground">指導老師：{c.advisorName}（系辦指派）</p> : null}
              <div className="mt-auto flex flex-wrap gap-2">
                <button
                  type="button"
                  className={cn(OUTLINE_BUTTON_SM, 'border-primary/40 text-primary')}
                  aria-label={`${c.advisorName ? '確認合作案' : '確認指導'}：${c.groupCode}`}
                  onClick={() => open('claim', c)}
                >
                  <IconCheck /> {c.advisorName ? '確認合作案' : '確認指導'}
                </button>
                <button type="button" className={OUTLINE_BUTTON_SM} aria-label={`婉拒：${c.groupCode}`} onClick={() => open('decline', c)}>
                  婉拒
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <dialog
        ref={setDialog}
        aria-label={
          picked
            ? picked.kind === 'claim'
              ? picked.card.advisorName
                ? `確認 ${picked.card.groupCode} 的合作案？`
                : `確認指導 ${picked.card.groupCode}？`
              : `婉拒 ${picked.card.groupCode}？`
            : '確認指導'
        }
        className={DIALOG}
      >
        {picked?.kind === 'claim' ? (
          // 換一組就重新掛表單：上一組的結果不會留在下一組的對話框裡。key 不含請求編號——
          // 確認後頁面重新整理會換新的編號，表單不能因此重掛、把剛拿到的結果洗掉。
          <ClaimForm
            key={`claim-${picked.card.groupId}`}
            card={picked.card}
            opportunityName={opportunityName}
            requestId={requestId}
            state={claimState}
            formAction={claimAction}
            pending={claimPending}
            onClose={() => dialog?.close()}
          />
        ) : picked?.kind === 'decline' ? (
          <DeclineForm
            key={`decline-${picked.card.groupId}`}
            card={picked.card}
            opportunityName={opportunityName}
            requestId={requestId}
            reasonMaxLength={reasonMaxLength}
            state={declineState}
            formAction={declineAction}
            pending={declinePending}
            onClose={() => dialog?.close()}
          />
        ) : null}
      </dialog>
    </section>
  )
}

function CloseX({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" onClick={onClose} aria-label="關閉對話框" className={cn(GHOST_BUTTON, 'absolute top-2 right-2 size-7 px-0')}>
      <IconX />
    </button>
  )
}

function Failure({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  return (
    <div className="relative flex flex-col items-center gap-3 p-6 text-center">
      <CloseX onClose={onClose} />
      <span className="inline-flex size-12 items-center justify-center rounded-full bg-warning-subtle text-warning-on-subtle">
        <IconAlertTriangle className="size-6" />
      </span>
      <h2 className="text-lg font-extrabold text-foreground">{title}</h2>
      <p role="alert" className="text-sm text-muted-foreground">
        {message}
      </p>
    </div>
  )
}

function ClaimForm({
  card,
  opportunityName,
  requestId,
  state,
  formAction,
  pending,
  onClose,
}: {
  card: PendingGroupCard
  opportunityName: string
  requestId: string
  state: ClaimActionState
  formAction: (formData: FormData) => void
  pending: boolean
  onClose: () => void
}) {
  // 只顯示「這一組」按下去之後的結果：共用的 action 狀態在打開這一組時可能還是上一組的，記下當時那一份當基準。
  const [baseline] = useState(state)
  const result = state !== baseline && !pending ? state : undefined

  const linkOnly = card.advisorName !== null

  if (result?.ok) {
    return (
      <div className="relative flex flex-col items-center gap-3 p-6 text-center">
        <CloseX onClose={onClose} />
        <StampMark>
          <IconCheck className="size-4" strokeWidth={3} />
          {linkOnly ? '已確認合作案' : '你已是指導老師'}
        </StampMark>
        <h2 className="text-lg font-extrabold text-foreground">{linkOnly ? `${card.groupCode} 的合作案已確認` : `${card.groupCode} 已指定為你的組別`}</h2>
        <p role="status" className="text-sm text-muted-foreground">
          {result.message}
        </p>
      </div>
    )
  }
  if (result && !result.ok) return <Failure title={result.conflict ? '已有其他老師擔任' : '沒有成功'} message={result.message} onClose={onClose} />
  return (
    <form action={formAction} className="relative flex flex-col gap-4 p-6">
      <CloseX onClose={onClose} />
      <div className="pr-8">
        <h2 className="text-lg font-extrabold text-foreground">{linkOnly ? `確認 ${card.groupCode} 的合作案？` : `確認指導 ${card.groupCode}？`}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {card.members.length} 人{card.leaderName ? `・組長 ${card.leaderName}` : ''}，選了「{opportunityName}」。
          {linkOnly
            ? `系辦已指派 ${card.advisorName} 老師指導這一組；確認後合作案連結成立，指導老師維持 ${card.advisorName} 老師。`
            : '確認後你就是這一組的指導老師，全組會收到通知。'}
        </p>
      </div>
      <input type="hidden" name="groupId" value={card.groupId} />
      <input type="hidden" name="requestId" value={requestId} />
      <button type="submit" disabled={pending} className={cn(PRIMARY_BUTTON, 'w-full')}>
        {pending ? '處理中…' : linkOnly ? '確認合作案' : '確認指導'}
      </button>
    </form>
  )
}

function DeclineForm({
  card,
  opportunityName,
  requestId,
  reasonMaxLength,
  state,
  formAction,
  pending,
  onClose,
}: {
  card: PendingGroupCard
  opportunityName: string
  requestId: string
  reasonMaxLength: number
  state: DeclineActionState
  formAction: (formData: FormData) => void
  pending: boolean
  onClose: () => void
}) {
  const [baseline] = useState(state)
  const result = state !== baseline && !pending ? state : undefined
  const reasonId = `decline-reason-${card.groupId}`

  if (result?.ok) {
    return (
      <div className="relative flex flex-col items-center gap-3 p-6 text-center">
        <CloseX onClose={onClose} />
        <h2 className="text-lg font-extrabold text-foreground">已婉拒 {card.groupCode}</h2>
        <p role="status" className="text-sm text-muted-foreground">
          {result.message}
        </p>
      </div>
    )
  }
  if (result && !result.ok) return <Failure title="沒有成功" message={result.message} onClose={onClose} />
  return (
    <form action={formAction} className="relative flex flex-col gap-4 p-6">
      <CloseX onClose={onClose} />
      <div className="pr-8">
        <h2 className="text-lg font-extrabold text-foreground">婉拒 {card.groupCode}？</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          婉拒後這一組與「{opportunityName}」的連結會結束，全組會收到通知、要重新選合作案
          {card.advisorName ? `（指導老師維持 ${card.advisorName} 老師）` : ''}。理由只有你與系辦看得到。
        </p>
      </div>
      <input type="hidden" name="groupId" value={card.groupId} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={reasonId} className="text-sm font-semibold text-foreground">
          理由（可不填）
        </label>
        <textarea id={reasonId} name="reason" rows={3} maxLength={reasonMaxLength} placeholder="例：題目方向與這一組的技術背景不合" className={TEXTAREA} />
      </div>
      <button type="submit" disabled={pending} className={cn(PRIMARY_BUTTON, 'w-full')}>
        {pending ? '處理中…' : '確定婉拒'}
      </button>
    </form>
  )
}

// ── 全部組別 ──────────────────────────────────────────────────────────────────

export function TeacherGroupsBoard({ groups, teacherOptions }: { groups: GroupRow[]; teacherOptions: { value: string; label: string }[] }) {
  const columns: Column<GroupRow>[] = [
    {
      id: 'code',
      label: '組別',
      width: 'w-[104px]',
      sortValue: (g) => g.code,
      cell: (g) => <span className="tabular text-sm font-semibold">{g.code}</span>,
    },
    {
      id: 'type',
      label: '類型',
      width: 'w-[104px]',
      sortValue: (g) => g.typeLabel,
      cell: (g) =>
        g.industry ? (
          <Badge variant="outline" className="border-primary/30 bg-primary-subtle text-[11px] text-primary-on-subtle">
            {g.typeLabel}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[11px] text-muted-foreground">
            {g.typeLabel}
          </Badge>
        ),
    },
    {
      id: 'advisor',
      label: '指導老師',
      width: 'w-[140px]',
      sortValue: (g) => g.advisorName ?? '',
      cell: (g) =>
        g.advisorName ? (
          <span className={cn('text-sm', g.mine && 'font-semibold')}>
            {g.advisorName}
            {g.mine ? '（你）' : ''}
          </span>
        ) : (
          <span className="text-sm font-semibold text-destructive">尚未指派</span>
        ),
    },
    {
      id: 'members',
      label: '組員',
      width: 'w-[260px]',
      cell: (g) => (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="flex items-center gap-2">
                <MemberAvatars code={g.code} members={g.members} size={24} />
                <span className="tabular text-xs text-muted-foreground">{g.members.length} 人</span>
              </span>
            }
          />
          <TooltipContent className="max-w-xs">{g.memberText}</TooltipContent>
        </Tooltip>
      ),
    },
    {
      id: 'opportunity',
      label: '合作案',
      width: 'w-[200px]',
      sortValue: (g) => g.opportunityName ?? '',
      cell: (g) =>
        g.industry ? (
          <span className="block truncate text-sm text-muted-foreground">{g.opportunityName ?? '尚未選案'}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
  ]

  return (
    <Panel title="全部組別" icon={<IconUsersGroup />} description="可搜尋、排序、篩選" bodyClassName="p-4">
      <DataTable
        rows={groups}
        columns={columns}
        rowKey={(g) => g.groupId}
        search={{ placeholder: '搜尋組別或組員…', text: (g) => `${g.code} ${g.memberText}` }}
        facets={[
          {
            id: 'type',
            label: '類型',
            options: [
              { value: '一般專題', label: '一般專題' },
              { value: '產學合作', label: '產學合作' },
            ],
            value: (g) => g.typeLabel,
          },
          {
            id: 'advisor',
            label: '指導老師',
            options: [...teacherOptions, { value: 'unassigned', label: '尚未指派' }],
            value: (g) => g.advisorUserId ?? 'unassigned',
          },
        ]}
        emptyTitle="本屆還沒有成立的組別"
        emptyHint="成員全數確認後，組別會自動成立並出現在這裡。"
      />
    </Panel>
  )
}

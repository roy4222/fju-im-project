'use client'
import { useActionState, useState } from 'react'
import { IconAlertTriangle, IconCheck, IconHandGrab, IconUsersGroup, IconX } from '@tabler/icons-react'
import { claimGroupAction } from './actions'
import { Badge } from '@/app/_ui/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/app/_ui/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/app/_ui/ui/tooltip'
import { DataTable, type Column } from '@/app/dashboard/teacher/_ui/data-table'
import { DIALOG, GHOST_BUTTON, OUTLINE_BUTTON_SM, Panel, PanelEmpty, Pill, PRIMARY_BUTTON, StampMark } from '@/app/dashboard/teacher/_ui/dash'
import { cn } from '@/shared/cn'

/**
 * 老師「分組總覽」會動的部分（票 19；票 37 照原型 `ClaimPanel`＋`ClaimDialog`＋`GroupsTable`）。
 *
 * 上面「產學組認領」一張表：可認領、你指導中、已被認領（誰）；下面「全部組別」是可搜尋、篩選、排序的資料表。
 * 兩張表的「認領」都打開**同一個**對話框：認領成功或撞到別的老師先認領，頁面都會重新整理、那一列換成新狀態——
 * 對話框與回饋放在表格外面，才不會跟著那一列一起不見。衝突訊息是伺服器回的句子（點名是誰先認領）。
 */

export type ClaimActionState = { ok: boolean; conflict: boolean; message: string } | undefined

export type ClaimRow = {
  groupId: string
  code: string
  memberCount: number
  leaderName: string | null
  state: 'open' | 'mine' | 'taken'
  advisorName: string | null
  /** 連結的合作案（公司・部門）；還沒連結是 null。 */
  opportunityName: string | null
}

export type GroupRow = {
  groupId: string
  code: string
  industry: boolean
  typeLabel: string
  members: string
  memberCount: number
  advisorName: string | null
  advisorUserId: string | null
  mine: boolean
  claimable: boolean
}

function ClaimState({ row }: { row: ClaimRow }) {
  if (row.state === 'open') return <Pill tone="brand">可認領</Pill>
  if (row.state === 'mine') return <Pill tone="success">你指導中</Pill>
  return <Pill>已被認領・{row.advisorName ?? ''}</Pill>
}

function ClaimButton({ code, onClick }: { code: string; onClick: () => void }) {
  return (
    <button type="button" className={OUTLINE_BUTTON_SM} aria-label={`認領 ${code}`} onClick={onClick}>
      <IconHandGrab /> 認領
    </button>
  )
}

export function TeacherGroupsBoard({
  claimRows,
  groups,
  teacherOptions,
  requestId,
}: {
  claimRows: ClaimRow[]
  groups: GroupRow[]
  teacherOptions: { value: string; label: string }[]
  requestId: string
}) {
  const [state, formAction, pending] = useActionState(claimGroupAction, undefined)
  const [picked, setPicked] = useState<ClaimRow | null>(null)
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null)
  const openCount = claimRows.filter((r) => r.state === 'open').length

  const open = (groupId: string) => {
    const row = claimRows.find((r) => r.groupId === groupId)
    if (!row) return
    setPicked(row)
    dialog?.showModal()
  }

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
          <TooltipTrigger render={<span className="block truncate text-sm text-muted-foreground">{g.members}</span>} />
          <TooltipContent className="max-w-xs">{g.members}</TooltipContent>
        </Tooltip>
      ),
    },
    {
      id: 'count',
      label: '人數',
      width: 'w-[80px]',
      sortValue: (g) => g.memberCount,
      cell: (g) => <span className="tabular text-sm">{g.memberCount} 人</span>,
    },
    {
      id: 'actions',
      label: '操作',
      width: 'w-[120px]',
      hideable: false,
      cell: (g) =>
        g.claimable ? <ClaimButton code={g.code} onClick={() => open(g.groupId)} /> : <span className="text-xs text-muted-foreground">—</span>,
    },
  ]

  return (
    <>
      <Panel
        title="產學組認領"
        icon={<IconHandGrab />}
        description={`可認領 ${openCount} 組・先按先得，同時操作只有一位會成功`}
      >
        {claimRows.length === 0 ? (
          <PanelEmpty icon={<IconHandGrab />} title="本屆還沒有產學組" hint="學生成組時選「產學合作」，組別就會出現在這裡等老師認領。" />
        ) : (
          <div className="px-3 pb-3">
            <Table>
              <TableHeader>
                <TableRow className="hover:[&>td]:bg-transparent">
                  <TableHead className="w-20">組別</TableHead>
                  <TableHead className="min-w-[8.5rem]">組員</TableHead>
                  <TableHead className="hidden md:table-cell">合作案</TableHead>
                  <TableHead className="w-32">狀態</TableHead>
                  <TableHead className="w-24 text-right">動作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {claimRows.map((r) => (
                  <TableRow key={r.groupId} className={r.state === 'open' ? '' : 'text-muted-foreground'}>
                    <TableCell className="tabular text-xs font-semibold">{r.code}</TableCell>
                    {/* 窄螢幕欄寬不夠時，只在「人數」「組長」「合作案」這幾段之間換行，不會一個字一行。 */}
                    <TableCell className="min-w-[8.5rem] max-w-[18rem] font-semibold whitespace-normal text-foreground md:truncate md:whitespace-nowrap">
                      <span className="whitespace-nowrap">{r.memberCount} 人</span>
                      {r.leaderName ? <span className="whitespace-nowrap">・組長 {r.leaderName}</span> : null}
                      <span className="block text-xs font-normal break-words text-muted-foreground md:hidden">{r.opportunityName ?? '尚未連結合作案'}</span>
                    </TableCell>
                    <TableCell className="hidden max-w-[16rem] truncate md:table-cell">{r.opportunityName ?? '尚未連結'}</TableCell>
                    <TableCell>
                      <ClaimState row={r} />
                    </TableCell>
                    <TableCell className="text-right">
                      {r.state === 'open' ? <ClaimButton code={r.code} onClick={() => open(r.groupId)} /> : <span className="text-xs">—</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      <Panel title="全部組別" icon={<IconUsersGroup />} description="可搜尋、排序、篩選" bodyClassName="p-4">
        <DataTable
          rows={groups}
          columns={columns}
          rowKey={(g) => g.groupId}
          search={{ placeholder: '搜尋組別或組員…', text: (g) => `${g.code} ${g.members}` }}
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

      <dialog ref={setDialog} aria-label={picked ? `認領 ${picked.code}` : '認領組別'} className={DIALOG}>
        {picked ? (
          // 換一組就重新掛表單：上一組的結果不會留在下一組的對話框裡。key 不含請求編號——
          // 認領後頁面重新整理會換新的編號，表單不能因此重掛、把剛拿到的結果洗掉。
          <ClaimForm
            key={picked.groupId}
            row={picked}
            requestId={requestId}
            state={state}
            formAction={formAction}
            pending={pending}
            onClose={() => dialog?.close()}
          />
        ) : null}
      </dialog>
    </>
  )
}

function ClaimForm({
  row,
  requestId,
  state,
  formAction,
  pending,
  onClose,
}: {
  row: ClaimRow
  requestId: string
  state: ClaimActionState
  formAction: (formData: FormData) => void
  pending: boolean
  onClose: () => void
}) {
  // 只顯示「這一組」按下去之後的結果：共用的 action 狀態在打開這一組時可能還是上一組的，記下當時那一份當基準。
  const [baseline] = useState(state)
  const result = state !== baseline && !pending ? state : undefined
  const close = (
    <button type="button" onClick={onClose} aria-label="關閉對話框" className={cn(GHOST_BUTTON, 'absolute top-2 right-2 size-7 px-0')}>
      <IconX />
    </button>
  )

  if (result?.ok) {
    return (
      <div className="relative flex flex-col items-center gap-3 p-6 text-center">
        {close}
        <StampMark>
          <IconCheck className="size-4" strokeWidth={3} />
          已認領
        </StampMark>
        <h2 className="text-lg font-extrabold text-foreground">{row.code} 已指定為你的組別</h2>
        <p role="status" className="text-sm text-muted-foreground">
          {result.message}
        </p>
      </div>
    )
  }
  if (result && !result.ok) {
    return (
      <div className="relative flex flex-col items-center gap-3 p-6 text-center">
        {close}
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-warning-subtle text-warning-on-subtle">
          <IconAlertTriangle className="size-6" />
        </span>
        <h2 className="text-lg font-extrabold text-foreground">{result.conflict ? '已被其他老師認領' : '沒有認領成功'}</h2>
        <p role="alert" className="text-sm text-muted-foreground">
          {result.message}
        </p>
      </div>
    )
  }
  return (
    <form action={formAction} className="relative flex flex-col gap-4 p-6">
      {close}
      <div className="pr-8">
        <h2 className="text-lg font-extrabold text-foreground">認領 {row.code}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {row.memberCount} 人{row.leaderName ? `・組長 ${row.leaderName}` : ''}。先按先得；同時操作只有一位會成功。
          認領後全組會收到通知；之後要換老師請洽系辦重派。
        </p>
      </div>
      <input type="hidden" name="groupId" value={row.groupId} />
      <input type="hidden" name="requestId" value={requestId} />
      <button type="submit" disabled={pending} className={cn(PRIMARY_BUTTON, 'w-full')}>
        {pending ? '處理中…' : '指定為我的組別'}
      </button>
    </form>
  )
}

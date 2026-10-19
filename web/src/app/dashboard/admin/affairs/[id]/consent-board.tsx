import { randomUUID } from 'node:crypto'
import { IconCheck, IconMinus, IconX } from '@tabler/icons-react'
import { UserAvatar } from '@/app/_ui/avatar/user-avatar'
import { CreatePackageButton, type DangerFacts, RemindButton, RestartButton, VoidButton } from '@/app/dashboard/admin/signoff/manage-forms'
import type { ConsentBoardPerson, ConsentBoardRow, ConsentItemBoard, RestartKind } from '@/application/signoff'
import { MAX_REASON_CHARS, PURPOSE_LABEL, restartKindFor } from '@/composition/signoff'
import { cn } from '@/shared/cn'

/**
 * 系辦「繳交狀況」的同意書看板（C 階段規格① §6.3、AC-21、AC-25、AC-25a；資料 `SignoffQuery.itemBoard`）。
 *
 * 每個對象組一塊：組別、狀態（收集中 3／5、等老師、已完成、退回修正中、已作廢）、組員頭像列（已同意綠勾／未表態灰／不同意紅）、老師；
 * 按鈕「提醒未同意者」「匯出 CSV／列印版」「重新收集」或「重開」「作廢」（理由都選填）。
 * 沒建包的組寫「尚未建立：沒有指導老師」＋「建立」（指派老師後按）。版本號與檢查碼不顯示（匯出 CSV 仍有）。
 */

const SKIP_TEXT = { no_advisor: '沒有指導老師', no_members: '沒有組員' } as const

const RESTART_UI: Readonly<Record<RestartKind, { button: string; title: string; confirm: string }>> = {
  reset: { button: '重新收集', title: '重新收集同意？', confirm: '確定重新收集' },
  reopen: { button: '重開', title: '重開新版？', confirm: '確定重開' },
}

function stateText(row: ConsentBoardRow): string {
  const agreed = row.students.filter((s) => s.result === 'agree').length
  switch (row.state) {
    case 'collecting':
      return `收集中 ${agreed}／${row.students.length}`
    case 'teacher_pending':
      return '等老師'
    case 'complete':
      return '已完成'
    case 'revision':
      return '退回修正中'
    case 'void':
      return '已作廢'
    case 'superseded':
      return '已失效'
    default:
      return row.skipped ? `尚未建立：${SKIP_TEXT[row.skipped]}` : '尚未建立'
  }
}

function Person({ p, advisor }: { p: ConsentBoardPerson; advisor?: boolean }) {
  const mark =
    p.result === 'agree' ? (
      <IconCheck className="size-3.5 text-success-on-subtle" aria-label="已同意" />
    ) : p.result ? (
      <IconX className="size-3.5 text-danger" aria-label={p.result === 'return' ? '退回' : '不同意'} />
    ) : (
      <IconMinus className="size-3.5 text-muted-foreground" aria-label="還沒表態" />
    )
  return (
    <li className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1 text-xs" data-testid="board-person">
      <UserAvatar user={{ id: p.userId, name: p.name, avatarPreset: p.avatarPreset, avatarFileId: p.avatarFileId }} size={24} decorative />
      <span className={cn(p.result === 'agree' && 'font-semibold')}>{p.name}</span>
      {advisor ? <span className="text-muted-foreground">老師</span> : null}
      {mark}
    </li>
  )
}

function facts(board: ConsentItemBoard, row: ConsentBoardRow, effect: string, undo: string): DangerFacts {
  return {
    target: `${row.groupCode}「${board.itemTitle}」（${PURPOSE_LABEL[board.purpose]}）`,
    scope: `只有 ${row.groupCode} 這一組。`,
    effect,
    undo,
  }
}

function RowActions({ board, row, archived }: { board: ConsentItemBoard; row: ConsentBoardRow; archived: boolean }) {
  if (!row.versionId || !row.state) {
    return archived ? null : <CreatePackageButton itemId={board.itemId} groupId={row.groupId} groupCode={row.groupCode} requestId={randomUUID()} />
  }
  const kind = restartKindFor(row.state)
  const pending = row.state === 'collecting' || row.state === 'teacher_pending'
  return (
    <div className="flex flex-wrap items-start gap-2">
      {pending && !archived ? <RemindButton versionId={row.versionId} requestId={randomUUID()} blockedReason={null} /> : null}
      {(['csv', 'printable'] as const).map((format) => (
        <form key={format} method="post" action={`/api/admin/signoff/${row.versionId}/export`} target="_blank">
          <input type="hidden" name="format" value={format} />
          <button type="submit" className="inline-flex h-10 items-center rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted">
            {format === 'csv' ? '匯出 CSV' : '列印版'}
          </button>
        </form>
      ))}
      {archived ? null : (
        <>
          <RestartButton
            versionId={row.versionId}
            requestId={randomUUID()}
            kind={kind}
            label={RESTART_UI[kind]}
            affected={[]}
            facts={facts(
              board,
              row,
              '用同樣內容建新版，參與者依此刻的組員與指導老師重新計算，每個人都要重新同意；這一版的回覆留作歷史、不計入新版。',
              '不能復原：新版建立後就是目前版本。',
            )}
            reasonMaxLength={MAX_REASON_CHARS}
            stay
          />
          {row.state !== 'void' && row.state !== 'superseded' ? (
            <VoidButton
              versionId={row.versionId}
              requestId={randomUUID()}
              facts={facts(board, row, '之後誰都不能再回覆這一版；已經回覆的留作歷史、不算數。', '作廢不能取消；要重新取得同意請按「重開」。')}
              reasonMaxLength={MAX_REASON_CHARS}
            />
          ) : null}
        </>
      )}
    </div>
  )
}

export function ConsentBoard({ board, archived }: { board: ConsentItemBoard; archived: boolean }) {
  if (board.rows.length === 0) {
    return (
      <p className="dash-card px-5 py-4 text-sm text-muted-foreground" data-testid="consent-board-empty">
        這份同意書還沒有對象組。
      </p>
    )
  }
  return (
    <section aria-label="同意書繳交狀況" className="flex flex-col gap-3" data-testid="consent-board">
      {board.rows.map((row) => (
        <article key={row.groupId} aria-label={row.groupCode} className="dash-card flex flex-col gap-3 px-5 py-4" data-testid="consent-board-row">
          <header className="flex flex-wrap items-center gap-3">
            <h2 className="text-base font-extrabold tabular">{row.groupCode}</h2>
            <span
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs font-semibold',
                row.state === 'complete'
                  ? 'bg-success-subtle text-success-on-subtle'
                  : row.state === 'revision'
                    ? 'bg-danger-subtle text-danger-on-subtle'
                    : row.state === null || row.state === 'void' || row.state === 'superseded'
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-primary-subtle text-primary-on-subtle',
              )}
              data-testid="consent-board-state"
            >
              {stateText(row)}
            </span>
          </header>
          {row.students.length > 0 || row.advisor ? (
            <ul className="flex flex-wrap gap-1.5" aria-label={`${row.groupCode} 參與者`}>
              {row.students.map((p) => (
                <Person key={p.userId} p={p} />
              ))}
              {row.advisor ? <Person p={row.advisor} advisor /> : null}
            </ul>
          ) : null}
          <RowActions board={board} row={row} archived={archived} />
        </article>
      ))}
    </section>
  )
}

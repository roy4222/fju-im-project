'use client'
import Link from 'next/link'
import { startTransition, useActionState, useState, type FormEvent } from 'react'
import { changeGroupTypeAction, linkOpportunityAction } from './actions'
import { Feedback } from './group-forms'

/**
 * 「我的組別」的組別類型與合作案（票 20；產品 5.3、6.3）。
 *
 * - 類型：組長在成組期內、尚未指派主指導、未連結合作案時可以自己改；任一條件不成立就列出原因、請聯絡系辦。
 * - 合作案：產學組的組長從已發布的合作案選一案連結；已經連著別的就是換案，理由必填（全組與新舊案主會收到通知）。
 * 其他組員只看得到目前的狀態。規則全在用例裡判，這裡只顯示伺服器回的句子。
 */

const PRIMARY =
  'inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60'
const INPUT = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
const LABEL = 'block text-sm font-medium text-ink'

/** 送出但不讓 React 在 action 回來後重設表單（被拒時選好的合作案與理由不能不見）。 */
function submitWithoutReset(action: (formData: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    startTransition(() => action(formData))
  }
}

export type IndustryPanelProps = {
  groupId: string
  groupCode: string
  revision: number
  isLeader: boolean
  groupType: 'general' | 'industry'
  typeLabels: Record<'general' | 'industry', string>
  typeChangeBlockers: readonly string[]
  link: { opportunityId: string; name: string; withdrawn: boolean } | null
  linkable: readonly { id: string; name: string; ownerName: string }[]
  /** 從合作案詳情頁「連結到這個合作案」過來時預先選好的那一案。 */
  preselect: string | null
  requestIds: { link: string; type: string }
  reasonMaxLength: number
}

export function IndustryPanel(props: IndustryPanelProps) {
  const { groupId, groupCode, revision, isLeader, groupType, typeLabels, typeChangeBlockers, link, linkable } = props
  const [linkState, linkAction, linking] = useActionState(linkOpportunityAction, undefined)
  const [typeState, typeAction, changingType] = useActionState(changeGroupTypeAction, undefined)
  const initial = props.preselect && linkable.some((o) => o.id === props.preselect) ? props.preselect : ''
  const [selected, setSelected] = useState(initial)
  const [reason, setReason] = useState('')
  const otherType = groupType === 'general' ? 'industry' : 'general'

  return (
    <section aria-label="組別類型與合作案" className="mb-6 grid gap-4 md:grid-cols-2">
      <div className="rounded-card border border-border bg-background p-5">
        <h2 className="text-base font-semibold text-ink">組別類型</h2>
        <p className="mt-1 text-sm text-ink" data-testid="group-type">
          目前是 <strong>{typeLabels[groupType]}</strong>
        </p>
        {isLeader ? (
          typeChangeBlockers.length === 0 ? (
            <form onSubmit={submitWithoutReset(typeAction)} className="mt-3 space-y-3">
              <input type="hidden" name="groupId" value={groupId} />
              <input type="hidden" name="revision" value={revision} />
              <input type="hidden" name="requestId" value={props.requestIds.type} />
              <input type="hidden" name="groupType" value={otherType} />
              <p className="text-xs text-muted-foreground">成組期內、還沒有指導老師、沒有連結合作案，組長可以自己改；全組看得到這筆紀錄。</p>
              <button type="submit" disabled={changingType} className={PRIMARY}>
                {changingType ? '處理中…' : `改成${typeLabels[otherType]}`}
              </button>
            </form>
          ) : (
            <p className="mt-3 rounded-md bg-muted px-3 py-2 text-sm text-ink" data-testid="type-change-blocked">
              目前不能自己改類型（{typeChangeBlockers.join('、')}）；需要調整請聯絡系辦處理。
            </p>
          )
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">組別類型由組長調整（成組期內、沒有指導老師與合作案時）；其他情況由系辦處理。</p>
        )}
        <div className="mt-3">
          <Feedback state={typeState} />
        </div>
      </div>

      <div id="industry-link" className="rounded-card border border-border bg-background p-5">
        <h2 className="text-base font-semibold text-ink">合作案</h2>
        {link ? (
          <p className="mt-1 text-sm text-ink" data-testid="linked-opportunity">
            已連結{' '}
            <Link href={`/industry/${link.opportunityId}`} className="font-semibold text-primary hover:underline">
              {link.name}
            </Link>
            {link.withdrawn ? <span className="ml-2 rounded-full bg-danger-subtle px-2 py-0.5 text-xs font-semibold text-danger-on-subtle">合作案已下架</span> : null}
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground" data-testid="linked-opportunity">
            {groupType === 'industry' ? '還沒有連結合作案。' : '一般專題不連結合作案。'}
          </p>
        )}
        {isLeader && groupType === 'industry' ? (
          <form onSubmit={submitWithoutReset(linkAction)} className="mt-3 space-y-3">
            <input type="hidden" name="groupId" value={groupId} />
            <input type="hidden" name="revision" value={revision} />
            <input type="hidden" name="requestId" value={props.requestIds.link} />
            <div>
              <label htmlFor="link-opportunity" className={LABEL}>
                {link ? '換到另一個合作案' : '選一個已發布的合作案'}
              </label>
              <select
                id="link-opportunity"
                name="opportunityId"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className={INPUT}
              >
                <option value="" disabled>
                  {linkable.length > 0 ? '請選合作案' : '目前沒有可以連結的合作案'}
                </option>
                {linkable.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}（{o.ownerName} 老師）
                  </option>
                ))}
              </select>
            </div>
            {link ? (
              <div>
                <label htmlFor="link-reason" className={LABEL}>
                  換案理由（必填）
                </label>
                <textarea
                  id="link-reason"
                  name="reason"
                  rows={2}
                  maxLength={props.reasonMaxLength}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="例：和企業討論後改做另一個題目"
                  className={INPUT}
                />
              </div>
            ) : (
              <input type="hidden" name="reason" value="" />
            )}
            <p className="text-xs text-muted-foreground">
              連結代表選用這個題目，不代表企業或老師已正式承諾合作；也不會讓案主老師自動成為指導老師。
              {link ? '換案後全組與新舊兩位案主老師會收到通知。' : ''}
            </p>
            <button type="submit" disabled={linking || selected === ''} className={PRIMARY}>
              {linking ? '處理中…' : link ? '確認換案' : `把 ${groupCode} 連結到這個合作案`}
            </button>
          </form>
        ) : groupType === 'industry' ? (
          <p className="mt-3 text-xs text-muted-foreground">合作案由組長連結；解除由案主老師或系辦處理。</p>
        ) : null}
        <div className="mt-3">
          <Feedback state={linkState} />
        </div>
      </div>
    </section>
  )
}

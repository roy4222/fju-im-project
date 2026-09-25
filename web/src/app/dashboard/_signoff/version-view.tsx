import Link from 'next/link'
import type { SignoffState, VersionDetail } from '@/application/signoff'
import { ACCEPTANCE_NOTICE, describeCause, PURPOSE_LABEL, STATE_LABEL, VOTE_RESULT_LABEL } from '@/composition/signoff'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 簽核版本的畫面（票 25）：三個角色看同一份——學生簽核頁、老師與管理員的版本頁共用，資料來自同一段查詢
 * （`SignoffQuery.versionDetail`／`studentView`），所以全文、附件、授權範圍、參與者三方一致。
 *
 * 順序照產品：全文 → 附件 → 授權範圍（最終文件授權才有，列在全文之後讓人讀完再同意）→ 參與者。
 * 版本頁固定標「站內內容確認與同意紀錄，行政採認待確認」。附件與海報連到 `/api/files/<id>`，每次下載都重新授權。
 */

const STATE_TONE: Record<SignoffState, string> = {
  collecting: 'bg-primary-subtle text-primary-on-subtle',
  teacher_pending: 'bg-primary-subtle text-primary-on-subtle',
  complete: 'bg-primary text-primary-foreground',
  revision: 'bg-danger-subtle text-danger-on-subtle',
  superseded: 'bg-muted text-muted-foreground',
  void: 'bg-muted text-muted-foreground',
}

export function StateBadge({ state }: { state: SignoffState }) {
  return (
    <span data-testid="signoff-state" className={cn('inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium', STATE_TONE[state])}>
      {STATE_LABEL[state]}
    </span>
  )
}

/** 失效、作廢、退回時放在最上面的說明；舊頁看到的就是這一句（模組 07 §7「等待管理員建立新版」）。 */
function Invalidated({ v }: { v: VersionDetail }) {
  if (v.state === 'revision') {
    return (
      <p role="status" data-testid="signoff-invalidated" className="rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-on-subtle">
        這一版已退回修正（理由：{v.cause ?? '未填'}），等系辦重開新版後大家再重新閱讀；舊的表態留作紀錄、不計入新版。
      </p>
    )
  }
  if (!v.isCurrent && v.state === 'complete') {
    return (
      <p role="status" data-testid="signoff-invalidated" className="rounded-md bg-muted px-4 py-3 text-sm text-ink">
        這是歷史版本的完成紀錄；目前已有新版本，請以新版為準。
      </p>
    )
  }
  if (v.state !== 'superseded' && v.state !== 'void') return null
  const cause = describeCause(v.cause)
  const text =
    v.state === 'void'
      ? `此版本已作廢${cause ? `（${cause}）` : ''}。`
      : v.isCurrent
        ? `此版本已失效（${cause ?? '內容或參與者變更'}），等待管理員建立新版後再重新閱讀。`
        : `此版本已失效（${cause ?? '已有新版本'}），已由新版本取代；舊版的同意不計入新版。`
  return (
    <p role="status" data-testid="signoff-invalidated" className="rounded-md bg-muted px-4 py-3 text-sm text-ink">
      {text}
    </p>
  )
}

export function VersionView({
  v,
  historyHref,
  action,
  footnote,
}: {
  v: VersionDetail
  /** 給了就列出同一個簽核包的版本歷史，連到各版本頁。 */
  historyHref?: (versionId: string) => string
  /** 放在進度下方的操作（本人表態、系辦管理）。 */
  action?: React.ReactNode
  /** 放在最下方的一句說明。 */
  footnote?: string
}) {
  const scope = v.authorizationScope
  return (
    <article className="space-y-5 rounded-card border border-border bg-background p-5" aria-label={`${v.groupCode} ${PURPOSE_LABEL[v.purpose]} v${v.versionNo}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">
            {v.groupCode}・{PURPOSE_LABEL[v.purpose]}・v{v.versionNo}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {v.cohortCode}・{v.createdByName} 建立於 {formatTaipeiMinute(v.createdAt)}・內容核對碼 {v.contentChecksum.slice(0, 12)}
          </p>
        </div>
        <StateBadge state={v.state} />
      </header>

      <Invalidated v={v} />
      <p className="rounded-md border border-border px-4 py-2 text-xs text-muted-foreground">{ACCEPTANCE_NOTICE}</p>

      <section aria-label="全文">
        <h3 className="mb-2 text-sm font-semibold text-ink">全文</h3>
        <div
          data-testid="signoff-content"
          className="prose-item max-h-[32rem] space-y-2 overflow-y-auto rounded-md bg-surface p-4 text-sm leading-7"
          dangerouslySetInnerHTML={{ __html: v.contentHtml }}
        />
      </section>

      <section aria-label="附件">
        <h3 className="mb-2 text-sm font-semibold text-ink">附件</h3>
        {v.attachments.length === 0 ? (
          <p className="text-sm text-muted-foreground">這一版沒有附件。</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {v.attachments.map((a) => (
              <li key={a.fileId} data-testid="signoff-attachment">
                <a href={`/api/files/${a.fileId}`} className="font-medium text-primary underline-offset-2 hover:underline">
                  {a.name}
                </a>
                <span className="ml-2 text-xs text-muted-foreground">
                  {a.source.itemTitle} 第 {a.source.versionNo} 次正式送出・核對碼 {a.checksum.slice(0, 12)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {scope ? (
        <section aria-label="授權範圍" data-testid="signoff-scope" className="rounded-md border border-primary/40 p-4">
          <h3 className="text-sm font-semibold text-ink">授權範圍：同意後，以下內容可以在系網公開展示</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            建版當下從精選草稿（第 {scope.scopeSource.draftRevision} 版）凍結；之後草稿再改，這一版的範圍也不會變。
          </p>
          <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[6rem_1fr]">
            <dt className="text-muted-foreground">用途</dt>
            <dd>公開展示（優秀專題）</dd>
            <dt className="text-muted-foreground">題目</dt>
            <dd data-testid="scope-title" className="font-medium text-ink">
              {scope.title}
            </dd>
            <dt className="text-muted-foreground">摘要</dt>
            <dd data-testid="scope-summary" className="whitespace-pre-line">
              {scope.summary}
            </dd>
            <dt className="text-muted-foreground">海報</dt>
            <dd>
              {scope.assets.length === 0
                ? '沒有海報'
                : scope.assets.map((a) => (
                    <a key={a.fileId} href={`/api/files/${a.fileId}`} className="text-primary underline-offset-2 hover:underline">
                      {a.name}
                    </a>
                  ))}
            </dd>
            <dt className="text-muted-foreground">影片連結</dt>
            <dd className="break-all">{scope.videoUrl ?? '沒有影片連結'}</dd>
          </dl>
        </section>
      ) : null}

      <ProgressPanel v={v} />

      {action}

      {historyHref && v.history.length > 1 ? (
        <section aria-label="版本歷史">
          <h3 className="mb-2 text-sm font-semibold text-ink">版本歷史</h3>
          <ul className="space-y-1 text-sm">
            {v.history.map((h) => (
              <li key={h.versionId} className="flex flex-wrap items-center gap-2">
                {h.versionId === v.versionId ? (
                  <span className="font-medium">v{h.versionNo}（這一版）</span>
                ) : (
                  <Link href={historyHref(h.versionId)} className="text-primary underline-offset-2 hover:underline">
                    v{h.versionNo}
                  </Link>
                )}
                <StateBadge state={h.state} />
                {h.cause && (h.state === 'superseded' || h.state === 'void' || h.state === 'revision') ? (
                  <span className="text-xs text-muted-foreground">{describeCause(h.cause)}</span>
                ) : null}
                <span className="text-xs text-muted-foreground">{formatTaipeiMinute(h.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {footnote ? <p className="border-t border-border pt-3 text-xs text-muted-foreground">{footnote}</p> : null}
    </article>
  )
}

const RESULT_TONE = {
  agree: 'text-primary',
  disagree: 'text-danger',
  return: 'text-danger',
} as const

/**
 * 逐人進度（票 26；原型「進度」卡：每位學生一列、最後一列是老師）。三個角色都是這一份，數字與缺誰一致（SGN-10）。
 * 人數照快照（三人組就 3／3）；老師那一列寫清楚「全部學生同意後輪到老師」。
 */
export function ProgressPanel({ v }: { v: VersionDetail }) {
  const p = v.progress
  const advisorTurn = v.state === 'teacher_pending'
  return (
    <section aria-label="進度" data-testid="signoff-progress">
      <h3 className="mb-2 flex flex-wrap items-baseline gap-2 text-sm font-semibold text-ink">
        進度
        <span data-testid="signoff-agreed" className="tabular-nums text-primary">
          學生 {p.agreed}／{p.total} 已同意
        </span>
      </h3>
      <ul className="divide-y divide-border rounded-md border border-border text-sm" data-testid="signoff-participants">
        {p.students.map((s) => (
          <li key={s.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid="progress-row">
            <span className={cn('font-medium', s.userId === v.viewer.userId && 'font-bold')}>
              {s.displayName}
              {s.userId === v.viewer.userId ? '（你）' : ''}
            </span>
            {s.studentNo ? <span className="text-xs text-muted-foreground tabular-nums">{s.studentNo}</span> : null}
            <span className={cn('ml-auto text-xs', s.result ? RESULT_TONE[s.result] : 'text-muted-foreground')}>
              {s.result ? `${VOTE_RESULT_LABEL[s.result]}・${formatTaipeiMinute(s.at!)}` : '尚未表態'}
            </span>
            {s.reason ? <span className="w-full text-xs text-muted-foreground">理由：{s.reason}</span> : null}
          </li>
        ))}
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-surface px-3 py-2" data-testid="progress-advisor">
          <span className="font-medium">{p.advisor.displayName}</span>
          <span className="text-xs text-muted-foreground">主指導</span>
          <span className={cn('ml-auto text-xs', p.advisor.result ? RESULT_TONE[p.advisor.result] : 'text-muted-foreground')}>
            {p.advisor.result
              ? `${VOTE_RESULT_LABEL[p.advisor.result]}・${formatTaipeiMinute(p.advisor.at!)}`
              : advisorTurn
                ? '輪到老師'
                : `全部 ${p.total} 位學生同意後輪到老師`}
          </span>
          {p.advisor.reason ? <span className="w-full text-xs text-muted-foreground">理由：{p.advisor.reason}</span> : null}
        </li>
      </ul>
      {p.missing.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="signoff-missing">
          還沒表態：{p.missing.join('、')}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">全部學生各自同意後，才輪到主指導；任何人都不能替別人同意，系辦也不行。</p>
    </section>
  )
}

/**
 * 參與者本人在版本頁上看到的「我的表態」區塊（票 26）：按得下去就出表單；投過了顯示自己那一票；
 * 其他情況（還沒輪到老師、已失效、已不是參與者）只寫一句為什麼不能按——不放按了沒反應的按鈕。
 */
export function MyResponse({ v, form }: { v: VersionDetail; form: React.ReactNode }) {
  const { role, voted, canRespond, eligible } = v.viewer
  if (role === null) return null
  if (canRespond) return <>{form}</>
  let text: string
  if (voted) {
    const at = role === 'student' ? v.progress.students.find((s) => s.userId === v.viewer.userId)?.at : v.progress.advisor.at
    text = `你已${VOTE_RESULT_LABEL[voted]}${at ? `（${formatTaipeiMinute(at)}）` : ''}；每人一票，不能改票。`
  } else if (!eligible) {
    text = role === 'student' ? '你已不在這一組，不能再對這一版表態。' : '你已不是這一組的指導老師，不能再對這一版表態。'
  } else if (role === 'advisor' && v.state === 'collecting') {
    const left = v.progress.total - v.progress.agreed
    text = `還有 ${left} 位學生沒同意；全部學生同意後才輪到你。`
  } else {
    return null
  }
  return (
    <p role="status" data-testid="my-response" className="rounded-md bg-surface px-4 py-3 text-sm text-ink">
      {text}
    </p>
  )
}

import type { ReactNode } from 'react'
import { IconCheck, IconDownload, IconFileTypePdf, IconMinus, IconSignature, IconX } from '@tabler/icons-react'
import { StatusPill } from '@/app/_ui/dashboard/cards'
import { newerVersionNo, signoffStateLabel } from '@/app/dashboard/_signoff/state-label'
import { consentTodo } from '@/app/dashboard/student/_todo/todos'
import { Invalidated, StateBadge } from '@/app/dashboard/_signoff/version-view'
import type { VersionDetail } from '@/application/signoff'
import { ACCEPTANCE_NOTICE, PURPOSE_LABEL, VOTE_RESULT_LABEL } from '@/composition/signoff'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 學生「同意書」的一版（ST-8；原型 `affairs/[id]/student-consent.tsx`）：
 * 頁首小字「同意書」＋標題「G01・最終文件授權」＋狀態膠囊；左卡讀全文（條文 → 附件 → 授權範圍 → 本人表態 → 歷史），
 * 右卡「全組表態 n／人數」逐人一列、最後一列指導老師。
 *
 * - 標題不寫「第 N 版」（版本序在「歷史」小節）；`article` 的無障礙名稱仍是「G01 最終文件授權 第 N 版」，報讀與 e2e 靠它分版。
 * - 膠囊字跟交作業的同意書卡同一個口徑（`consentTodo`：待你同意／已同意／不同意…）；失效、作廢不列卡，膠囊改寫版本狀態。
 *   簽核本身的狀態（收集中、等老師、已完成…）是 `StateBadge`（`signoff-state`），放在右卡、是這一版第一顆。
 * - 資料與老師、系辦版本頁同一份（`SignoffQuery.studentView`）；原型的「條文摘要＋內嵌 PDF」在正式碼是系辦建版時填的全文與附件
 *   （產品模組 07），所以左卡放全文與附件下載，不放 iframe。e2e 用到的 data-testid 跟共用的 `VersionView`／`ProgressPanel` 一樣。
 */
export function ConsentVersion({ v, action, headingLevel = 1 }: { v: VersionDetail; action: ReactNode; headingLevel?: 1 | 2 }) {
  const scope = v.authorizationScope
  const Heading = headingLevel === 1 ? 'h1' : 'h2'
  const SubHeading = headingLevel === 1 ? 'h2' : 'h3'
  const todo = consentTodo(v)
  const newer = newerVersionNo(v.versionNo, v.history)
  return (
    <article aria-label={`${v.groupCode} ${PURPOSE_LABEL[v.purpose]} 第 ${v.versionNo} 版`} className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-4 rounded-3xl bg-accent/70 p-5 md:p-6">
        <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl bg-ink text-ink-foreground">
          <IconSignature className="size-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-bold tracking-[0.06em] text-muted-foreground">同意書</p>
          <Heading className="text-[22px] font-extrabold tracking-tight">
            {v.groupCode}・{PURPOSE_LABEL[v.purpose]}
          </Heading>
        </div>
        <StatusPill tone={todo === null ? 'neutral' : todo.status === 'open' ? 'violet' : 'done'}>
          {todo?.label ?? signoffStateLabel(v.state, { cause: v.cause, newerVersionNo: newer })}
        </StatusPill>
      </header>

      {v.state === 'revision' || v.state === 'superseded' || v.state === 'void' || (!v.isCurrent && v.state === 'complete') ? <Invalidated v={v} /> : null}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <section aria-label="同意書全文" className="dash-card overflow-hidden">
          <section aria-label="全文" className="flex flex-col gap-3 px-5 py-4">
            <SubHeading className="text-[15px] font-bold">全文</SubHeading>
            <div
              data-testid="signoff-content"
              className="prose-item max-h-[48vh] space-y-2 overflow-y-auto text-sm leading-relaxed"
              dangerouslySetInnerHTML={{ __html: v.contentHtml }}
            />
            <p className="text-xs text-muted-foreground">{ACCEPTANCE_NOTICE}</p>
          </section>

          <section aria-label="附件" className="border-t border-border/70">
            {v.attachments.length === 0 ? (
              <p className="px-5 py-3 text-sm text-muted-foreground">這一版沒有附件。</p>
            ) : (
              <ul className="divide-y divide-border/70">
                {v.attachments.map((a) => (
                  <li key={a.fileId} data-testid="signoff-attachment" className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                    <IconFileTypePdf className="size-5 shrink-0 text-destructive" aria-hidden />
                    <span className="min-w-0">
                      <span className="block font-semibold break-all">{a.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {a.source.itemTitle} 第 {a.source.versionNo} 次正式送出・檔案核對碼 {a.checksum.slice(0, 12)}
                      </span>
                    </span>
                    <a
                      href={`/api/files/${a.fileId}`}
                      className="ml-auto inline-flex h-10 items-center gap-1 rounded-lg px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-accent"
                    >
                      <IconDownload className="size-4" aria-hidden /> 下載
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {scope ? (
            <section aria-label="授權範圍" data-testid="signoff-scope" className="border-t border-border/70 px-5 py-4">
              <h3 className="text-[15px] font-bold">授權範圍：同意後，以下內容可以在系網公開展示</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                建立同意書時已鎖定成果展示草稿第 {scope.scopeSource.draftRevision} 版的內容；之後草稿再改，這一版的範圍也不會變。
              </p>
              <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[6rem_1fr]">
                <dt className="text-muted-foreground">用途</dt>
                <dd>公開展示（優秀專題）</dd>
                <dt className="text-muted-foreground">題目</dt>
                <dd data-testid="scope-title" className="font-semibold">
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
                        <a key={a.fileId} href={`/api/files/${a.fileId}`} className="font-semibold text-ink underline-offset-2 hover:underline">
                          {a.name}
                        </a>
                      ))}
                </dd>
                <dt className="text-muted-foreground">影片連結</dt>
                <dd className="break-all">{scope.videoUrl ?? '沒有影片連結'}</dd>
              </dl>
            </section>
          ) : null}

          {action ? <div className="border-t border-border/70 px-5 py-4">{action}</div> : null}

          <History v={v} />
        </section>

        <WholeGroup v={v} newer={newer} />
      </div>
    </article>
  )
}

/** 「歷史」小節：版本序、誰在何時建立、一致性檢查碼都在這裡（標題不放版本序）。舊版只列狀態，不給連結。 */
function History({ v }: { v: VersionDetail }) {
  const others = v.history.filter((h) => h.versionId !== v.versionId)
  return (
    <section aria-label="歷史" className="border-t border-border/70 px-5 py-4 text-xs text-muted-foreground">
      <h3 className="mb-1.5 text-[13px] font-bold text-foreground">歷史</h3>
      <ul className="tabular flex flex-col gap-1">
        <li>
          <span className="font-semibold text-foreground">第 {v.versionNo} 版（這一版）</span>・{formatTaipeiMinute(v.createdAt)} {v.createdByName}{' '}
          建立・文件一致性檢查碼 {v.contentChecksum.slice(0, 12)}
          （用來確認每個人同意的是同一份內容；內容一改，碼就不同）
        </li>
        {others.map((h) => (
          <li key={h.versionId}>
            第 {h.versionNo} 版・
            {signoffStateLabel(h.state, {
              cause: h.cause,
              newerVersionNo: newerVersionNo(h.versionNo, v.history),
            })}
            ・{formatTaipeiMinute(h.createdAt)}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * 右卡「全組表態 n／人數」（原型 student-consent 的 aside）：人數照這一版的參與者快照（不寫死五人），逐人姓名＋✓／—，最後一列指導老師。
 * 「學生 n／人數 已同意」與「還沒回覆：…」的字跟共用 `ProgressPanel` 一致（三個角色看到的數字一樣；還沒回覆的名單由 `approval.ts` 算）。
 */
function WholeGroup({ v, newer }: { v: VersionDetail; newer: number | null }) {
  const p = v.progress
  const advisorTurn = v.state === 'teacher_pending'
  const headingId = `consent-who-${v.versionId}`
  return (
    <aside aria-labelledby={headingId} data-testid="signoff-progress" className="dash-card flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-[15px] font-bold">
          全組表態{' '}
          <span className="tabular ml-1 text-sm text-muted-foreground">
            {p.agreed}／{p.total}
          </span>
        </h3>
        <StateBadge state={v.state} cause={v.cause} newerVersionNo={newer} />
      </div>
      <div className="text-sm">
        <p className="font-semibold" data-testid="signoff-agreed">
          學生 {p.agreed}／{p.total} 已同意
        </p>
        {p.missing.length > 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="signoff-missing">
            還沒回覆：{p.missing.join('、')}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">學生都已回覆</p>
        )}
      </div>
      <ul className="flex flex-col gap-2.5" data-testid="signoff-participants">
        {p.students.map((s) => {
          const me = s.userId === v.viewer.userId
          return (
            <li key={s.userId} className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-sm" data-testid="progress-row">
              {s.result === 'agree' ? (
                <IconCheck className="size-4 shrink-0 text-success" aria-label="已同意" />
              ) : s.result ? (
                <IconX className="size-4 shrink-0 text-destructive" aria-label={VOTE_RESULT_LABEL[s.result]} />
              ) : (
                <IconMinus className="size-4 shrink-0 text-muted-foreground" aria-label="還沒表態" />
              )}
              <span className={cn(me && 'font-bold')}>
                {s.displayName}
                {me ? '（你）' : ''}
              </span>
              <span className={cn('tabular ml-auto text-xs', s.result && s.result !== 'agree' ? 'text-destructive' : 'text-muted-foreground')}>
                {s.result ? `${VOTE_RESULT_LABEL[s.result]}・${formatTaipeiMinute(s.at!).slice(5)}` : '還沒表態'}
              </span>
              {s.reason ? <span className="w-full pl-6 text-xs text-muted-foreground">理由：{s.reason}</span> : null}
            </li>
          )
        })}
        <li className="flex items-start gap-2.5 border-t border-border pt-2.5 text-sm" data-testid="progress-advisor">
          <IconSignature className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0">
            <span className="block">{p.advisor.displayName}（指導老師）</span>
            <span className={cn('block text-xs', p.advisor.result && p.advisor.result !== 'agree' ? 'text-destructive' : 'text-muted-foreground')}>
              {p.advisor.result
                ? `${VOTE_RESULT_LABEL[p.advisor.result]}・${formatTaipeiMinute(p.advisor.at!)}`
                : advisorTurn
                  ? '輪到老師'
                  : `全部 ${p.total} 位學生同意後輪到老師`}
            </span>
            {p.advisor.reason ? <span className="block text-xs text-muted-foreground">理由：{p.advisor.reason}</span> : null}
          </span>
        </li>
      </ul>
    </aside>
  )
}

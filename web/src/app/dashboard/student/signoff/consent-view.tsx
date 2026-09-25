import type { ReactNode } from 'react'
import { IconCheck, IconClock, IconDownload, IconFileText, IconFileTypePdf, IconSignature, IconUsersGroup, IconX } from '@tabler/icons-react'
import { Panel, Ring } from '@/app/_ui/dashboard-primitives'
import { Invalidated, StateBadge } from '@/app/dashboard/_signoff/version-view'
import type { VersionDetail } from '@/application/signoff'
import { ACCEPTANCE_NOTICE, PURPOSE_LABEL, VOTE_RESULT_LABEL } from '@/composition/signoff'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 學生「同意書」的一版（票 38；原型 `student-signoff.tsx`＋`consent-reader.tsx`）：
 * 左邊一張白卡讀全文（條文 → 附件 → 授權範圍 → 本人表態），右邊「進度」卡（環形＋逐人一列＋最後一列老師）。
 *
 * 資料與老師、系辦版本頁同一份（`SignoffQuery.studentView`）；這裡只換版型。原型的「條文摘要＋內嵌 PDF」
 * 在正式碼是系辦建版時填的全文與附件（產品模組 07），所以左卡放全文與附件下載，不放 iframe。
 * e2e 用到的 data-testid 跟共用的 `VersionView`／`ProgressPanel` 一樣。
 */
export function ConsentVersion({ v, action }: { v: VersionDetail; action: ReactNode }) {
  const scope = v.authorizationScope
  return (
    <article
      aria-label={`${v.groupCode} ${PURPOSE_LABEL[v.purpose]} v${v.versionNo}`}
      className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]"
    >
      <Panel title={`${v.groupCode}・${PURPOSE_LABEL[v.purpose]}・v${v.versionNo}`} icon={<IconFileText />} action={<StateBadge state={v.state} />}>
        {v.state === 'revision' || v.state === 'superseded' || v.state === 'void' || (!v.isCurrent && v.state === 'complete') ? (
          <div className="px-5 pb-3">
            <Invalidated v={v} />
          </div>
        ) : null}
        <section aria-label="全文" className="flex flex-col gap-3 border-t border-border/70 px-5 py-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-[15px] font-bold">全文</h3>
            <span className="tabular text-xs text-muted-foreground">
              v{v.versionNo}・{formatTaipeiMinute(v.createdAt)} {v.createdByName} 建立・核對碼 {v.contentChecksum.slice(0, 12)}
            </span>
          </div>
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
                      {a.source.itemTitle} 第 {a.source.versionNo} 次正式送出・核對碼 {a.checksum.slice(0, 12)}
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
              建版當下從精選草稿（第 {scope.scopeSource.draftRevision} 版）凍結；之後草稿再改，這一版的範圍也不會變。
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
      </Panel>

      <ProgressCard v={v} />
    </article>
  )
}

/**
 * 右欄「進度」（原型：環形 n/人數＋誰還沒表態，逐人一列，最後一列指導老師）。
 * 人數照這一版的參與者快照（不寫死五人）；字與共用 `ProgressPanel` 一致（三個角色看到的數字一樣）。
 */
function ProgressCard({ v }: { v: VersionDetail }) {
  const p = v.progress
  const advisorTurn = v.state === 'teacher_pending'
  return (
    <Panel title="進度" icon={<IconUsersGroup />}>
      <section aria-label="進度" data-testid="signoff-progress" className="flex flex-col gap-4 px-5 pb-5">
        <div className="flex items-center gap-4">
          <Ring value={p.total === 0 ? 0 : (p.agreed / p.total) * 100} size={64} color="var(--success)" className="size-16" label={`${p.agreed}／${p.total}`}>
            <span className="tabular text-sm font-extrabold">
              {p.agreed}/{p.total}
            </span>
          </Ring>
          <div className="min-w-0 text-sm">
            <p className="font-bold" data-testid="signoff-agreed">
              學生 {p.agreed}／{p.total} 已同意
            </p>
            {p.missing.length > 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="signoff-missing">
                還沒表態：{p.missing.join('、')}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">學生都已表態</p>
            )}
          </div>
        </div>
        <ul className="flex flex-col gap-2" data-testid="signoff-participants">
          {p.students.map((s) => {
            const me = s.userId === v.viewer.userId
            return (
              <li key={s.userId} className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-sm" data-testid="progress-row">
                {s.result === 'agree' ? (
                  <IconCheck className="size-4 text-success" aria-hidden />
                ) : s.result ? (
                  <IconX className="size-4 text-destructive" aria-hidden />
                ) : (
                  <IconClock className="size-4 text-muted-foreground" aria-hidden />
                )}
                <span className={cn(me && 'font-bold')}>
                  {s.displayName}
                  {me ? '（你）' : ''}
                </span>
                {s.studentNo ? <span className="tabular text-xs text-muted-foreground">{s.studentNo}</span> : null}
                <span className={cn('tabular ml-auto text-xs', s.result && s.result !== 'agree' ? 'text-destructive' : 'text-muted-foreground')}>
                  {s.result ? `${VOTE_RESULT_LABEL[s.result]}・${formatTaipeiMinute(s.at!).slice(5)}` : '尚未表態'}
                </span>
                {s.reason ? <span className="w-full pl-6 text-xs text-muted-foreground">理由：{s.reason}</span> : null}
              </li>
            )
          })}
          <li className="flex items-start gap-2.5 border-t border-border pt-2 text-sm" data-testid="progress-advisor">
            <IconSignature className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0">
              <span className="block">{p.advisor.displayName}（主指導）</span>
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
        <p className="border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
          全部學生各自同意後，才輪到主指導；任何人都不能替別人同意，系辦也不行。每人一票、投了不能改。
        </p>
      </section>
    </Panel>
  )
}

import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { IconSignature } from '@tabler/icons-react'
import { GroupStatus } from '@/app/dashboard/_signoff/group-status'
import { RespondForm } from '@/app/dashboard/_signoff/respond-form'
import { Invalidated, MyResponse } from '@/app/dashboard/_signoff/version-view'
import { BackLink } from '@/app/dashboard/_submissions/assignment-view'
import type { VersionDetail } from '@/application/signoff'
import { BUTTON_TEXT, MAX_REASON_CHARS, PURPOSE_LABEL } from '@/composition/signoff'
import { cn } from '@/shared/cn'
import { taipeiParts } from '@/shared/time'

export type ConsentTab = 'about' | 'status'

/**
 * 站內同意書作業頁（C 階段規格① §6.2、AC-22、AC-23）：分頁「說明｜狀態」。學生的作業頁與老師的同意書頁共用。
 *
 * - 說明：全文、附件、（最終文件授權）授權範圍摘要。
 * - 狀態：「全組狀態」表；自己那一列放本人表態（先勾「我已完整閱讀」再按，理由選填）；投過就只寫結果、按鈕消失。
 *   內容改版建了新版（`supersedeCause='content_change'`）時頂部黃框「同意書內容已更新（m/d），之前的同意不算」，表格是新版、歸零。
 * - **不顯示**版本號、文件一致性檢查碼、檔案核對碼、登入方式、「校方是否接受」字樣、版本歷史（資料都留著，系辦匯出看得到）。
 */
export function ConsentStatus({
  v,
  tab,
  href,
  back,
}: {
  v: VersionDetail
  tab: ConsentTab
  /** 這一頁的網址（不含 query）；分頁是 `?tab=about`／`?tab=status`。 */
  href: string
  back: { href: string; label: string }
}) {
  const scope = v.authorizationScope
  const role = v.viewer.role
  const updated = v.isCurrent && v.supersedeCause === 'content_change' && v.state !== 'superseded' && v.state !== 'void'
  const at = taipeiParts(v.createdAt)
  return (
    <div className="flex flex-col gap-5">
      <BackLink href={back.href} label={back.label} />
      <article className="dash-card overflow-hidden" aria-label={v.itemTitle ?? PURPOSE_LABEL[v.purpose]} data-testid="consent-item">
        <header className="flex flex-wrap items-center gap-4 px-6 pt-5 pb-3">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-ink-foreground">
            <IconSignature className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold tracking-[0.06em] text-muted-foreground">
              同意書・{PURPOSE_LABEL[v.purpose]}・{v.groupCode}
            </p>
            <h1 className="text-[22px] font-extrabold tracking-tight">{v.itemTitle ?? PURPOSE_LABEL[v.purpose]}</h1>
          </div>
        </header>
        <nav className="flex gap-1 border-b border-border px-4" aria-label="同意書分頁">
          {(
            [
              ['about', '說明'],
              ['status', '狀態'],
            ] as const
          ).map(([key, label]) => (
            <Link
              key={key}
              href={`${href}?tab=${key}`}
              aria-current={tab === key ? 'page' : undefined}
              className={cn(
                '-mb-px inline-flex h-11 items-center border-b-2 px-4 text-sm font-semibold transition-colors',
                tab === key ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </Link>
          ))}
        </nav>

        {tab === 'about' ? (
          <div className="flex flex-col gap-5 p-6">
            <section aria-label="全文">
              <div
                data-testid="signoff-content"
                className="prose-item max-h-[56vh] space-y-2 overflow-y-auto text-sm leading-relaxed"
                dangerouslySetInnerHTML={{ __html: v.contentHtml }}
              />
            </section>
            {v.attachments.length > 0 ? (
              <section aria-label="附件">
                <h2 className="mb-2 text-[15px] font-bold">附件</h2>
                <ul className="space-y-1 text-sm">
                  {v.attachments.map((a) => (
                    <li key={a.fileId} data-testid="signoff-attachment">
                      <a href={`/api/files/${a.fileId}`} className="font-medium text-primary underline-offset-2 hover:underline">
                        {a.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {scope ? (
              <section aria-label="授權範圍" data-testid="signoff-scope" className="rounded-lg border border-primary/40 p-4">
                <h2 className="text-sm font-semibold">授權範圍：同意後，以下內容可以在系網公開展示</h2>
                <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[6rem_1fr]">
                  <dt className="text-muted-foreground">題目</dt>
                  <dd data-testid="scope-title" className="font-medium">
                    {scope.title}
                  </dd>
                  <dt className="text-muted-foreground">摘要</dt>
                  <dd data-testid="scope-summary" className="whitespace-pre-line">
                    {scope.summary}
                  </dd>
                </dl>
              </section>
            ) : null}
            <p>
              <Link href={`${href}?tab=status`} className="text-sm font-semibold text-primary underline-offset-2 hover:underline">
                讀完了，到「狀態」表態 →
              </Link>
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-6">
            {updated ? (
              <p role="status" data-testid="consent-updated" className="rounded-lg bg-warning-subtle px-4 py-3 text-sm font-semibold text-warning-on-subtle">
                同意書內容已更新（{at.month}/{at.day}），之前的同意不算，請重新閱讀並同意。
              </p>
            ) : null}
            {v.state === 'revision' || v.state === 'superseded' || v.state === 'void' ? <Invalidated v={v} /> : null}
            <GroupStatus
              v={v}
              action={
                role === null ? null : (
                  <MyResponse
                    v={v}
                    form={
                      <RespondForm
                        versionId={v.versionId}
                        contentChecksum={v.contentChecksum}
                        requestId={randomUUID()}
                        role={role}
                        agreeText={BUTTON_TEXT[role].agree}
                        rejectText={BUTTON_TEXT[role].reject}
                        reasonMaxLength={MAX_REASON_CHARS}
                      />
                    }
                  />
                )
              }
            />
            <p className="text-xs text-muted-foreground">每個人只代表自己一票；全部組員同意後才輪到指導老師。任何人都不能替別人同意，系辦也不行；投了不能改。</p>
          </div>
        )}
      </article>
    </div>
  )
}

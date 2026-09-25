import Link from 'next/link'
import type { Metadata } from 'next'
import { IconBriefcase, IconLock } from '@tabler/icons-react'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { currentActor, requireSignedIn } from '@/app/_ui/guard'
import { CleanBody, Crumbs, NeedLogin, Tag } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { getOpportunityQuery, OPPORTUNITY_STATUS_LABEL, studentCohortOf } from '@/composition/groups'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, taipeiDateOf } from '@/shared/time'

/** 同一個請求裡 metadata 與頁面共用一次查詢。 */
const load = cache(async (id: string) => getOpportunityQuery().open(await currentActor(), id))

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const page = await load(id)
  // 看不到內容的狀態不在標題裡露出公司名稱。
  if (page.access !== 'visible' && page.access !== 'withdrawn_linked') return { title: '產學合作｜資管系專題平台', robots: { index: false } }
  return {
    title: `${page.opportunity.companyName}・${page.opportunity.department}｜資管系專題平台`,
    robots: { index: false },
    alternates: { canonical: `/industry/${id}` },
  }
}

/**
 * 產學合作詳情（票 20；原型 `/industry/[id]`；產品 6.1–6.3）。
 *
 * 五種狀態照 `OpportunityQuery.open`：看得到就顯示公開欄位（正文已經過伺服器端清洗）；
 * 聯絡資訊（地址、聯絡人、電話、Email）只有負責老師與系辦的查詢會回來，其他人這一區只有說明；
 * 已下架：組別仍連著它的組員看得到原本的內容並標示「合作案已下架」，其他人看到下架說明；
 * 別人的草稿與不存在的一律 404；訪客請他登入。
 */
export default async function IndustryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await currentActor()
  if (actor.kind === 'authenticated') await requireSignedIn(`/industry/${id}`)
  const page = await load(id)
  if (page.access === 'not_found') notFound()

  if (page.access === 'need_login') {
    return (
      <SiteShell current="/industry">
        <NeedLogin next={`/industry/${id}`} what="產學合作詳情" />
      </SiteShell>
    )
  }
  if (page.access === 'withdrawn') {
    return (
      <SiteShell current="/industry">
        <div className="mx-auto flex min-h-[420px] max-w-xl flex-col items-center justify-center gap-3 px-5 py-16 text-center" data-testid="gone-notice">
          <IconBriefcase className="size-9 text-muted-foreground/60" aria-hidden />
          <h1 className="text-[24px] font-extrabold text-foreground sm:text-[28px]">這個合作案已下架</h1>
          <p className="text-base leading-relaxed text-muted-foreground">負責老師已經把它下架，不再接受新的組別連結。</p>
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            <Link href="/industry" className="btn-fju h-11.5 px-7 text-[15px]">
              看其他合作案
            </Link>
            <Link href="/" className="btn-fju-outline h-11.5 px-7 text-[15px]">
              回首頁
            </Link>
          </div>
        </div>
      </SiteShell>
    )
  }

  if (page.access !== 'visible' && page.access !== 'withdrawn_linked') notFound()
  const o = page.opportunity
  // 產學組組長：可以到「我的組別」把組別連到這一案（只在發布中、自己不是案主時顯示入口）。
  const leaderPanel =
    o.status === 'published' && studentCohortOf(actor)
      ? await getOpportunityQuery().leaderPanel(actor, studentCohortOf(actor)!)
      : null
  const canLink = leaderPanel?.isLeader && leaderPanel.groupType === 'industry' && leaderPanel.link?.opportunityId !== o.id

  return (
    <SiteShell current="/industry">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_340px]">
        <article className="flex min-w-0 flex-col gap-5" aria-labelledby="opportunity-title">
          <Crumbs items={[{ href: '/industry', label: '產學合作' }, { label: o.companyName }]} />
          {page.access === 'withdrawn_linked' ? (
            <p role="status" className="rounded-[10px] bg-danger-subtle px-4 py-3 text-sm font-semibold text-danger-on-subtle">
              合作案已下架：你的組別仍保留這個連結，以下是下架前發布的內容。
            </p>
          ) : o.status !== 'published' ? (
            <p role="status" className="rounded-[10px] bg-muted px-4 py-3 text-sm text-foreground">
              目前狀態：{OPPORTUNITY_STATUS_LABEL[o.status]}（只有你與系辦看得到這一頁）。
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {o.linkedGroupCount > 0 ? <Tag tone="ink">已有 {o.linkedGroupCount} 組</Tag> : <Tag>尚無組別</Tag>}
          </div>
          <h1 id="opportunity-title" className="text-[26px] leading-snug font-extrabold break-words text-foreground sm:text-[32px]">
            {o.companyName}
          </h1>
          <dl className="grid gap-3.5 sm:grid-cols-3">
            {[
              ['公司名稱', o.companyName],
              ['需求部門', o.department],
              ['負責老師', `${o.ownerName}${o.publishedAt ? `・${formatTaipeiDate(taipeiDateOf(o.publishedAt))} 發布` : ''}`],
            ].map(([k, v]) => (
              <div key={k} className="flex flex-col gap-1 rounded-[10px] border border-border p-4">
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="font-bold break-words text-foreground">{v}</dd>
              </div>
            ))}
          </dl>
          <section aria-labelledby="content-h" className="flex flex-col gap-2.5">
            <h2 id="content-h" className="text-xl font-bold text-ink">
              專題／合作內容
            </h2>
            <CleanBody html={o.contentHtml} />
          </section>
          {o.requirementsHtml ? (
            <section aria-labelledby="req-h" className="flex flex-col gap-2.5">
              <h2 id="req-h" className="text-xl font-bold text-ink">
                對學生的條件／需求
              </h2>
              <CleanBody html={o.requirementsHtml} />
            </section>
          ) : null}
          {o.notesHtml ? (
            <section aria-labelledby="notes-h" className="flex flex-col gap-2.5">
              <h2 id="notes-h" className="text-xl font-bold text-ink">
                備註{o.notesVisibility === 'internal' ? '（內部，只有你與系辦看得到）' : ''}
              </h2>
              <CleanBody html={o.notesHtml} />
            </section>
          ) : null}
        </article>

        <aside className="flex flex-col gap-4 lg:pt-11">
          <section
            aria-label="聯絡資訊"
            className={cn('flex flex-col gap-2.5 rounded-xl p-5.5', o.contact ? 'bg-secondary' : 'border border-dashed border-border')}
            data-testid="opportunity-contact"
          >
            <p className="flex items-center gap-2 font-bold text-foreground">
              {o.contact ? null : <IconLock className="size-4 text-muted-foreground" aria-hidden />}
              聯絡資訊
            </p>
            {o.contact ? (
              <dl className="flex flex-col gap-1.5 text-sm">
                {(
                  [
                    ['地址', o.contact.address],
                    ['聯絡人', o.contact.contactName],
                    ['電話', o.contact.contactPhone],
                    ['Email', o.contact.contactEmail],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="w-14 shrink-0 text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 break-words text-foreground">{v || '—'}</dd>
                  </div>
                ))}
                <p className="mt-1 text-xs text-muted-foreground">只有負責老師與系辦看得到這一區。</p>
              </dl>
            ) : (
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                公司地址、聯絡人、電話與 Email 只有負責老師與系辦看得到。學生請透過指導老師聯繫。
              </p>
            )}
          </section>
          <section aria-label="連結的組別" className="flex flex-col gap-2.5 rounded-xl bg-secondary p-5.5">
            <p className="font-bold text-foreground">連結的組別</p>
            {o.linkedGroups.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {o.linkedGroups.map((g) => (
                  <li key={g.linkId} className="font-bold text-foreground tabular-nums">
                    {g.cohortCode}・{g.groupCode}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">尚未有組別連結。</p>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">連結代表組別選用這個題目，不代表企業或老師已正式承諾合作。</p>
            {canLink ? (
              <Link href={`/dashboard/student/groups?opportunity=${o.id}#industry-link`} className="btn-fju mt-1 h-11 px-4 text-sm">
                {leaderPanel?.link ? `把 ${leaderPanel.groupCode} 換到這個合作案` : `把 ${leaderPanel?.groupCode} 連結到這個合作案`}
              </Link>
            ) : null}
          </section>
          {o.canManage ? (
            <Link
              href={actor.kind === 'authenticated' && actor.roles.includes('admin') ? '/dashboard/admin/industry' : '/dashboard/teacher/industry'}
              className="btn-fju h-12 text-base"
            >
              到合作案管理
            </Link>
          ) : null}
          <Link href="/industry" className="btn-fju-outline h-12 text-base">
            回到產學合作列表
          </Link>
        </aside>
      </div>
    </SiteShell>
  )
}

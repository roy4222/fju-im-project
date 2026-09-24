import type { Metadata } from 'next'
import { currentActor } from '@/app/_ui/guard'
import { CleanBody, ListEmpty, PublicPageHead } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { getPublicItemQuery } from '@/composition/items'

export const metadata: Metadata = {
  title: '專題規則｜資管系專題平台',
  description: '輔大資管系專題規則：課程目的、修課限制、分組與指導老師、課程要求、評分與獎懲。',
  alternates: { canonical: '/rules' },
}

/**
 * 專題規則（票 16；原型 `/rules`；產品模組 09 §9.1、04 §4.2）。
 *
 * 內容就是發布位置「專題規則」的項目（從專題事務工作台建立、發布），一個項目＝一節，先發布的在前；
 * 左邊目錄、右邊全文。照原型：不顯示版本號與附件（附件不公開，Roy 2026-09-08）。
 * 對象是「公開訪客」的訪客就看得到；其他對象的規則只給對象內的人。
 */
export default async function RulesPage() {
  const sections = await getPublicItemQuery().fullText(await currentActor(), 'rules')

  return (
    <SiteShell current="/rules">
      <PublicPageHead title="專題規則" />
      {sections.length === 0 ? (
        <ListEmpty title="專題規則還沒發布" hint="系辦發布規則後會出現在這裡。" />
      ) : (
        <div className="grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <p className="text-xs font-semibold tracking-wider text-muted-foreground">目錄</p>
            <nav aria-label="規則目錄" className="mt-2 flex flex-col">
              {sections.map((s, index) => (
                <a
                  key={s.id}
                  href={`#rule-${index + 1}`}
                  className="border-l-[3px] border-border py-1.5 pl-3 text-sm text-ink transition-colors hover:border-primary hover:text-primary"
                >
                  {s.title}
                </a>
              ))}
            </nav>
          </aside>
          <article className="flex min-w-0 flex-col gap-8">
            {sections.map((s, index) => (
              <section key={s.id} id={`rule-${index + 1}`} aria-labelledby={`rule-${index + 1}-title`} className="scroll-mt-6">
                <h2 id={`rule-${index + 1}-title`} className="border-b-2 border-border pb-2 text-xl font-semibold text-ink">
                  {s.title}
                </h2>
                {s.summary ? <p className="mt-2 text-sm text-muted-foreground">{s.summary}</p> : null}
                <div className="mt-3">
                  <CleanBody html={s.bodyHtml} />
                </div>
              </section>
            ))}
          </article>
        </div>
      )}
    </SiteShell>
  )
}

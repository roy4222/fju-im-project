import type { Metadata } from 'next'
import { IconBook2 } from '@tabler/icons-react'
import { currentActor } from '@/app/_ui/guard'
import { CleanBody, ListEmpty, PublicPage } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { getPublicItemQuery } from '@/composition/items'

/**
 * 規則正文的版型（原型 `/rules`）：編號清單＝`<ol>`、灰底註解框＝`<blockquote>`。
 * 兩個標籤都在正文白名單裡（`renderBodyHtml`），這裡只給樣子，不放寬消毒。
 */
const RULE_BODY =
  '[&_ol]:flex [&_ol]:list-decimal [&_ol]:flex-col [&_ol]:gap-1.5 [&_ol]:pl-6 ' +
  '[&_blockquote]:mt-1 [&_blockquote]:flex [&_blockquote]:flex-col [&_blockquote]:gap-1 [&_blockquote]:rounded-[10px] [&_blockquote]:border-0 ' +
  '[&_blockquote]:bg-muted/60 [&_blockquote]:p-4 [&_blockquote]:text-[15px] [&_blockquote]:leading-relaxed [&_blockquote]:text-muted-foreground'

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
    <SiteShell current="/rules" bare>
      <PublicPage title="專題規則">
        {sections.length === 0 ? (
          <ListEmpty
            icon={<IconBook2 className="size-9" aria-hidden />}
            title="專題規則還沒發布"
            hint="系辦發布規則後會出現在這裡。"
          />
        ) : (
          <div className="grid gap-10 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-14">
            <aside className="lg:sticky lg:top-28 lg:self-start">
              <p className="text-[13px] font-bold tracking-wider text-muted-foreground">目錄</p>
              <nav aria-label="規則目錄" className="mt-3 flex flex-col">
                {sections.map((s, index) => (
                  <a
                    key={s.id}
                    href={`#rule-${index + 1}`}
                    className="border-l-[3px] border-border py-2 pl-3.5 text-[15px] text-foreground transition-[border-color,color,padding-left] duration-200 hover:border-primary hover:pl-5 hover:text-primary"
                  >
                    {s.title}
                  </a>
                ))}
              </nav>
            </aside>
            <article className="flex min-w-0 flex-col gap-9">
              {sections.map((s, index) => (
                <section
                  key={s.id}
                  id={`rule-${index + 1}`}
                  aria-labelledby={`rule-${index + 1}-title`}
                  className="flex scroll-mt-28 flex-col gap-3"
                >
                  <h2 id={`rule-${index + 1}-title`} className="border-b-2 border-border pb-2 text-[22px] font-bold text-ink">
                    {s.title}
                  </h2>
                  {s.summary ? <p className="text-[15px] text-muted-foreground">{s.summary}</p> : null}
                  <CleanBody html={s.bodyHtml} className={RULE_BODY} />
                </section>
              ))}
            </article>
          </div>
        )}
      </PublicPage>
    </SiteShell>
  )
}

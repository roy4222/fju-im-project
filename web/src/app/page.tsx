import Link from 'next/link'
import { currentActor, homeFor } from '@/app/_ui/guard'
import { LinkButton } from '@/app/_ui/primitives'
import { ListEmpty, NewsCard } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { getPublicItemQuery } from '@/composition/items'

/**
 * 公開首頁（票 16 先做「最新公告」一區；產品模組 09 §9.2：重要消息優先、每區三筆再進完整列表）。
 * 優秀專題、榮譽與競賽在「公開精選發布」那一批（開發計畫第 6 節）。
 */
export default async function HomePage() {
  const actor = await currentActor()
  const signedIn = actor.kind === 'authenticated'
  const latest = await getPublicItemQuery().list(actor, 'news', { limit: 3 })

  return (
    <SiteShell>
      <h1 className="text-2xl font-semibold text-ink">輔仁大學資訊管理學系專題管理平台</h1>
      <p className="mt-2 max-w-prose text-muted-foreground">
        專題的公告、規則、名單、分組、繳交、評分與簽核都在這裡。學生用系上發的信箱或 Google 註冊，
        系辦核准後才會開通。
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <LinkButton href="/news">查看最新公告</LinkButton>
        {signedIn ? (
          <LinkButton href={homeFor(actor)} variant="secondary">
            回到我的首頁
          </LinkButton>
        ) : (
          <LinkButton href="/login" variant="secondary">
            登入
          </LinkButton>
        )}
      </div>

      <section aria-labelledby="home-news" className="mt-10">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 id="home-news" className="text-lg font-semibold text-ink">
            最新公告
          </h2>
          <Link href="/news" className="text-sm font-semibold text-primary hover:underline">
            全部公告 ›
          </Link>
        </div>
        {latest.length === 0 ? (
          <ListEmpty title="目前還沒有公告" hint="系辦發布公告後會出現在這裡。" />
        ) : (
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {latest.map((card) => (
              <li key={card.id}>
                <NewsCard card={card} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="快速入口" className="mt-10 grid gap-4 sm:grid-cols-3">
        <Link href="/rules" className="rounded-card border border-border p-4 hover:border-primary">
          <p className="font-semibold text-ink">專題規則</p>
          <p className="mt-1 text-sm text-muted-foreground">修課限制、分組、課程要求與評分。</p>
        </Link>
        <Link href="/files" className="rounded-card border border-border p-4 hover:border-primary">
          <p className="font-semibold text-ink">檔案下載</p>
          <p className="mt-1 text-sm text-muted-foreground">範本與格式（登入後）。</p>
        </Link>
        <Link href={signedIn ? homeFor(actor) : '/register'} className="rounded-card border border-border p-4 hover:border-primary">
          <p className="font-semibold text-ink">{signedIn ? '我的首頁' : '我要註冊'}</p>
          <p className="mt-1 text-sm text-muted-foreground">{signedIn ? '分組、要交的東西與截止日。' : '用系上信箱或 Google 申請帳號。'}</p>
        </Link>
      </section>
    </SiteShell>
  )
}

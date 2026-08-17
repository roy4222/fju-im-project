import Link from "next/link";
import { IconArrowRight, IconPlayerPlay, IconTrophy } from "@tabler/icons-react";
import { SiteHeader } from "@/components/public/site-header";
import { SiteFooter } from "@/components/public/site-footer";
import { VersionSwitcher } from "@/components/public/version-switcher";
import {
  ContentCard,
  ImagePlaceholder,
  MoreLink,
  Section,
  SectionHeading,
} from "@/components/public/sections";
import { Badge } from "@/components/ui/badge";
import {
  HONORS,
  INDUSTRY,
  MANAGED_ITEMS,
  NEWS,
  PROJECTS,
  daysUntil,
  formatDue,
} from "@/lib/fixtures";

export const metadata = { title: "首頁（V3 作品優先）" };

/**
 * V3「作品優先」
 *
 * 與 V1／V2 的差異也是資訊架構：把歷屆成果放到最上面，首頁的第一件事是
 * 「這個系的學生做出什麼」。適合對外招生、對競賽單位、對產學廠商展示；
 * 代價是本屆學生要多捲一段才看到自己的待辦。
 *
 * 焦點區是一張大作品 + 兩張小作品的不對稱格線，而不是文字 hero。
 */
export default function HomeV3() {
  const [lead, ...rest] = PROJECTS;
  const upcoming = MANAGED_ITEMS.filter((i) => i.dueAt)
    .sort((a, b) => daysUntil(a.dueAt!) - daysUntil(b.dueAt!))
    .slice(0, 3);

  return (
    <>
      <SiteHeader />

      <main className="flex-1">
        {/* 焦點區：作品本身就是主視覺 */}
        <section className="border-b border-border">
          <div className="mx-auto max-w-6xl px-5 py-10 md:py-14">
            <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="tabular text-sm text-muted-foreground">114 學年度 · 2026</p>
                <h1 className="type-display mt-2">
                  <span className="inline-block whitespace-nowrap">資管系專題</span>
                  <span className="inline-block whitespace-nowrap">成果與資訊</span>
                </h1>
              </div>
              <Link
                href="/login"
                className="press inline-flex h-11 items-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                登入平台
                <IconArrowRight className="size-4" />
              </Link>
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              {/* 主打作品 */}
              <Link
                href={`/projects/${lead.id}`}
                className="press group flex flex-col overflow-hidden rounded-2xl border border-border bg-card transition-colors hover:border-brand/45"
              >
                <ImagePlaceholder
                  className="aspect-[16/9]"
                  note="作品主視覺待提供"
                  label={lead.field}
                />
                <div className="p-6">
                  <div className="flex flex-wrap items-center gap-2">
                    {lead.award ? (
                      <Badge
                        variant="outline"
                        className="border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle"
                      >
                        {lead.award}
                      </Badge>
                    ) : null}
                    <Badge variant="outline" className="text-[11px] text-muted-foreground">
                      {lead.cohort} 屆
                    </Badge>
                  </div>
                  <h2 className="type-section mt-3 group-hover:text-primary">{lead.title}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    本屆代表作品。完整說明、海報與三分鐘影片連結於作品頁。
                  </p>
                </div>
              </Link>

              {/* 側欄：兩件作品 + 近期截止摘要 */}
              <div className="flex flex-col gap-5">
                {rest.slice(0, 2).map((p) => (
                  <Link
                    key={p.id}
                    href={`/projects/${p.id}`}
                    className="press group flex gap-4 rounded-xl border border-border bg-card p-3 transition-colors hover:border-brand/45"
                  >
                    <ImagePlaceholder
                      className="size-20 shrink-0 rounded-lg border-0"
                      note=""
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          {p.cohort} 屆
                        </Badge>
                        {p.hasVideo ? (
                          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                            <IconPlayerPlay className="size-3" />
                            影片
                          </span>
                        ) : null}
                      </div>
                      <p className="type-card-title mt-1 line-clamp-2 group-hover:text-primary">
                        {p.title}
                      </p>
                    </div>
                  </Link>
                ))}

                <div className="flex-1 rounded-xl border border-border bg-muted/50 p-4">
                  <p className="text-sm font-semibold">近期截止</p>
                  <ul className="mt-3 space-y-2.5">
                    {upcoming.map((item) => (
                      <li key={item.id} className="flex items-baseline gap-2.5">
                        <span className="tabular w-12 shrink-0 text-xs text-muted-foreground">
                          {item.dueAt!.slice(5).replace("-", "/")}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                        <span
                          className={`tabular shrink-0 text-xs font-semibold ${
                            daysUntil(item.dueAt!) < 0
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }`}
                        >
                          {formatDue(item.dueAt!)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 作品牆 */}
        <Section tone="muted">
          <SectionHeading
            title="歷屆專題"
            description="依屆別與領域瀏覽。歷屆優秀專題會標示得獎資訊。"
          />
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {PROJECTS.map((p) => (
              <li key={p.id}>
                <ContentCard
                  href={`/projects/${p.id}`}
                  imageLabel={p.field}
                  category={p.award}
                  badge={`${p.cohort} 屆`}
                  title={p.title}
                  hasVideo={p.hasVideo}
                />
              </li>
            ))}
          </ul>
          <div className="mt-8 flex justify-center">
            <MoreLink href="/projects">進入完整專題庫</MoreLink>
          </div>
        </Section>

        {/* 公告：列表式，作品優先版把公告壓縮成一欄清單 */}
        <Section>
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <div>
              <SectionHeading title="最新公告" align="start" />
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {NEWS.slice(0, 5).map((n) => (
                  <Link
                    key={n.id}
                    href={`/news/${n.id}`}
                    className="press group flex flex-col gap-1 px-4 py-3.5 transition-colors hover:bg-accent/45"
                  >
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className="border-brand/30 bg-brand-subtle text-[10px] text-brand-on-subtle"
                      >
                        {n.category}
                      </Badge>
                      <time className="tabular text-xs text-muted-foreground">{n.date}</time>
                    </div>
                    <p className="text-sm font-medium leading-snug group-hover:text-primary">
                      {n.title}
                    </p>
                  </Link>
                ))}
              </ul>
              <div className="mt-6">
                <MoreLink href="/news">查看全部公告</MoreLink>
              </div>
            </div>

            <div>
              <SectionHeading title="榮譽與競賽" align="start" />
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {HONORS.map((h) => (
                  <li key={h.id} className="flex items-center gap-3 px-4 py-3.5">
                    <IconTrophy className="size-4 shrink-0 text-brand" aria-hidden />
                    <span className="tabular w-11 shrink-0 text-sm text-muted-foreground">
                      {h.year}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {h.competition}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                <MoreLink href="/honors">榮譽榜與相簿</MoreLink>
              </div>
            </div>
          </div>
        </Section>

        <Section tone="muted">
          <SectionHeading title="產學合作" description="老師建立的合作需求，開放學生與訪客瀏覽。" />
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {INDUSTRY.slice(0, 3).map((item) => (
              <li key={item.id}>
                <ContentCard
                  href={`/industry/${item.id}`}
                  imageLabel={item.department}
                  category={item.status === "open" ? "未指派組別" : undefined}
                  badge={item.company}
                  title={item.title}
                  summary={`指導老師：${item.advisorName}`}
                />
              </li>
            ))}
          </ul>
          <div className="mt-8 flex justify-center">
            <MoreLink href="/industry">查看全部合作案</MoreLink>
          </div>
        </Section>
      </main>

      <SiteFooter />
      <VersionSwitcher />
    </>
  );
}

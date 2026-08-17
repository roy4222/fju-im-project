import Link from "next/link";
import {
  IconArrowRight,
  IconCalendarDue,
  IconFileText,
  IconTrophy,
} from "@tabler/icons-react";
import { SiteHeader } from "@/components/public/site-header";
import { SiteFooter } from "@/components/public/site-footer";
import { VersionSwitcher } from "@/components/public/version-switcher";
import { NewsTabs } from "@/components/public/news-tabs";
import {
  ContentCard,
  ImagePlaceholder,
  MoreLink,
  Section,
  SectionHeading,
} from "@/components/public/sections";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  HONORS,
  INDUSTRY,
  MANAGED_ITEMS,
  NEWS,
  PROJECTS,
  daysUntil,
  formatDue,
} from "@/lib/fixtures";

export const metadata = { title: "首頁" };

/**
 * V1「系網延伸」
 *
 * 節奏刻意做成一屏一件事：大圖焦點 → 公告（分類 tab）→ 近期截止 → 產學 →
 * 歷屆成果 → 榮譽。每個區塊一個標題、最多三張卡、一個「查看更多」。
 * 這是系網的節奏，也是 uiuxpro 給的 Portfolio Grid 模式（視覺優先、可分類篩選）。
 */
export default function HomeV1() {
  const pinned = NEWS.find((n) => n.pinned) ?? NEWS[0];
  const upcoming = MANAGED_ITEMS.filter((i) => i.dueAt)
    .sort((a, b) => daysUntil(a.dueAt!) - daysUntil(b.dueAt!))
    .slice(0, 4);

  return (
    <>
      <SiteHeader />

      <main className="flex-1">
        {/* 焦點區：單張大圖 + 一則焦點公告。不做輪播。 */}
        <section className="border-b border-border bg-primary text-primary-foreground dark:bg-card dark:text-foreground">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-14 md:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            <div>
              <p className="tabular text-sm opacity-70">114 學年度 · 2026</p>
              <h1 className="type-display mt-3">
                {/* 中文沒有詞間空白，靠 nowrap 片段控制斷行，避免把「規則」切開 */}
                <span className="inline-block whitespace-nowrap">專題公告、規則</span>
                <span className="inline-block whitespace-nowrap">與歷屆成果</span>
              </h1>
              <p className="mt-5 max-w-md text-[0.9375rem] leading-relaxed opacity-85">
                本系專題的公開資訊入口。學生與指導老師登入後，於同一平台完成分組、
                文件繳交、評分與線上同意。
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/rules"
                  className="press inline-flex h-11 items-center gap-2 rounded-full bg-brand px-6 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand/90"
                >
                  查看專題規則
                  <IconArrowRight className="size-4" />
                </Link>
                <Link
                  href="/login"
                  className="press inline-flex h-11 items-center rounded-full border border-current/35 px-6 text-sm font-medium transition-colors hover:bg-white/10"
                >
                  登入平台
                </Link>
              </div>
            </div>

            {/* 大圖，之後換成系上實際照片 */}
            <Link href={`/news/${pinned.id}`} className="press group block">
              <div className="overflow-hidden rounded-2xl border border-white/15 bg-black/10 dark:border-border">
                <ImagePlaceholder className="aspect-[16/9]" note="系上照片待提供" onDark />
                <div className="bg-background p-5 text-foreground">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className="border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle"
                    >
                      焦點公告
                    </Badge>
                    <time className="tabular text-xs text-muted-foreground">
                      {pinned.date}
                    </time>
                  </div>
                  <h2 className="type-card-title mt-2 group-hover:text-primary">
                    {pinned.title}
                  </h2>
                  <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                    {pinned.summary}
                  </p>
                </div>
              </div>
            </Link>
          </div>
        </section>

        {/* 最新公告 */}
        <Section>
          <SectionHeading
            title="最新公告"
            description="專題事務、競賽資訊與規則異動。依分類查看。"
          />
          <NewsTabs limit={3} />
        </Section>

        {/* 近期截止 */}
        <Section tone="muted">
          <SectionHeading
            title="近期截止"
            description="登入後可看到自己組別的繳交狀態與待辦。"
          />
          <ul className="mx-auto max-w-3xl divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {upcoming.map((item) => {
              const d = daysUntil(item.dueAt!);
              return (
                <li key={item.id} className="flex items-center gap-4 px-5 py-4">
                  <div className="w-16 shrink-0 text-center">
                    <p className="tabular text-2xl font-semibold leading-none">
                      {item.dueAt!.slice(8)}
                    </p>
                    <p className="tabular mt-1 text-xs text-muted-foreground">
                      {item.dueAt!.slice(5, 7)} 月
                    </p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium leading-snug">{item.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      對象：{item.audience}
                    </p>
                  </div>
                  <span
                    className={`tabular shrink-0 text-sm font-semibold ${
                      d < 0
                        ? "text-destructive"
                        : d <= 10
                          ? "text-brand-on-subtle"
                          : "text-muted-foreground"
                    }`}
                  >
                    {formatDue(item.dueAt!)}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="mt-8 flex justify-center">
            <MoreLink href="/login">登入查看我的待辦</MoreLink>
          </div>
        </Section>

        {/* 產學合作 */}
        <Section>
          <SectionHeading
            title="產學合作"
            description="由指導老師建立的合作需求。未指派組別者，老師可直接認領。"
          />
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {INDUSTRY.slice(0, 3).map((item, i) => (
              <li key={item.id}>
                <ContentCard
                  href={`/industry/${item.id}`}
                  imageTone={((i % 5) + 1) as 1 | 2 | 3 | 4 | 5}
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

        {/* 歷屆專題 */}
        <Section tone="muted">
          <SectionHeading
            title="歷屆專題與優秀作品"
            description="歷屆成果、海報與三分鐘影片連結。"
          />
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {PROJECTS.slice(0, 3).map((p, i) => (
              <li key={p.id}>
                <ContentCard
                  href={`/projects/${p.id}`}
                  imageTone={((i % 5) + 1) as 1 | 2 | 3 | 4 | 5}
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
            <MoreLink href="/projects">進入歷屆專題庫</MoreLink>
          </div>
        </Section>

        {/* 榮譽 + 規則 */}
        <Section>
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div>
              <SectionHeading
                title="榮譽與競賽"
                align="start"
              />
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
                    <Badge
                      variant="outline"
                      className="shrink-0 border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle"
                    >
                      {h.award}
                    </Badge>
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                <MoreLink href="/honors">查看榮譽榜與相簿</MoreLink>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-secondary/50 p-6">
              <IconFileText className="size-5 text-primary" />
              <h3 className="type-card-title mt-3">專題規則 2026.1 版</h3>
              <p className="mt-2 text-sm leading-relaxed text-secondary-foreground/85">
                分組方式、指導老師指派與系統驗收評分項目已更新為七項。舊版本仍可查閱。
              </p>
              <Link
                href="/rules"
                className={buttonVariants({
                  size: "lg",
                  className: "press mt-5 h-10 w-full justify-center rounded-full",
                })}
              >
                閱讀完整規則
              </Link>

              <div className="mt-6 flex items-center gap-2 border-t border-border pt-5 text-xs text-muted-foreground">
                <IconCalendarDue className="size-4 shrink-0" />
                <p>下一次規則說明會：9 月 4 日（週五）系上會議室</p>
              </div>
            </div>
          </div>
        </Section>
      </main>

      <SiteFooter />
      <VersionSwitcher />
    </>
  );
}

import Link from "next/link";
import {
  IconArrowRight,
  IconCalendarDue,
  IconFileText,
  IconPaperclip,
  IconPlayerPlay,
  IconPin,
  IconTrophy,
} from "@tabler/icons-react";
import { SiteHeader } from "@/components/public/site-header";
import { SiteFooter } from "@/components/public/site-footer";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { buttonVariants } from "@/components/ui/button";
import {
  HONORS,
  INDUSTRY,
  MANAGED_ITEMS,
  NEWS,
  PROJECTS,
  formatDue,
  daysUntil,
} from "@/lib/fixtures";

const CATEGORY_STYLE: Record<string, string> = {
  專題事務: "border-primary/25 bg-primary/8 text-primary",
  規則異動: "border-warning/30 bg-warning-subtle text-warning-on-subtle",
  競賽資訊: "border-brand/30 bg-brand-subtle text-brand-on-subtle",
  活動: "border-info/25 bg-info-subtle text-info-on-subtle",
};

/** 區塊標題：名詞性，不使用行銷標語（見 docs/ANTI-PATTERNS.md 第 1、2 條） */
function SectionHeading({
  title,
  href,
  hrefLabel = "查看全部",
}: {
  title: string;
  href?: string;
  hrefLabel?: string;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4 border-b border-border pb-2">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {href ? (
        <Link
          href={href}
          className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {hrefLabel}
          <IconArrowRight className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}

export default function HomePage() {
  const upcoming = MANAGED_ITEMS.filter((i) => i.dueAt)
    .sort((a, b) => daysUntil(a.dueAt!) - daysUntil(b.dueAt!))
    .slice(0, 4);

  return (
    <>
      <SiteHeader />

      <main className="flex-1">
        <div className="mx-auto max-w-7xl px-4 py-8">
          {/* 首屏：左側公告列表、右側近期截止。不做形象 hero。 */}
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <section aria-labelledby="news-heading">
              <div className="mb-4 flex items-end justify-between gap-4 border-b border-border pb-2">
                <h1 id="news-heading" className="text-lg font-semibold tracking-tight">
                  最新公告
                </h1>
                <Link
                  href="/news"
                  className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  查看全部 <IconArrowRight className="size-3.5" />
                </Link>
              </div>

              <ul className="divide-y divide-border">
                {NEWS.slice(0, 6).map((item) => (
                  <li key={item.id}>
                    <Link
                      href={`/news/${item.id}`}
                      className="group flex flex-col gap-1.5 py-3.5 transition-colors hover:bg-accent/50 sm:flex-row sm:items-start sm:gap-4"
                    >
                      <div className="flex shrink-0 items-center gap-2 sm:w-40 sm:flex-col sm:items-start sm:gap-1.5">
                        <time
                          className="tabular text-xs text-muted-foreground"
                          dateTime={item.date}
                        >
                          {item.date}
                        </time>
                        <Badge
                          variant="outline"
                          className={`text-[11px] ${CATEGORY_STYLE[item.category] ?? ""}`}
                        >
                          {item.category}
                        </Badge>
                      </div>
                      <div className="min-w-0">
                        <p className="flex items-start gap-1.5 font-medium leading-snug group-hover:text-primary">
                          {item.pinned ? (
                            <IconPin
                              className="mt-0.5 size-4 shrink-0 text-brand"
                              aria-label="置頂"
                            />
                          ) : null}
                          <span>{item.title}</span>
                        </p>
                        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                          {item.summary}
                        </p>
                        {item.attachments ? (
                          <p className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <IconPaperclip className="size-3.5" />
                            {item.attachments} 個附件
                          </p>
                        ) : null}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            {/* 近期截止：訪客也看得到日期，但要登入才看得到「自己」的狀態 */}
            <aside className="lg:sticky lg:top-28 lg:self-start" aria-labelledby="due-heading">
              <div className="rounded-lg border border-border bg-card">
                <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                  <IconCalendarDue className="size-4 text-brand" />
                  <h2 id="due-heading" className="text-sm font-semibold">
                    近期截止
                  </h2>
                </div>
                <ul className="divide-y divide-border">
                  {upcoming.map((item) => {
                    const d = daysUntil(item.dueAt!);
                    return (
                      <li key={item.id} className="px-4 py-3">
                        <div className="flex items-baseline justify-between gap-3">
                          <time className="tabular text-xs text-muted-foreground">
                            {item.dueAt}
                          </time>
                          <span
                            className={`tabular shrink-0 text-xs font-semibold ${
                              d < 0
                                ? "text-destructive"
                                : d <= 10
                                  ? "text-brand"
                                  : "text-muted-foreground"
                            }`}
                          >
                            {formatDue(item.dueAt!)}
                          </span>
                        </div>
                        <p className="mt-1 text-sm font-medium leading-snug">{item.title}</p>
                      </li>
                    );
                  })}
                </ul>
                <div className="border-t border-border p-4">
                  <Link href="/login" className={buttonVariants({ size: "lg", className: "w-full" })}>
                    登入查看我的待辦
                  </Link>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    登入後可看到自己組別的繳交狀態、指導老師與簽核進度。
                  </p>
                </div>
              </div>

              <div className="mt-4 rounded-lg border border-border bg-secondary/60 p-4">
                <div className="flex items-center gap-2">
                  <IconFileText className="size-4 text-primary" />
                  <p className="text-sm font-semibold">專題規則 2026.1 版</p>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-secondary-foreground/80">
                  分組方式、指導老師與系統驗收評分項目已更新為七項。
                </p>
                <Link
                  href="/rules"
                  className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  閱讀完整規則 <IconArrowRight className="size-3.5" />
                </Link>
              </div>
            </aside>
          </div>

          <Separator className="my-10" />

          {/* 產學合作：列表式，不做卡片牆。列表只顯示摘要欄位（MOC §6.2） */}
          <section aria-labelledby="industry-heading">
            <SectionHeading title="產學合作" href="/industry" />
            <ul className="divide-y divide-border rounded-lg border border-border">
              {INDUSTRY.map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/industry/${item.id}`}
                    className="group grid gap-2 px-4 py-3.5 transition-colors hover:bg-accent/50 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium group-hover:text-primary">
                        {item.title}
                      </p>
                      <p className="truncate text-sm text-muted-foreground">
                        {item.company}
                      </p>
                    </div>
                    <div className="min-w-0 text-sm text-muted-foreground">
                      <p className="truncate">需求部門：{item.department}</p>
                      <p className="truncate">指導老師：{item.advisorName}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {item.status === "open" ? (
                        <Badge className="border-brand/30 bg-brand-subtle text-brand-on-subtle" variant="outline">
                          未指派組別
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          已有 {item.linkedGroups} 組
                        </Badge>
                      )}
                      <IconArrowRight className="size-4 text-muted-foreground" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <Separator className="my-10" />

          {/* 歷屆專題 */}
          <section aria-labelledby="projects-heading">
            <SectionHeading title="歷屆專題與優秀作品" href="/projects" />
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {PROJECTS.map((p, i) => (
                <li key={p.id}>
                  <Link
                    href={`/projects/${p.id}`}
                    className="group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/40"
                  >
                    {/* 封面 16:9。原型無實圖，以扁平色塊佔位，不使用漸層裝飾。 */}
                    <div
                      className="flex aspect-video items-end p-3"
                      style={{ backgroundColor: `var(--chart-${(i % 5) + 1})` }}
                    >
                      <span className="rounded bg-black/25 px-1.5 py-0.5 text-[11px] font-medium text-white">
                        {p.field}
                      </span>
                    </div>
                    <div className="flex flex-1 flex-col p-3.5">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[11px] text-muted-foreground">
                          {p.cohort} 屆
                        </Badge>
                        {p.award ? (
                          <Badge
                            variant="outline"
                            className="border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle"
                          >
                            {p.award}
                          </Badge>
                        ) : null}
                        {p.hasVideo ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            <IconPlayerPlay className="size-3" />
                            影片
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-2 font-medium leading-snug group-hover:text-primary">
                        {p.title}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <Separator className="my-10" />

          {/* 榮譽榜 */}
          <section aria-labelledby="honors-heading">
            <SectionHeading title="榮譽與競賽" href="/honors" />
            <ul className="divide-y divide-border rounded-lg border border-border">
              {HONORS.map((h) => (
                <li
                  key={h.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3.5"
                >
                  <IconTrophy className="size-4 shrink-0 text-brand" aria-hidden />
                  <span className="tabular w-12 shrink-0 text-sm text-muted-foreground">
                    {h.year}
                  </span>
                  <span className="min-w-0 flex-1 font-medium">{h.competition}</span>
                  <Badge variant="outline" className="border-brand/30 bg-brand-subtle text-brand-on-subtle">
                    {h.award}
                  </Badge>
                  <span className="w-16 shrink-0 text-right text-sm text-muted-foreground">
                    {h.team}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}

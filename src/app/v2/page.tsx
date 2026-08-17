import Link from "next/link";
import { IconArrowRight, IconCheck, IconCircle, IconClockHour4 } from "@tabler/icons-react";
import { SiteHeader } from "@/components/public/site-header";
import { SiteFooter } from "@/components/public/site-footer";
import { VersionSwitcher } from "@/components/public/version-switcher";
import { NewsTabs } from "@/components/public/news-tabs";
import { ContentCard, MoreLink, Section, SectionHeading } from "@/components/public/sections";
import { Badge } from "@/components/ui/badge";
import { INDUSTRY, PROJECTS, daysUntil, formatDue, MANAGED_ITEMS } from "@/lib/fixtures";

export const metadata = { title: "首頁（V2 時程優先）" };

/**
 * V2「時程優先」
 *
 * 與 V1 的差異是**資訊架構**，不是換皮：把「本學期時程」放在最上面當主角，
 * 因為專題站一年裡使用者最常問的問題是「下一件事什麼時候到」。
 * 焦點區不放大圖，改成一條可掃視的學期時程軸；公告退到第二區塊。
 */

const MILESTONES = [
  { date: "2026-07-15", label: "專題規則公告", state: "done" as const },
  { date: "2026-08-04", label: "分組名單確認", state: "done" as const },
  { date: "2026-08-26", label: "指導老師意願調查", state: "current" as const },
  { date: "2026-09-18", label: "題目與摘要初稿", state: "todo" as const },
  { date: "2026-11-20", label: "系統驗收", state: "todo" as const },
  { date: "2027-01-15", label: "期中通過／不通過", state: "todo" as const },
  { date: "2027-05-10", label: "專題發表", state: "todo" as const },
];

export default function HomeV2() {
  const upcoming = MANAGED_ITEMS.filter((i) => i.dueAt)
    .sort((a, b) => daysUntil(a.dueAt!) - daysUntil(b.dueAt!))
    .slice(0, 3);
  const next = upcoming[0];

  return (
    <>
      <SiteHeader />

      <main className="flex-1">
        {/* 焦點區：下一個截止日就是主角 */}
        <section className="border-b border-border bg-primary text-primary-foreground dark:bg-card dark:text-foreground">
          <div className="mx-auto max-w-6xl px-5 py-14 md:py-16">
            <div className="grid items-end gap-8 lg:grid-cols-[minmax(0,1fr)_auto]">
              <div>
                <p className="tabular text-sm opacity-70">114 學年度 · 2026</p>
                <h1 className="type-display mt-3">
                  <span className="inline-block whitespace-nowrap">輔大資管系</span>
                  <span className="inline-block whitespace-nowrap">專題行事曆</span>
                </h1>
                <p className="mt-4 max-w-lg text-[0.9375rem] leading-relaxed opacity-85">
                  規則、繳交期限與成果都在這裡。登入後可看到自己組別的待辦與進度。
                </p>
              </div>

              {next ? (
                <div className="rounded-2xl border border-white/15 bg-white/8 p-5 dark:border-border dark:bg-muted/40">
                  <p className="type-eyebrow opacity-70">下一個截止</p>
                  <p className="tabular mt-2 text-4xl font-semibold leading-none">
                    {next.dueAt!.slice(5).replace("-", " / ")}
                  </p>
                  <p className="mt-3 max-w-[16rem] font-medium leading-snug">{next.title}</p>
                  <p className="tabular mt-1.5 text-sm text-brand dark:text-brand">
                    {formatDue(next.dueAt!)}
                  </p>
                  <Link
                    href="/login"
                    className="press mt-4 inline-flex h-10 items-center gap-2 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand/90"
                  >
                    登入查看我的待辦
                    <IconArrowRight className="size-4" />
                  </Link>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        {/* 學期時程軸 */}
        <Section>
          <SectionHeading
            title="本學年專題時程"
            description="從規則公告到專題發表的完整流程。灰色為尚未開始的階段。"
          />
          <ol className="relative mx-auto max-w-4xl">
            {/* 垂直軸線 */}
            <span
              aria-hidden
              className="absolute bottom-3 left-[7.5rem] top-3 w-px bg-border sm:left-[9.5rem]"
            />
            {MILESTONES.map((m) => (
              <li key={m.date} className="relative flex items-start gap-4 py-3.5 sm:gap-6">
                <div className="w-24 shrink-0 text-right sm:w-32">
                  <p className="tabular text-sm font-medium">{m.date.slice(5).replace("-", "/")}</p>
                  <p className="tabular text-xs text-muted-foreground">{m.date.slice(0, 4)}</p>
                </div>
                <span className="relative z-10 mt-0.5 shrink-0">
                  {m.state === "done" ? (
                    <IconCheck className="size-5 rounded-full bg-success p-0.5 text-success-foreground" />
                  ) : m.state === "current" ? (
                    <IconClockHour4 className="size-5 rounded-full bg-brand p-0.5 text-brand-foreground" />
                  ) : (
                    <IconCircle className="size-5 rounded-full bg-background text-border" />
                  )}
                </span>
                <div className="min-w-0 flex-1 pb-1">
                  <p
                    className={`font-medium leading-snug ${
                      m.state === "todo" ? "text-muted-foreground" : ""
                    }`}
                  >
                    {m.label}
                  </p>
                  {m.state === "current" ? (
                    <Badge
                      variant="outline"
                      className="mt-1.5 border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle"
                    >
                      進行中
                    </Badge>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-8 flex justify-center">
            <MoreLink href="/rules">查看完整專題規則</MoreLink>
          </div>
        </Section>

        <Section tone="muted">
          <SectionHeading title="最新公告" description="專題事務、競賽資訊與規則異動。" />
          <NewsTabs limit={3} />
        </Section>

        <Section>
          <SectionHeading
            title="產學合作"
            description="由指導老師建立的合作需求。未指派組別者，老師可直接認領。"
          />
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

        <Section tone="muted">
          <SectionHeading title="歷屆專題與優秀作品" description="歷屆成果、海報與三分鐘影片連結。" />
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {PROJECTS.slice(0, 3).map((p) => (
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
            <MoreLink href="/projects">進入歷屆專題庫</MoreLink>
          </div>
        </Section>
      </main>

      <SiteFooter />
      <VersionSwitcher />
    </>
  );
}

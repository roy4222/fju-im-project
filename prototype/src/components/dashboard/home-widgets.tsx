import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowRight, IconCheck, IconChevronRight } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { Panel, Pill } from "@/components/dashboard/primitives";
import { MiniCalendar } from "@/components/dashboard/mini-calendar";
import { CALENDAR_EVENTS, CALENDAR_KIND_LABEL, NEWS, SCHEDULE, SCHEDULE_YEAR, TODAY_YMD, cohortProgress, currentStage, daysUntil, formatDue, stageTasksFor, type CalendarEvent, type Role, type Stage } from "@/lib/fixtures";

/**
 * 首頁積木（2026-09-09 第三輪，Roy 給的 Ace Academy 參考）：
 *   歡迎回來大色塊（日期、名字、本屆進度）│ 專題行事曆
 *   公告                                   │ 接下來要做
 *   專題時間軸（A 軌道，常駐）
 *   有才出現的色塊卡（作業區、我的組別、同意書…）
 *   統計一條（放最下面：做完就沒意義的數字不佔上面）
 */

export function md(d: string) { return d.slice(5).replace("-", "/"); }
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/* ------------------------------------------------------------------ 歡迎回來 */
export type HeroChip = { label: string; value: string; href: string; hot?: boolean };
export function HeroWelcome({ name, line, progress, illustration, cta, chips }: { name: string; line: string; progress: number; illustration?: ReactNode; cta?: { href: string; label: string }; chips?: HeroChip[] }) {
  const [, mm, dd] = TODAY_YMD.split("-").map(Number);
  const today = `${mm} 月 ${dd} 日・星期${WEEKDAY[new Date(`${TODAY_YMD}T00:00:00`).getDay()]}`;
  return (
    <section className="hero flex min-h-[220px] items-stretch">
      <div className="flex min-w-0 flex-1 flex-col justify-between gap-5 p-6 md:p-7">
        <div>
          <p className="tabular text-[13px] font-semibold text-white/75">{today}</p>
          <h1 className="mt-2 text-[28px] font-extrabold leading-tight tracking-tight md:text-[32px]">歡迎回來，{name}</h1>
          <p className="mt-2 max-w-[44ch] text-[15px] text-white/85">{line}</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-[220px] flex-1">
            <div className="mb-1.5 flex items-baseline justify-between text-[12px] font-semibold text-white/80"><span>{SCHEDULE_YEAR.label} 本屆進度</span><span className="tabular text-[15px] font-extrabold text-white">{progress}%</span></div>
            <div className="hero-bar"><span style={{ width: `${progress}%` }} /></div>
          </div>
          {cta ? <Link href={cta.href} className="btn-fju h-10 rounded-xl px-5 text-[14px]">{cta.label}<IconArrowRight className="size-4" /></Link> : null}
        </div>
        {chips?.length ? (
          <div className="flex flex-wrap gap-2" data-hero-chips>
            {chips.map((c) => (
              <Link key={c.label} href={c.href} className={`inline-flex h-9 items-center gap-2 rounded-xl px-3 text-[13px] transition-colors ${c.hot ? "bg-brand text-brand-foreground hover:bg-[oklch(0.7_0.16_55)]" : "bg-white/12 text-white/90 hover:bg-white/20"}`}>
                <span className="font-medium">{c.label}</span>
                <span className="tabular font-extrabold">{c.value}</span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
      <div className="hidden w-[280px] shrink-0 items-center justify-center pr-6 md:flex" data-illustration="hero">{illustration}</div>
    </section>
  );
}

/** 插圖佔位（Roy 用 GPT 生 3D 圖後換成 <Image>） */
export function Spot({ icon, size = 140, className = "" }: { icon: ReactNode; size?: number; className?: string }) {
  return <span className={`spot ${className}`} style={{ width: size, height: size }} data-illustration>{icon}</span>;
}

/* ------------------------------------------------------------------ 專題行事曆 */
export function CalendarCard({ canEdit = false, scroll = false }: { canEdit?: boolean; scroll?: boolean }) {
  return (
    <Panel title="專題行事曆" description="系辦設定" className="h-full" bodyClassName={scroll ? "min-h-0 overflow-y-auto" : ""}>
      <MiniCalendar events={CALENDAR_EVENTS} today={TODAY_YMD} canEdit={canEdit} />
    </Panel>
  );
}

/* ------------------------------------------------------------------ 接下來要做 */
type Upcoming = { id: string; title: string; sub: string; date: string; href: string; kind: "task" | CalendarEvent["kind"] };

export function upcomingFor(role: Role): Upcoming[] {
  const today = TODAY_YMD;
  const tasks: Upcoming[] = SCHEDULE.flatMap((s) => s.tasks.filter((t) => t.role === role && !t.done && t.due && t.due >= today).map((t) => ({ id: `${s.id}-${t.label}`, title: t.label, sub: s.title, date: t.due!, href: t.href, kind: "task" as const })));
  const events: Upcoming[] = CALENDAR_EVENTS.filter((e) => e.date >= today && e.kind !== "deadline").map((e) => ({ id: e.id, title: e.title, sub: CALENDAR_KIND_LABEL[e.kind], date: e.date, href: e.href ?? "#", kind: e.kind }));
  return [...tasks, ...events].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
}

const UP_TINT: Record<Upcoming["kind"], string> = { task: "tint-peach", deadline: "tint-peach", event: "tint-sky", competition: "tint-mint" };

export function UpcomingCard({ role, base, limit, scroll = false }: { role: Role; base: string; limit?: number; scroll?: boolean }) {
  const list = limit ? upcomingFor(role).slice(0, limit) : upcomingFor(role);
  const groups: { label: string; items: Upcoming[] }[] = [
    { label: "本週", items: list.filter((u) => daysUntil(u.date) <= 7) },
    { label: "之後", items: list.filter((u) => daysUntil(u.date) > 7) },
  ].filter((g) => g.items.length > 0);
  return (
    <Panel title="接下來" action={{ href: `${base}/timeline`, label: "全部" }} className="h-full" bodyClassName={scroll ? "min-h-0 overflow-y-auto" : ""}>
      {list.length === 0 ? <p className="px-5 pb-5 text-sm text-muted-foreground">最近沒有要做的事。</p> : (
        <div className="flex flex-col gap-1 px-3 pb-3">
          {groups.map((g) => (
            <div key={g.label}>
              <p className="px-2 pt-2 pb-1 text-[11px] font-bold tracking-[0.06em] text-muted-foreground">{g.label}</p>
              <ul className="flex flex-col gap-1">
                {g.items.map((u) => {
                  const d = daysUntil(u.date);
                  return (
                    <li key={u.id}>
                      <Link href={u.href} className="dash-card-hover group flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-card">
                        <span className={`tint spot size-11 shrink-0 rounded-xl text-[13px] font-extrabold ${UP_TINT[u.kind]}`} style={{ borderRadius: 12 }}>{d === 0 ? "今" : `${d}天`}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-bold">{u.title}</span>
                          <span className="tabular block truncate text-xs text-muted-foreground">{u.sub}・{md(u.date)}</span>
                        </span>
                        <IconChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ 公告 */
export function NewsCard({ action, limit = 5, scroll = false }: { action?: ReactNode; limit?: number; scroll?: boolean }) {
  return (
    <Panel title="公告" action={action ?? { href: "/news", label: "全部" }} className="h-full" bodyClassName={scroll ? "min-h-0 overflow-y-auto" : ""}>
      <ul className="px-2 pb-2">
        {NEWS.slice(0, limit).map((n) => (
          <li key={n.id}>
            <Link href={`/news/${n.id}`} className="flex items-center gap-4 rounded-xl px-3 py-2.5 transition-colors hover:bg-accent/60">
              <span className="tabular flex w-11 shrink-0 flex-col items-center rounded-xl bg-muted py-1.5 leading-none"><span className="text-[10px] font-semibold text-muted-foreground">{Number(n.date.slice(5, 7))} 月</span><span className="mt-0.5 text-[17px] font-extrabold">{Number(n.date.slice(8, 10))}</span></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{n.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{n.category}{n.pinned ? "・置頂" : ""}</span>
              </span>
              <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* ------------------------------------------------------------------ 這階段要做的事（時間軸共用） */
export function StageTasks({ stage, role, compact = false }: { stage: Stage; role: Role; compact?: boolean }) {
  const tasks = stageTasksFor(stage, role);
  if (tasks.length === 0) return <p className="px-5 pb-5 text-sm text-muted-foreground">這個階段沒有你要做的事。</p>;
  return (
    <ul className={compact ? "" : "border-t border-border/70"}>
      {tasks.map((t) => {
        const d = t.due ? daysUntil(t.due) : null;
        const urgent = d !== null && d >= 0 && d <= 10;
        return (
          <li key={t.label} className="flex items-center gap-3 border-t border-border/70 px-5 py-3 first:border-t-0">
            <span className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full ${t.done ? "bg-success text-success-foreground" : "border-2 border-border"}`}>{t.done ? <IconCheck className="size-3.5" strokeWidth={3} /> : null}</span>
            <div className="min-w-0 flex-1">
              <p className={`truncate text-sm font-semibold ${t.done ? "text-muted-foreground line-through decoration-border" : ""}`}>{t.label}</p>
              {t.due ? <p className={`tabular text-xs ${t.done ? "text-muted-foreground" : d! < 0 ? "text-destructive" : urgent ? "font-semibold text-brand" : "text-muted-foreground"}`}>{md(t.due)} 截止{t.done ? "" : `・${formatDue(t.due)}`}</p> : null}
            </div>
            {!t.done ? <Link href={t.href} className={buttonVariants({ size: "sm", variant: urgent ? "default" : "outline", className: "press rounded-lg" })}>前往</Link> : null}
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ 專題時間軸（A 軌道，Roy 選定） */
export function TimelineRail({ role, base }: { role: Role; base: string }) {
  const cur = currentStage();
  return (
    <Panel title="專題時間軸" description={`${SCHEDULE_YEAR.label}・現在「${cur.title}」`} action={{ href: `${base}/timeline`, label: "全部階段" }}>
      <div className="overflow-x-auto px-3 pt-2 pb-1">
        <ol className="rail min-w-[720px]">
          {SCHEDULE.map((s, i) => (
            <li key={s.id} className="rail-stop" data-status={s.status} data-first={i === 0} data-last={i === SCHEDULE.length - 1}>
              <Link href={`${base}/timeline?stage=${s.id}`} className="block rounded-lg px-1 py-1 transition-colors hover:bg-accent/60">
                <span className="rail-dot" />
                <span className={`block text-[13px] leading-tight ${s.status === "current" ? "font-extrabold" : s.status === "done" ? "font-semibold" : "font-medium text-muted-foreground"}`}>{s.title}</span>
                <span className="tabular mt-0.5 block text-[11px] text-muted-foreground">{md(s.from)}</span>
              </Link>
            </li>
          ))}
        </ol>
      </div>
      <div className="mx-5 mb-5 rounded-2xl border border-border bg-muted/30">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 pt-4 pb-3">
          <span className="text-[11px] font-bold tracking-[0.06em] text-brand">現在</span>
          <h3 className="text-[17px] font-extrabold">{cur.title}</h3>
          <span className="tabular text-xs text-muted-foreground">{md(cur.from)} – {md(cur.to)}</span>
          {cur.tag ? <Pill tone="default">{cur.tag}</Pill> : null}
          <p className="basis-full text-sm text-muted-foreground">{cur.summary}</p>
        </div>
        <div className="border-t border-border/70"><StageTasks stage={cur} role={role} compact /></div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ 色塊卡（有才出現） */
export function TintCard({ tint, title, description, action, illustration, children, className = "" }: { tint: "sky" | "peach" | "lilac" | "mint" | "sand"; title: string; description?: string; action?: { href: string; label: string }; illustration?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`dash-card tint tint-${tint} relative flex h-full flex-col overflow-hidden ${className}`}>
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold">{title}</h2>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <Link href={action.href} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-card/70 px-2.5 py-1 text-[12px] font-semibold text-foreground transition-colors hover:bg-card">{action.label}<IconArrowRight className="size-3.5" /></Link> : null}
      </div>
      {illustration ? <div className="pointer-events-none absolute top-3 right-4" data-illustration>{illustration}</div> : null}
      <div className="flex-1">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ 統計一條（最下面） */
export type StatSpec = { key: string; label: string; icon: ReactNode; value: string | number; unit?: string; hint?: string; tone?: "default" | "brand" | "danger"; href: string };
const CHIP: Record<NonNullable<StatSpec["tone"]>, string> = { default: "bg-muted text-foreground", brand: "bg-brand text-brand-foreground", danger: "bg-destructive-subtle text-destructive-on-subtle" };

export function StatStrip({ stats }: { stats: StatSpec[] }) {
  return (
    <div className="dash-card strip">
      {stats.map((s) => (
        <Link key={s.key} href={s.href} className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-accent/40 first:rounded-l-[18px] last:rounded-r-[18px]">
          <span className={`inline-flex size-10 shrink-0 items-center justify-center rounded-xl ${CHIP[s.tone ?? "default"]} [&_svg]:size-5`}>{s.icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-medium text-muted-foreground">{s.label}</span>
            <span className="tabular block text-[24px] font-extrabold leading-tight tracking-tight">{s.value}{s.unit ? <span className="ml-1 text-[12px] font-medium text-muted-foreground">{s.unit}</span> : null}</span>
            {s.hint ? <span className="block truncate text-[11px] text-muted-foreground">{s.hint}</span> : null}
          </span>
        </Link>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ 頁面骨架 */
export type HomeModel = { role: Role; name: string; line: string; cta?: { href: string; label: string }; heroIllustration: ReactNode; stats: StatSpec[]; modules: { key: string; present: boolean; span?: 1 | 2; node: ReactNode }[]; newsAction?: ReactNode; /** 學生：四塊壓一屏；老師：歡迎＋評分進度環＋工作模組（Roy 2026-09-10） */ layout?: "student" | "teacher"; chips?: HeroChip[]; aside?: ReactNode };

export function HomeLayout({ model }: { model: HomeModel }) {
  const base = `/dashboard/${model.role}`;
  const live = model.modules.filter((m) => m.present);
  if (model.layout === "teacher") {
    /* Roy 2026-09-10：老師不要行事曆／公告／接下來／時間軸，只要評分、簽核、可認領產學組，分組與合作案當摘要。 */
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <HeroWelcome name={model.name} line={model.line} progress={cohortProgress()} illustration={model.heroIllustration} cta={model.cta} chips={model.chips} />
        <div className="min-w-0">{model.aside}</div>
        {live.length ? (
          <div className="grid grid-flow-dense grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-3 xl:col-span-2">
            {live.map((m) => <div key={m.key} className={`min-w-0 ${m.span === 2 ? "md:col-span-2" : ""}`}>{m.node}</div>)}
          </div>
        ) : null}
      </div>
    );
  }
  if (model.layout === "student") {
    /* Roy 2026-09-10：學生首頁只要歡迎回來、公告、行事曆、接下來四塊，壓在一屏內；作業／組員／同意書縮成歡迎色塊底部三格。 */
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:h-[calc(100dvh-7.5rem)] xl:min-h-[600px] xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-h-0 min-w-0 flex-col gap-5">
          <HeroWelcome name={model.name} line={model.line} progress={cohortProgress()} illustration={model.heroIllustration} cta={model.cta} chips={model.chips} />
          <div className="min-h-0 flex-1"><NewsCard action={model.newsAction} limit={5} scroll /></div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-col gap-5">
          <div className="shrink-0"><CalendarCard canEdit={false} /></div>
          <div className="min-h-0 flex-1"><UpcomingCard role={model.role} base={base} limit={6} scroll /></div>
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-5">
        <HeroWelcome name={model.name} line={model.line} progress={cohortProgress()} illustration={model.heroIllustration} cta={model.cta} />
        <NewsCard action={model.newsAction} />
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <CalendarCard canEdit={model.role === "admin"} />
        <UpcomingCard role={model.role} base={base} />
      </div>
      <div className="min-w-0 xl:col-span-2"><TimelineRail role={model.role} base={base} /></div>
      {live.length ? (
        <div className="grid grid-flow-dense grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-2 xl:col-span-2 xl:grid-cols-3">
          {live.map((m) => <div key={m.key} className={`min-w-0 ${m.span === 2 ? "md:col-span-2" : ""}`}>{m.node}</div>)}
        </div>
      ) : null}
      <div className="min-w-0 xl:col-span-2"><StatStrip stats={model.stats} /></div>
    </div>
  );
}

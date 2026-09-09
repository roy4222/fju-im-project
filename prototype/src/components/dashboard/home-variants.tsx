import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowRight, IconCheck } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { Greeting, Panel, Pill } from "@/components/dashboard/primitives";
import type { DashVariant } from "@/lib/data/dash-variant";
import { NEWS, SCHEDULE, SCHEDULE_YEAR, TODAY, currentStage, daysUntil, formatDue, stageTasksFor, type Role, type Stage } from "@/lib/fixtures";

/**
 * 後台首頁（2026-09-09 Roy 第二輪）：
 * 頂端統計一條不動 → 本屆時程（三種做法，右下角切換）→ 公告 → 其他模組有才出現、沒有就消失。
 * 「現在要做」不再單獨一塊：現在這個階段要做的事直接列在時程裡。里程碑改成獨立頁「本屆時程」。
 */

export type StatSpec = { key: string; label: string; icon: ReactNode; value: string | number; unit?: string; hint?: string; tone?: "default" | "brand" | "danger"; href: string };
export type Module = { key: string; present: boolean; span?: 1 | 2; node: ReactNode };
export type HomeModel = { role: Role; greeting: { name: string; line: string }; stats: StatSpec[]; modules: Module[] };

const CHIP: Record<NonNullable<StatSpec["tone"]>, string> = { default: "bg-muted text-foreground", brand: "bg-brand text-brand-foreground", danger: "bg-destructive-subtle text-destructive-on-subtle" };

/* ------------------------------------------------------------------ 統計一條 */
export function StatStrip({ stats }: { stats: StatSpec[] }) {
  return (
    <div className="dash-card strip">
      {stats.map((s) => (
        <Link key={s.key} href={s.href} className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-accent/40">
          <span className={`inline-flex size-10 shrink-0 items-center justify-center rounded-[10px] ${CHIP[s.tone ?? "default"]} [&_svg]:size-5`}>{s.icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-medium text-muted-foreground">{s.label}</span>
            <span className="tabular block text-[26px] font-extrabold leading-tight tracking-tight">{s.value}{s.unit ? <span className="ml-1 text-[12px] font-medium text-muted-foreground">{s.unit}</span> : null}</span>
            {s.hint ? <span className="block truncate text-[11px] text-muted-foreground">{s.hint}</span> : null}
          </span>
        </Link>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ 這階段要做的事（三種做法共用） */
function md(d: string) { return d.slice(5).replace("-", "/"); }

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

function StageHeading({ stage }: { stage: Stage }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 pt-4 pb-3">
      <span className="text-[11px] font-bold tracking-[0.06em] text-brand">現在</span>
      <h3 className="text-[17px] font-extrabold">{stage.title}</h3>
      <span className="tabular text-xs text-muted-foreground">{md(stage.from)} – {md(stage.to)}</span>
      {stage.tag ? <Pill tone="default">{stage.tag}</Pill> : null}
      <p className="basis-full text-sm text-muted-foreground">{stage.summary}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ A 軌道 */
function TimelineRail({ role, base }: { role: Role; base: string }) {
  const cur = currentStage();
  return (
    <Panel title="本屆時程" description={SCHEDULE_YEAR.label} action={{ href: `${base}/timeline`, label: "全部階段" }}>
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
      <div className="mx-5 mb-5 rounded-xl border border-border bg-muted/30">
        <StageHeading stage={cur} />
        <div className="border-t border-border/70"><StageTasks stage={cur} role={role} compact /></div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ B 行程 */
function TimelineAgenda({ role, base }: { role: Role; base: string }) {
  return (
    <Panel title="本屆時程" description={SCHEDULE_YEAR.label} action={{ href: `${base}/timeline`, label: "全部階段" }}>
      <ol className="agenda px-5 pt-1 pb-4">
        {SCHEDULE.map((s) => {
          const cur = s.status === "current";
          return (
            <li key={s.id} className="agenda-row py-2" data-status={s.status}>
              <span className={`tabular pt-1.5 text-right text-xs leading-5 ${cur ? "font-bold text-foreground" : "text-muted-foreground"}`}>{md(s.from)}<br /><span className="text-muted-foreground/70">– {md(s.to)}</span></span>
              <span className="agenda-dot" />
              <div className={`min-w-0 ${cur ? "dash-card -mx-1 mb-1 overflow-hidden" : ""}`}>
                {cur ? (
                  <>
                    <StageHeading stage={s} />
                    <StageTasks stage={s} role={role} />
                  </>
                ) : (
                  <Link href={`${base}/timeline?stage=${s.id}`} className="group flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/60">
                    <span className={`text-sm ${s.status === "done" ? "font-semibold text-muted-foreground" : "font-semibold"}`}>{s.title}</span>
                    {s.tag ? <span className="text-[11px] text-muted-foreground">{s.tag}</span> : null}
                    <span className="ml-auto hidden truncate text-xs text-muted-foreground sm:inline">{s.summary}</span>
                    <IconArrowRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

/* ------------------------------------------------------------------ C 甘特 */
const MONTHS = 11; // 2026-08 → 2027-06
function monthIndex(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return (y - 2026) * 12 + (m - 8) + (day - 1) / 30;
}
function TimelineChart({ role, base }: { role: Role; base: string }) {
  const cur = currentStage();
  const today = monthIndex(TODAY.toISOString().slice(0, 10));
  const labels = Array.from({ length: MONTHS }, (_, i) => ((i + 7) % 12) + 1);
  return (
    <Panel title="本屆時程" description={SCHEDULE_YEAR.label} action={{ href: `${base}/timeline`, label: "全部階段" }}>
      <div className="overflow-x-auto px-5 pt-3">
        <div className="gantt min-w-[720px]" style={{ "--months": MONTHS } as React.CSSProperties}>
          <div />
          <div className="gantt-months mb-2 text-center text-[11px] font-semibold text-muted-foreground">
            {labels.map((m, i) => <span key={i}>{m} 月</span>)}
          </div>
          {SCHEDULE.map((s) => {
            const from = monthIndex(s.from), to = Math.max(monthIndex(s.to), from + 0.25);
            const cur = s.status === "current";
            return (
              <Link key={s.id} href={`${base}/timeline?stage=${s.id}`} className="contents">
                <span className={`flex h-10 items-center pr-3 text-[13px] ${cur ? "font-extrabold" : s.status === "done" ? "font-semibold text-muted-foreground" : "font-medium text-muted-foreground"}`}>{s.title}</span>
                <span className="gantt-row">
                  <span className="gantt-bar" data-status={s.status} style={{ left: `${(from / MONTHS) * 100}%`, width: `${((to - from) / MONTHS) * 100}%` }} />
                </span>
              </Link>
            );
          })}
        </div>
        <div className="relative -mt-[calc(40px*8)] ml-[132px] h-[calc(40px*8)] pointer-events-none min-w-[588px]">
          <span className="gantt-today" style={{ left: `${(today / MONTHS) * 100}%` }} />
        </div>
      </div>
      <div className="mx-5 mt-4 mb-5 rounded-xl border border-border bg-muted/30">
        <StageHeading stage={cur} />
        <div className="border-t border-border/70"><StageTasks stage={cur} role={role} compact /></div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ 公告 */
function NewsPanel() {
  return (
    <Panel title="公告" action={{ href: "/news", label: "全部" }} className="h-full">
      <ul>
        {NEWS.slice(0, 5).map((n) => (
          <li key={n.id}>
            <Link href={`/news/${n.id}`} className="flex items-center gap-3 border-t border-border/70 px-5 py-2.5 transition-colors hover:bg-accent/50">
              <time className="tabular shrink-0 text-xs text-muted-foreground">{md(n.date)}</time>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{n.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{n.category}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* ------------------------------------------------------------------ 入口 */
export function HomeRenderer({ model, variant }: { model: HomeModel; variant: DashVariant }) {
  const base = `/dashboard/${model.role}`;
  const live = model.modules.filter((m) => m.present);
  const Timeline = variant === "agenda" ? TimelineAgenda : variant === "chart" ? TimelineChart : TimelineRail;
  return (
    <div className="flex flex-col gap-5">
      <Greeting name={model.greeting.name} line={model.greeting.line} />
      <StatStrip stats={model.stats} />
      <Timeline role={model.role} base={base} />
      <div className="grid grid-flow-dense gap-4 md:grid-cols-2">
        <div><NewsPanel /></div>
        {live.map((m) => <div key={m.key} className={m.span === 2 ? "md:col-span-2" : ""}>{m.node}</div>)}
      </div>
    </div>
  );
}

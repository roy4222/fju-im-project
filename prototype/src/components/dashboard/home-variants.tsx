import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowRight, IconCheck, IconClock, IconTrophy } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { Greeting, Panel, QuietState, StatRow, StatTile } from "@/components/dashboard/primitives";
import { MiniBars, Ring } from "@/components/dashboard/charts";
import { Milestones } from "@/components/dashboard/milestones";
import type { DashVariant } from "@/lib/data/dash-variant";
import { daysUntil, formatDue, type Milestone } from "@/lib/fixtures";

/**
 * 後台首頁的資料模型與四種版面（2026-09-09 版本評選）。
 * 三個角色只準備一份 HomeModel；版面由 cookie 決定：
 *   grid     V1 模組網格（Roy 09-08 定案版，原樣保留）
 *   timeline V2 時間軸：截止日當主角、單欄工作單、右側里程碑
 *   console  V3 控制台：狀態優先、細線分格、里程碑橫軌、等寬數字
 *   navy     V4 系網深藍：深藍側欄、統計一條、兩欄模組
 * 定案後刪掉其餘版面與 DashVariant。
 */

export type StatSpec = {
  key: string;
  label: string;
  icon: ReactNode;
  value: string | number;
  unit?: string;
  hint?: string;
  tone?: "default" | "brand" | "danger";
  href: string;
  /** 迷你長條的歷史值（最後一筆＝現值）；沒有就畫環 */
  bars?: number[];
  /** 0–100，畫環用 */
  ring?: number;
};

export type FocusRow = {
  id: string;
  title: string;
  /** 標題下的一行小字（時間軸版：沒有截止日時顯示） */
  detail?: string;
  /** ISO 日期；有就顯示倒數 */
  dueAt?: string;
  /** 沒有截止日時，左側顯示的短代號（組號） */
  leading?: string;
  /** 管理員：數量 */
  count?: number;
  /** 列首的小圓點顏色（V1 學生列表用） */
  dot?: "danger" | "brand" | "muted";
  /** 列首 icon 方塊（V1 管理員列表用） */
  icon?: ReactNode;
  iconTone?: "default" | "brand" | "danger";
  badge?: ReactNode;
  cta: { label: string; href: string; primary?: boolean };
};

export type Focus = {
  title: string;
  description?: string;
  action?: { href: string; label: string };
  rows: FocusRow[];
  empty: { title: string; hint: string };
};

export type Module = { key: string; present: boolean; span?: 1 | 2 | 3; node: ReactNode };

export type HomeModel = {
  greeting: { name: string; line: string };
  stats: StatSpec[];
  focus: Focus;
  milestones: { items: Milestone[]; title: string };
  /** 「有才出現」的模組（不含現在要做與里程碑） */
  modules: Module[];
};

/* ------------------------------------------------------------------ 共用小件 */

function Due({ dueAt }: { dueAt: string }) {
  const d = daysUntil(dueAt);
  return <span className={`tabular inline-flex items-center gap-1 text-xs font-semibold ${d < 0 ? "text-destructive" : d <= 10 ? "text-brand" : "text-muted-foreground"}`}><IconClock className="size-3.5" />{formatDue(dueAt)}・{dueAt.slice(5)}</span>;
}

function Cta({ cta, size = "sm" }: { cta: FocusRow["cta"]; size?: "sm" | "default" }) {
  return <Link href={cta.href} className={buttonVariants({ size, variant: cta.primary ? "default" : "outline", className: "press rounded-lg" })}>{cta.label}</Link>;
}

const CHIP: Record<NonNullable<StatSpec["tone"]>, string> = { default: "bg-muted text-foreground", brand: "bg-brand text-brand-foreground", danger: "bg-destructive-subtle text-destructive-on-subtle" };

function statChart(s: StatSpec) {
  if (s.bars) return <MiniBars values={s.bars} />;
  if (typeof s.ring === "number") return <Ring value={s.ring} size={40} stroke={5} color="currentColor" />;
  return null;
}

/* ------------------------------------------------------------------ 現在要做：V1／V3／V4 的清單版 */

export function FocusPanel({ focus, className = "h-full" }: { focus: Focus; className?: string }) {
  const has = focus.rows.length > 0;
  return (
    <Panel title={has ? focus.title : focus.empty.title} description={has ? focus.description ?? `${focus.rows.length} 件` : undefined} action={focus.action} className={className}>
      {!has ? (
        <div className="px-5 pb-5"><QuietState title={focus.empty.title} hint={focus.empty.hint} /></div>
      ) : (
        <ul>
          {focus.rows.map((r) => (
            <li key={r.id} className="flex items-center gap-4 border-t border-border/70 px-5 py-3.5">
              {r.icon ? (
                <span className={`inline-flex size-[34px] shrink-0 items-center justify-center rounded-[10px] ${r.iconTone === "danger" ? "bg-destructive-subtle text-destructive-on-subtle" : r.iconTone === "brand" ? "bg-brand-subtle text-brand-on-subtle" : "bg-muted text-foreground"} [&_svg]:size-4`}>{r.icon}</span>
              ) : r.dot ? (
                <span className={`size-2 shrink-0 rounded-full ${r.dot === "danger" ? "bg-destructive" : r.dot === "brand" ? "bg-brand" : "bg-muted-foreground/40"}`} aria-hidden />
              ) : r.leading ? (
                <span className="tabular w-14 shrink-0 text-xs font-semibold text-muted-foreground">{r.leading}</span>
              ) : null}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{r.title}</p>
                {r.dueAt ? <Due dueAt={r.dueAt} /> : r.detail ? <p className="truncate text-xs text-muted-foreground">{r.detail}</p> : null}
              </div>
              {typeof r.count === "number" ? <span className="tabular text-lg font-bold">{r.count}</span> : null}
              {r.badge}
              <Cta cta={r.cta} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ V2 時間軸 */

function TimelineLead({ r }: { r: FocusRow }) {
  if (r.dueAt) {
    const d = daysUntil(r.dueAt);
    const over = d < 0;
    return (
      <span className={`tl-days ${over ? "text-destructive" : d <= 10 ? "text-brand" : ""}`}>
        {over ? Math.abs(d) : d}<span className="ml-0.5 text-[13px] font-semibold">天</span>
        <small>{over ? "逾期" : "截止"} {r.dueAt.slice(5)}</small>
      </span>
    );
  }
  if (typeof r.count === "number") return <span className="tl-days">{r.count}<small>件</small></span>;
  return <span className="tl-days text-[15px] text-muted-foreground">{r.leading}</span>;
}

function FocusTimeline({ focus }: { focus: Focus }) {
  const has = focus.rows.length > 0;
  return (
    <section>
      <div className="flex items-end justify-between gap-3 pb-3">
        <h2 className="text-[20px] font-extrabold tracking-tight">{has ? focus.title : focus.empty.title}</h2>
        {focus.action ? <Link href={focus.action.href} className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted-foreground hover:text-foreground">{focus.action.label}<IconArrowRight className="size-3.5" /></Link> : null}
      </div>
      {!has ? (
        <QuietState title={focus.empty.title} hint={focus.empty.hint} />
      ) : (
        <ol className="border-b border-border">
          {focus.rows.map((r) => (
            <li key={r.id} className="tl-row">
              <TimelineLead r={r} />
              <div className="min-w-0">
                <p className="truncate text-[15px] font-bold">{r.title}</p>
                {r.detail ? <p className="truncate text-xs text-muted-foreground">{r.detail}</p> : null}
              </div>
              <div className="flex items-center gap-3">
                {r.badge}
                <Cta cta={r.cta} size="default" />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function StatList({ stats }: { stats: StatSpec[] }) {
  return (
    <ul className="dash-card divide-y divide-border/70">
      {stats.map((s) => (
        <li key={s.key}>
          <Link href={s.href} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
            <span className="text-muted-foreground [&_svg]:size-4">{s.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">{s.label}</span>
              {s.hint ? <span className="block truncate text-[11px] text-muted-foreground">{s.hint}</span> : null}
            </span>
            <span className="tabular text-[20px] font-extrabold leading-none tracking-tight">{s.value}{s.unit ? <span className="ml-0.5 text-[11px] font-medium text-muted-foreground">{s.unit}</span> : null}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function TimelineHome({ model }: { model: HomeModel }) {
  const h = new Date().getHours();
  const hello = h < 5 ? "晚安" : h < 11 ? "早安" : h < 18 ? "午安" : "晚安";
  const extras = model.modules.filter((m) => m.present);
  return (
    <div className="flex flex-col gap-8 pt-2">
      <div>
        <h1 className="text-[26px] font-extrabold tracking-tight">{hello}，{model.greeting.name}</h1>
        <p className="mt-1.5 text-[15px] text-muted-foreground">{model.greeting.line}</p>
      </div>
      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_300px] xl:gap-12">
        <div className="flex min-w-0 flex-col gap-10">
          <FocusTimeline focus={model.focus} />
          {extras.length ? (
            <div className="grid gap-4 md:grid-cols-2">
              {extras.map((m) => <div key={m.key} className={m.span && m.span > 1 ? "md:col-span-2" : ""}>{m.node}</div>)}
            </div>
          ) : null}
        </div>
        <aside className="flex flex-col gap-4 xl:sticky xl:top-20">
          <StatList stats={model.stats} />
          <Milestones items={model.milestones.items} title={model.milestones.title} />
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ V3 控制台 */

function ConsoleStat({ s }: { s: StatSpec }) {
  return (
    <Link href={s.href} className="dash-card-hover flex h-full flex-col justify-between gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-muted-foreground">{s.label}</span>
        <span className={`inline-flex size-6 items-center justify-center rounded-md ${CHIP[s.tone ?? "default"]} [&_svg]:size-3.5`}>{s.icon}</span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <p className="mono-num text-[28px] font-bold leading-none">{s.value}{s.unit ? <span className="ml-1 font-sans text-[12px] font-medium text-muted-foreground">{s.unit}</span> : null}</p>
        <span className={s.tone === "danger" ? "text-destructive" : "text-brand"}>{statChart(s)}</span>
      </div>
      <p className="truncate text-[11px] text-muted-foreground">{s.hint ?? " "}</p>
    </Link>
  );
}

export function MilestoneTrack({ items, title }: { items: Milestone[]; title: string }) {
  const done = items.filter((m) => m.done).length;
  const latest = [...items].reverse().find((m) => m.done);
  return (
    <section className="p-4 md:px-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-bold">{title}<span className="ml-2 font-medium text-muted-foreground">{done}/{items.length} 達成</span></h2>
        {latest ? <span className="inline-flex items-center gap-1 rounded-full bg-brand-subtle px-2 py-0.5 text-[11px] font-bold text-brand-on-subtle"><IconTrophy className="size-3" />最新達成・{latest.title}</span> : null}
      </div>
      <ol className="track overflow-x-auto">
        {items.map((m, i) => (
          <li key={m.id} className="track-node px-1 text-center" data-done={m.done} data-current={!!m.current} data-latest={latest?.id === m.id} data-first={i === 0} data-last={i === items.length - 1}>
            <span className="track-dot">{m.done ? <IconCheck className="absolute inset-0 m-auto size-2.5 text-brand-foreground" strokeWidth={3} /> : null}</span>
            <p className={`text-[12px] font-semibold leading-tight ${m.done || m.current ? "" : "text-muted-foreground"}`}>{m.title}</p>
            <p className="mono-num mt-0.5 text-[11px] text-muted-foreground">{m.done && m.at ? m.at : m.hint}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ConsoleHome({ model }: { model: HomeModel }) {
  const extras = model.modules.filter((m) => m.present);
  return (
    <div className="flex flex-col gap-4">
      <Greeting name={model.greeting.name} line={model.greeting.line} />
      <div className="bento grid-flow-dense md:grid-cols-2 xl:grid-cols-4">
        <div className="md:col-span-2 xl:col-span-4"><MilestoneTrack items={model.milestones.items} title={model.milestones.title} /></div>
        {model.stats.map((s) => <div key={s.key}><ConsoleStat s={s} /></div>)}
        <div className="md:col-span-2 xl:row-span-2"><FocusPanel focus={model.focus} /></div>
        {extras.map((m) => <div key={m.key} className={m.span && m.span > 1 ? "md:col-span-2" : ""}>{m.node}</div>)}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ V4 系網深藍 */

function StatStrip({ stats }: { stats: StatSpec[] }) {
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

function NavyHome({ model }: { model: HomeModel }) {
  const extras = model.modules.filter((m) => m.present);
  return (
    <div className="flex flex-col gap-5">
      <Greeting name={model.greeting.name} line={model.greeting.line} />
      <StatStrip stats={model.stats} />
      <div className="grid grid-flow-dense gap-4 md:grid-cols-2">
        <div className="md:col-span-2"><FocusPanel focus={model.focus} /></div>
        <div><Milestones items={model.milestones.items} title={model.milestones.title} /></div>
        {extras.map((m) => <div key={m.key} className={m.span && m.span > 1 ? "md:col-span-2" : ""}>{m.node}</div>)}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ V1 模組網格（原樣） */

function GridHome({ model }: { model: HomeModel }) {
  const live: Module[] = [
    { key: "focus", present: true, span: 2, node: <FocusPanel focus={model.focus} /> },
    ...model.modules,
  ];
  // 里程碑固定排在第一個「有才出現」模組之後（維持 09-08 定案的視覺順序）
  live.splice(2, 0, { key: "milestones", present: true, node: <Milestones items={model.milestones.items} title={model.milestones.title} /> });
  return (
    <div className="flex flex-col gap-5">
      <Greeting name={model.greeting.name} line={model.greeting.line} />
      <StatRow>
        {model.stats.map((s) => <StatTile key={s.key} label={s.label} icon={s.icon} value={s.value} unit={s.unit} hint={s.hint} tone={s.tone} href={s.href} chart={statChart(s)} />)}
      </StatRow>
      <div className="grid grid-flow-dense gap-4 md:grid-cols-2 xl:grid-cols-3">
        {live.filter((m) => m.present).map((m) => (
          <div key={m.key} className={m.span === 3 ? "md:col-span-2 xl:col-span-3" : m.span === 2 ? "md:col-span-2" : ""}>{m.node}</div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 入口 */

export function HomeRenderer({ model, variant }: { model: HomeModel; variant: DashVariant }) {
  if (variant === "timeline") return <TimelineHome model={model} />;
  if (variant === "console") return <ConsoleHome model={model} />;
  if (variant === "navy") return <NavyHome model={model} />;
  return <GridHome model={model} />;
}

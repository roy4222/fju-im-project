import Link from "next/link";
import { notFound } from "next/navigation";
import { IconCheck } from "@tabler/icons-react";
import { PageTitle, Panel, Pill } from "@/components/dashboard/primitives";
import { StageTasks } from "@/components/dashboard/home-widgets";
import { isValidRole, ROLE_LABEL } from "@/lib/nav-config";
import { SCHEDULE, SCHEDULE_YEAR, currentStage, daysUntil, formatDue, type Role } from "@/lib/fixtures";

function md(d: string) { return d.slice(5).replace("-", "/"); }

/**
 * 專題時間軸（Roy 2026-09-09：里程碑改成獨立一頁，左邊時間軸、右邊該階段要做的事）。
 * 階段用 ?stage= 選，預設現在的階段；三個角色看同一條時程、各自的事。
 */
export default async function TimelinePage({ params, searchParams }: PageProps<"/dashboard/[role]/timeline">) {
  const { role } = await params;
  const sp = await searchParams;
  if (!isValidRole(role)) notFound();
  const base = `/dashboard/${role}`;
  const cur = currentStage();
  const selected = SCHEDULE.find((s) => s.id === sp.stage) ?? cur;
  const idx = SCHEDULE.indexOf(selected);
  const done = SCHEDULE.filter((s) => s.status === "done").length;
  const others = (["student", "teacher", "admin"] as Role[]).filter((r) => r !== role);

  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="專題時間軸" description={`${SCHEDULE_YEAR.label}・${SCHEDULE.length} 個階段，已完成 ${done} 個；現在是「${cur.title}」。`} />
      <div className="grid items-start gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <nav aria-label="階段" className="dash-card p-3">
          <ol className="stage-nav">
            {SCHEDULE.map((s) => (
              <li key={s.id}>
                <Link href={`${base}/timeline?stage=${s.id}`} className="stage-link" aria-current={s.id === selected.id ? "true" : undefined} data-status={s.status}>
                  <span className="agenda-dot" />
                  <span className="min-w-0">
                    <span className={`block truncate text-sm ${s.status === "current" ? "font-extrabold" : s.status === "done" ? "font-semibold" : "font-medium text-muted-foreground"}`}>{s.title}</span>
                    <span className="tabular block text-[11px] text-muted-foreground">{md(s.from)} – {md(s.to)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </nav>

        <div className="flex min-w-0 flex-col gap-5">
          <section className="dash-card">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 px-6 pt-5">
              <span className="tabular text-xs font-bold tracking-[0.06em] text-muted-foreground">第 {idx + 1} 階段</span>
              {selected.status === "current" ? <Pill tone="brand">現在</Pill> : selected.status === "done" ? <Pill tone="success"><IconCheck className="mr-1 size-3" />已完成</Pill> : <Pill tone="default">{formatDue(selected.from)}開始</Pill>}
              {selected.tag ? <span className="text-xs text-muted-foreground">{selected.tag}</span> : null}
            </div>
            <h2 className="px-6 pt-1 text-[26px] font-extrabold tracking-tight">{selected.title}</h2>
            <p className="tabular px-6 text-sm text-muted-foreground">{selected.from.replace(/-/g, "/")} – {selected.to.replace(/-/g, "/")}{selected.status !== "done" ? `・${daysUntil(selected.to) >= 0 ? `${daysUntil(selected.to)} 天後結束` : "已結束"}` : ""}</p>
            <p className="max-w-[60ch] px-6 pt-3 pb-5 text-[15px] leading-relaxed">{selected.summary}</p>
          </section>

          <Panel title={`${ROLE_LABEL[role]}要做的事`} description={`${selected.title}`}>
            <StageTasks stage={selected} role={role} />
          </Panel>

          <Panel title="其他角色在這階段" className="text-sm">
            <dl className="grid gap-x-6 gap-y-3 px-5 pb-5 md:grid-cols-2">
              {others.map((r) => (
                <div key={r}>
                  <dt className="text-xs font-bold text-muted-foreground">{ROLE_LABEL[r]}</dt>
                  <dd className="mt-1 flex flex-col gap-1">
                    {selected.tasks.filter((t) => t.role === r).map((t) => (
                      <span key={t.label} className="flex items-baseline gap-2"><span className="size-1.5 shrink-0 translate-y-[-2px] rounded-full bg-border" />{t.label}{t.due ? <span className="tabular text-xs text-muted-foreground">{md(t.due)}</span> : null}</span>
                    ))}
                    {selected.tasks.every((t) => t.role !== r) ? <span className="text-xs text-muted-foreground">—</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  );
}

import { notFound } from "next/navigation";
import { IconHistory, IconShieldLock } from "@tabler/icons-react";
import { PageTitle, Panel, Pill, StatTile } from "@/components/dashboard/primitives";
import { MiniBars } from "@/components/dashboard/charts";
import { PillLink } from "@/components/public/pill-link";
import { isValidRole } from "@/lib/nav-config";
import { AUDIT_EVENTS } from "@/lib/fixtures";

const ROLES = [{ key: "all", label: "全部" }, { key: "admin", label: "管理員" }, { key: "teacher", label: "老師" }, { key: "student", label: "學生" }, { key: "system", label: "系統" }];

/** 操作紀錄（規格 §12 AuditEvent）：append-only；actor、target、reason。 */
export default async function AuditPage({ params, searchParams }: PageProps<"/dashboard/[role]/audit">) {
  const { role } = await params;
  const sp = await searchParams;
  if (!isValidRole(role) || role !== "admin") notFound();
  const who = typeof sp.role === "string" ? sp.role : "all";
  const list = who === "all" ? AUDIT_EVENTS : AUDIT_EVENTS.filter((e) => e.role === who);
  const byDay = ["08-12", "08-13", "08-14", "08-15", "08-16", "08-17"].map((d) => AUDIT_EVENTS.filter((e) => e.at.slice(5, 10) === d).length);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="操作紀錄" description="重要業務操作留痕：誰、何時、對哪個對象、做了什麼、為什麼。不可修改。" />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="近 7 天事件" icon={<IconHistory />} value={AUDIT_EVENTS.length} unit="筆" chart={<MiniBars values={byDay} />} />
        <StatTile label="高權限操作" icon={<IconShieldLock />} value={AUDIT_EVENTS.filter((e) => e.role === "admin").length} unit="筆" tone="brand" hint="管理員" />
        <StatTile label="附理由" icon={<IconShieldLock />} value={AUDIT_EVENTS.filter((e) => e.reason).length} unit="筆" hint="重開、更正、例外都必填" />
      </div>
      <Panel title="事件" icon={<IconHistory />} action={<nav className="flex flex-wrap gap-1.5">{ROLES.map((r) => <PillLink key={r.key} href={r.key === "all" ? `/dashboard/${role}/audit` : `/dashboard/${role}/audit?role=${r.key}`} active={who === r.key}>{r.label}</PillLink>)}</nav>}>
        <ol className="relative">
          {list.map((e) => (
            <li key={e.id} className="grid items-start gap-3 border-b border-border px-5 py-3.5 last:border-0 md:grid-cols-[9rem_7rem_minmax(0,1fr)]">
              <time className="tabular text-xs text-muted-foreground">{e.at}</time>
              <span className="flex items-center gap-2 text-sm font-semibold"><span className="inline-flex size-6 items-center justify-center rounded-full bg-brand-subtle text-[10px] font-bold text-brand-on-subtle">{e.actor.slice(0, 1)}</span>{e.actor}</span>
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Pill tone={e.role === "admin" ? "brand" : e.role === "system" ? "default" : "info"}>{e.action}</Pill><span className="truncate text-sm">{e.target}</span></div>{e.reason ? <p className="mt-1 text-xs text-muted-foreground">理由：{e.reason}</p> : null}</div>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}

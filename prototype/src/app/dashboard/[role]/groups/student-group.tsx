import Link from "next/link";
import { IconAward, IconCheck, IconConfetti, IconCrown, IconFlag, IconHistory, IconMail, IconPresentation, IconSchool, IconUsersGroup } from "@tabler/icons-react";
import { MY_GROUP } from "@/lib/fixtures";
import { groupEvents, groupView, proposals, type Phase, type Proposal } from "@/lib/student-v1";
import { TeamBuilder } from "./team-builder";

/**
 * 學生：組別 v1（Roy 2026-10-15，Q73）。分頁 我的組｜組隊｜紀錄。
 * - 我的組：組名、成員頭像（組長皇冠）、指導老師卡、整組里程碑徽章（不做個人排名）。
 * - 組隊：發起提案、邀請狀態、找組員；成組後顯示「已完成組隊」。
 * - 紀錄：異動紀錄、提案紀錄，用時間線，不用表格。
 * 示範切換 ?phase=formed：成組期（預設，對應原型的今天 08-17）／已成組；三個分頁都跟著變。
 */
type Tab = "mine" | "team" | "log";
const TABS: { key: Tab; label: string }[] = [
  { key: "mine", label: "我的組" },
  { key: "team", label: "組隊" },
  { key: "log", label: "紀錄" },
];

function href(tab: Tab, phase: Phase) {
  const q = new URLSearchParams();
  if (tab !== "mine") q.set("tab", tab);
  if (phase !== "forming") q.set("phase", phase);
  const s = q.toString();
  return `/dashboard/student/groups${s ? `?${s}` : ""}`;
}

export function StudentGroup({ tab: tabParam, phase: phaseParam }: { tab?: string; phase?: string }) {
  const tab: Tab = tabParam === "team" || tabParam === "log" ? tabParam : "mine";
  const phase: Phase = phaseParam === "formed" ? "formed" : "forming";
  const v = groupView(phase);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="tabular text-[13px] font-bold text-muted-foreground">{MY_GROUP.no}・{MY_GROUP.type === "INDUSTRY" ? "產學合作" : "一般專題"}</p>
          <h1 className="mt-0.5 text-[26px] leading-tight font-extrabold tracking-tight">{MY_GROUP.title}</h1>
        </div>
        {/* 原型示範切換 */}
        <div className="flex items-center gap-2 rounded-2xl border border-dashed border-border bg-card/70 px-2 py-1.5" data-phase-toggle>
          <span className="pl-1.5 text-[12px] font-bold text-muted-foreground">示範</span>
          {(["forming", "formed"] as const).map((p) => (
            <Link key={p} href={href(tab, p)} scroll={false} aria-current={p === phase ? "true" : undefined} className={`inline-flex h-9 items-center rounded-xl px-3 text-[13px] font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40 ${p === phase ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
              {p === "forming" ? "成組期" : "已成組"}
            </Link>
          ))}
        </div>
      </div>

      <nav aria-label="組別分頁" className="flex gap-1 border-b border-border" data-group-tabs>
        {TABS.map((t) => (
          <Link key={t.key} href={href(t.key, phase)} scroll={false} aria-current={t.key === tab ? "page" : undefined} className={`-mb-px inline-flex h-11 items-center border-b-[3px] px-4 text-[15px] font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-[-3px] focus-visible:outline-ring/40 ${t.key === tab ? "border-brand text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "mine" ? <MineTab v={v} /> : tab === "team" ? <TeamTab phase={phase} /> : <LogTab phase={phase} />}
    </div>
  );
}

/* ---------------------------------------------------------------- 我的組 */
const BADGE_ICON = { proposal: IconFlag, formed: IconUsersGroup, midterm: IconAward, final: IconPresentation } as const;
const BADGE_TINT = { proposal: "oklch(0.62 0.16 250)", formed: "oklch(0.6 0.14 152)", midterm: "oklch(0.68 0.17 51)", final: "oklch(0.58 0.17 300)" } as const;

function MineTab({ v }: { v: ReturnType<typeof groupView> }) {
  const confirmed = v.members.filter((m) => m.confirmed).length;
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section aria-labelledby="members-title" className="dash-card p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="members-title" className="text-[17px] font-extrabold">成員</h2>
          <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-bold ${v.formed ? "bg-success-subtle text-success-on-subtle" : "bg-brand-subtle text-brand-on-subtle"}`}>{v.formed ? "已正式成組" : `成組中・${confirmed}/5 已確認`}</span>
        </div>
        <ol className="mt-6 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-5" data-members>
          {v.members.map((m) => (
            <li key={m.id} className="flex flex-col items-center text-center">
              <span className="relative">
                {m.isLeader ? <IconCrown aria-label="組長" className="absolute -top-4 left-1/2 size-6 -translate-x-1/2 fill-[oklch(0.84_0.15_85)] text-[oklch(0.62_0.13_70)]" strokeWidth={1.6} /> : null}
                <span className={`inline-flex size-16 items-center justify-center rounded-full text-[18px] font-extrabold ${m.confirmed ? "bg-primary text-primary-foreground" : "border-2 border-dashed border-border bg-muted text-muted-foreground"}`}>{m.name.slice(-2)}</span>
              </span>
              <span className={`mt-2 text-sm ${m.id === v.me.id ? "font-extrabold" : "font-semibold"}`}>{m.name}{m.id === v.me.id ? "（你）" : ""}</span>
              <span className="text-[12px] text-muted-foreground">{m.isLeader ? "組長" : m.confirmed ? "組員" : "等待確認"}</span>
            </li>
          ))}
        </ol>

        <h2 className="mt-8 text-[17px] font-extrabold">整組里程碑</h2>
        <ul className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4" data-badges>
          {v.milestones.map((b) => {
            const Icon = BADGE_ICON[b.id as keyof typeof BADGE_ICON];
            const tint = BADGE_TINT[b.id as keyof typeof BADGE_TINT];
            return (
              <li key={b.id} data-done={b.done} className={`flex flex-col items-center rounded-2xl border px-3 py-4 text-center ${b.done ? "border-transparent" : "border-dashed border-border bg-muted/40"}`} style={b.done ? { background: `color-mix(in oklch, ${tint} 12%, var(--card))` } : undefined}>
                <span className={`relative inline-flex size-14 items-center justify-center rounded-full ${b.done ? "text-white shadow-[0_6px_16px_-6px_rgba(0,0,0,0.35)]" : "bg-muted text-muted-foreground/60"}`} style={b.done ? { background: tint } : undefined}>
                  <Icon className="size-7" strokeWidth={1.8} />
                  {b.done ? <span className="absolute -right-1 -bottom-1 inline-flex size-5 items-center justify-center rounded-full bg-card ring-2 ring-card"><IconCheck className="size-3.5 text-success" strokeWidth={3} /></span> : null}
                </span>
                <span className={`mt-2.5 text-sm font-extrabold ${b.done ? "" : "text-muted-foreground"}`}>{b.title}</span>
                <span className="tabular mt-0.5 text-[12px] text-muted-foreground">{b.done ? `${b.at} 達成` : b.hint}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <aside aria-labelledby="advisor-title" className="flex flex-col gap-4">
        <section className={`rounded-3xl p-5 ${v.advisor ? "bg-accent/70" : "border border-dashed border-border bg-card/60"}`} data-advisor>
          <h2 id="advisor-title" className="text-[13px] font-bold text-muted-foreground">指導老師</h2>
          {v.advisor ? (
            <>
              <div className="mt-3 flex items-center gap-3">
                <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground"><IconSchool className="size-7" strokeWidth={1.6} /></span>
                <div>
                  <p className="text-[19px] font-extrabold">{v.advisor.name} 老師</p>
                  <p className="text-[13px] text-muted-foreground">資訊管理學系</p>
                </div>
              </div>
              <a href={`mailto:${v.advisor.email}`} className="mt-4 inline-flex h-10 items-center gap-1.5 rounded-xl bg-card px-3.5 text-sm font-bold text-primary ring-1 ring-border transition-colors hover:bg-background"><IconMail className="size-4" /> 寫信給老師</a>
            </>
          ) : (
            <>
              <p className="mt-3 text-[17px] font-extrabold">還沒有指導老師</p>
              <p className="mt-1 text-sm text-muted-foreground">正式成組後填意願調查，9/25 公開抽籤後公布。</p>
            </>
          )}
        </section>
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">換組員、換組長、指派老師由系辦處理；有問題請聯絡系辦。</p>
      </aside>
    </div>
  );
}

/* ---------------------------------------------------------------- 組隊 */
function TeamTab({ phase }: { phase: Phase }) {
  if (phase === "formed") {
    return (
      <section className="flex flex-col items-center rounded-3xl bg-success-subtle px-6 py-14 text-center" data-team-done>
        <span className="inline-flex size-16 items-center justify-center rounded-full bg-success text-success-foreground"><IconConfetti className="size-8" /></span>
        <h2 className="mt-4 text-[22px] font-extrabold text-success-on-subtle">已完成組隊</h2>
        <p className="mt-1 text-sm text-success-on-subtle/80">{MY_GROUP.no} 五位都已確認，08-17 正式成立。不用再發提案或找組員。</p>
        <Link href={href("mine", phase)} className="mt-5 inline-flex h-10 items-center rounded-xl bg-card px-4 text-sm font-bold text-primary ring-1 ring-border">看我的組</Link>
      </section>
    );
  }
  return <TeamBuilder proposal={proposals(phase)[0]} />;
}

/* ---------------------------------------------------------------- 紀錄 */
const RESULT: Record<Proposal["result"], { label: string; cls: string }> = {
  open: { label: "等待回覆", cls: "bg-brand-subtle text-brand-on-subtle" },
  formed: { label: "已成組", cls: "bg-success-subtle text-success-on-subtle" },
  withdrawn: { label: "已撤回", cls: "bg-muted text-muted-foreground" },
  expired: { label: "已過期", cls: "bg-muted text-muted-foreground" },
};
const INVITE = { accepted: "text-success-on-subtle", pending: "text-muted-foreground", declined: "text-destructive" } as const;
const INVITE_LABEL = { accepted: "接受", pending: "還沒回覆", declined: "婉拒" } as const;

function LogTab({ phase }: { phase: Phase }) {
  const events = groupEvents(phase);
  const props = proposals(phase);
  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <section aria-labelledby="events-title" className="dash-card p-6" data-log="events">
        <h2 id="events-title" className="flex items-center gap-2 text-[17px] font-extrabold"><IconHistory className="size-5 text-muted-foreground" /> 異動紀錄</h2>
        <ol className="relative mt-5 flex flex-col gap-5 before:absolute before:top-1.5 before:bottom-1.5 before:left-[5px] before:w-0.5 before:bg-border">
          {events.map((e) => (
            <li key={e.at + e.text} className="relative pl-7">
              <span aria-hidden className={`absolute top-1.5 left-0 size-3 rounded-full ring-4 ring-card ${e.tone === "success" ? "bg-success" : e.tone === "brand" ? "bg-brand" : "bg-muted-foreground"}`} />
              <p className="text-[15px] font-bold">{e.text}</p>
              <p className="tabular text-[13px] text-muted-foreground">{e.at.slice(5).replace("-", "/")}・{e.who}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="props-title" className="flex flex-col gap-3" data-log="proposals">
        <h2 id="props-title" className="flex items-center gap-2 px-1 text-[17px] font-extrabold"><IconFlag className="size-5 text-muted-foreground" /> 提案紀錄</h2>
        {props.map((p) => (
          <article key={p.id} className="dash-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="tabular text-sm font-bold">{p.by} 發起・{p.at.slice(5).replace("-", "/")}</p>
              <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-bold ${RESULT[p.result].cls}`}>{RESULT[p.result].label}</span>
            </div>
            <ul className="mt-3 flex flex-wrap gap-2">
              {p.invites.map((i) => (
                <li key={i.studentNo} className="inline-flex items-center gap-1.5 rounded-full bg-muted/70 py-1 pr-3 pl-1 text-[13px]">
                  <span className="inline-flex size-6 items-center justify-center rounded-full bg-card text-[11px] font-bold">{i.name.slice(-1)}</span>
                  <span className="font-semibold">{i.name}</span>
                  <span className={`font-semibold ${INVITE[i.state]}`}>{INVITE_LABEL[i.state]}</span>
                </li>
              ))}
            </ul>
            {p.note ? <p className="mt-3 text-[13px] text-muted-foreground">{p.note}</p> : null}
          </article>
        ))}
      </section>
    </div>
  );
}

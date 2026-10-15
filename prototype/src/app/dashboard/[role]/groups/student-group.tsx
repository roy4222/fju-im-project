import Link from "next/link";
import { IconCheck, IconLock, IconConfetti, IconCrown, IconFlag, IconHistory, IconMail, IconSchool } from "@tabler/icons-react";
import { UserAvatar } from "@/components/dashboard/avatar";
import { MY_GROUP } from "@/lib/fixtures";
import { groupEvents, groupView, proposals, type Phase, type Proposal } from "@/lib/student-v1";
import { TeamBuilder } from "./team-builder";

/**
 * 學生：組別 v1（Roy 2026-10-15，Q73；第 2 輪改字）。分頁 我的組｜找隊員｜紀錄。
 * - 我的組：組名、成員頭像（組長皇冠）、指導老師卡（直接顯示 Email）、里程碑徽章（達成上色、未達成灰鎖）。
 * - 找隊員：邀請組員、邀請狀態、找隊員名單；成組後顯示「已成組」。
 * - 紀錄：組別動態、邀請紀錄，用時間線，不用表格。
 * 第 3 輪：上方組名卡（組名＋一句簡介）、組員卡（插畫頭像）、老師卡（頭像）、里程碑線。
 * 示範切換 ?phase=formed：還沒成組（預設，對應原型的今天 08-17）／已成組；三個分頁都跟著變。
 */
type Tab = "mine" | "team" | "log";
const TABS: { key: Tab; label: string }[] = [
  { key: "mine", label: "我的組" },
  { key: "team", label: "找隊員" },
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
      {/* 組名卡：組名＋一句簡介；右上是原型的示範切換 */}
      <section className="dash-card flex flex-wrap items-start justify-between gap-4 p-6 md:p-7" data-group-head>
        <div className="min-w-0">
          <p className="tabular text-[14px] font-bold text-muted-foreground">{MY_GROUP.no}・{MY_GROUP.type === "INDUSTRY" ? "產學合作" : "一般專題"}</p>
          <h1 className="page-title mt-1 text-balance">{MY_GROUP.title}</h1>
          {MY_GROUP.summary ? <p className="mt-2 text-[15px] text-muted-foreground">{MY_GROUP.summary}</p> : null}
        </div>
        <div className="flex items-center gap-2 rounded-2xl border border-dashed border-border bg-card/70 px-2 py-1.5" data-phase-toggle>
          <span className="pl-1.5 text-[12px] font-bold text-muted-foreground">示範</span>
          {(["forming", "formed"] as const).map((p) => (
            <Link key={p} href={href(tab, p)} scroll={false} aria-current={p === phase ? "true" : undefined} className={`inline-flex h-9 items-center rounded-xl px-3 text-[13px] font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40 ${p === phase ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
              {p === "forming" ? "還沒成組" : "已成組"}
            </Link>
          ))}
        </div>
      </section>

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
/* 第 3 輪（照 A-group 的排版）：組員卡（插畫頭像、組長皇冠）＋指導老師卡＋下方一條里程碑線（達成深橘打勾、未達成灰鎖） */
function MineTab({ v }: { v: ReturnType<typeof groupView> }) {
  const confirmed = v.members.filter((m) => m.confirmed).length;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <section aria-labelledby="members-title" className="dash-card p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="members-title" className="text-[18px] font-extrabold">組員<span className="tabular ml-1.5 text-[15px] font-bold text-muted-foreground">（{v.members.length} 人）</span></h2>
            <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-bold ${v.formed ? "bg-success-subtle text-success-on-subtle" : "bg-brand-subtle text-brand-on-subtle"}`}>{v.formed ? "已成組" : `${confirmed}/5 人已確認`}</span>
          </div>
          <ol className="mt-7 grid grid-cols-3 gap-x-3 gap-y-7 sm:grid-cols-5" data-members>
            {v.members.map((m) => (
              <li key={m.id} className="flex flex-col items-center text-center">
                <span className="relative">
                  {m.isLeader ? <IconCrown aria-label="組長" className="absolute -top-5 left-1/2 z-10 size-6 -translate-x-1/2 fill-[var(--brand-deep)] text-[var(--brand-deep)]" strokeWidth={1.6} /> : null}
                  <UserAvatar id={m.id} name={m.name} className={`size-20 md:size-24 ${m.confirmed ? "" : "opacity-45 grayscale"}`} />
                  {!m.confirmed ? <span className="absolute inset-0 rounded-full border-2 border-dashed border-muted-foreground/50" aria-hidden /> : null}
                </span>
                <span className={`mt-2.5 text-[15px] ${m.id === v.me.id ? "font-extrabold" : "font-bold"}`}>{m.name}{m.id === v.me.id ? "（你）" : ""}</span>
                <span className={`text-[13px] font-semibold ${m.isLeader ? "text-[var(--brand-deep)]" : "text-muted-foreground"}`}>{m.isLeader ? "組長" : m.confirmed ? "組員" : "等待確認"}</span>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="advisor-title" className="dash-card flex flex-col p-6" data-advisor>
          <h2 id="advisor-title" className="text-[18px] font-extrabold">指導老師</h2>
          {v.advisor ? (
            <div className="mt-5 flex flex-1 flex-col items-center text-center">
              <UserAvatar id={v.advisor.id} name={v.advisor.name} className="size-24" />
              <p className="mt-3 text-[19px] font-extrabold">{v.advisor.name} 老師</p>
              <p className="text-[13px] text-muted-foreground">資訊管理學系</p>
              <a href={`mailto:${v.advisor.email}`} className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold break-all text-primary underline-offset-2 hover:underline" data-advisor-email><IconMail className="size-4 shrink-0" />{v.advisor.email}</a>
            </div>
          ) : (
            <div className="mt-5 flex flex-1 flex-col items-center text-center">
              <span className="inline-flex size-24 items-center justify-center rounded-full border-2 border-dashed border-border bg-muted/50 text-muted-foreground"><IconSchool className="size-10" strokeWidth={1.4} /></span>
              <p className="mt-3 text-[17px] font-extrabold">還沒有指導老師</p>
              <p className="mt-0.5 text-sm text-muted-foreground">9/25 抽籤後公布</p>
            </div>
          )}
        </section>
      </div>

      <section aria-labelledby="ms-title" className="dash-card p-6">
        <h2 id="ms-title" className="text-[18px] font-extrabold">里程碑</h2>
        <ol className="mt-6 flex flex-col gap-6 md:grid md:grid-cols-4 md:gap-0" data-badges>
          {v.milestones.map((b, i) => {
            const prevDone = i > 0 && v.milestones[i - 1].done;
            return (
              <li key={b.id} data-done={b.done} className="relative flex items-center gap-4 md:flex-col md:gap-0 md:text-center">
                {/* 連接線：桌機橫的、手機直的；兩端都達成才上色 */}
                {i > 0 ? <span aria-hidden className={`absolute md:top-7 md:right-1/2 md:left-[-50%] md:h-[3px] md:w-auto max-md:-top-6 max-md:left-[27px] max-md:h-6 max-md:w-[3px] ${prevDone && b.done ? "bg-[var(--brand-deep)]" : "bg-border"}`} /> : null}
                {b.done ? (
                  <span className="relative z-10 inline-flex size-14 shrink-0 items-center justify-center rounded-full bg-[var(--brand-deep)] text-white shadow-[0_8px_20px_-8px_oklch(0.5_0.15_45/70%)]"><IconCheck className="size-7" strokeWidth={3} /></span>
                ) : (
                  <span className="relative z-10 inline-flex size-14 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ring-4 ring-card" aria-label="未達成"><IconLock className="size-6" strokeWidth={2} /></span>
                )}
                <span className="min-w-0 md:mt-3">
                  <span className={`block text-[16px] font-extrabold ${b.done ? "" : "text-muted-foreground"}`}>{b.title}</span>
                  <span className="tabular block text-[13px] text-muted-foreground">{b.done ? `${b.at} 完成` : b.hint}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- 找隊員 */
function TeamTab({ phase }: { phase: Phase }) {
  if (phase === "formed") {
    return (
      <section className="flex flex-col items-center rounded-3xl bg-success-subtle px-6 py-14 text-center" data-team-done>
        <span className="inline-flex size-16 items-center justify-center rounded-full bg-success text-success-foreground"><IconConfetti className="size-8" /></span>
        <h2 className="mt-4 text-[22px] font-extrabold text-success-on-subtle">已成組</h2>
        <p className="tabular mt-1 text-sm text-success-on-subtle/80">{MY_GROUP.no}・8/17</p>
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
        <h2 id="events-title" className="flex items-center gap-2 text-[17px] font-extrabold"><IconHistory className="size-5 text-muted-foreground" /> 組別動態</h2>
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
        <h2 id="props-title" className="flex items-center gap-2 px-1 text-[17px] font-extrabold"><IconFlag className="size-5 text-muted-foreground" /> 邀請紀錄</h2>
        {props.map((p) => (
          <article key={p.id} className="dash-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="tabular text-sm font-bold">{p.by} 邀請・{p.at.slice(5).replace("-", "/")}</p>
              <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-bold ${RESULT[p.result].cls}`}>{RESULT[p.result].label}</span>
            </div>
            <ul className="mt-3 flex flex-wrap gap-2">
              {p.invites.map((i) => (
                <li key={i.studentNo} className="inline-flex items-center gap-1.5 rounded-full bg-muted/70 py-1 pr-3 pl-1 text-[13px]">
                  <UserAvatar id={MY_GROUP.members.find((m) => m.studentNo === i.studentNo)?.id ?? i.studentNo} name={i.name} className="size-6" />
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

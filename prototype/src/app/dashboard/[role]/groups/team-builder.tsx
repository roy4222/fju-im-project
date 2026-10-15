"use client";

import { useState } from "react";
import { IconBell, IconCheck, IconClock, IconFlag, IconMail, IconSend, IconUserPlus, IconX } from "@tabler/icons-react";
import { CURRENT_USERS, UNGROUPED } from "@/lib/fixtures";
import type { InviteState, Proposal } from "@/lib/student-v1";

/**
 * 組隊（成組期）：目前提案的邀請狀態 → 撤回後可以重新發起提案；下方找組員。
 * 原型：全部是本地 state，重新整理就回到假資料。
 */
const STATE: Record<InviteState, { label: string; cls: string; icon: typeof IconCheck }> = {
  accepted: { label: "已接受", cls: "bg-success-subtle text-success-on-subtle", icon: IconCheck },
  pending: { label: "等待回覆", cls: "bg-brand-subtle text-brand-on-subtle", icon: IconClock },
  declined: { label: "婉拒", cls: "bg-destructive-subtle text-destructive-on-subtle", icon: IconX },
};

export function TeamBuilder({ proposal }: { proposal: Proposal }) {
  const me = CURRENT_USERS.student;
  const [current, setCurrent] = useState<Proposal | null>(proposal);
  const [picked, setPicked] = useState<string[]>([]);
  const [reminded, setReminded] = useState(false);
  const [open, setOpen] = useState(true);
  const classmates = UNGROUPED.filter((u) => u.openToJoin);
  const accepted = current ? current.invites.filter((i) => i.state === "accepted").length + 1 : 0;

  function toggle(no: string) {
    setPicked((p) => (p.includes(no) ? p.filter((x) => x !== no) : p.length >= 4 ? p : [...p, no]));
  }
  function send() {
    const invites = classmates.filter((c) => picked.includes(c.studentNo)).map((c) => ({ name: c.name, studentNo: c.studentNo, state: "pending" as const }));
    setCurrent({ id: "p-new", by: me.name, at: "2026-08-17 14:32", expires: "2026-08-24", result: "open", invites });
    setPicked([]);
  }

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      {/* 提案 */}
      <section aria-labelledby="proposal-title" className="dash-card p-6" data-proposal>
        {current ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="proposal-title" className="flex items-center gap-2 text-[17px] font-extrabold"><IconFlag className="size-5 text-brand" /> 目前的提案</h2>
                <p className="tabular mt-1 text-[13px] text-muted-foreground">{current.by} 發起・{current.expires?.slice(5).replace("-", "/")} 前沒回覆就過期</p>
              </div>
              <span className="tabular rounded-full bg-accent px-3 py-1 text-sm font-extrabold text-primary">{accepted}/5 到齊</span>
            </div>
            <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={5} aria-valuenow={accepted} aria-label="已接受人數">
              <span className="block h-full rounded-full bg-success transition-[width] duration-500" style={{ width: `${(accepted / 5) * 100}%` }} />
            </div>
            <ul className="mt-5 flex flex-col gap-2.5">
              <li className="flex items-center gap-3 rounded-2xl bg-muted/50 px-3.5 py-2.5">
                <span className="inline-flex size-9 items-center justify-center rounded-full bg-primary text-[12px] font-bold text-primary-foreground">{me.name.slice(-2)}</span>
                <span className="flex-1 text-sm font-bold">{me.name}（你，提案人）</span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-bold ${STATE.accepted.cls}`}><IconCheck className="size-3.5" />已加入</span>
              </li>
              {current.invites.map((i) => {
                const s = STATE[i.state];
                return (
                  <li key={i.studentNo} className="flex items-center gap-3 rounded-2xl bg-muted/50 px-3.5 py-2.5">
                    <span className={`inline-flex size-9 items-center justify-center rounded-full text-[12px] font-bold ${i.state === "accepted" ? "bg-primary text-primary-foreground" : "border-2 border-dashed border-border bg-card text-muted-foreground"}`}>{i.name.slice(-2)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-bold">{i.name}</span>
                      <span className="tabular block text-[12px] text-muted-foreground">{i.studentNo}{i.at ? `・${i.at}` : ""}</span>
                    </span>
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-bold ${s.cls}`}><s.icon className="size-3.5" />{s.label}</span>
                  </li>
                );
              })}
            </ul>
            <div className="mt-5 flex flex-wrap gap-2">
              <button type="button" onClick={() => setReminded(true)} disabled={reminded} className="btn-fju h-11 rounded-xl px-4 text-sm disabled:opacity-60"><IconBell className="size-4" />{reminded ? "已提醒還沒回覆的人" : "提醒還沒回覆的人"}</button>
              <button type="button" onClick={() => setCurrent(null)} className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-border px-4 text-sm font-bold transition-colors hover:bg-accent">撤回提案</button>
            </div>
          </>
        ) : (
          <>
            <h2 id="proposal-title" className="flex items-center gap-2 text-[17px] font-extrabold"><IconFlag className="size-5 text-brand" /> 發起提案</h2>
            <p className="mt-1 text-sm text-muted-foreground">從右邊找組員勾選最多 4 位，加上你共 5 人；每個人用自己的帳號接受後才成組。</p>
            <ul className="mt-5 flex flex-wrap gap-2" aria-label="已選的組員">
              <li className="inline-flex items-center gap-1.5 rounded-full bg-primary py-1 pr-3 pl-1 text-[13px] font-bold text-primary-foreground"><span className="inline-flex size-6 items-center justify-center rounded-full bg-white/20 text-[11px]">{me.name.slice(-1)}</span>{me.name}（你）</li>
              {picked.map((no) => {
                const c = classmates.find((x) => x.studentNo === no)!;
                return <li key={no} className="inline-flex items-center gap-1.5 rounded-full bg-accent py-1 pr-1 pl-3 text-[13px] font-bold text-primary">{c.name}<button type="button" onClick={() => toggle(no)} aria-label={`移除 ${c.name}`} className="inline-flex size-6 items-center justify-center rounded-full hover:bg-card"><IconX className="size-3.5" /></button></li>;
              })}
              {Array.from({ length: 4 - picked.length }, (_, i) => <li key={`empty-${i}`} className="inline-flex h-8 w-20 items-center justify-center rounded-full border-2 border-dashed border-border text-[12px] text-muted-foreground">空位</li>)}
            </ul>
            <button type="button" onClick={send} disabled={picked.length === 0} className="btn-fju mt-5 h-11 rounded-xl px-5 text-sm disabled:cursor-not-allowed disabled:opacity-50"><IconSend className="size-4" /> 送出提案（邀請 {picked.length} 位）</button>
          </>
        )}
      </section>

      {/* 找組員 */}
      <section aria-labelledby="find-title" className="rounded-3xl bg-accent/60 p-5" data-find>
        <div className="flex items-center justify-between gap-3">
          <h2 id="find-title" className="text-[17px] font-extrabold">找組員</h2>
          <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] font-semibold">
            <span>公開我在找組</span>
            <input type="checkbox" role="switch" checked={open} onChange={(e) => setOpen(e.target.checked)} className="peer sr-only" />
            <span aria-hidden className="relative h-6 w-10 rounded-full bg-border transition-colors peer-checked:bg-success peer-focus-visible:ring-3 peer-focus-visible:ring-ring/40 after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-card after:shadow after:transition-transform peer-checked:after:translate-x-4" />
          </label>
        </div>
        <p className="mt-1 text-[12px] text-muted-foreground">只列出也開了公開的同屆未分組同學。</p>
        <ul className="mt-4 flex flex-col gap-2">
          {classmates.map((c) => {
            const on = picked.includes(c.studentNo);
            const invited = current?.invites.some((i) => i.studentNo === c.studentNo);
            return (
              <li key={c.id} className="flex items-center gap-3 rounded-2xl bg-card px-3.5 py-2.5">
                <span className="inline-flex size-9 items-center justify-center rounded-full bg-muted text-[12px] font-bold">{c.name.slice(-2)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold">{c.name}</span>
                  <span className="tabular block text-[12px] text-muted-foreground">{c.studentNo}</span>
                </span>
                {current ? (
                  invited ? <span className="text-[12px] font-bold text-muted-foreground">已邀請</span> : <a href={`mailto:${c.studentNo}@m365.fju.edu.tw`} className="inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-[13px] font-bold text-primary hover:bg-accent"><IconMail className="size-4" />聯絡</a>
                ) : (
                  <button type="button" onClick={() => toggle(c.studentNo)} aria-pressed={on} className={`inline-flex h-9 items-center gap-1 rounded-lg px-3 text-[13px] font-bold transition-colors ${on ? "bg-primary text-primary-foreground" : "text-primary ring-1 ring-border hover:bg-accent"}`}>
                    {on ? <IconCheck className="size-4" /> : <IconUserPlus className="size-4" />}{on ? "已選" : "邀請"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

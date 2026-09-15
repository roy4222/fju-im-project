"use client";

import { useState } from "react";
import { Pill } from "@/components/dashboard/primitives";
import type { AuditEvent } from "@/lib/fixtures";

const ROLES = [{ key: "all", label: "全部" }, { key: "admin", label: "管理員" }, { key: "teacher", label: "老師" }, { key: "student", label: "學生" }, { key: "system", label: "系統" }] as const;
type Who = (typeof ROLES)[number]["key"];

/** 操作紀錄清單：角色篩選用本地 state（不換頁），選取用短底線描出（共同語法：選單選取線）。 */
export function AuditList({ events, initial = "all" }: { events: AuditEvent[]; initial?: string }) {
  const [who, setWho] = useState<Who>(ROLES.some((r) => r.key === initial) ? (initial as Who) : "all");
  const list = who === "all" ? events : events.filter((e) => e.role === who);
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3" role="tablist" aria-label="依角色篩選">
        {ROLES.map((r) => {
          const n = r.key === "all" ? events.length : events.filter((e) => e.role === r.key).length;
          const on = who === r.key;
          return (
            <button key={r.key} type="button" role="tab" aria-selected={on} onClick={() => setWho(r.key)} className={`relative h-10 px-3 text-sm font-semibold transition-colors ${on ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {r.label} <span className="tabular text-xs font-medium text-muted-foreground">{n}</span>
              <span className={`absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-brand transition-transform duration-150 ${on ? "scale-x-100" : "scale-x-0"}`} aria-hidden />
            </button>
          );
        })}
      </div>
      <ol>
        {list.map((e) => (
          <li key={e.id} className="grid items-start gap-3 border-b border-border px-5 py-3.5 last:border-0 md:grid-cols-[9rem_7rem_minmax(0,1fr)]">
            <time className="tabular text-xs text-muted-foreground">{e.at}</time>
            <span className="flex items-center gap-2 text-sm font-semibold"><span className="inline-flex size-6 items-center justify-center rounded-full bg-brand-subtle text-[10px] font-bold text-brand-on-subtle">{e.actor.slice(0, 1)}</span>{e.actor}</span>
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Pill tone={e.role === "admin" ? "brand" : e.role === "system" ? "default" : "info"}>{e.action}</Pill><span className="truncate text-sm">{e.target}</span></div>{e.reason ? <p className="mt-1 text-sm text-muted-foreground">理由：{e.reason}</p> : null}</div>
          </li>
        ))}
        {list.length === 0 ? <li className="px-5 py-8 text-center text-sm text-muted-foreground">這個角色最近沒有操作。</li> : null}
      </ol>
    </div>
  );
}

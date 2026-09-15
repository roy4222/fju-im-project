"use client";

import { useState } from "react";
import { IconSearch, IconX } from "@tabler/icons-react";
import { GROUPS } from "@/lib/fixtures";

/**
 * 指定組別挑選器（Codex 09-10 A-01）：可搜尋組號／題目、多選、已選 chips。
 * 快速建立與完整編輯器共用。
 */
export function GroupPicker({ value, onChange, id = "group-picker" }: { value: string[]; onChange: (ids: string[]) => void; id?: string }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase().replace(/\s+/g, "");
  const list = GROUPS.filter((g) => !query || g.no.replace(/\s+/g, "").toLowerCase().includes(query) || g.title.toLowerCase().includes(query));
  const picked = GROUPS.filter((g) => value.includes(g.id)).sort((a, b) => a.no.localeCompare(b.no));
  function toggle(gid: string) {
    onChange(value.includes(gid) ? value.filter((x) => x !== gid) : [...value, gid]);
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {picked.length === 0 ? <span className="text-xs text-muted-foreground">還沒選組別</span> : null}
        {picked.map((g) => (
          <span key={g.id} className="inline-flex h-7 items-center gap-1 rounded-full border border-brand/30 bg-brand-subtle pr-1 pl-2.5 text-xs font-semibold text-brand-on-subtle">
            {g.no}
            <button type="button" onClick={() => toggle(g.id)} aria-label={`移除 ${g.no}`} className="inline-flex size-5 items-center justify-center rounded-full hover:bg-brand/20"><IconX className="size-3" /></button>
          </span>
        ))}
        {picked.length ? <button type="button" onClick={() => onChange([])} className="text-xs text-muted-foreground underline-offset-2 hover:underline">清除</button> : null}
      </div>
      <label className="relative block">
        <span className="sr-only">搜尋組號或題目</span>
        <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <input id={id} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋組號或題目，例：02、補貨" className="h-10 w-full rounded-lg border border-input bg-background pr-3 pl-9 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25" />
      </label>
      <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border" aria-label="組別">
        {list.map((g) => {
          const on = value.includes(g.id);
          return (
            <li key={g.id}>
              <label className={`flex min-h-10 cursor-pointer items-center gap-3 px-3 py-1.5 text-sm transition-colors hover:bg-accent/60 ${on ? "bg-brand-subtle/40" : ""}`}>
                <input type="checkbox" checked={on} onChange={() => toggle(g.id)} className="size-4 accent-[var(--brand)]" />
                <span className="tabular w-16 shrink-0 font-semibold">{g.no}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{g.title.replace(/（產學：.*）/, "")}</span>
                <span className="tabular shrink-0 text-xs text-muted-foreground">{g.members.length} 人</span>
              </label>
            </li>
          );
        })}
        {list.length === 0 ? <li className="px-3 py-3 text-center text-xs text-muted-foreground">沒有符合「{q}」的組別</li> : null}
      </ul>
    </div>
  );
}

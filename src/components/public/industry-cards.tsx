"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { IconArrowRight, IconBriefcase, IconBuilding, IconSearch, IconUser, IconX } from "@tabler/icons-react";
import { ListState, Tag } from "@/components/public/blocks";
import type { IndustryItem } from "@/lib/fixtures";

type Status = "all" | "open" | "claimed";
type Sort = "newest" | "oldest" | "company";

const SORT_LABEL: Record<Sort, string> = { newest: "發布日期（新到舊）", oldest: "發布日期（舊到新）", company: "公司名稱" };

/**
 * 產學合作列表：卡片式（Roy 2026-09-08：表格看起來太單薄），
 * 保留搜尋、狀態與老師篩選、排序。公司聯絡資料不在列表（規格 §6.2）。
 */
export function IndustryCards({ items, canClaim = false }: { items: IndustryItem[]; canClaim?: boolean }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [advisor, setAdvisor] = useState("all");
  const [sort, setSort] = useState<Sort>("newest");
  const advisors = useMemo(() => [...new Set(items.map((i) => i.advisorName))], [items]);

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    let r = items;
    if (status !== "all") r = r.filter((i) => i.status === status);
    if (advisor !== "all") r = r.filter((i) => i.advisorName === advisor);
    if (k) r = r.filter((i) => [i.company, i.department, i.title, i.advisorName].some((t) => t.toLowerCase().includes(k)));
    r = [...r];
    if (sort === "company") r.sort((a, b) => a.company.localeCompare(b.company, "zh-Hant"));
    else if (sort === "oldest") r.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    else r.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return r;
  }, [items, q, status, advisor, sort]);

  const pill = (v: Status, label: string) => (
    <button
      type="button"
      onClick={() => setStatus(v)}
      aria-pressed={status === v}
      className={`inline-flex h-9 items-center rounded-full border px-4 text-sm font-semibold transition-colors ${status === v ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-accent"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="狀態篩選">
          {pill("all", "全部")}
          {pill("open", "尚未指派組別")}
          {pill("claimed", "已有組別")}
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="relative flex h-10 w-full items-center sm:w-64">
            <IconSearch className="pointer-events-none absolute left-3 size-4 text-muted-foreground" aria-hidden />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋公司、部門、內容、老師" aria-label="搜尋產學合作案" className="h-10 w-full rounded-md border border-input bg-background pr-9 pl-9 text-sm outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30" />
            {q ? (
              <button type="button" onClick={() => setQ("")} className="absolute right-2 inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground" aria-label="清除搜尋">
                <IconX className="size-4" />
              </button>
            ) : null}
          </label>
          <select value={advisor} onChange={(e) => setAdvisor(e.target.value)} aria-label="負責老師" className="h-10 rounded-md border border-input bg-background px-2.5 text-sm font-semibold outline-none focus-visible:border-brand">
            <option value="all">全部老師</option>
            {advisors.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="排序方式" className="h-10 rounded-md border border-input bg-background px-2.5 text-sm font-semibold outline-none focus-visible:border-brand">
            {(Object.keys(SORT_LABEL) as Sort[]).map((s) => (
              <option key={s} value={s}>{SORT_LABEL[s]}</option>
            ))}
          </select>
        </div>
      </div>

      {list.length === 0 ? (
        <ListState
          icon={<IconBriefcase className="size-8" />}
          title={items.length === 0 ? "目前沒有公開的產學合作案" : "找不到符合的合作案"}
          hint={items.length === 0 ? "老師建立並公開合作案後會出現在這裡。" : "換個關鍵字，或清除篩選條件。"}
          action={items.length > 0 ? <button type="button" onClick={() => { setQ(""); setStatus("all"); setAdvisor("all"); }} className="btn-fju-outline h-10 px-4 text-sm">清除條件</button> : undefined}
        />
      ) : (
        <ul className="grid gap-5 md:grid-cols-2">
          {list.map((i) => (
            <li key={i.id}>
              <Link href={`/industry/${i.id}`} className="group flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-6 transition-colors hover:border-brand">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-subtle text-brand-on-subtle">
                      <IconBuilding className="size-5" />
                    </span>
                    <div className="flex flex-col">
                      <span className="text-lg font-bold leading-tight group-hover:text-brand">{i.company}</span>
                      <span className="text-[13px] text-muted-foreground">{i.department}</span>
                    </div>
                  </div>
                  {i.status === "claimed" ? <Tag tone="navy">已有 {i.linkedGroups} 組</Tag> : <Tag>尚未指派</Tag>}
                </div>
                <p className="text-[16px] font-semibold leading-snug">{i.title}</p>
                <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-[13px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5"><IconUser className="size-4" />{i.advisorName} 老師<span aria-hidden>・</span><span className="tabular">{i.publishedAt}</span></span>
                  <span className="inline-flex items-center gap-1 font-semibold text-primary group-hover:text-brand">
                    {canClaim && i.status === "open" ? "查看與認領" : "詳細資料"} <IconArrowRight className="size-4" />
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[13px] text-muted-foreground">共 {list.length} 件合作案。公司聯絡資料只有負責老師與系辦看得到。</p>
    </div>
  );
}

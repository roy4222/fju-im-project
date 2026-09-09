"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { IconFileText, IconPlayerPlay, IconSearch, IconSearchOff } from "@tabler/icons-react";
import { AwardBadge, ListState, Tag } from "@/components/public/blocks";
import { Input } from "@/components/ui/input";
import type { ProjectItem } from "@/lib/fixtures";

type Sort = "cohort" | "award" | "title";

/**
 * 歷屆專題一覽：卡片式（Roy 2026-09-07，參考 NIICC 成果展示），
 * 依屆別分段，優秀專題王冠、佳作獎盃；可搜尋、篩選、排序。
 */
export function ProjectBrowser({ projects, cohorts }: { projects: ProjectItem[]; cohorts: string[] }) {
  const [q, setQ] = useState("");
  const [cohort, setCohort] = useState("all");
  const [awardOnly, setAwardOnly] = useState(false);
  const [sort, setSort] = useState<Sort>("cohort");

  const items = useMemo(() => {
    const rank = (p: ProjectItem) => (p.award === "excellent" ? 0 : p.award === "merit" ? 1 : 2);
    let list = projects.filter((p) => (cohort === "all" || p.cohort === cohort) && (!awardOnly || p.award));
    const needle = q.trim();
    if (needle) list = list.filter((p) => [p.title, p.groupNo, p.advisor, p.field, p.summary].some((t) => t.includes(needle)));
    list = [...list].sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title, "zh-Hant");
      if (sort === "award") return rank(a) - rank(b) || b.cohort.localeCompare(a.cohort);
      return b.cohort.localeCompare(a.cohort) || rank(a) - rank(b);
    });
    return list;
  }, [projects, q, cohort, awardOnly, sort]);

  const groups = useMemo(() => {
    if (sort !== "cohort") return [{ key: "all", label: "", items }];
    const map = new Map<string, ProjectItem[]>();
    items.forEach((p) => map.set(p.cohort, [...(map.get(p.cohort) ?? []), p]));
    return [...map.entries()].map(([k, v]) => ({ key: k, label: `${k} 屆`, items: v }));
  }, [items, sort]);

  const pill = (active: boolean, tone: "navy" | "brand" = "navy") =>
    `inline-flex h-9 items-center rounded-full border px-4 text-sm font-semibold transition-colors ${
      active ? (tone === "brand" ? "border-brand bg-brand text-brand-foreground" : "border-primary bg-primary text-primary-foreground") : tone === "brand" ? "border-brand text-brand hover:bg-brand-subtle" : "border-border hover:bg-accent"
    }`;

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="屆別篩選">
          <button type="button" className={pill(cohort === "all")} onClick={() => setCohort("all")} aria-pressed={cohort === "all"}>全部屆別</button>
          {cohorts.map((c) => (
            <button key={c} type="button" className={pill(cohort === c)} onClick={() => setCohort(c)} aria-pressed={cohort === c}>{c} 屆</button>
          ))}
          <button type="button" className={pill(awardOnly, "brand")} onClick={() => setAwardOnly((v) => !v)} aria-pressed={awardOnly}>只看得獎</button>
        </div>
        <div className="flex gap-2">
          <label className="relative block">
            <span className="sr-only">搜尋題目、組別、指導老師</span>
            <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋題目、組別、指導老師" className="h-10 w-64 pl-9" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">排序</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <option value="cohort">依屆別（新到舊）</option>
              <option value="award">得獎優先</option>
              <option value="title">依題目</option>
            </select>
          </label>
        </div>
      </div>

      {items.length === 0 ? (
        <ListState
          icon={<IconSearchOff className="size-9" />}
          title={q ? `找不到符合「${q}」的作品` : "沒有符合條件的作品"}
          hint="換個關鍵字，或清除篩選條件。"
          action={
            <button type="button" className="font-bold text-brand hover:underline" onClick={() => { setQ(""); setCohort("all"); setAwardOnly(false); }}>
              清除條件
            </button>
          }
        />
      ) : (
        groups.map((g) => (
          <section key={g.key} className="flex flex-col gap-5" aria-label={g.label || "全部作品"}>
            {g.label ? (
              <h2 className="flex items-center gap-4 text-xl font-bold text-primary">
                <span className="rounded-md bg-primary px-3 py-1 text-base text-primary-foreground">{g.label}</span>
                <span className="text-sm font-semibold text-muted-foreground">{g.items.length} 件</span>
                <span className="h-px flex-1 bg-border" aria-hidden />
              </h2>
            ) : null}
            <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {g.items.map((p) => (
                <li key={p.id}>
                  <ProjectCard project={p} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <p className="text-center text-[13px] text-muted-foreground">共 {items.length} 件作品。影片為系上 YouTube 不公開連結。</p>
    </div>
  );
}

export function ProjectCard({ project: p }: { project: ProjectItem }) {
  return (
    <Link href={`/projects/${p.id}`} className="group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:shadow-[0_8px_22px_rgba(0,51,102,0.14)]">
      <div className="relative aspect-video overflow-hidden bg-muted">
        <Image src={p.image} alt="" fill sizes="(max-width: 640px) 100vw, 380px" className="object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
        <AwardBadge award={p.award} label={p.awardLabel} className="absolute top-3 left-3 shadow-md" />
        <span className="absolute bottom-3 left-3 rounded bg-background/95 px-2 py-0.5 text-xs font-semibold">{p.field}</span>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4.5">
        <span className="type-card-title group-hover:text-brand">{p.title}</span>
        <span className="text-[13px] text-muted-foreground">
          {p.cohort} 屆・{p.groupNo}・指導老師 {p.advisor}
        </span>
        <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{p.summary}</p>
        <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
          {p.hasPoster ? <Tag tone="navy"><IconFileText className="mr-1 size-3.5" />海報</Tag> : null}
          {p.hasVideo ? <Tag tone="navy"><IconPlayerPlay className="mr-1 size-3.5" />影片</Tag> : null}
        </div>
      </div>
    </Link>
  );
}

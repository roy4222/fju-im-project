import Image from "next/image";
import type { Metadata } from "next";
import { IconExternalLink, IconTrophy } from "@tabler/icons-react";
import { ListState, PageHead, PillLink, Tag } from "@/components/public/blocks";
import { SearchSortBar } from "@/components/public/search-sort-bar";
import { listCompetitions } from "@/lib/data/catalog";

export const metadata: Metadata = {
  title: "競賽資訊",
  description: "進行中與近期的競賽資訊、報名連結與本系參賽紀錄。",
  alternates: { canonical: "/competitions" },
  openGraph: { url: "/competitions" },
};

const STATUS: Record<string, { label: string; tone: "brand" | "navy" }> = {
  open: { label: "報名中", tone: "brand" },
  result: { label: "決賽／結果", tone: "navy" },
  closed: { label: "已結束", tone: "navy" },
};

function keep(sp: Record<string, string | string[] | undefined>, patch: Record<string, string>) {
  const p = new URLSearchParams();
  for (const k of ["q", "sort"]) if (typeof sp[k] === "string" && sp[k]) p.set(k, sp[k] as string);
  for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k);
  const s = p.toString();
  return s ? `/competitions?${s}` : "/competitions";
}

/** 競賽資訊：狀態由日期自動推導；可搜尋、排序（Roy 2026-09-08）。 */
export default async function CompetitionsPage({ searchParams }: PageProps<"/competitions">) {
  const sp = await searchParams;
  const status = typeof sp.status === "string" ? sp.status : "all";
  const q = typeof sp.q === "string" ? sp.q : "";
  const sort = typeof sp.sort === "string" ? sp.sort : undefined;
  const items = await listCompetitions({ status, q, sort });
  return (
    <>
      <PageHead title="競賽資訊" description="進行中與近期的競賽。狀態依截止日與活動日自動更新。" crumbs={[{ href: "/news", label: "最新公告" }, { label: "競賽資訊" }]} />
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <nav className="flex flex-wrap gap-2" aria-label="篩選">
            <PillLink href={keep(sp, { status: "" })} active={status === "all"}>全部</PillLink>
            <PillLink href={keep(sp, { status: "open" })} active={status === "open"} tone="brand">報名中</PillLink>
            <PillLink href={keep(sp, { status: "result" })} active={status === "result"}>決賽／結果</PillLink>
            <PillLink href={keep(sp, { status: "closed" })} active={status === "closed"}>已結束</PillLink>
          </nav>
          <SearchSortBar
            placeholder="搜尋競賽名稱、主辦單位"
            sortOptions={[
              { value: "deadline", label: "截止日（新到舊）" },
              { value: "deadline-asc", label: "截止日（舊到新）" },
              { value: "title", label: "名稱" },
            ]}
          />
        </div>
        {items.length === 0 ? (
          <ListState icon={<IconTrophy className="size-8" />} title={q ? "找不到符合的競賽" : "目前沒有競賽資訊"} hint={q ? "換個關鍵字，或清除篩選條件。" : "系辦發布競賽資訊後會出現在這裡。"} />
        ) : (
          <ul className="grid gap-6 md:grid-cols-2">
            {items.map((c) => (
              <li key={c.id} id={c.id} className="scroll-mt-24">
                <article className="grid h-full overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-[280px_minmax(0,1fr)]">
                  <div className="relative aspect-video sm:aspect-auto">
                    <Image src={c.image} alt="" fill sizes="(max-width: 640px) 100vw, 280px" className="object-cover" />
                  </div>
                  <div className="flex flex-col gap-2.5 p-6">
                    <div className="flex items-center gap-2">
                      <Tag tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Tag>
                      <span className="tabular text-[13px] font-semibold text-muted-foreground">{c.status === "open" ? `截止 ${c.deadline}` : c.eventDate ? `活動 ${c.eventDate}` : `截止 ${c.deadline}`}</span>
                    </div>
                    <h2 className="text-xl font-bold leading-snug">{c.title}</h2>
                    <p className="text-[13px] text-muted-foreground">主辦：{c.organizer}</p>
                    <p className="text-[15px] leading-relaxed text-muted-foreground">{c.summary}</p>
                    {c.link ? (
                      <a href={c.link} target="_blank" rel="noreferrer" className="mt-auto inline-flex items-center gap-1 pt-2 text-sm font-bold text-brand hover:underline">
                        競賽詳情與報名 <IconExternalLink className="size-4" />
                      </a>
                    ) : null}
                  </div>
                </article>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

import Image from "next/image";
import type { Metadata } from "next";
import { IconExternalLink } from "@tabler/icons-react";
import { PageHead, PillLink, Tag } from "@/components/public/blocks";
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

export default async function CompetitionsPage({ searchParams }: PageProps<"/competitions">) {
  const sp = await searchParams;
  const filter = typeof sp.status === "string" ? sp.status : "all";
  const all = await listCompetitions();
  const items = filter === "all" ? all : all.filter((c) => c.status === filter);
  return (
    <>
      <PageHead title="競賽資訊" description="進行中與近期的競賽，比照公告卡片；每張卡片含狀態、截止日、說明與報名連結。" crumbs={[{ href: "/news", label: "最新公告" }, { label: "競賽資訊" }]} />
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10">
        <nav className="flex flex-wrap gap-2" aria-label="篩選">
          <PillLink href="/competitions" active={filter === "all"}>全部</PillLink>
          <PillLink href="/competitions?status=open" active={filter === "open"} tone="brand">報名中</PillLink>
          <PillLink href="/competitions?status=result" active={filter === "result"}>決賽／結果</PillLink>
          <PillLink href="/competitions?status=closed" active={filter === "closed"}>已結束</PillLink>
        </nav>
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
                    <span className="tabular text-[13px] font-semibold text-muted-foreground">{c.status === "open" ? `截止 ${c.deadline}` : c.eventDate ? `活動 ${c.eventDate}` : c.deadline}</span>
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
      </div>
    </>
  );
}

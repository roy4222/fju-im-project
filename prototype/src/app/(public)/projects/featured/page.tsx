import type { Metadata } from "next";
import { IconCrown } from "@tabler/icons-react";
import { ListState, PageHead, PillLink } from "@/components/public/blocks";
import { SearchSortBar } from "@/components/public/search-sort-bar";
import { PhotoDialogGrid, type PhotoEntry } from "@/components/public/photo-dialog-grid";
import { listFeaturedProjects, projectCohorts } from "@/lib/data/catalog";

export const metadata: Metadata = {
  title: "優秀專題",
  description: "歷屆校級優秀專題與競賽得獎作品：海報、題目、說明與獎項。",
  alternates: { canonical: "/projects/featured" },
  openGraph: { url: "/projects/featured" },
};

/** 優秀專題：公開，訪客可點開一圖一文 dialog 與完整詳情（Roy 2026-09-07）；可搜尋排序、不放登入提示（Roy 2026-09-08）。 */
export default async function FeaturedPage({ searchParams }: PageProps<"/projects/featured">) {
  const sp = await searchParams;
  const cohort = typeof sp.cohort === "string" ? sp.cohort : "all";
  const open = typeof sp.item === "string" ? sp.item : undefined;
  const q = typeof sp.q === "string" ? sp.q : "";
  const sort = typeof sp.sort === "string" ? sp.sort : undefined;
  const all = await listFeaturedProjects({ q, sort });
  const items = cohort === "all" ? all : all.filter((p) => p.cohort === cohort);
  const keep = (c: string) => {
    const p = new URLSearchParams();
    if (c !== "all") p.set("cohort", c);
    if (q) p.set("q", q);
    if (sort) p.set("sort", sort);
    const s = p.toString();
    return s ? `/projects/featured?${s}` : "/projects/featured";
  };
  const entries: PhotoEntry[] = items.map((p) => ({
    id: p.id,
    image: p.image,
    title: p.title,
    tags: [{ label: `${p.cohort} 屆`, tone: "navy" }, { label: p.field }],
    award: p.award,
    awardLabel: p.awardLabel,
    summary: p.summary,
    facts: [
      { label: "獎項", value: p.awardLabel ?? "" },
      { label: "組別", value: p.groupNo },
      { label: "指導老師", value: p.advisor },
    ],
    moreHref: `/projects/${p.id}`,
    moreLabel: "查看完整資料",
  }));
  return (
    <>
      <PageHead title="優秀專題" description="歷屆校級優秀專題與競賽得獎作品。點開卡片看海報、說明與獎項；完整摘要、影片與文件概述在詳情頁。" crumbs={[{ label: "優秀專題" }]} />
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <nav className="flex flex-wrap gap-2" aria-label="屆別篩選">
            <PillLink href={keep("all")} active={cohort === "all"}>全部屆別</PillLink>
            {projectCohorts().map((c) => (
              <PillLink key={c} href={keep(c)} active={cohort === c}>{c} 屆</PillLink>
            ))}
          </nav>
          <SearchSortBar placeholder="搜尋題目、指導老師、組別" sortOptions={[{ value: "cohort", label: "屆別（新到舊）" }, { value: "excellent", label: "優秀專題優先" }, { value: "merit", label: "佳作優先" }]} />
        </div>
        {items.length === 0 ? (
          <ListState icon={<IconCrown className="size-8" />} title="找不到符合的作品" hint="換個關鍵字，或清除篩選條件。" />
        ) : (
          <PhotoDialogGrid entries={entries} initialOpenId={open} />
        )}
      </div>
    </>
  );
}

import type { Metadata } from "next";
import { PageHead, PillLink } from "@/components/public/blocks";
import { PhotoDialogGrid, type PhotoEntry } from "@/components/public/photo-dialog-grid";
import { honorYears, listHonors } from "@/lib/data/catalog";

export const metadata: Metadata = {
  title: "榮譽榜",
  description: "競賽得獎照片、得獎組別與獎項。",
  alternates: { canonical: "/honors" },
  openGraph: { url: "/honors" },
};

/** 榮譽榜／得獎照片：卡片一格一格，點開一張圖＋文字（0715 §9）。`?item=` 可深連結。 */
export default async function HonorsPage({ searchParams }: PageProps<"/honors">) {
  const sp = await searchParams;
  const year = typeof sp.year === "string" ? sp.year : "all";
  const open = typeof sp.item === "string" ? sp.item : undefined;
  const items = await listHonors({ year });
  const entries: PhotoEntry[] = items.map((h) => ({
    id: h.id,
    image: h.image,
    title: `${h.competition} ${h.award}`,
    date: h.date,
    tags: [{ label: "榮譽榜" }, { label: h.team, tone: "navy" }],
    summary: h.summary,
    facts: [
      { label: "競賽", value: h.competition },
      { label: "獎項", value: h.award },
      { label: "得獎組別", value: h.team },
      { label: "日期", value: h.date },
    ],
  }));
  return (
    <>
      <PageHead title="榮譽榜" description="競賽得獎照片與得獎組別。點開卡片為一張圖片加文字；人物照不裁切。" crumbs={[{ label: "榮譽榜" }]} />
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10">
        <nav className="flex flex-wrap gap-2" aria-label="年份篩選">
          <PillLink href="/honors" active={year === "all"}>全部</PillLink>
          {honorYears().map((y) => (
            <PillLink key={y} href={`/honors?year=${y}`} active={year === y}>{y}</PillLink>
          ))}
        </nav>
        <PhotoDialogGrid entries={entries} columns={3} initialOpenId={open} />
      </div>
    </>
  );
}

import Link from "next/link";
import type { Metadata } from "next";
import { IconLock } from "@tabler/icons-react";
import { PageHead, PillLink } from "@/components/public/blocks";
import { PhotoDialogGrid, type PhotoEntry } from "@/components/public/photo-dialog-grid";
import { listFeaturedProjects, projectCohorts } from "@/lib/data/catalog";
import { getViewer } from "@/lib/data/viewer";

export const metadata: Metadata = {
  title: "優秀專題",
  description: "歷屆校級優秀專題與競賽得獎作品：海報、題目、說明與獎項。",
  alternates: { canonical: "/projects/featured" },
  openGraph: { url: "/projects/featured" },
};

/** 優秀專題：公開，訪客可點開一圖一文 dialog 與完整詳情（Roy 2026-09-07）。 */
export default async function FeaturedPage({ searchParams }: PageProps<"/projects/featured">) {
  const sp = await searchParams;
  const cohort = typeof sp.cohort === "string" ? sp.cohort : "all";
  const open = typeof sp.item === "string" ? sp.item : undefined;
  const viewer = await getViewer();
  const all = await listFeaturedProjects();
  const items = cohort === "all" ? all : all.filter((p) => p.cohort === cohort);
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
        <nav className="flex flex-wrap gap-2" aria-label="屆別篩選">
          <PillLink href="/projects/featured" active={cohort === "all"}>全部屆別</PillLink>
          {projectCohorts().map((c) => (
            <PillLink key={c} href={`/projects/featured?cohort=${c}`} active={cohort === c}>{c} 屆</PillLink>
          ))}
        </nav>
        <PhotoDialogGrid entries={entries} initialOpenId={open} />
        {!viewer.isMember ? (
          <div className="mt-8 flex flex-col items-start gap-4 rounded-xl bg-secondary p-8 text-secondary-foreground sm:flex-row sm:items-center">
            <IconLock className="size-5 shrink-0 text-brand" aria-hidden />
            <div className="flex-1">
              <p className="text-lg font-bold text-foreground">歷屆專題一覽需要登入</p>
              <p className="text-sm text-muted-foreground">得獎作品公開；全部歷屆作品的題目、摘要、海報與三分鐘影片只提供本系學生與老師作為學習參考。</p>
            </div>
            <Link href="/login?returnTo=/projects" className="btn-fju h-11 px-5 text-[15px]">
              登入查看
            </Link>
          </div>
        ) : null}
      </div>
    </>
  );
}

import type { Metadata } from "next";
import { PageHead } from "@/components/public/blocks";
import { IndustryCards } from "@/components/public/industry-cards";
import { NeedLogin } from "@/components/public/need-login";
import { listIndustry } from "@/lib/data/catalog";
import { getViewer } from "@/lib/data/viewer";

export const metadata: Metadata = { title: "產學合作", robots: { index: false }, alternates: { canonical: "/industry" } };

/** 產學合作列表：登入後（7/22 §6.2、需求表）；卡片式，可搜尋、篩選、排序（Roy 2026-09-08）。 */
export default async function IndustryPage() {
  const viewer = await getViewer();
  if (!viewer.isMember) return <NeedLogin returnTo="/industry" what="產學合作列表" />;
  const items = await listIndustry(viewer);
  return (
    <>
      <PageHead title="產學合作" description="指導老師建立的合作案。尚未指派組別者由老師認領。" crumbs={[{ label: "產學合作" }]} />
      <div className="mx-auto max-w-6xl px-5 py-10">
        <IndustryCards items={items} canClaim={viewer.role === "teacher"} />
      </div>
    </>
  );
}

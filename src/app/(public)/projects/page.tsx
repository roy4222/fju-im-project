import type { Metadata } from "next";
import { PageHead } from "@/components/public/blocks";
import { NeedLogin } from "@/components/public/need-login";
import { ProjectBrowser } from "@/components/public/project-browser";
import { listProjects, projectCohorts } from "@/lib/data/catalog";
import { getViewer } from "@/lib/data/viewer";

export const metadata: Metadata = {
  title: "歷屆專題一覽",
  robots: { index: false },
  alternates: { canonical: "/projects" },
};

/** 歷屆專題一覽：登入後（7/22 §6.2）。卡片式、依屆別分段、可搜尋排序。 */
export default async function ProjectsPage() {
  const viewer = await getViewer();
  if (!viewer.isMember) return <NeedLogin returnTo="/projects" what="歷屆專題一覽" />;
  const projects = await listProjects(viewer);
  return (
    <>
      <PageHead title="歷屆專題一覽" description="本系學生與老師的學習參考庫：題目、摘要、海報、三分鐘影片與文件概述。王冠是優秀專題，獎盃是佳作。" crumbs={[{ label: "歷屆專題一覽" }]} />
      <div className="mx-auto max-w-6xl px-5 py-10">
        <ProjectBrowser projects={projects} cohorts={projectCohorts()} />
      </div>
    </>
  );
}

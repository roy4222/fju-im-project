import { PageHeader } from "@/components/public/page-header";
import { PROJECTS } from "@/lib/fixtures";
import { ProjectsGrid } from "./projects-grid";

export const metadata = { title: "歷屆專題" };

export default function ProjectsPage() {
  const cohorts = [...new Set(PROJECTS.map((p) => p.cohort))].sort().reverse();

  return (
    <>
      <PageHeader
        title="歷屆專題"
        breadcrumb={[{ href: "/projects", label: "歷屆專題" }]}
        description="歷屆專題成果、優秀專題、海報與三分鐘影片連結。可依屆別篩選。"
        meta={
          <p className="tabular text-sm text-muted-foreground">
            共 {PROJECTS.length} 件作品，涵蓋 {cohorts.length} 個屆別
          </p>
        }
      />
      <div className="mx-auto max-w-6xl px-5 py-10 md:py-14">
        <ProjectsGrid cohorts={cohorts} />
      </div>
    </>
  );
}

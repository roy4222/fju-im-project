import { PageHeader } from "@/components/public/page-header";
import { HONORS } from "@/lib/fixtures";
import { HonorsCards } from "./honors-cards";

export const metadata = { title: "榮譽與競賽" };

export default function HonorsPage() {
  const years = [...new Set(HONORS.map((h) => h.year))].sort().reverse();

  return (
    <>
      <PageHeader
        title="榮譽與競賽"
        breadcrumb={[{ href: "/honors", label: "榮譽與競賽" }]}
        description="系上專題組別的競賽得獎紀錄與活動相簿。點開卡片可看完整照片與說明。"
        meta={
          <p className="tabular text-sm text-muted-foreground">
            共 {HONORS.length} 筆紀錄，涵蓋 {years.join("、")} 年
          </p>
        }
      />
      <div className="mx-auto max-w-6xl px-5 py-10 md:py-14">
        <HonorsCards />
      </div>
    </>
  );
}

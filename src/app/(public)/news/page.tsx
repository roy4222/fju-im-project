import { PageHeader } from "@/components/public/page-header";
import { NewsList } from "./news-list";

export const metadata = { title: "最新公告" };

export default function NewsPage() {
  return (
    <>
      <PageHeader
        title="最新公告"
        breadcrumb={[{ href: "/news", label: "公告" }]}
        description="專題事務、競賽資訊、活動與規則異動。公告內容同時會出現在相關的待辦與截止提醒中。"
      />
      <div className="mx-auto max-w-6xl px-5 py-10 md:py-14">
        <NewsList />
      </div>
    </>
  );
}

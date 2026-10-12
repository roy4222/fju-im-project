import { SiteHeader } from "@/components/site-header"

/** 每一頁的外框：頁首標題＋內容區。側欄在 layout.tsx。 */
export function PageShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <SiteHeader title={title} />
      <div className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">{children}</div>
    </>
  )
}

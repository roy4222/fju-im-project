import { SiteHeader } from "@/components/public/site-header";
import { SiteFooter } from "@/components/public/site-footer";
import { PrototypeBar } from "@/components/public/prototype-bar";
import { TopLoader } from "@/components/public/ux/top-loader";
import { PageTransition } from "@/components/public/ux/page-transition";
import { Suspense } from "react";
import { getViewer, workbenchHref, workbenchLabel } from "@/lib/data/viewer";

/** 前台共用外框：導覽列依身分不同（訪客／登入後）。後台不走這個 layout。 */
export default async function PublicLayout({ children }: LayoutProps<"/">) {
  const viewer = await getViewer();
  return (
    <>
      <SiteHeader role={viewer.role} userName={viewer.user?.name ?? null} workbench={{ label: workbenchLabel(viewer.role), href: workbenchHref(viewer.role) }} />
      <Suspense fallback={null}>
        <TopLoader />
      </Suspense>
      <main className="flex-1 overflow-x-clip">
        <PageTransition>{children}</PageTransition>
      </main>
      <SiteFooter role={viewer.role} />
      <PrototypeBar role={viewer.role} />
    </>
  );
}

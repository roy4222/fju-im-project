import { Suspense } from "react";
import { notFound } from "next/navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { TopLoader } from "@/components/public/ux/top-loader";
import { PageTransition } from "@/components/public/ux/page-transition";
import { isValidRole } from "@/lib/nav-config";
import { DashThemeRoot } from "@/components/layout/dash-theme";

/**
 * 後台外框（2026-09-09 第三輪，Roy 給的 Ace Academy 參考）：
 * 淡藍底、白色圓角側欄、內容區是另一塊圓角面板（shadcn inset 變體）；卡片白、圓角大、無邊框陰影很淡。
 */
export default async function DashboardLayout({ children, params }: LayoutProps<"/dashboard/[role]">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();

  return (
    <DashThemeRoot>
    <SidebarProvider className="dash-frame" style={{ "--sidebar-width": "16.5rem", "--sidebar-width-icon": "3.75rem" } as React.CSSProperties}>
      <AppSidebar role={role} />
      <SidebarInset className="dash-surface">
        <Suspense fallback={null}>
          <TopLoader top={0} />
        </Suspense>
        <DashboardHeader role={role} />
        <div className="dash-content mx-auto w-full max-w-[1320px] flex-1 p-4 md:p-6 lg:px-8 lg:py-7">
          <PageTransition>{children}</PageTransition>
        </div>
      </SidebarInset>
    </SidebarProvider>
    </DashThemeRoot>
  );
}

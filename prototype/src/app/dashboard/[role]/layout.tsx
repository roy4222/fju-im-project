import { Suspense } from "react";
import { notFound } from "next/navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { VariantSwitcher } from "@/components/layout/variant-switcher";
import { TopLoader } from "@/components/public/ux/top-loader";
import { PageTransition } from "@/components/public/ux/page-transition";
import { isValidRole } from "@/lib/nav-config";
import { DashThemeRoot } from "@/components/layout/dash-theme";
import { getDashVariant } from "@/lib/data/dash-variant-server";

/** 後台外框（V4 系網深藍）：深藍側欄＋白頂列＋暖白內容區。換頁進度條貼在最上緣，不再切在頂列下方。 */
export default async function DashboardLayout({ children, params }: LayoutProps<"/dashboard/[role]">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  const variant = await getDashVariant();

  return (
    <DashThemeRoot variant={variant}>
    <SidebarProvider style={{ "--sidebar-width": "16rem", "--sidebar-width-icon": "3.75rem" } as React.CSSProperties}>
      <AppSidebar role={role} />
      <SidebarInset className="dash-surface">
        <Suspense fallback={null}>
          <TopLoader top={0} />
        </Suspense>
        <DashboardHeader role={role} />
        <div className="dash-content mx-auto w-full max-w-[1280px] flex-1 p-4 md:p-6 lg:p-8">
          <PageTransition>{children}</PageTransition>
        </div>
      </SidebarInset>
    </SidebarProvider>
    <VariantSwitcher variant={variant} />
    </DashThemeRoot>
  );
}

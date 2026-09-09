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
import type { DashVariant } from "@/lib/data/dash-variant";

/** 各版本的側欄寬度：V3 控制台較窄、V2 時間軸略窄，其餘 256px。 */
const SIDEBAR_WIDTH: Record<DashVariant, string> = { grid: "16rem", timeline: "15rem", console: "13.5rem", navy: "16rem" };

/** 後台外框：側欄＋頂列；`data-dash` 版本屬性由 DashThemeRoot 掛上，CSS 依版本換皮。 */
export default async function DashboardLayout({ children, params }: LayoutProps<"/dashboard/[role]">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  const variant = await getDashVariant();

  return (
    <DashThemeRoot variant={variant}>
    <SidebarProvider style={{ "--sidebar-width": SIDEBAR_WIDTH[variant] } as React.CSSProperties}>
      <AppSidebar role={role} />
      <SidebarInset className="dash-surface">
        <Suspense fallback={null}>
          <TopLoader top={56} />
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

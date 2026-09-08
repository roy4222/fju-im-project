import { Suspense } from "react";
import { notFound } from "next/navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { TopLoader } from "@/components/public/ux/top-loader";
import { PageTransition } from "@/components/public/ux/page-transition";
import { isValidRole } from "@/lib/nav-config";

/** 後台外框：側欄＋頂列，內容區淡灰底讓白卡浮出來（參考 demos.shadcndashboard.dev）。 */
export default async function DashboardLayout({ children, params }: LayoutProps<"/dashboard/[role]">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();

  return (
    <SidebarProvider>
      <AppSidebar role={role} />
      <SidebarInset className="bg-muted/40">
        <Suspense fallback={null}>
          <TopLoader top={56} />
        </Suspense>
        <DashboardHeader role={role} />
        <div className="flex-1 p-4 md:p-6">
          <PageTransition>{children}</PageTransition>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

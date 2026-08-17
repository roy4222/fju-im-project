import { notFound } from "next/navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { isValidRole } from "@/lib/nav-config";

export default async function DashboardLayout({
  children,
  params,
}: LayoutProps<"/dashboard/[role]">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();

  return (
    <SidebarProvider>
      <AppSidebar role={role} />
      <SidebarInset>
        <DashboardHeader role={role} />
        <div className="flex-1 p-4 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

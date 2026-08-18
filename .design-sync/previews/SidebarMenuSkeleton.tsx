import { SidebarMenu, SidebarMenuItem, SidebarMenuSkeleton } from "fju-project";

/** 側欄導覽的載入狀態 */
export const Loading = () => (
  <div className="w-64 rounded-lg border border-sidebar-border bg-sidebar p-2">
    <SidebarMenu>
      {[0, 1, 2, 3, 4].map((i) => (
        <SidebarMenuItem key={i}>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  </div>
);

import { SidebarInput } from "fju-project";

/** 側欄搜尋框。單獨渲染是一個空輸入框，因此給它實際寬度與內容。 */
export const InSidebar = () => (
  <div className="w-64 rounded-lg border border-sidebar-border bg-sidebar p-3">
    <p className="mb-2 text-xs font-medium text-muted-foreground">搜尋</p>
    <SidebarInput placeholder="搜尋組別、學生、項目…" defaultValue="補貨預測" />
  </div>
);

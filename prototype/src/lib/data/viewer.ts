import { cookies } from "next/headers";
import { CURRENT_USERS, type Person } from "@/lib/fixtures";
import { ROLE_COOKIE, isViewerRole, type ViewerRole } from "./roles";

export { ROLE_COOKIE, ROLE_LABEL, isViewerRole, type ViewerRole } from "./roles";

/**
 * 目前瀏覽者。
 *
 * 原型階段沒有 Auth：身分來自 cookie `fju-role`，由右下角「原型操作列」切換。
 * 接 Better Auth 之後只換這個檔案的實作，頁面呼叫端不動。
 *
 * 規格 §2.1：前端隱藏按鈕不是權限控制。這裡的 role 只決定畫面，
 * 正式版每個 route 與 server action 仍須依資料庫事實重新驗證。
 */
export type Viewer = {
  role: ViewerRole;
  user: Person | null;
  isMember: boolean;
};

export async function getViewer(): Promise<Viewer> {
  const jar = await cookies();
  const raw = jar.get(ROLE_COOKIE)?.value;
  const role: ViewerRole = isViewerRole(raw) ? raw : "guest";
  const user = role === "guest" ? null : CURRENT_USERS[role];
  return { role, user, isMember: role !== "guest" };
}

/** 登入後右上角的後台入口文案，依角色 */
export function workbenchLabel(role: ViewerRole): string {
  if (role === "teacher") return "老師工作台";
  if (role === "admin") return "管理後台";
  return "我的專題事務";
}

export function workbenchHref(role: ViewerRole): string {
  if (role === "guest") return "/login";
  return `/dashboard/${role}`;
}

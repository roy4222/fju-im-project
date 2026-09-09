import type { Role } from "@/lib/fixtures";

/** 身分常數：不含 next/headers，client component 也能 import。 */
export type ViewerRole = "guest" | Role;

export const ROLE_LABEL: Record<ViewerRole, string> = {
  guest: "訪客",
  student: "學生",
  teacher: "老師",
  admin: "管理員",
};

export const ROLE_COOKIE = "fju-role";

export function isViewerRole(v: string | undefined): v is ViewerRole {
  return v === "guest" || v === "student" || v === "teacher" || v === "admin";
}

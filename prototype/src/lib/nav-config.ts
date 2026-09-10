import type { Role } from "@/lib/fixtures";

/**
 * 登入後導覽。對應規格 §3.3 的六個核心區域。
 * `roles` 只決定「看不看得到入口」（規格 §2.1：前端隱藏按鈕不是權限控制）。
 */
export type NavIcon = "dashboard" | "timeline" | "inbox" | "affairs" | "editor" | "groups" | "industry" | "grading" | "signoff" | "accounts" | "audit" | "files";

export type NavItem = { href: string; label: string; icon: NavIcon; roles: Role[]; badge?: Partial<Record<Role, number>> };
export type NavGroup = { title: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    title: "總覽",
    items: [
      { href: "", label: "首頁", icon: "dashboard", roles: ["student", "teacher", "admin"] },
      { href: "/timeline", label: "專題時間軸", icon: "timeline", roles: ["student"] },
      { href: "/timeline", label: "時間軸設定", icon: "timeline", roles: ["admin"] },
      { href: "/inbox", label: "通知", icon: "inbox", roles: ["student", "teacher", "admin"], badge: { student: 2, teacher: 2, admin: 3 } },
    ],
  },
  {
    title: "專題事務",
    items: [
      { href: "/affairs", label: "作業區", icon: "affairs", roles: ["student"], badge: { student: 2 } },
      { href: "/affairs", label: "專題事務", icon: "affairs", roles: ["admin"] },
      { href: "/editor", label: "內容編輯器", icon: "editor", roles: ["admin"] },
      { href: "/files", label: "檔案管理", icon: "files", roles: ["admin"] },
    ],
  },
  {
    title: "分組與產學",
    items: [
      { href: "/groups", label: "我的組別", icon: "groups", roles: ["student"] },
      { href: "/groups", label: "分組總覽", icon: "groups", roles: ["teacher", "admin"] },
      { href: "/industry", label: "產學合作", icon: "industry", roles: ["student", "teacher", "admin"] },
    ],
  },
  {
    title: "評分與簽核",
    items: [
      { href: "/grading", label: "評分", icon: "grading", roles: ["teacher"], badge: { teacher: 2 } },
      { href: "/grading", label: "成績管理", icon: "grading", roles: ["admin"] },
      { href: "/signoff", label: "同意書", icon: "signoff", roles: ["student"], badge: { student: 1 } },
      { href: "/signoff", label: "簽核", icon: "signoff", roles: ["teacher", "admin"], badge: { teacher: 1 } },
    ],
  },
  {
    title: "系統管理",
    items: [
      { href: "/accounts", label: "帳號管理", icon: "accounts", roles: ["admin"], badge: { admin: 4 } },
      { href: "/audit", label: "操作紀錄", icon: "audit", roles: ["admin"] },
    ],
  },
];

export const ROLE_LABEL: Record<Role, string> = { student: "學生", teacher: "指導老師", admin: "系辦管理員" };

export function navForRole(role: Role): NavGroup[] {
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.roles.includes(role)) })).filter((g) => g.items.length > 0);
}

export function isValidRole(value: string): value is Role {
  return value === "student" || value === "teacher" || value === "admin";
}

/** 依路徑找頁面標題（header 麵包屑用） */
export function titleFor(role: Role, pathname: string): string {
  const base = `/dashboard/${role}`;
  const items = navForRole(role).flatMap((g) => g.items);
  const match = items.filter((i) => (i.href === "" ? pathname === base : pathname.startsWith(base + i.href))).sort((a, b) => b.href.length - a.href.length)[0];
  return match?.label ?? "專題管理平台";
}

import { NOTIFICATIONS, pendingAccounts, teacherGradingCounts, teacherSignReady, type Role } from "@/lib/fixtures";
import { studentOpenCount } from "@/lib/student-v1";

/**
 * 登入後導覽。對應規格 §3.3 的六個核心區域。
 * `roles` 只決定「看不看得到入口」（規格 §2.1：前端隱藏按鈕不是權限控制）。
 */
export type NavIcon = "dashboard" | "timeline" | "inbox" | "affairs" | "editor" | "groups" | "industry" | "grading" | "signoff" | "accounts" | "audit" | "files";

export type NavItem = { href: string; label: string; icon: NavIcon; roles: Role[]; badge?: Partial<Record<Role, number>> };

/**
 * 側欄徽章統一從 fixtures 的計數函式算（Codex 09-10：首頁待辦 3、側欄 2、頁面又不一樣）。
 * 只算「現在輪到我做」的：學生＝沒送出的作業；老師＝還沒正式送出的組、輪到我簽的組；管理員＝待審核帳號。
 */
function badgeFor(role: Role, href: string): number | undefined {
  if (href === "/inbox") return NOTIFICATIONS[role].filter((n) => !n.read).length || undefined;
  /* 學生 v1：同意書併進交作業，徽章＝交作業「待交」數（作業＋同意書，同一個函式） */
  if (role === "student" && href === "/affairs") return studentOpenCount() || undefined;
  if (role === "teacher" && href === "/grading") return teacherGradingCounts().remaining || undefined;
  if (role === "teacher" && href === "/signoff") return teacherSignReady().length || undefined;
  if (role === "admin" && href === "/accounts") return pendingAccounts().length || undefined;
  return undefined;
}
export type NavGroup = { title: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    title: "總覽",
    items: [
      { href: "", label: "首頁", icon: "dashboard", roles: ["teacher", "admin"] },
      { href: "/timeline", label: "時間軸設定", icon: "timeline", roles: ["admin"] },
      { href: "/inbox", label: "通知", icon: "inbox", roles: ["teacher", "admin"] },
    ],
  },
  {
    title: "專題事務",
    items: [
      { href: "/affairs", label: "專題事務", icon: "affairs", roles: ["admin"] },
      { href: "/editor", label: "內容編輯器", icon: "editor", roles: ["admin"] },
      { href: "/files", label: "檔案管理", icon: "files", roles: ["admin"] },
    ],
  },
  {
    title: "分組與產學",
    items: [
      { href: "/groups", label: "分組總覽", icon: "groups", roles: ["teacher", "admin"] },
      { href: "/industry", label: "產學合作", icon: "industry", roles: ["teacher", "admin"] },
    ],
  },
  {
    title: "評分與簽核",
    items: [
      { href: "/grading", label: "評分", icon: "grading", roles: ["teacher"] },
      { href: "/grading", label: "成績管理", icon: "grading", roles: ["admin"] },
      { href: "/signoff", label: "簽核", icon: "signoff", roles: ["teacher", "admin"] },
    ],
  },
  {
    title: "系統管理",
    items: [
      { href: "/accounts", label: "帳號管理", icon: "accounts", roles: ["admin"] },
      { href: "/audit", label: "操作紀錄", icon: "audit", roles: ["admin"] },
    ],
  },
];

/**
 * 學生後台 v1（Roy 2026-10-15，Q71～Q73）：側欄只有三項、不分組標題。
 * 通知只留右上角鈴鐺；時程搬到前台 /timeline；同意書是交作業裡的一張卡；產學合作、成績說明不在學生側欄。
 */
const STUDENT_NAV: NavGroup[] = [
  {
    title: "",
    items: [
      { href: "", label: "首頁", icon: "dashboard", roles: ["student"] },
      { href: "/affairs", label: "交作業", icon: "affairs", roles: ["student"] },
      { href: "/groups", label: "組別", icon: "groups", roles: ["student"] },
    ],
  },
];

export const ROLE_LABEL: Record<Role, string> = { student: "學生", teacher: "指導老師", admin: "系辦管理員" };

export function navForRole(role: Role): NavGroup[] {
  return (role === "student" ? STUDENT_NAV : NAV_GROUPS).map((g) => ({
    ...g,
    items: g.items.filter((i) => i.roles.includes(role)).map((i) => { const n = badgeFor(role, i.href); return n ? { ...i, badge: { [role]: n } } : i; }),
  })).filter((g) => g.items.length > 0);
}

export function isValidRole(value: string): value is Role {
  return value === "student" || value === "teacher" || value === "admin";
}

/** 依路徑找頁面標題（header 麵包屑用） */
export function titleFor(role: Role, pathname: string): string {
  const base = `/dashboard/${role}`;
  const items = navForRole(role).flatMap((g) => g.items);
  const match = items.filter((i) => (i.href === "" ? pathname === base : pathname.startsWith(base + i.href))).sort((a, b) => b.href.length - a.href.length)[0];
  if (!match && pathname.startsWith(`${base}/inbox`)) return "通知";
  return match?.label ?? "專題管理平台";
}

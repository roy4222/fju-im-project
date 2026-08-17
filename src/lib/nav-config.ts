import type { Role } from "@/lib/fixtures";

/**
 * 登入後導覽。對應 MOC §3.3 的六個核心區域。
 *
 * `roles` 就是這一項對哪些角色出現。注意：**前端隱藏按鈕不是權限控制**
 * （MOC §2.1）——這份設定只決定「看不看得到入口」，正式版每個 route 與
 * server action 仍必須依資料庫事實重新驗證。
 */
export type NavItem = {
  href: string;
  label: string;
  icon: NavIcon;
  roles: Role[];
  /** 待處理數量；顯示在右側，0 或 undefined 不顯示 */
  badge?: number;
};

export type NavIcon =
  | "dashboard"
  | "affairs"
  | "editor"
  | "groups"
  | "industry"
  | "grading"
  | "signoff"
  | "accounts"
  | "audit"
  | "files";

export type NavGroup = {
  title: string;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    title: "總覽",
    items: [
      {
        href: "",
        label: "首頁",
        icon: "dashboard",
        roles: ["student", "teacher", "admin"],
      },
    ],
  },
  {
    title: "專題事務",
    items: [
      {
        href: "/affairs",
        label: "我的專題事務",
        icon: "affairs",
        roles: ["student"],
        badge: 3,
      },
      {
        href: "/affairs",
        label: "各組繳交狀態",
        icon: "affairs",
        roles: ["teacher"],
      },
      {
        href: "/affairs",
        label: "專題事務工作台",
        icon: "affairs",
        roles: ["admin"],
      },
      {
        href: "/editor",
        label: "內容與表單編輯器",
        icon: "editor",
        roles: ["admin"],
      },
      {
        href: "/files",
        label: "檔案與資源",
        icon: "files",
        roles: ["admin"],
      },
    ],
  },
  {
    title: "分組與產學",
    items: [
      {
        href: "/groups",
        label: "我的組別",
        icon: "groups",
        roles: ["student"],
      },
      {
        href: "/groups",
        label: "分組總覽",
        icon: "groups",
        roles: ["teacher", "admin"],
      },
      {
        href: "/industry",
        label: "產學合作",
        icon: "industry",
        roles: ["student", "teacher", "admin"],
        badge: undefined,
      },
    ],
  },
  {
    title: "評分與簽核",
    items: [
      {
        href: "/grading",
        label: "我的評分工作",
        icon: "grading",
        roles: ["teacher"],
        badge: 2,
      },
      {
        href: "/grading",
        label: "成績管理",
        icon: "grading",
        roles: ["admin"],
      },
      {
        href: "/signoff",
        label: "待我同意",
        icon: "signoff",
        roles: ["student"],
        badge: 1,
      },
      {
        href: "/signoff",
        label: "簽核進度",
        icon: "signoff",
        roles: ["teacher", "admin"],
      },
    ],
  },
  {
    title: "系統管理",
    items: [
      {
        href: "/accounts",
        label: "帳號管理",
        icon: "accounts",
        roles: ["admin"],
        badge: 4,
      },
      {
        href: "/audit",
        label: "操作紀錄",
        icon: "audit",
        roles: ["admin"],
      },
    ],
  },
];

export const ROLE_LABEL: Record<Role, string> = {
  student: "學生",
  teacher: "指導老師",
  admin: "系辦管理員",
};

export function navForRole(role: Role): NavGroup[] {
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => i.roles.includes(role)),
  })).filter((g) => g.items.length > 0);
}

export function isValidRole(value: string): value is Role {
  return value === "student" || value === "teacher" || value === "admin";
}

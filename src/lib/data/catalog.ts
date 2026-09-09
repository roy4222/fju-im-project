import {
  COMPETITIONS,
  FILES,
  HONORS,
  INDUSTRY,
  INDUSTRY_DETAIL,
  MANAGED_ITEMS,
  NEWS,
  NEWS_BODY,
  PROJECTS,
  PROJECT_DETAIL,
  RULES_DOC,
  daysUntil,
  type Competition,
  type FileItem,
  type HonorItem,
  type IndustryItem,
  type NewsItem,
  type ProjectItem,
} from "@/lib/fixtures";
import type { Viewer } from "./viewer";

/**
 * 前台資料存取層。
 *
 * 頁面只呼叫這裡的函式，不直接讀 fixtures。接 PostgreSQL 時只換這裡的實作，
 * 函式簽名貼近規格 §12 的 entity 與 §4.3 的 audience 規則。
 * 每個函式都收 viewer：可見性在這一層決定，不在畫面上靠隱藏按鈕。
 */

/* ------------------------------------------------------------------ 公告 */

function newsVisible(n: NewsItem, viewer: Viewer): boolean {
  const a = n.audience ?? "public";
  if (a === "public") return true;
  if (!viewer.isMember) return false;
  if (a === "members") return true;
  if (a === "students") return viewer.role === "student" || viewer.role === "admin";
  if (a === "teachers") return viewer.role === "teacher" || viewer.role === "admin";
  return false;
}

export async function listNews(viewer: Viewer, opts: { category?: string; q?: string } = {}) {
  let items = NEWS.filter((n) => newsVisible(n, viewer));
  if (opts.category && opts.category !== "全部") items = items.filter((n) => n.category === opts.category);
  if (opts.q) {
    const q = opts.q.trim();
    items = items.filter((n) => n.title.includes(q) || n.summary.includes(q));
  }
  return items.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.date.localeCompare(a.date));
}

export async function getNews(viewer: Viewer, id: string) {
  const item = NEWS.find((n) => n.id === id);
  if (!item) return null;
  const visible = newsVisible(item, viewer);
  const all = await listNews(viewer);
  const idx = all.findIndex((n) => n.id === id);
  return {
    item,
    visible,
    body: NEWS_BODY[id] ?? [item.summary],
    related: all.filter((n) => n.category === item.category && n.id !== id).slice(0, 4),
    prev: idx > 0 ? all[idx - 1] : null,
    next: idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null,
  };
}

export const NEWS_CATEGORIES = ["全部", "專題事務", "競賽資訊", "活動", "規則異動"] as const;

/* ------------------------------------------------------------------ 競賽 */

export type CompetitionStatus = "open" | "result" | "closed";
export type CompetitionSort = "deadline" | "deadline-asc" | "title";

/**
 * 競賽狀態由日期推導（Roy 2026-09-08）：後台只填截止日與活動日，
 * 截止日未過＝報名中；活動日未過＝決賽／結果；都過了自動變已結束，不用手動切換。
 */
export function competitionStatus(c: Competition): CompetitionStatus {
  if (daysUntil(c.deadline) >= 0) return "open";
  if (c.eventDate && daysUntil(c.eventDate) >= 0) return "result";
  return "closed";
}

export async function listCompetitions(opts: { status?: string; q?: string; sort?: string } = {}): Promise<(Competition & { status: CompetitionStatus })[]> {
  const order = { open: 0, result: 1, closed: 2 };
  const q = opts.q?.trim().toLowerCase();
  let items = COMPETITIONS.map((c) => ({ ...c, status: competitionStatus(c) }));
  if (opts.status && opts.status !== "all") items = items.filter((c) => c.status === opts.status);
  if (q) items = items.filter((c) => [c.title, c.organizer, c.summary].some((t) => t.toLowerCase().includes(q)));
  const sort = (opts.sort ?? "deadline") as CompetitionSort;
  if (sort === "title") return items.sort((a, b) => a.title.localeCompare(b.title, "zh-Hant"));
  if (sort === "deadline-asc") return items.sort((a, b) => a.deadline.localeCompare(b.deadline));
  return items.sort((a, b) => order[a.status] - order[b.status] || b.deadline.localeCompare(a.deadline));
}

/* ------------------------------------------------------------------ 規則 */

export async function getRules() {
  return RULES_DOC;
}

/* ------------------------------------------------------------------ 專題 */

export type ProjectSort = "cohort" | "award" | "title";

export async function listFeaturedProjects(opts: { q?: string; sort?: string } = {}): Promise<ProjectItem[]> {
  const q = opts.q?.trim().toLowerCase();
  let items = PROJECTS.filter((p) => p.award);
  if (q) items = items.filter((p) => [p.title, p.advisor, p.groupNo, p.field, p.awardLabel ?? ""].some((t) => t.toLowerCase().includes(q)));
  const rank = (p: ProjectItem) => (p.award === "excellent" ? 0 : 1);
  if (opts.sort === "excellent") return items.sort((a, b) => rank(a) - rank(b) || b.cohort.localeCompare(a.cohort));
  if (opts.sort === "merit") return items.sort((a, b) => rank(b) - rank(a) || b.cohort.localeCompare(a.cohort));
  return items.sort((a, b) => b.cohort.localeCompare(a.cohort) || rank(a) - rank(b));
}

/** 歷屆專題一覽：登入後（7/22 §6.2）。訪客回空陣列，由頁面顯示需要登入。 */
export async function listProjects(viewer: Viewer, opts: { cohort?: string; q?: string; awardOnly?: boolean; sort?: ProjectSort } = {}) {
  if (!viewer.isMember) return [];
  let items = [...PROJECTS];
  if (opts.cohort && opts.cohort !== "all") items = items.filter((p) => p.cohort === opts.cohort);
  if (opts.awardOnly) items = items.filter((p) => p.award);
  if (opts.q) {
    const q = opts.q.trim();
    items = items.filter((p) => [p.title, p.groupNo, p.advisor, p.field, p.summary].some((t) => t.includes(q)));
  }
  const awardRank = (p: ProjectItem) => (p.award === "excellent" ? 0 : p.award === "merit" ? 1 : 2);
  const sort = opts.sort ?? "cohort";
  items.sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title, "zh-Hant");
    if (sort === "award") return awardRank(a) - awardRank(b) || b.cohort.localeCompare(a.cohort);
    return b.cohort.localeCompare(a.cohort) || awardRank(a) - awardRank(b);
  });
  return items;
}

export function projectCohorts(): string[] {
  return [...new Set(PROJECTS.map((p) => p.cohort))].sort((a, b) => b.localeCompare(a));
}

/**
 * 專題詳情。得獎作品（優秀專題）公開；其餘只給登入者。
 * Roy 2026-09-07：優秀專題不能「進得去卻點不開」。
 */
export async function getProject(viewer: Viewer, id: string) {
  const item = PROJECTS.find((p) => p.id === id);
  if (!item) return null;
  const detail = PROJECT_DETAIL[id];
  const visible = !!item.award || viewer.isMember;
  const all = viewer.isMember ? PROJECTS : PROJECTS.filter((p) => p.award);
  const idx = all.findIndex((p) => p.id === id);
  return {
    item,
    visible,
    detail: detail ?? { abstract: item.summary, advisor: item.advisor, members: [], tech: [], hasPoster: item.hasPoster },
    prev: idx > 0 ? all[idx - 1] : null,
    next: idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null,
  };
}

/* ------------------------------------------------------------------ 榮譽 */

export async function listHonors(opts: { year?: string; q?: string; sort?: string } = {}): Promise<HonorItem[]> {
  const q = opts.q?.trim().toLowerCase();
  let items = [...HONORS];
  if (opts.year && opts.year !== "all") items = items.filter((h) => h.date.startsWith(opts.year!));
  if (q) items = items.filter((h) => [h.competition, h.award, h.team, h.summary].some((t) => t.toLowerCase().includes(q)));
  if (opts.sort === "date-asc") return items.sort((a, b) => a.date.localeCompare(b.date));
  return items.sort((a, b) => b.date.localeCompare(a.date));
}

export function honorYears(): string[] {
  return [...new Set(HONORS.map((h) => h.year))].sort((a, b) => b.localeCompare(a));
}

/* ------------------------------------------------------------------ 產學 */

/** 產學合作：登入後（7/22 §6.2、需求表）。 */
export async function listIndustry(viewer: Viewer): Promise<IndustryItem[]> {
  if (!viewer.isMember) return [];
  return INDUSTRY.filter((i) => i.publishStatus === "public").sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export async function getIndustry(viewer: Viewer, id: string) {
  if (!viewer.isMember) return { item: null, visible: false, detail: null, canSeeContact: false };
  const item = INDUSTRY.find((i) => i.id === id) ?? null;
  const detail = item ? INDUSTRY_DETAIL[id] : null;
  // 規格 §6.2：聯絡資料只有負責老師與管理員可見。原型無法核對「負責老師本人」，先以角色判斷。
  const canSeeContact = viewer.role === "admin" || viewer.role === "teacher";
  return { item, visible: !!item, detail, canSeeContact };
}

/* ------------------------------------------------------------------ 檔案 */

export async function listFiles(viewer: Viewer, opts: { category?: string; q?: string } = {}): Promise<FileItem[]> {
  if (!viewer.isMember) return [];
  let items = [...FILES];
  if (opts.category && opts.category !== "全部") {
    items = items.filter((f) => f.category === opts.category || `${f.cohort} 學年度` === opts.category);
  }
  if (opts.q) items = items.filter((f) => f.name.includes(opts.q!.trim()));
  return items.sort((a, b) => b.date.localeCompare(a.date));
}

export function fileCategories(): string[] {
  const cats = [...new Set(FILES.map((f) => f.category))];
  const cohorts = [...new Set(FILES.map((f) => `${f.cohort} 學年度`))].sort((a, b) => b.localeCompare(a));
  return ["全部", ...cats, ...cohorts];
}

/* ------------------------------------------------------------------ 首頁「我的工作」與近期截止 */

export type WorkEntry = { key: string; title: string; hint: string; href: string };

export async function listWork(viewer: Viewer): Promise<WorkEntry[]> {
  const base = `/dashboard/${viewer.role}`;
  if (viewer.role === "student")
    return [
      { key: "requirement", title: "專題需求", hint: "10 月填報題目與名稱", href: `${base}/affairs` },
      { key: "submission", title: "文件繳交", hint: "整組一份，任一人送出", href: `${base}/affairs` },
      { key: "signoff", title: "同意書簽核", hint: "逐一線上同意", href: `${base}/signoff` },
      { key: "group", title: "我的組別", hint: "第 07 組・3/5 已確認", href: `${base}/groups` },
      { key: "files", title: "檔案下載", hint: "範本、格式、附件", href: "/files" },
    ];
  if (viewer.role === "teacher")
    return [
      { key: "submission", title: "各組繳交狀態", hint: "3 組・5 個收件項目", href: `${base}/affairs` },
      { key: "grading", title: "我的評分工作", hint: "系統驗收 2 組待評", href: `${base}/grading` },
      { key: "signoff", title: "待我同意", hint: "第 08 組同意書", href: `${base}/signoff` },
      { key: "claim", title: "可認領產學組", hint: "2 組尚未指派", href: `${base}/groups` },
      { key: "industry", title: "我的合作案", hint: "1 件公開中", href: `${base}/industry` },
    ];
  if (viewer.role === "admin")
    return [
      { key: "accounts", title: "待審核帳號", hint: "4 筆需人工核准", href: `${base}/accounts` },
      { key: "overdue", title: "逾期未繳組別", hint: "3 組・需重新開放", href: `${base}/affairs` },
      { key: "grading", title: "缺評老師", hint: "系統驗收 2 位", href: `${base}/grading` },
      { key: "signoff", title: "簽核進度", hint: "9 組・完成 4 組", href: `${base}/signoff` },
      { key: "workbench", title: "專題事務工作台", hint: "5 個項目進行中", href: `${base}/affairs` },
    ];
  return [];
}

export type DueEntry = { id: string; title: string; dueAt: string; days: number; href: string };

export async function listUpcoming(viewer: Viewer): Promise<DueEntry[]> {
  if (!viewer.isMember) return [];
  // 截止日由後台項目的 dueAt 帶入；過期的自動不再出現在首頁（Roy 2026-09-08）
  return MANAGED_ITEMS.filter((i) => i.dueAt)
    .map((i) => ({ id: i.id, title: i.title, dueAt: i.dueAt!, days: daysUntil(i.dueAt!), href: `/dashboard/${viewer.role}/affairs` }))
    .filter((d) => d.days >= 0)
    .sort((a, b) => a.days - b.days)
    .slice(0, 3);
}

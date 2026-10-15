import { CURRENT_USERS, GROUPS, GROUP_SUBMISSIONS, INDUSTRY, MANAGED_ITEMS, MY_GROUP, SIGNOFF, SIGNOFF_PROGRESS, isSubmittedState, type Group, type SubmissionState } from "@/lib/fixtures";

/**
 * 老師後台 v2（Roy 2026-10-15，Q77～Q84）：側欄 首頁｜評分｜作業區｜分組總覽。
 *
 * 數字的唯一口徑：首頁待辦、側欄徽章、評分總覽、作業區都從這裡算，不各自推（學生 v1 同樣做法）。
 * 評分的進度存在 sessionStorage（grading-store.ts），這裡只放種子資料與算分規則。
 */
export const ME = CURRENT_USERS.teacher;
export const TEACHER_BASE = "/dashboard/teacher";

export function shortTitle(title: string) {
  return title.replace(/（產學：.*）/, "");
}

/** 我指導的組別（G07、G02、G05、G08） */
export function myGroups(): Group[] {
  return GROUPS.filter((g) => g.advisorId === ME.id).sort((a, b) => a.no.localeCompare(b.no));
}

/* ------------------------------------------------------------------ 評分 */

/** 評分項目的類型：滿分制（分數按鈕＋輸入）、等第制（等第按鈕）、通過制（通過／不通過） */
export type CriterionKind = "score" | "letter" | "pass";
export type Criterion = { id: string; name: string; weight: number; hint: string; kind: CriterionKind };

export const RUBRIC: Criterion[] = [
  { id: "c1", name: "問題定義", weight: 25, hint: "需求清楚、目標具體", kind: "score" },
  { id: "c2", name: "實作完成度", weight: 35, hint: "功能完整、操作流暢", kind: "score" },
  { id: "c3", name: "創新與價值", weight: 20, hint: "有創意、有實際用途", kind: "score" },
  { id: "c4", name: "成果表達", weight: 20, hint: "簡報清楚、回答有條理", kind: "letter" },
  { id: "c5", name: "資料安全檢核", weight: 0, hint: "個資有遮罩、帳密沒有寫死", kind: "pass" },
];

export const SCORE_STEPS = [60, 70, 80, 90, 100];
/** 等第換算分數（算總分用） */
export const LETTERS: { label: string; value: number }[] = [
  { label: "A+", value: 95 },
  { label: "A", value: 90 },
  { label: "B+", value: 85 },
  { label: "B", value: 80 },
  { label: "C", value: 70 },
];
export const PASS_LABEL = { pass: "通過", fail: "不通過" } as const;

export type Scores = Record<string, { value?: string; comment?: string }>;

/** 總分＝滿分制與等第制依權重加總（等第照上表換算）；通過制不計分但要填 */
export function scoreSummary(scores: Scores): { total: number; missing: number } {
  let total = 0;
  let missing = 0;
  for (const c of RUBRIC) {
    const v = scores[c.id]?.value;
    if (!v) { missing++; continue; }
    if (c.kind === "score") total += (Number(v) * c.weight) / 100;
    if (c.kind === "letter") total += ((LETTERS.find((l) => l.label === v)?.value ?? 0) * c.weight) / 100;
  }
  return { total: Math.round(total * 10) / 10, missing };
}

export type GradeState = "pending" | "draft" | "submitted";
export type GradeRecord = {
  state: GradeState;
  scores: Scores;
  lastEdited?: string;
  /** 送出後又存了草稿、還沒重新送出 */
  unsent?: boolean;
  /** 很簡短的紀錄：只留送出與重新送出 */
  log: { at: string; text: string }[];
};

export type Work = { report: { name: string; pages: number }; files: { name: string; size: string }[]; video: { title: string; length: string } };
export type GradingGroup = { groupId: string; no: string; title: string; blurb: string; work: Work; seed: GradeRecord };

function work(slug: string, title: string, length: string): Work {
  return {
    report: { name: "成果報告.pdf", pages: 18 },
    files: [
      { name: `${slug}-系統操作說明.pdf`, size: "1.4 MB" },
      { name: `${slug}-原始碼連結.txt`, size: "1 KB" },
    ],
    video: { title: `${title} 展示`, length },
  };
}

const s = (c1?: string, c2?: string, c3?: string, c4?: string, c5?: string): Scores =>
  Object.fromEntries(([["c1", c1], ["c2", c2], ["c3", c3], ["c4", c4], ["c5", c5]] as const).filter(([, v]) => v).map(([k, v]) => [k, { value: v }]));

/** 已送出的種子：紀錄只有一行「送出 N 分」 */
function sent(scores: Scores, at: string): GradeRecord {
  return { state: "submitted", scores, lastEdited: at, log: [{ at, text: `送出 ${scoreSummary(scores).total} 分` }] };
}

/** 系辦指派給我評的 5 組（系統驗收）；順序就是「第 N／5 組」 */
export const GRADING_GROUPS: GradingGroup[] = [
  {
    groupId: "g-02", no: "第 02 組", title: "零售門市補貨預測", blurb: "用銷售紀錄預測各門市補貨量，缺貨前先提醒。",
    work: work("G02", "零售門市補貨預測", "06:10"),
    seed: sent(s("90", "80", "90", "A", "pass"), "10/14 16:20"),
  },
  {
    groupId: "g-04", no: "第 04 組", title: "校內活動報名與簽到整合", blurb: "活動報名、QR 簽到、出席統計放在同一個地方。",
    work: work("G04", "校內活動報名與簽到", "04:48"),
    seed: sent(s("80", "90", "80", "B+", "pass"), "10/13 21:30"),
  },
  {
    groupId: "g-07", no: "第 07 組", title: "校園閒置空間共享媒合平台", blurb: "讓閒置的教室、討論室被看見，媒合更多使用。",
    work: work("G07", "校園空間媒合平台", "05:32"),
    seed: { state: "draft", scores: s("90", "80", "80"), lastEdited: "10/15 11:05", log: [] },
  },
  {
    groupId: "g-05", no: "第 05 組", title: "二手教科書交易平台", blurb: "學長姐的課本直接賣給學弟妹，面交地點在校內。",
    work: work("G05", "二手教科書交易", "03:57"),
    seed: { state: "pending", scores: {}, log: [] },
  },
  {
    groupId: "g-08", no: "第 08 組", title: "長照機構家屬溝通看板", blurb: "照護紀錄、探視預約、通知家屬，一個看板看完。",
    work: work("G08", "長照家屬溝通看板", "05:05"),
    seed: sent(s("80", "80", "90", "A", "pass"), "10/12 10:18"),
  },
];

export const GRADE_STATE_LABEL: Record<GradeState, string> = { pending: "待評", draft: "草稿", submitted: "已送出" };

/** 伺服器端（側欄徽章、首頁初值）用種子資料算；瀏覽器端用 grading-store 覆蓋 */
export function gradingCounts(records: Record<string, GradeRecord> = {}) {
  const states = GRADING_GROUPS.map((g) => (records[g.groupId] ?? g.seed).state);
  const submitted = states.filter((x) => x === "submitted").length;
  return { total: states.length, submitted, remaining: states.length - submitted };
}

/** 下一組要評的：第一組還沒送出的 */
export function nextToGrade(records: Record<string, GradeRecord> = {}) {
  return GRADING_GROUPS.find((g) => (records[g.groupId] ?? g.seed).state !== "submitted");
}

/* ------------------------------------------------------------------ 作業區 */

export type DotState = "done" | "missing" | "overdue";
export const DOT_LABEL: Record<DotState, string> = { done: "已交", missing: "缺交", overdue: "逾期" };

export function dotState(state: SubmissionState): DotState {
  if (isSubmittedState(state)) return "done";
  if (state === "overdue") return "overdue";
  return "missing";
}

/** 有收件的作業（依截止日） */
export function workItems() {
  return MANAGED_ITEMS.filter((i) => i.progress).sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
}

/** 某組每份作業的狀態 */
export function groupWork(groupId: string) {
  return workItems().map((item) => {
    const sub = GROUP_SUBMISSIONS[item.id]?.find((x) => x.groupId === groupId);
    const state = sub?.state ?? "todo";
    return { item, sub, state, dot: dotState(state) };
  });
}

/** 缺件的組：有逾期沒交的 */
export function groupsMissingWork(): Group[] {
  return myGroups().filter((g) => groupWork(g.id).some((w) => w.dot === "overdue"));
}

/* ------------------------------------------------------------------ 同意書 */

export function myConsents() {
  const mine = new Set(myGroups().map((g) => g.id));
  const order = { teacher: 0, students: 1, revision: 2, complete: 3 } as const;
  return SIGNOFF_PROGRESS.filter((p) => mine.has(p.groupId)).sort((a, b) => order[a.state] - order[b.state] || a.groupNo.localeCompare(b.groupNo));
}

/** 某組已同意的學生；第 07 組照學生端的 SIGNOFF（誰同意了要和學生畫面一樣） */
export function approvedStudents(groupId: string): { name: string; at?: string }[] {
  if (groupId === MY_GROUP.id) return SIGNOFF.studentApprovals.filter((a) => a.approved);
  const p = SIGNOFF_PROGRESS.find((x) => x.groupId === groupId);
  const g = GROUPS.find((x) => x.id === groupId);
  return (g?.members ?? []).slice(0, p?.students ?? 0).map((m, i) => ({ name: m.name, at: `2026-08-1${4 + (i % 3)} ${10 + i}:${String((i * 13) % 60).padStart(2, "0")}` }));
}

export function consentsWaitingForMe() {
  return myConsents().filter((p) => p.state === "teacher");
}

/* ------------------------------------------------------------------ 分組總覽 */

/** 還沒有指導老師的產學組（可以擔任指導老師） */
export function openIndustryGroups(): Group[] {
  return GROUPS.filter((g) => g.type === "INDUSTRY" && g.advisorId === null);
}

export type CaseStatus = "public" | "draft" | "unlisted";
export const CASE_STATUS_LABEL: Record<CaseStatus, string> = { public: "發布中", draft: "草稿", unlisted: "已下架" };
export type MyCase = { id: string; company: string; title: string; status: CaseStatus; groupIds: string[] };

/**
 * 我的合作案。前台 /industry 沒有依發布狀態過濾，所以草稿、下架的示範案只放在這裡，不塞進 INDUSTRY。
 */
export function myCases(): MyCase[] {
  const real = INDUSTRY.filter((i) => i.advisorName === ME.name).map((i): MyCase => ({
    id: i.id,
    company: i.company,
    title: i.title,
    status: i.publishStatus,
    groupIds: GROUPS.filter((g) => g.industryId === i.id).map((g) => g.id),
  }));
  return [
    ...real,
    { id: "ind-t2", company: "宏昇物流股份有限公司", title: "倉儲揀貨路徑最佳化", status: "draft", groupIds: [] },
    { id: "ind-t3", company: "禾豐連鎖餐飲", title: "門市排班與人力預估", status: "unlisted", groupIds: [] },
  ];
}

/** 可以連到合作案的組：產學組 */
export function industryGroups(): Group[] {
  return GROUPS.filter((g) => g.type === "INDUSTRY");
}

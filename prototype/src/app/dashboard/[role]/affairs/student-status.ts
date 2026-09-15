import { MY_GROUP, SUBMISSION_VERSIONS, TODAY_YMD, daysUntil, isSubmittedState, myGroupEstablished, type ManagedItem, type SubmissionState } from "@/lib/fixtures";

/**
 * 學生作業狀態的唯一口徑（Codex 09-10 S-02／S-03）：
 * 「是否已繳」「是否仍可修改」「逾期」三件事分開講；列表、詳情、回執都從這裡拿字，不各自推。
 * 逾期只給「未繳且過期」；locked 是「已繳・截止後唯讀」，不是逾期。
 */
export type ItemStatus = {
  state: SubmissionState;
  submitted: boolean;
  /** 已繳的最後版本號 */
  version?: number;
  lastBy?: string;
  lastAt?: string;
  /** 還能不能改（截止前可重送／截止後唯讀） */
  editable: boolean;
  /** 未繳且已過截止 */
  overdue: boolean;
  /** 第一行：已繳 v2／未繳／逾期未繳 */
  headline: string;
  headlineTone: "success" | "muted" | "brand" | "danger";
  /** 第二行：截止前可重送／截止後唯讀／草稿已存 */
  detail: string;
  /** 列表按鈕文字 */
  action: string;
};

export function itemStatus(item: ManagedItem, override?: SubmissionState): ItemStatus {
  const state = override ?? item.myState ?? "todo";
  const versions = SUBMISSION_VERSIONS[item.id] ?? [];
  const last = versions[0];
  const submitted = isSubmittedState(state);
  const pastDue = item.dueAt ? daysUntil(item.dueAt) < 0 : false;
  const editable = !(state === "locked" || state === "overdue") && !pastDue;
  const overdue = state === "overdue" || (!submitted && pastDue);
  const version = submitted ? (last?.version ?? 1) : undefined;

  if (submitted) {
    return {
      state, submitted, version, lastBy: last?.by, lastAt: last?.at, editable, overdue: false,
      headline: `已繳 v${version}`, headlineTone: "success",
      detail: editable ? "截止前可重送" : "截止後唯讀",
      action: editable ? "查看或重送" : "查看",
    };
  }
  if (overdue) {
    return { state, submitted, editable: false, overdue: true, headline: "逾期未繳", headlineTone: "danger", detail: item.dueAt ? `逾期 ${Math.abs(daysUntil(item.dueAt))} 天・需系辦重開` : "已截止", action: "查看" };
  }
  if (state === "resubmit") return { state, submitted, editable, overdue, headline: "需重送", headlineTone: "brand", detail: "老師退回，修改後重送", action: "重送" };
  if (state === "draft") return { state, submitted, editable, overdue, headline: "未繳", headlineTone: "brand", detail: "草稿已存，尚未正式送出", action: "繼續填寫" };
  return { state, submitted, editable, overdue, headline: "未繳", headlineTone: "muted", detail: item.dueAt ? "尚未開始" : "無截止", action: "去繳交" };
}

export const TONE_CLS: Record<ItemStatus["headlineTone"], string> = {
  success: "text-success-on-subtle",
  muted: "text-muted-foreground",
  brand: "text-brand-on-subtle",
  danger: "text-destructive",
};

/** 原型假資料：草稿的最後編輯者與時間（正式版來自共用草稿） */
const DRAFT_META: Record<string, { editor: string; savedAt: string }> = {
  "mi-014": { editor: "林彥廷", savedAt: "08-16 21:40" },
};

/** 填寫單位一列（S-02）：整組一份要列組別、目前編輯者、最後儲存；個人一份就只寫個人 */
export function fillUnit(item: ManagedItem, savedAt?: string): { group: boolean; text: string } {
  if (item.form === "personal") return { group: false, text: "個人一份・每位同學各自填寫" };
  const s = itemStatus(item);
  const meta = DRAFT_META[item.id];
  const parts = ["整組一份", MY_GROUP.no];
  if (s.submitted && s.lastBy && s.lastAt) parts.push(`最後送出 ${s.lastBy}`, s.lastAt.slice(5, 16));
  else if (savedAt) parts.push(`目前編輯者 ${meta?.editor ?? "林彥廷"}`, `最後儲存 ${savedAt}`);
  else if (meta) parts.push(`目前編輯者 ${meta.editor}`, `最後儲存 ${meta.savedAt}`);
  else parts.push("尚未有人開始填");
  return { group: true, text: parts.join("・") };
}

/** 組別未成立時的阻擋文案；成立則回 null */
export function groupBlock(): { missing: number; text: string } | null {
  if (myGroupEstablished()) return null;
  const missing = MY_GROUP.members.filter((m) => !m.confirmed).length + Math.max(0, 5 - MY_GROUP.members.length);
  return { missing, text: `組別成立後才能送出（還差 ${missing} 位確認）` };
}

/** 示範時鐘：回執、儲存時間都以 TODAY_YMD 為基準，不用 new Date()，倒數與回執才會在同一個時間基準 */
export const DEMO_TIME = "14:32";
export const DEMO_STAMP = `${TODAY_YMD} ${DEMO_TIME}`;
export const DEMO_STAMP_SHORT = `${TODAY_YMD.slice(5)} ${DEMO_TIME}`;

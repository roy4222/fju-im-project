import { CURRENT_USERS, MANAGED_ITEMS, MY_GROUP, SIGNOFF, TEACHERS, UNGROUPED, daysUntil, isSubmittedState, mySignoffPending, type Member, type SubmissionState } from "@/lib/fixtures";

/**
 * 學生後台 v1（Roy 2026-10-15，Q71～Q73）：只留「首頁｜交作業｜組別」三塊。
 *
 * 待辦的唯一口徑：作業和同意書混在同一份清單。首頁待辦卡、首頁「下一件要交的」、
 * 交作業三個篩選、側欄徽章全部從 studentTodos() 算，不各自推（09-10 Codex：數字對不起來的老問題）。
 */
export type TodoStatus = "overdue" | "soon" | "open" | "done";
export type StudentTodo = {
  id: string;
  kind: "item" | "consent";
  title: string;
  /** 同意書沒有截止日 */
  due?: string;
  status: TodoStatus;
  /** 相對於 /dashboard/student */
  href: string;
  draft?: boolean;
};

/** 幾天內算「快到期」 */
export const SOON_DAYS = 10;
export const CONSENT_ID = "consent";

function itemTodoStatus(state: SubmissionState | undefined, due?: string): TodoStatus {
  if (isSubmittedState(state)) return "done";
  if (state === "overdue" || (due && daysUntil(due) < 0)) return "overdue";
  if (due && daysUntil(due) <= SOON_DAYS) return "soon";
  return "open";
}

/** 全部待辦：沒做完的在前（依截止，沒截止日的同意書排在有日期的後面），做完的在後 */
export function studentTodos(consentDone = !mySignoffPending()): StudentTodo[] {
  const items: StudentTodo[] = MANAGED_ITEMS.filter((i) => i.myState).map((i) => ({
    id: i.id,
    kind: "item",
    title: i.title,
    due: i.dueAt,
    status: itemTodoStatus(i.myState, i.dueAt),
    href: `/affairs/${i.id}`,
    draft: i.myState === "draft",
  }));
  const consent: StudentTodo = { id: CONSENT_ID, kind: "consent", title: SIGNOFF.title, status: consentDone ? "done" : "open", href: `/affairs/${CONSENT_ID}` };
  const byDue = (a: StudentTodo, b: StudentTodo) => (a.due ?? "9999").localeCompare(b.due ?? "9999");
  const all = [...items, consent];
  return [...all.filter((t) => t.status !== "done").sort(byDue), ...all.filter((t) => t.status === "done").sort(byDue)];
}

export type TodoTab = "open" | "done" | "overdue";
export const TODO_TABS: { key: TodoTab; label: string; match: (t: StudentTodo) => boolean }[] = [
  { key: "open", label: "待交", match: (t) => t.status === "open" || t.status === "soon" },
  { key: "done", label: "已交", match: (t) => t.status === "done" },
  { key: "overdue", label: "逾期", match: (t) => t.status === "overdue" },
];

/** 側欄徽章＝待交數（現在還能做的；逾期要系辦重開，不算） */
export function studentOpenCount(): number {
  return studentTodos().filter(TODO_TABS[0].match).length;
}

/** 首頁「下一件要交的」：待交清單裡第一件有截止日的 */
export function nextDue(): StudentTodo | undefined {
  return studentTodos().find((t) => TODO_TABS[0].match(t) && t.due);
}

/* ------------------------------------------------------------------ 組別 */

/** 示範切換：還沒成組（預設，對應 TODAY 08-17）／已成組 */
export type Phase = "forming" | "formed";

export function groupView(phase: Phase) {
  const formed = phase === "formed";
  const members: Member[] = formed ? MY_GROUP.members.map((m) => ({ ...m, confirmed: true })) : MY_GROUP.members;
  const advisor = formed ? TEACHERS.find((t) => t.id === MY_GROUP.advisorId) ?? null : null;
  const milestones = [
    { id: "proposal", title: "邀請組員", done: true, at: "08-11", hint: "" },
    { id: "formed", title: "成組", done: formed, at: formed ? "08-17" : undefined, hint: `還差 ${members.filter((m) => !m.confirmed).length} 人確認` },
    { id: "midterm", title: "期中交件", done: false, hint: "2027/03" },
    { id: "final", title: "成果發表", done: false, hint: "2027/05" },
  ];
  return { formed, members, advisor, milestones, me: CURRENT_USERS.student };
}

export type InviteState = "accepted" | "pending" | "declined";
export type Proposal = {
  id: string;
  by: string;
  at: string;
  expires?: string;
  result: "open" | "formed" | "withdrawn" | "expired";
  invites: { name: string; studentNo: string; state: InviteState; at?: string }[];
  note?: string;
};

/** 邀請紀錄（新的在前）。目前這筆在還沒成組時是「等待回覆」，已成組時是「已成組」 */
export function proposals(phase: Phase): Proposal[] {
  const current: Proposal = {
    id: "p-02",
    by: "林彥廷",
    at: "2026-08-11 20:15",
    expires: "2026-08-24",
    result: phase === "formed" ? "formed" : "open",
    invites: MY_GROUP.members.filter((m) => m.id !== CURRENT_USERS.student.id).map((m) => ({
      name: m.name,
      studentNo: m.studentNo,
      state: phase === "formed" || m.confirmed ? "accepted" : "pending",
      at: m.confirmed ? (m.id === "u-402" ? "08-11 21:02" : "08-12 10:40") : phase === "formed" ? "08-17 09:30" : undefined,
    })),
  };
  const first: Proposal = {
    id: "p-01",
    by: "林彥廷",
    at: "2026-08-06 13:20",
    result: "withdrawn",
    invites: [
      { name: "黃詩涵", studentNo: "411410145", state: "accepted", at: "08-06 14:01" },
      { name: "冷佳霓", studentNo: "411410444", state: "declined", at: "08-07 09:12" },
    ],
    note: "冷佳霓婉拒後撤回",
  };
  return [current, first];
}

export type GroupEvent = { at: string; text: string; who: string; tone?: "brand" | "success" | "muted" };

/** 組別動態（新的在前，唯讀） */
export function groupEvents(phase: Phase): GroupEvent[] {
  const base: GroupEvent[] = [
    { at: "2026-08-12 10:40", text: "吳柏諺確認加入", who: "吳柏諺", tone: "success" },
    { at: "2026-08-11 21:02", text: "黃詩涵確認加入", who: "黃詩涵", tone: "success" },
    { at: "2026-08-11 20:15", text: "林彥廷邀請 4 位同學", who: "林彥廷", tone: "brand" },
  ];
  if (phase === "forming") return base;
  return [
    { at: "2026-09-25 15:30", text: "系辦指派指導老師：陳建宏", who: "系辦", tone: "brand" },
    { at: "2026-08-17 09:30", text: "五人都已確認，第 07 組成組", who: "系統", tone: "success" },
    { at: "2026-08-16 22:10", text: "蔡育瑄、鄭凱文確認加入", who: "蔡育瑄", tone: "success" },
    ...base,
  ];
}

/** 找隊員：本人開啟公開的同屆未分組學生 */
export function openClassmates() {
  return UNGROUPED.filter((u) => u.openToJoin);
}

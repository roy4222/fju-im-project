import { TODAY_YMD, type FormField, type Placement } from "@/lib/fixtures";

/**
 * 內容草稿（原型）：快速建立與完整編輯器共用同一個草稿 id（Codex 09-10 A-02）。
 * 存在 sessionStorage，重新整理仍在、關掉分頁就沒了；正式版換成 API 即可，欄位形狀照 ManagedItem。
 */
export type Visibility = "students" | "public";

export type Draft = {
  id: string;
  kind: Placement;
  title: string;
  summary: string;
  body: string;
  audience: string;
  groupIds: string[];
  dueAt: string;
  visibility: Visibility;
  notify: boolean;
  fields: FormField[];
  attachments: string[];
  status: "draft" | "published";
  /** 假時間字串，以 TODAY_YMD 為基準 */
  updatedAt: string;
  publishedAt?: string;
};

const KEY = "fju-proto-drafts";

export function newDraftId(): string {
  return `d-${Date.now().toString(36)}`;
}

/** 原型固定「今天」：日期固定 TODAY_YMD，只取真實時鐘的時分，畫面才對得上其他假資料 */
export function fakeNow(): string {
  const d = new Date();
  return `${TODAY_YMD} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function emptyDraft(id: string, kind: Placement = "news"): Draft {
  return { id, kind, title: "", summary: "", body: "", audience: "本屆學生", groupIds: [], dueAt: "", visibility: "students", notify: true, fields: [], attachments: [], status: "draft", updatedAt: fakeNow() };
}

function readAll(): Record<string, Draft> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, Draft>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Draft>) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* 私密模式等情況：忽略 */
  }
}

/** 給 useSyncExternalStore 用：整份原始字串（穩定，才不會每次 render 都是新物件） */
export function readDraftsRaw(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function subscribeDrafts(cb: () => void): () => void {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

export function saveDraft(draft: Draft): Draft {
  const next = { ...draft, updatedAt: fakeNow() };
  const all = readAll();
  all[next.id] = next;
  writeAll(all);
  return next;
}

export function loadDraft(id: string): Draft | null {
  return readAll()[id] ?? null;
}

export function listDrafts(): Draft[] {
  return Object.values(readAll()).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function removeDraft(id: string) {
  const all = readAll();
  delete all[id];
  writeAll(all);
}

export function isDraftId(id: string): boolean {
  return id.startsWith("d-");
}

/** 對象文案：「第 02、07 組，共 2 組」 */
export function describeGroups(groupIds: string[], groups: { id: string; no: string; members: unknown[] }[]): { text: string; count: number; students: number } {
  const picked = groups.filter((g) => groupIds.includes(g.id)).sort((a, b) => a.no.localeCompare(b.no));
  const nos = picked.map((g) => g.no.replace(/第\s*|\s*組/g, ""));
  const students = picked.reduce((a, g) => a + g.members.length, 0);
  return { text: nos.length ? `第 ${nos.join("、")} 組，共 ${nos.length} 組` : "尚未選組別", count: nos.length, students };
}

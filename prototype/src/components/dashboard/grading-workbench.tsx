"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { IconAlertCircle, IconCheck, IconDeviceFloppy, IconLock, IconSend } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { EVALUATION_QUEUE, GRADING_SCHEME, GROUPS, TODAY_YMD } from "@/lib/fixtures";

const LETTER: Record<string, number> = { A: 95, B: 85, C: 75, D: 65, F: 50 };
type Scores = Record<string, string>;
type QueueState = (typeof EVALUATION_QUEUE)[number]["state"];
/** sessionStorage 裡每組的紀錄（原型層的「可靠保存」示範；正式版換成 API） */
type Stored = { scores: Scores; state: "staged" | "submitted"; savedAt?: string; submittedAt?: string };
type SaveState = "unsaved" | "saving" | "saved" | "failed";

const ITEMS = GRADING_SCHEME.stages[0].items;
const storageKey = (groupId: string) => `fju-grading-${groupId}`;
const FOCUS_FLAG = "fju-grading-focus";

/** 原型時鐘：日期固定 TODAY_YMD，時分取目前時刻，避免每次重整日期跳動 */
function fakeNow() {
  const d = new Date();
  return `${TODAY_YMD} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function readStored(groupId: string): Stored | null {
  try {
    const raw = sessionStorage.getItem(storageKey(groupId));
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}
function writeStored(groupId: string, v: Stored) {
  sessionStorage.setItem(storageKey(groupId), JSON.stringify(v));
}

/** 預設分數：已暫存／已送出的組別有值，未開始為空 */
function seed(groupId: string, state: string): Scores {
  if (state === "pending") return {};
  const n = groupId.charCodeAt(2) + groupId.charCodeAt(3);
  return Object.fromEntries(ITEMS.map((it, i) => [it.id, it.input === "letter" ? ["A", "B", "B", "A"][(n + i) % 4] : String(70 + ((n * (i + 3)) % 28))]));
}

/** 單項驗證（T-01）：整數、0–max；回傳錯誤訊息或 null */
function validate(it: (typeof ITEMS)[number], index: number, raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  if (it.input === "letter") return raw in LETTER ? null : `第 ${index + 1} 項需選 A–F`;
  const t = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t) || !Number.isInteger(Number(t))) return `第 ${index + 1} 項需填 0–${it.max} 的整數`;
  const n = Number(t);
  if (n < 0 || n > it.max) return `第 ${index + 1} 項需介於 0–${it.max}`;
  return null;
}

function calc(scores: Scores) {
  let sum = 0, filled = 0, invalid = 0;
  const errors: Record<string, string> = {};
  ITEMS.forEach((it, i) => {
    const raw = scores[it.id];
    if (raw === undefined || raw === "") return;
    const err = validate(it, i, raw);
    if (err) { errors[it.id] = err; invalid++; return; }
    const pct = it.input === "letter" ? LETTER[raw] : (Number(raw) / it.max) * 100;
    sum += pct * (it.weight / 100);
    filled++;
  });
  /* 精度政策：預覽、回執、隊列摘要都一位小數 */
  return { score: Math.round(sum * 10) / 10, filled, invalid, total: ITEMS.length, errors };
}

function SaveDot({ state }: { state: SaveState | "locked" }) {
  const cls = { unsaved: "border-[1.5px] border-muted-foreground", saving: "bg-muted-foreground/60", saved: "bg-success", failed: "bg-destructive", locked: "bg-success" }[state];
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${cls}`} />;
}

const stateLabel = (s: QueueState) => (s === "submitted" ? "已送出" : s === "staged" ? "草稿" : "未開始");

/**
 * 評分工作台（規格 §16.4 方向 C：左側組別清單＋右側評分表）。
 * 老師只看受指派組別；暫存只本人可見；送出後鎖定（§7.4）。
 * 目前組別是路由狀態（/grading/<groupId>）；暫存與送出寫在 sessionStorage（原型層的可靠保存）。
 */
const subscribeNoop = () => () => {};

export function GradingWorkbench(props: { role: string; groupId: string }) {
  /* 伺服器與首次 hydration 用 fixtures；掛上後以 key 重新初始化，從 sessionStorage 讀暫存（避免 hydration 不一致） */
  const hydrated = useSyncExternalStore(subscribeNoop, () => true, () => false);
  return <Bench key={`${props.groupId}-${hydrated ? "client" : "server"}`} {...props} hydrated={hydrated} />;
}

function Bench({ role, groupId, hydrated }: { role: string; groupId: string; hydrated: boolean }) {
  const router = useRouter();
  const base = `/dashboard/${role}/grading`;
  const current = groupId;
  const fixture = EVALUATION_QUEUE.find((e) => e.groupId === current) ?? EVALUATION_QUEUE[0];
  const group = GROUPS.find((g) => g.id === current) ?? GROUPS[0];
  const stage = GRADING_SCHEME.stages[0];

  const [stored, setStored] = useState<Record<string, Stored | null>>(() => {
    if (!hydrated) return {};
    const map: Record<string, Stored | null> = {};
    for (const e of EVALUATION_QUEUE) map[e.groupId] = readStored(e.groupId);
    return map;
  });
  const mine = stored[current] ?? null;
  const [draft, setDraft] = useState<Scores>(() => mine?.scores ?? seed(current, fixture.state));
  const [dirty, setDirty] = useState(false);
  const [save, setSave] = useState<SaveState>(mine ? "saved" : "unsaved");
  const [savedAt, setSavedAt] = useState<string | undefined>(mine?.submittedAt ?? mine?.savedAt);
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<null | { groupNo: string; score: number; at: string }>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const inputRefs = useRef<Record<string, HTMLElement | null>>({});

  /* 從隊列切過來：焦點移到組別標題 */
  useEffect(() => {
    if (!hydrated) return;
    try {
      if (sessionStorage.getItem(FOCUS_FLAG)) {
        sessionStorage.removeItem(FOCUS_FLAG);
        titleRef.current?.focus();
      }
    } catch { /* 讀不到就不移焦點 */ }
  }, [hydrated, current]);

  /* 重新整理／關閉分頁時還有未儲存輸入 */
  useEffect(() => {
    if (!dirty) return;
    const h = (ev: BeforeUnloadEvent) => { ev.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const entryState: QueueState = stored[current]?.state ?? fixture.state;
  const locked = entryState === "submitted";
  const result = useMemo(() => calc(draft), [draft]);
  const complete = result.filled === result.total && result.invalid === 0;
  const missing = result.total - result.filled - result.invalid;

  const queue = useMemo(() => EVALUATION_QUEUE.map((e) => {
    const s = stored[e.groupId];
    const scores = e.groupId === current ? draft : s?.scores ?? seed(e.groupId, e.state);
    return { ...e, state: (s?.state ?? e.state) as QueueState, calc: calc(scores) };
  }), [stored, draft, current]);

  function set(itemId: string, v: string) {
    setDraft((d) => ({ ...d, [itemId]: v }));
    setDirty(true);
    setSave("unsaved");
  }

  function stash(after?: () => void) {
    setSave("saving");
    window.setTimeout(() => {
      try {
        const at = fakeNow();
        const rec: Stored = { scores: draft, state: "staged", savedAt: at };
        writeStored(current, rec);
        setStored((m) => ({ ...m, [current]: rec }));
        setSavedAt(at);
        setSave("saved");
        setDirty(false);
        after?.();
      } catch {
        setSave("failed");
      }
    }, 400);
  }

  function submit() {
    if (!complete) return;
    const at = fakeNow();
    const rec: Stored = { scores: draft, state: "submitted", savedAt: at, submittedAt: at };
    try { writeStored(current, rec); } catch { setSave("failed"); return; }
    setStored((m) => ({ ...m, [current]: rec }));
    setSavedAt(at);
    setSave("saved");
    setDirty(false);
    setReceipt({ groupNo: fixture.groupNo, score: result.score, at });
  }

  function navigate(id: string) {
    try { sessionStorage.setItem(FOCUS_FLAG, "1"); } catch { /* 無法寫入時只是不自動移焦點 */ }
    router.push(`${base}/${id}`);
  }
  function go(id: string) {
    if (id === current) return;
    if (dirty && !locked) setPendingNav(id);
    else navigate(id);
  }
  function focusFirstMissing() {
    const it = ITEMS.find((i) => !draft[i.id] || result.errors[i.id]);
    if (it) inputRefs.current[it.id]?.focus();
  }

  const blockReason = locked ? null : result.invalid > 0 ? `${Object.values(result.errors)[0]}，修正後才能正式送出。` : missing > 0 ? `還差 ${missing} 項，填齊後才能正式送出。` : null;
  const statusText = locked ? `已正式送出 ${savedAt ?? ""}` : save === "saving" ? "儲存中…" : save === "failed" ? "儲存失敗，請再暫存一次" : save === "saved" && savedAt ? `已儲存 ${savedAt.slice(11)}` : "尚未儲存";

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      {/* 手機：下拉選組 */}
      <label className="flex flex-col gap-1.5 lg:hidden">
        <span className="text-xs font-semibold text-muted-foreground">組別</span>
        <select value={current} onChange={(e) => go(e.target.value)} className="tabular h-11 rounded-lg border border-input bg-card px-3 text-sm font-semibold outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
          {queue.map((e) => <option key={e.groupId} value={e.groupId}>{e.groupNo}・{e.title}（{stateLabel(e.state)}）</option>)}
        </select>
      </label>

      {/* 桌面：左側隊列 */}
      <aside className="dash-card hidden lg:block">
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm font-bold text-primary">{stage.name}</p>
          <p className="tabular text-xs text-muted-foreground">我的 {queue.length} 組・占總成績 {stage.weight}%</p>
        </div>
        <ul className="py-2" aria-label="評分隊列">
          {queue.map((e) => {
            const active = e.groupId === current;
            return (
              <li key={e.groupId}>
                <a href={`${base}/${e.groupId}`} aria-current={active ? "page" : undefined} onClick={(ev) => { ev.preventDefault(); go(e.groupId); }} className={`flex min-h-11 items-center gap-3 border-l-[3px] py-2 pr-3 pl-3 transition-colors duration-150 ${active ? "border-brand bg-accent/60" : "border-transparent hover:bg-accent/50"}`}>
                  <span className="min-w-0 flex-1">
                    <span className="tabular block text-[11px] text-muted-foreground">{e.groupNo}</span>
                    <span className={`block truncate text-sm ${active ? "font-bold text-primary" : "font-semibold"}`}>{e.title}</span>
                  </span>
                  {e.state === "submitted" ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-success-on-subtle"><IconLock className="size-3.5" />已送出</span> : e.state === "staged" ? <span className="tabular text-[11px] font-semibold text-muted-foreground">草稿 {e.calc.filled}/{e.calc.total}</span> : <span className="text-[11px] text-muted-foreground">未開始</span>}
                </a>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* 右：評分表 */}
      <section className="dash-card">
        {/* 頂端固定一列：組別＋儲存狀態 */}
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-t-[18px] border-b border-border bg-card px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="tabular text-xs font-semibold text-muted-foreground">{fixture.groupNo}・{stage.name}</p>
            <h2 key={current} ref={titleRef} tabIndex={-1} className="animate-in fade-in-0 truncate rounded text-lg font-extrabold text-primary outline-none duration-150 focus-visible:ring-3 focus-visible:ring-ring/50">{group.title.replace(/（產學：.*）/, "")}</h2>
          </div>
          <p className="tabular inline-flex items-center gap-2 text-xs font-medium" role="status" aria-live="polite">
            <SaveDot state={locked ? "locked" : save} />
            <span className={save === "failed" ? "text-destructive" : locked || save === "saved" ? "text-foreground" : "text-muted-foreground"}>{statusText}</span>
          </p>
        </div>
        <p className="truncate px-5 pt-3 text-xs text-muted-foreground">{group.members.map((m) => m.name).join("、")}</p>

        {/* 項目列：名稱＋占比｜輸入｜狀態；項目間只用細線與留白 */}
        <ol className="px-5 pt-2 pb-2">
          {ITEMS.map((it, i) => {
            const v = draft[it.id] ?? "";
            const err = result.errors[it.id];
            const filled = v !== "" && !err;
            const helpId = `help-${it.id}`;
            const errId = `err-${it.id}`;
            const inputId = `score-${it.id}`;
            return (
              <li key={it.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-t border-border py-4 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_13.5rem_4rem] sm:gap-x-5">
                <div className="col-span-2 min-w-0 sm:col-span-1">
                  <label htmlFor={inputId} className="block text-[15px] font-semibold">{i + 1}. {it.name}</label>
                  <p id={helpId} className="tabular text-xs text-muted-foreground">滿分 {it.max}・占 {it.weight}%</p>
                </div>
                <div className="min-w-0">
                  {it.input === "letter" ? (
                    <div className="flex gap-1" role="radiogroup" aria-label={`${it.name}，等第 A 到 F`} aria-describedby={helpId} id={inputId}>
                      {Object.keys(LETTER).map((l, li) => (
                        <button key={l} type="button" role="radio" aria-checked={v === l} aria-label={`${l}，${LETTER[l]} 分`} disabled={locked} ref={(el) => { if (li === 0) inputRefs.current[it.id] = el; }} onClick={() => set(it.id, l)} className={`press h-11 flex-1 rounded-lg text-sm font-bold transition-colors duration-150 disabled:opacity-60 ${v === l ? "bg-brand text-brand-foreground" : "bg-muted text-foreground hover:bg-accent"}`}>{l}</button>
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-baseline gap-2">
                      <input id={inputId} ref={(el) => { inputRefs.current[it.id] = el; }} type="text" inputMode="numeric" autoComplete="off" value={v} onChange={(e) => set(it.id, e.target.value)} disabled={locked} placeholder="0–100" aria-describedby={err ? `${helpId} ${errId}` : helpId} aria-invalid={err ? true : undefined} className={`tabular h-11 w-28 rounded-lg border bg-background px-3 text-center text-[18px] font-bold outline-none transition-[border-color,box-shadow] duration-150 focus-visible:ring-3 disabled:bg-muted disabled:opacity-70 ${err ? "border-destructive text-destructive focus-visible:ring-destructive/25" : "border-input focus-visible:border-brand focus-visible:ring-brand/25"}`} />
                      <span className="tabular text-sm text-muted-foreground">/ {it.max}</span>
                    </div>
                  )}
                  {err ? <p id={errId} className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-destructive"><IconAlertCircle className="size-3.5" />{err}</p> : null}
                </div>
                <div className="tabular text-xs sm:text-right">
                  {locked ? <span className="text-muted-foreground">已採計</span> : err ? <span className="font-semibold text-destructive">需修正</span> : filled ? <span className="inline-flex items-center gap-1 text-success-on-subtle"><IconCheck className="size-3.5" strokeWidth={3} />已填</span> : <span className="text-muted-foreground">未填</span>}
                </div>
              </li>
            );
          })}
        </ol>
        {/* 手機底部固定列會蓋住最後一項，內容底部留空 */}
        <div className="h-24 lg:hidden" aria-hidden />

        {/* 底部：預覽總分＋動作（手機固定在底） */}
        <div className="sticky bottom-0 z-10 rounded-b-[18px] border-t border-border bg-card lg:static">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 pt-3">
            <p className="tabular text-sm"><span className="text-muted-foreground">{locked ? "正式採計" : "預覽總分"}</span> <b className="text-[17px] font-extrabold">{result.score.toFixed(1)}</b><span className="text-muted-foreground"> / 100</span></p>
            <div className="min-w-[120px] flex-1"><div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden><span className="block h-full rounded-full bg-primary transition-[width] duration-150" style={{ width: `${Math.min(100, result.score)}%` }} /></div></div>
            {!locked && (missing > 0 || result.invalid > 0) ? (
              <button type="button" onClick={focusFirstMissing} className="tabular text-xs font-semibold text-primary underline-offset-2 hover:underline">{result.invalid > 0 ? `${result.invalid} 項需修正` : `還差 ${missing} 項`}</button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3 px-5 py-3">
            <span className="min-w-0 basis-full text-xs text-muted-foreground sm:flex-1 sm:basis-auto">
              {locked ? "已正式送出並鎖定；要改請系辦退回。" : blockReason ?? "七項都有效，可以正式送出。"}
            </span>
            {!locked ? (
              <div className="flex w-full gap-2 sm:w-auto">
                <button type="button" onClick={() => stash()} disabled={save === "saving"} className={buttonVariants({ variant: "outline", size: "lg", className: "press h-11 flex-1 rounded-lg px-4 sm:flex-none" })}><IconDeviceFloppy /> 暫存</button>
                <button type="button" onClick={submit} disabled={!complete} title={complete ? undefined : blockReason ?? undefined} className="btn-fju h-11 flex-1 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"><IconSend className="size-4" /> 正式送出</button>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {/* 切組前：有未儲存輸入 */}
      <Dialog open={pendingNav !== null} onOpenChange={(o) => !o && setPendingNav(null)}>
        <DialogContent className="max-w-sm">
          <DialogTitle className="text-lg font-extrabold">{fixture.groupNo} 還有未儲存的分數</DialogTitle>
          <DialogDescription>先暫存再切換，或放棄這次修改。</DialogDescription>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <button type="button" onClick={() => { const id = pendingNav!; setPendingNav(null); stash(() => navigate(id)); }} className="btn-fju h-10 flex-1 text-sm">先暫存</button>
            <button type="button" onClick={() => { const id = pendingNav!; setPendingNav(null); setDirty(false); navigate(id); }} className={buttonVariants({ variant: "outline", size: "lg", className: "press h-10 flex-1 rounded-lg" })}>放棄修改</button>
            <button type="button" onClick={() => setPendingNav(null)} className={buttonVariants({ variant: "ghost", size: "lg", className: "press h-10 rounded-lg" })}>取消</button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 收件章回執 */}
      <Dialog open={receipt !== null} onOpenChange={(o) => !o && setReceipt(null)}>
        <DialogContent className="max-w-sm">
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <span className="animate-in fade-in-0 zoom-in-95 inline-flex -rotate-2 items-center gap-1.5 rounded-lg border-2 border-success px-3 py-1.5 text-sm font-extrabold tracking-[0.12em] text-success-on-subtle duration-300"><IconCheck className="size-4" strokeWidth={3} />已收件</span>
            <div>
              <DialogTitle className="text-lg font-extrabold">{receipt?.groupNo}・{stage.name}</DialogTitle>
              <DialogDescription className="tabular mt-1">收件時間 {receipt?.at}</DialogDescription>
            </div>
            <p className="tabular text-sm text-muted-foreground">正式採計 <b className="text-[28px] font-extrabold text-foreground">{receipt?.score.toFixed(1)}</b> / 100</p>
            <p className="text-xs text-muted-foreground">已鎖定。多位老師時以算術平均計入階段成績；學生看不到分數。</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

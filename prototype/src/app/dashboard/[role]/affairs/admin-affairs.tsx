"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { IconClipboardText, IconExternalLink, IconSearch } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, PageTitle, Panel, Pill, ProgressBar } from "@/components/dashboard/primitives";
import { NewItemDialog } from "@/components/dashboard/new-item-dialog";
import { MANAGED_ITEMS, PLACEMENT_LABEL, daysUntil, isSubmittedState, GROUP_SUBMISSIONS, type Placement, type Role } from "@/lib/fixtures";
import { describeGroups, readDraftsRaw, subscribeDrafts, type Draft } from "@/lib/draft-store";
import { GROUPS } from "@/lib/fixtures";

const KIND_FILTERS: { key: Placement | "all"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "news", label: "公告" },
  { key: "resource", label: "資源" },
  { key: "submission", label: "文件繳交" },
  { key: "requirement", label: "專題需求" },
];

/** 統一內容列表用的列形狀：fixtures 的 ManagedItem 與 sessionStorage 的草稿都轉成這個 */
type Row = {
  id: string;
  kind: Placement;
  title: string;
  status: "draft" | "published" | "archived";
  visibility: string;
  audience: string;
  date: string;
  dateKind: "due" | "published";
  progress?: { done: number; total: number; overdue: number };
  newsId?: string;
  editHref: string;
  detailHref?: string;
  isLocalDraft?: boolean;
};

function fromDraft(d: Draft, base: string): Row {
  return {
    id: d.id,
    kind: d.kind,
    title: d.title || "（未命名）",
    status: d.status,
    visibility: d.visibility === "public" ? "網際網路公開" : "學生可見",
    audience: d.audience === "指定組別" ? describeGroups(d.groupIds, GROUPS).text : d.audience,
    date: d.dueAt || d.updatedAt.slice(0, 10),
    dateKind: d.dueAt ? "due" : "published",
    editHref: `${base}/editor/${d.id}`,
    isLocalDraft: true,
  };
}

/* ---------------------------------------------------------------- 管理員 */
export function AdminAffairs({ role, placement }: { role: Role; placement: string }) {
  const base = `/dashboard/${role}`;
  const [kind, setKind] = useState<Placement | "all">(KIND_FILTERS.some((k) => k.key === placement) ? (placement as Placement | "all") : "all");
  const [q, setQ] = useState("");
  const raw = useSyncExternalStore(subscribeDrafts, readDraftsRaw, () => "");
  const drafts = useMemo<Draft[]>(() => (raw ? Object.values(JSON.parse(raw) as Record<string, Draft>).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)) : []), [raw]);

  const rows = useMemo<Row[]>(() => {
    const fixed: Row[] = MANAGED_ITEMS.map((i) => {
      const subs = GROUP_SUBMISSIONS[i.id];
      const collects = i.placement === "submission" || i.placement === "requirement";
      return {
        id: i.id,
        kind: i.placement,
        title: i.title,
        status: i.status,
        visibility: i.audience === "公開訪客" ? "網際網路公開" : "學生可見",
        audience: i.audience,
        date: i.dueAt ?? i.publishedAt,
        dateKind: i.dueAt ? "due" : "published",
        progress: subs ? { done: subs.filter((r) => isSubmittedState(r.state)).length, total: subs.length, overdue: subs.filter((r) => r.state === "overdue").length } : undefined,
        newsId: i.newsId,
        editHref: `${base}/editor/${i.id}`,
        detailHref: collects ? `${base}/affairs/${i.id}` : undefined,
      };
    });
    return [...drafts.map((d) => fromDraft(d, base)), ...fixed];
  }, [drafts, base]);

  const query = q.trim().toLowerCase();
  const shown = rows.filter((r) => (kind === "all" || r.kind === kind) && (!query || r.title.toLowerCase().includes(query) || r.audience.toLowerCase().includes(query)));
  const published = rows.filter((r) => r.status === "published").length;
  const collectRows = rows.filter((r) => r.progress);
  const totalDone = collectRows.reduce((a, r) => a + r.progress!.done, 0);
  const totalAll = collectRows.reduce((a, r) => a + r.progress!.total, 0);
  const overdue = collectRows.reduce((a, r) => a + r.progress!.overdue, 0);

  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="專題事務" description={`${rows.length} 項・發布中 ${published}・收件 ${totalDone}/${totalAll}${overdue ? `・逾期 ${overdue} 組` : ""}`} actions={<NewItemDialog base={base} />} />
      <Panel
        title="全部內容"
        icon={<IconClipboardText />}
        action={<div className="hidden sm:block"><div className="flex flex-wrap items-center gap-2">
            <label className="relative block">
              <span className="sr-only">搜尋標題或對象</span>
              <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋標題、對象" className="h-9 w-48 max-sm:w-full rounded-lg border border-input bg-background pr-3 pl-8 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25" />
            </label>
            <nav className="flex flex-wrap gap-1" aria-label="種類">
              {KIND_FILTERS.map((k) => (
                <button key={k.key} type="button" onClick={() => setKind(k.key)} aria-pressed={kind === k.key} className={`press h-9 rounded-full border px-3.5 text-sm font-semibold transition-colors ${kind === k.key ? "border-primary bg-primary text-primary-foreground" : "border-border text-foreground hover:border-primary/40 hover:bg-accent"}`}>{k.label}</button>
              ))}
            </nav>
          </div></div>}
      >
        <div className="border-t border-border px-5 py-3 sm:hidden"><div className="flex flex-wrap items-center gap-2">
            <label className="relative block">
              <span className="sr-only">搜尋標題或對象</span>
              <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋標題、對象" className="h-9 w-48 max-sm:w-full rounded-lg border border-input bg-background pr-3 pl-8 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25" />
            </label>
            <nav className="flex flex-wrap gap-1" aria-label="種類">
              {KIND_FILTERS.map((k) => (
                <button key={k.key} type="button" onClick={() => setKind(k.key)} aria-pressed={kind === k.key} className={`press h-9 rounded-full border px-3.5 text-sm font-semibold transition-colors ${kind === k.key ? "border-primary bg-primary text-primary-foreground" : "border-border text-foreground hover:border-primary/40 hover:bg-accent"}`}>{k.label}</button>
              ))}
            </nav>
          </div></div>
        <div className="hidden grid-cols-[6.5rem_minmax(0,1fr)_5rem_7rem_9rem_7rem_9rem_7rem] gap-3 border-t border-border px-5 py-2 text-xs font-semibold text-muted-foreground md:grid">
          <span>種類</span><span>標題</span><span>狀態</span><span>可見範圍</span><span>對象</span><span>截止／發布</span><span>收件進度</span><span className="sr-only">操作</span>
        </div>
        <ul className="divide-y divide-border border-t border-border md:border-t-0">
          {shown.map((r) => (
            <li key={r.id} className="grid items-center gap-x-3 gap-y-1.5 px-5 py-3 transition-colors hover:bg-accent/40 md:grid-cols-[6.5rem_minmax(0,1fr)_5rem_7rem_9rem_7rem_9rem_7rem]">
              <span className="text-xs font-semibold text-muted-foreground md:text-sm">{PLACEMENT_LABEL[r.kind].split("／")[0]}</span>
              <div className="min-w-0">
                <Link href={r.detailHref ?? r.editHref} className="link-ink block truncate text-[15px] font-bold">{r.title}</Link>
                {r.newsId ? <Link href={`/news/${r.newsId}`} className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground">前台頁面 <IconExternalLink className="size-3" /></Link> : r.isLocalDraft ? <span className="text-xs text-muted-foreground">這個瀏覽器的草稿</span> : null}
              </div>
              <span><Pill tone={r.status === "published" ? "success" : "default"}>{r.status === "published" ? "發布中" : r.status === "draft" ? "草稿" : "已下架"}</Pill></span>
              <span className="text-xs text-muted-foreground md:text-sm">{r.visibility}</span>
              <span className="truncate text-xs text-muted-foreground md:text-sm">{r.audience}</span>
              <span className={`tabular text-xs md:text-sm ${r.dateKind === "due" ? (daysUntil(r.date) < 0 ? "font-semibold text-destructive" : "font-semibold") : "text-muted-foreground"}`}>{r.date}</span>
              <span>{r.progress ? <ProgressBar done={r.progress.done} total={r.progress.total} overdue={r.progress.overdue} /> : <span className="text-xs text-muted-foreground">—</span>}</span>
              <span className="flex gap-1.5 md:justify-end">
                {r.detailHref ? <Link href={r.detailHref} className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}>收件</Link> : null}
                <Link href={r.editHref} className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}>編輯</Link>
              </span>
            </li>
          ))}
        </ul>
        {shown.length === 0 ? <EmptyState title={query ? `沒有符合「${q}」的內容` : "這個種類沒有內容"} /> : null}
      </Panel>
    </div>
  );
}

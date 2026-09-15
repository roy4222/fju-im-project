import Link from "next/link";
import { IconArrowRight, IconChevronRight, IconPencilPlus } from "@tabler/icons-react";
import { Panel, Pill } from "@/components/dashboard/primitives";
import { SegmentBar } from "@/components/dashboard/charts";
import { Donut } from "@/components/dashboard/rc-charts";
import { NewItemDialog } from "@/components/dashboard/new-item-dialog";
import { RemindDialog } from "@/components/dashboard/remind-dialog";
import { ACCOUNTS, CURRENT_USERS, GRADING_PROGRESS, GROUPS, INDUSTRY, MANAGED_ITEMS, SIGNOFF_PROGRESS, TEACHERS, TODAY_YMD, UNGROUPED, currentStage, overdueGroupCount, pendingAccounts, type Role } from "@/lib/fixtures";

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
function md(d: string) { return d.slice(5).replace("-", "/"); }

/**
 * 管理員首頁（Codex 09-10 A-05：數字要接到真的處理路徑）。
 * 版面：一列歡迎（≤150px，不放插圖）→ 四磚待處理 → 收件完成率＋本屆分組 → 老師評分進度＋我發的公告。
 * 所有數字都從 fixtures 的同一批函式算，不用 ADMIN_STATS。
 */
export function AdminHome({ role }: { role: Role }) {
  const base = `/dashboard/${role}`;
  const stage = currentStage();
  const [, mm, dd] = TODAY_YMD.split("-").map(Number);
  const today = `${mm} 月 ${dd} 日・星期${WEEKDAY[new Date(`${TODAY_YMD}T00:00:00`).getDay()]}`;

  const pending = pendingAccounts();
  const overdue = overdueGroupCount();
  const overdueItem = MANAGED_ITEMS.find((i) => (i.progress?.overdue ?? 0) > 0);
  const intake = MANAGED_ITEMS.filter((i) => i.progress);
  const gradingAssigned = GRADING_PROGRESS.reduce((a, t) => a + t.assigned, 0);
  const gradingSubmitted = GRADING_PROGRESS.reduce((a, t) => a + t.submitted, 0);
  const missingTeachers = GRADING_PROGRESS.filter((t) => t.submitted < t.assigned);
  const signComplete = SIGNOFF_PROGRESS.filter((p) => p.state === "complete").length;
  const signWaitTeacher = SIGNOFF_PROGRESS.filter((p) => p.state === "teacher").length;
  const totalStudents = GROUPS.reduce((a, g) => a + g.members.length, 0);
  const industryGroups = GROUPS.filter((g) => g.type === "INDUSTRY").length;
  const unassignedIndustry = INDUSTRY.filter((i) => i.status !== "claimed").length;
  const exceptions = GROUPS.filter((g) => g.status === "exception").length;
  const approved = ACCOUNTS.filter((a) => a.status === "active").length;
  const news = MANAGED_ITEMS.filter((i) => i.placement === "news");
  const todo = pending.length + overdue + missingTeachers.length + signWaitTeacher;

  const tiles = [
    { key: "accounts", label: "審核帳號", value: pending.length, of: `${ACCOUNTS.length} 筆`, scope: `已核准 ${approved}`, href: `${base}/accounts?status=pending`, tone: "brand" },
    { key: "overdue", label: "逾期組別", value: overdue, of: `${GROUPS.length} 組`, scope: overdueItem?.title ?? "—", href: `${base}/affairs/${overdueItem?.id ?? "mi-011"}?filter=overdue`, tone: overdue ? "danger" : "default" },
    { key: "grading", label: "缺評老師", value: missingTeachers.length, of: `${GRADING_PROGRESS.length} 位`, scope: `評分 ${gradingSubmitted}／${gradingAssigned} 份・${Math.round((gradingSubmitted / gradingAssigned) * 100)}%`, href: `${base}/grading`, tone: "default" },
    { key: "sign", label: "等老師簽核", value: signWaitTeacher, of: `${GROUPS.length} 組`, scope: `完成 ${signComplete} 組`, href: `${base}/signoff?state=teacher`, tone: "default" },
  ] as const;

  return (
    <div className="flex flex-col gap-5">
      {/* 歡迎列：一行，不放插圖（Codex 09-10：別讓歡迎語把待處理資料推下去） */}
      <section className="hero flex flex-wrap md:max-h-[150px] items-center justify-between gap-x-6 gap-y-3 px-6 py-5">
        <div className="min-w-0">
          <p className="tabular text-[12px] font-semibold text-white/75">{today}・現在「{stage.title}」</p>
          <h1 className="mt-1 text-[22px] font-extrabold leading-tight tracking-tight">歡迎回來，{CURRENT_USERS.admin.name}</h1>
          <p className="mt-0.5 text-[13px] text-white/85">今天 {todo} 件待處理；本屆 {GROUPS.length} 組、{totalStudents} 位學生、{UNGROUPED.length} 位未分組。</p>
        </div>
        <Link href={`${base}/accounts?status=pending`} className="btn-fju h-10 rounded-xl px-4 text-[14px]">審核帳號（{pending.length}）<IconArrowRight className="size-4" /></Link>
      </section>

      {/* 四磚：每磚＝一條處理路徑，數字旁寫母數與範圍 */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.key} href={t.href} className="dash-card dash-card-hover flex flex-col px-5 py-4">
            <span className="flex items-center justify-between text-[13px] font-semibold text-muted-foreground">{t.label}<IconChevronRight className="size-4" /></span>
            <span className="mt-1.5 flex items-baseline gap-1.5">
              <span className={`tabular text-[30px] font-extrabold leading-none tracking-tight ${t.tone === "brand" ? "text-brand" : t.tone === "danger" ? "text-destructive" : ""}`}>{t.value}</span>
              <span className="tabular text-[13px] font-medium text-muted-foreground">／{t.of}</span>
            </span>
            <span className="mt-1.5 truncate text-[12px] text-muted-foreground">{t.scope}</span>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-3">
        <div className="min-w-0 md:col-span-2">
          <Panel title="各收件項目完成率" description="點一列看未繳組別" action={{ href: `${base}/affairs`, label: "工作台" }} className="h-full">
            <ul className="flex flex-col px-2 pb-2">
              {intake.map((i) => {
                const p = i.progress!;
                const missing = p.total - p.done;
                return (
                  <li key={i.id}>
                    <Link href={`${base}/affairs/${i.id}?filter=missing`} className="group flex flex-col gap-1.5 rounded-xl px-3 py-2.5 transition-colors hover:bg-accent/60">
                      <span className="flex items-center justify-between gap-3 text-sm">
                        <span className="truncate font-semibold">{i.title}</span>
                        <span className="tabular shrink-0 text-xs text-muted-foreground">{p.done}／{p.total} 組{p.overdue ? <span className="ml-1 font-semibold text-destructive">逾期 {p.overdue}</span> : null}</span>
                      </span>
                      <span className="flex items-center gap-3">
                        <SegmentBar className="flex-1" segments={[{ value: p.done, color: "var(--brand)", label: "已繳" }, { value: p.overdue, color: "var(--destructive)", label: "逾期" }, { value: Math.max(0, p.total - p.done - p.overdue), color: "transparent", label: "未繳" }]} />
                        <span className="tabular w-16 shrink-0 text-right text-xs text-muted-foreground group-hover:text-foreground">{missing ? `未繳 ${missing}` : "全數"}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </div>
        <div className="min-w-0">
          <Panel title="本屆分組" description={`${GROUPS.length} 組・${totalStudents} 人`} action={{ href: `${base}/groups`, label: "總覽" }} className="h-full">
            <div className="flex items-center gap-5 px-5 pt-1 pb-5">
              <Donut size={120} thickness={16} data={[{ name: "一般專題", value: GROUPS.length - industryGroups, color: "var(--primary)" }, { name: "產學合作", value: industryGroups, color: "var(--brand)" }]} center={<span className="text-center"><span className="tabular block text-[22px] font-extrabold leading-none">{GROUPS.length}</span><span className="text-[10px] text-muted-foreground">組</span></span>} />
              <ul className="flex flex-1 flex-col gap-2 text-sm">
                <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm bg-primary" />一般專題</span><b className="tabular">{GROUPS.length - industryGroups}</b></li>
                <li className="flex items-center justify-between"><span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-sm bg-brand" />產學合作</span><b className="tabular">{industryGroups}</b></li>
                <li className="flex items-center justify-between border-t border-border/70 pt-2"><Link href={`${base}/industry`} className="hover:underline">產學未指派</Link><b className="tabular">{unassignedIndustry}</b></li>
                <li className="flex items-center justify-between"><Link href={`${base}/groups`} className="hover:underline">未分組學生</Link><b className="tabular">{UNGROUPED.length}</b></li>
                <li className="flex items-center justify-between"><Link href={`${base}/groups`} className="hover:underline">例外組別</Link><b className="tabular">{exceptions}</b></li>
              </ul>
            </div>
          </Panel>
        </div>
        <div className="min-w-0 md:col-span-2">
          <Panel title="老師評分進度" description={`系統驗收・${gradingSubmitted}／${gradingAssigned} 份`} action={{ href: `${base}/grading`, label: "成績" }} className="h-full">
            <div className="overflow-x-auto"><table className="w-full text-sm whitespace-nowrap">
              <thead><tr className="text-left text-[12px] text-muted-foreground"><th className="px-5 py-2 font-semibold">老師</th><th className="px-3 py-2 font-semibold">進度</th><th className="px-3 py-2 font-semibold">送出</th><th className="px-5 py-2"></th></tr></thead>
              <tbody>
                {GRADING_PROGRESS.map((t) => {
                  const done = t.submitted === t.assigned;
                  const email = TEACHERS.find((x) => x.name === t.teacher)?.email;
                  return (
                    <tr key={t.teacher} className="border-t border-border/70">
                      <td className="px-5 py-2.5 font-semibold">{t.teacher}</td>
                      <td className="px-3 py-2.5"><div className="h-2.5 w-32 overflow-hidden rounded-full bg-muted"><span className={`block h-full rounded-full ${done ? "bg-success" : "bg-primary"}`} style={{ width: `${(t.submitted / t.assigned) * 100}%` }} /></div></td>
                      <td className="tabular px-3 py-2.5">{t.submitted}／{t.assigned}</td>
                      <td className="px-5 py-2.5 text-right">{done ? <Pill tone="success">完成</Pill> : <RemindDialog recipients={[{ name: t.teacher, detail: email }]} subject={`【專題】系統驗收評分尚有 ${t.assigned - t.submitted} 組未送出`} context={`${t.teacher} 老師目前送出 ${t.submitted}／${t.assigned} 組。`} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </Panel>
        </div>
        <div className="min-w-0">
          <Panel title="我發的公告" description={`${news.length} 則`} action={<NewItemDialog base={base} trigger={<span className="inline-flex cursor-pointer items-center gap-1 text-[13px] font-semibold text-brand hover:underline"><IconPencilPlus className="size-4" />發布公告</span>} />} className="h-full">
            <ul className="px-2 pb-2">
              {news.map((n) => (
                <li key={n.id}>
                  <Link href={n.status === "published" && n.newsId ? `/news/${n.newsId}` : `${base}/editor/${n.id}`} className="flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-accent/60">
                    <span className="tabular w-11 shrink-0 text-[11px] font-semibold text-muted-foreground">{md(n.publishedAt)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{n.title}</span>
                    {n.status === "draft" ? <Pill tone="brand">草稿</Pill> : <span className="text-[11px] text-muted-foreground">{n.audience}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

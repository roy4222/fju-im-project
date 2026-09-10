import Link from "next/link";
import { IconClipboardText, IconClock } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, PageTitle, Panel, Pill, ProgressBar, StatTile } from "@/components/dashboard/primitives";
import { Ring, SegmentBar } from "@/components/dashboard/charts";
import { PillLink } from "@/components/public/pill-link";
import { NewItemDialog } from "@/components/dashboard/new-item-dialog";
import { MANAGED_ITEMS, PLACEMENT_LABEL, daysUntil, type Placement, type Role } from "@/lib/fixtures";

/* ---------------------------------------------------------------- 管理員 */
export function AdminAffairs({ role, placement }: { role: Role; placement: string }) {
  const base = `/dashboard/${role}`;
  const all = MANAGED_ITEMS;
  const items = placement === "all" ? all : all.filter((i) => i.placement === placement);
  const placements = [...new Set(all.map((i) => i.placement))] as Placement[];
  const published = all.filter((i) => i.status === "published").length;
  const totalDone = all.reduce((a, i) => a + (i.progress?.done ?? 0), 0);
  const totalAll = all.reduce((a, i) => a + (i.progress?.total ?? 0), 0);
  const overdue = all.reduce((a, i) => a + (i.progress?.overdue ?? 0), 0);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="專題事務工作台" description="公告、資源、文件繳交、專題需求共用同一個編輯器與生命週期。" actions={<NewItemDialog base={base} />} />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="發布中" value={published} unit="項" hint={`共 ${all.length} 項`} chart={<Ring value={(published / all.length) * 100} size={44} stroke={5} />} />
        <StatTile label="整體收件" value={`${totalDone}/${totalAll}`} tone="success" chart={<Ring value={(totalDone / totalAll) * 100} size={44} stroke={5} color="var(--success)" />} />
        <StatTile label="逾期組別" value={overdue} unit="組" tone={overdue ? "danger" : "default"} hint="需個別重新開放" chart={<Ring value={(overdue / totalAll) * 100} size={44} stroke={5} color="var(--destructive)" />} />
      </div>
      <Panel
        title="全部項目"
        icon={<IconClipboardText />}
        action={
          <nav className="flex flex-wrap gap-1.5" aria-label="發布位置">
            <PillLink href={`${base}/affairs`} active={placement === "all"}>全部</PillLink>
            {placements.map((p) => (
              <PillLink key={p} href={`${base}/affairs?placement=${p}`} active={placement === p}>{PLACEMENT_LABEL[p]}</PillLink>
            ))}
          </nav>
        }
      >
        <ul className="divide-y divide-border">
          {items.map((i) => (
            <li key={i.id} className="grid items-center gap-3 px-5 py-3.5 md:grid-cols-[minmax(0,1.5fr)_10rem_14rem_auto]">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Pill tone="default">{PLACEMENT_LABEL[i.placement]}</Pill>
                  <Pill tone={i.status === "published" ? "success" : i.status === "draft" ? "info" : "default"}>{i.status === "published" ? "發布中" : i.status === "draft" ? "草稿" : "已下架"}</Pill>
                  {i.schemaVersion ? <span className="tabular text-[11px] text-muted-foreground">v{i.schemaVersion}</span> : null}
                </div>
                <Link href={`${base}/affairs/${i.id}`} className="link-ink mt-1 block truncate text-[15px] font-bold">{i.title}</Link>
                <p className="truncate text-xs text-muted-foreground">{i.audience}</p>
              </div>
              <div className="text-xs text-muted-foreground">
                {i.dueAt ? <span className={`tabular inline-flex items-center gap-1 font-semibold ${daysUntil(i.dueAt) < 0 ? "text-destructive" : "text-foreground"}`}><IconClock className="size-3.5" />{i.dueAt}</span> : <span>無截止</span>}
              </div>
              <div>{i.progress ? <ProgressBar done={i.progress.done} total={i.progress.total} overdue={i.progress.overdue} /> : <span className="text-xs text-muted-foreground">不收件</span>}</div>
              <div className="flex gap-2">
                <Link href={`${base}/affairs/${i.id}`} className={buttonVariants({ size: "sm", variant: "outline", className: "press rounded-lg" })}>狀態</Link>
                <Link href={`${base}/editor/${i.id}`} className={buttonVariants({ size: "sm", className: "press rounded-lg" })}>編輯</Link>
              </div>
            </li>
          ))}
        </ul>
        {items.length === 0 ? <EmptyState title="這個位置沒有項目" /> : null}
      </Panel>
      {placement === "all" ? (
        <Panel title="各位置收件概況" icon={<IconClipboardText />}>
          <ul className="grid gap-4 p-5 md:grid-cols-2">
            {all.filter((i) => i.progress).map((i) => (
              <li key={i.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-sm"><span className="truncate font-semibold">{i.title}</span><span className="tabular text-xs text-muted-foreground">{i.progress!.done}/{i.progress!.total}</span></div>
                <SegmentBar segments={[{ value: i.progress!.done, color: "var(--success)", label: "已繳" }, { value: i.progress!.overdue, color: "var(--destructive)", label: "逾期" }, { value: i.progress!.total - i.progress!.done - i.progress!.overdue, color: "var(--muted)", label: "未繳" }]} />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
